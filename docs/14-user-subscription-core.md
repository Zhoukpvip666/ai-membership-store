# Phase 2 — User Model Refactoring & Subscription Management Core

> **Later approved design (pending implementation):** [T25](34-customer-claim-registration.md) permits unclaimed customer records without a login email and updates name fallbacks/DTOs accordingly. The historical Phase 2 creation and activation rules below remain the current baseline until T25 is implemented; all subscription and ownership safeguards remain applicable.

> **Historical implementation and compatibility scope:** This guide preserves Phase 2 behavior and its migration/test history. Its administrator direct-creation and manual-renewal endpoints remain compatibility functionality; they are distinct from customer/order-based renewal, which remains unimplemented. Initial order fulfillment and ORDER-linked subscription creation were later merged in PR #26, and customer subscription reads in PR #38. See the [current project status](00-project-status.md) and [manual fulfillment contract](24-manual-fulfillment-api.md). References below to placeholder/Mock order and customer pages describe the Phase 2 handoff only.

This phase was implemented on a separate feature worktree for owner review and superseded the older renewal design for its administrator subscription operations. Its original handoff stopped at its PR; that historical scope is not a prohibition on the later merged order/payment stages or authorization to begin new features.

## Scope and architecture

Keep the existing Node.js 24/Express/Prisma/MySQL 8.4 modular monolith and Vue/Element Plus application. Reuse ADMIN database sessions, Argon2id login, CSRF, bounded mutation limits, serializable transactions and responsive layouts. No Redis, queue service, supplier integration, SMTP, public deployment or customer subscription endpoint is introduced.

The original `shopping` checkout, its `.env`, services and development volume are preserved. Implementation lives in `shopping-phase2` on `codex/phase2-subscription-core`, without a copied `.env`. Every database write during automated verification targets a random isolated test project/database.

## User names and privacy

- Rename `displayName` to nullable `adminLabel`, preserving every old value. Add nullable `username`, initially NULL for all old accounts.
- Preserve IDs, login emails, password hashes, roles/statuses, activation dates, creators, timestamps, Session, InvitationToken and all restrictive foreign keys. Migration does not revoke existing sessions or invitations; a pre-migration administrator session and password login are exercised after upgrade.
- ADMIN customer APIs accept optional nullable `adminLabel`, never customer `username` or passwords. Creation with only a login email is valid. Existing invitation activation remains token/password only; the nullable username leaves room for a later separately authorized flow.
- Public authentication projections include username and exclude adminLabel for both login/me. Administrator customer/list/detail projections include adminLabel. Backend authorization still gates every administrator path.
- Back-office naming is adminLabel → username → login-email prefix. The customer profile uses username or its email prefix; no private label is inferred from old displayName.

## Migration and historical compatibility

New migration: `20261117030000_user_subscription_core`. All three earlier migrations remain byte-for-byte unchanged. No `db push`, reset, row reconstruction or development migration occurs during implementation.

The owner confirmed this legacy mapping:

| Old subscription source | New source | Preserved |
|---|---|---|
| ORDER | ADMIN | id, userId, productId, sourceOrderId, createdByAdminId, dates, price, status, timestamps |
| MANUAL_GRANT | ADMIN | Same |
| HISTORICAL_IMPORT | ADMIN | Same |

`npm run db:migrate` performs a read-only preflight before invoking Prisma Migrate. If any SUSPENDED row exists, it fails with the number and IDs, before any pending migration is applied. It never restores, terminates, deletes or edits those rows. The operator must decide how to handle them in a separate authorized action. The SQL file also starts with a temporary CHECK guard before any persistent schema/data change, protecting direct Prisma invocation. Direct Prisma errors identify the guard; use the project command for the detailed count/ID report. Do not resolve a failed migration, retry with a different schema, or alter paused rows automatically.

Subscription adds product name/description/type/price/term/form-schema snapshots, formData, note, termination metadata and version. Sources become ADMIN/SYSTEM and statuses ACTIVE/TERMINATED; createdByAdminId becomes nullable for future SYSTEM creation. The old targetIdentifier remains nullable/read-only so no legacy identifier is lost. No ordinary API accepts it. SourceOrderId and all old event/order references remain.

Legacy subscriptions lack historic product/configuration snapshots. The migration freezes the referenced Product at migration time, retains the original renewal price/dates/status and initializes formData `{}` and version1. It cannot reconstruct an earlier product price/schema or fabricate submitted values. Old data may therefore omit newly-required form fields; supplied formData on a later edit must satisfy the frozen schema. An edit that does not supply formData preserves the original data. Terminated historical rows retain missing termination metadata rather than inventing a timestamp/reason.

SubscriptionEvent is extended, not replaced. Preserve all historical event enum values, date columns, orders, actors, reasons and timestamps. Only new writes use the new eight-event vocabulary. Add actorType/beforeJson/afterJson. AdminAuditLog also gains actorType, and both actor FKs become nullable for SYSTEM; existing rows default ADMIN with the same actor. No fake system user is created.

One new `IdempotencyRecord` table makes twelve business tables plus Prisma metadata. It stores a scoped unique key hash, canonical request hash, operation and original response. No raw key/request is stored. These responses are protected service data, not logs: retain locally, do not export or expose them to customers. Automatic retention/deletion is deferred so replay protection is not silently weakened.

## Subscription operations

- Create only for CUSTOMER users who are ACTIVE or PENDING_ACTIVATION, and unarchived SUBSCRIPTION products. Listing is irrelevant. Disabled/missing customers, one-time/archived/missing products are rejected.
- Copy current Product name, description, type, initial price, term and form schema atomically. `priceSnapshotFen` means the product price at subscription creation, not an actual payment. Each submission creates an independent entitlement unless an idempotency key replays a previous request. No order/payment is created.
- Start must precede expiry. Expired historical entries may be created, but grant no current entitlement and are picked up by the expiry sweep. Renewal price uses integer CNY Fen 0–2147483647. No inferred duration arithmetic.
- PATCH allows dates, renewal price, formData and private note with version/reason. Ownership, source and frozen snapshots are immutable. It validates supplied values against the subscription's own schema. Archived products do not prevent maintaining an existing unexpired subscription.
- Direct renewal updates the same unexpired ACTIVE subscription, with explicit expiry later than database now and start; it rejects archived products. It does not require expiry to be calculated from an old date or a product cycle. Optional renewal price overrides only that subscription.
- Immediate cancellation is irreversible, requires version/reason, sets termination metadata and increments version. Terminated rows retain readable detail/history and reject edits/renewal/repeated termination, except an original idempotent replay.

Eight form types use stable configured IDs and strict server validation. Strings/selection/date/number/checkbox limits follow the product contract. Required values reject missing/blank/empty choices; numeric zero is valid. Unknown keys/types/options are rejected; optional empty fields are omitted. Text is rendered with Vue escaping; no JavaScript/HTML/expression execution. Defaults initialize the administrator form, not the authoritative server result. No credentials may be entered in service data or notes.

## Atomicity, concurrency and expiry

Each mutation commits Subscription, SubscriptionEvent, sanitized AdminAuditLog and optional IdempotencyRecord together. Audit failure rolls everything back. PATCH emits UPDATED and specific DATE/PRICE/FORM change events where appropriate; renewal/termination use their dedicated events.

History before/after JSON includes the mutable state, versions, dates, amounts and termination metadata. note and formData values are redacted; field IDs/changed structure are retained. Raw values remain only in protected subscription data and the protected original idempotency response, never audit/history/console output. Reasons are required operational explanations; the UI warns against entering secrets. Existing authentication/customer audits retain their prior minimized behavior.

Optimistic locking uses conditional updates with version/status and database `UTC_TIMESTAMP(3)`, not a browser clock. PATCH/renew reject a row that expired while waiting for a lock. Read eligibility and product-archive checks occur in the same serializable transaction; transient write conflicts have bounded retries. Stale versions return409 without overwriting a winner.

The API process performs a startup sweep and checks every minute, in batches of100 without overlapping local sweeps. A conditional update terminates only still-ACTIVE expired rows, sets `订阅到期`, increments version and writes one AUTO_TERMINATED event/SYSTEM audit with NULL actor ID. Multiple workers and administrator operations race through the same database state/version/time predicates. A failed sweep logs only a generic error and retries next minute. Shutdown waits for the current batch. There is no public sweep endpoint.

Future customer entitlement checks must always require `status=ACTIVE AND expiresAt>now`; neither scheduler timing nor a stored ACTIVE label alone proves access.

All four mutations support `Idempotency-Key`. The frontend generates one per intended payload and retains it for unchanged retries. Canonical hashing includes operation/target/body, is scoped by admin, and ignores JSON object key order. Same key/request returns the original committed status/body after a restart or later state changes; a reused key for a different operation/body returns409. Parallel duplicates cannot commit duplicate subscriptions/events/audits. Without a key, distinct create requests intentionally create distinct subscriptions.

## UI and API

`/admin/subscriptions` now reads the local database and supports filters, creation, snapshot detail, maintenance, direct renewal, cancellation and paginated history. Creation selectors search eligible customers/products remotely, include pending users/unlisted products and exclude disabled/archived/one-time choices. List filter selectors also include disabled customers and archived products so their history remains searchable. Archived product subscriptions remain readable/editable while unexpired, but have no renewal action. Details render the frozen fields and values; customer pages remain placeholders and order/dashboard pages remain clearly Mock.

List filters: search across adminLabel/username/email/frozen product name; userId/productId; ACTIVE/TERMINATED; ADMIN/SYSTEM; seven-day upcoming or expired; inclusive expiry date range; pagination. Dates are stored as UTC and displayed/entered in configured IANA timezone independently of the browser OS timezone. Nonexistent calendar/DST times are rejected. Ambiguous fall-back times use the converter's deterministic offset; choose a nonambiguous time when precision matters. UI eligibility is advisory; backend/database checks are authoritative.

Implemented under `/api/v1`, ADMIN-only:

```text
GET  /admin/subscriptions
POST /admin/subscriptions
GET  /admin/subscriptions/:id
PATCH /admin/subscriptions/:id
POST /admin/subscriptions/:id/renew
POST /admin/subscriptions/:id/terminate
GET  /admin/subscriptions/:id/events
```

Payload/response/validation details: [API contract](05-api-contract.md). Sidebar/grid/dialog styling preserves the existing desktop and mobile baseline. Tables scroll within their panel; dialogs and filters fit mobile widths.

## Local operation after review

Implementation does not apply the new migration to the developer's `membership_store` database or modify `.env`. After the PR is reviewed and merged, an operator must back up the intended database and explicitly authorize applying the committed migration before running this version against it. Existing services should continue using the old checkout until then. Do not run a newer generated client against an unmigrated database.

From the reviewed checkout, with the operator's existing local configuration and initialized MySQL:

```powershell
npm ci
npm run db:validate
npm run db:status
# Only after review, backup and separate operator authorization:
npm run db:migrate
# No seed is needed for an existing administrator.
npm run dev:api
# Second terminal:
npm run dev:web
```

Use the exact APP_BASE_URL origin, normally `http://localhost:5173/admin/login`; subscriptions are `/admin/subscriptions`, customers `/admin/users`. API defaults to loopback3000. Reuse healthy correctly configured services; do not overwrite `.env`, reset volumes or reset an admin password. Migration preserves current sessions/login. No email, payment or supplier action occurs.

## Verification and delivery

Required commands: `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm run db:validate`, `npm test`, `npm run test:db`, `npm run test:e2e`, `npm run build`.

Run database and browser suites sequentially on a memory-constrained workstation. Playwright defaults to one worker; database tests still exercise simultaneous mutations and expiry workers. The root E2E script forwards CLI flags (for example `npm run test:e2e -- --workers=2`) to Playwright. No assertions, browser projects or database checks are disabled.

The existing runner creates random `membership-foundation-*` MySQL8.4 projects/volumes with temporary credentials and guards the database/user name. It never loads the development `.env`. Upgrade fixtures populate all original business tables under the unchanged initial schema; exercise paused-record CLI/SQL guards; preserve original columns/references/timestamps; verify all source mappings, new name privacy, existing session and admin login; and remove only their own fictional fixtures. The schema includes one added idempotency table. Integration coverage includes strict forms, permissions/CSRF, snapshots, independent records, archive behavior, idempotency/restart replay, version races, expiry/renewal races, SYSTEM audit and audit-failure rollback. Browser coverage uses isolated real API/MySQL on desktop/mobile Edge, alongside prior authentication/product/Mock-history regression tests. Mobile viewport emulation is not a physical-device test.

Verified locally with Node.js 24, Prisma 7.10.1 and isolated MySQL 8.4:

| Check | Result |
|---|---|
| `npm ci` | Passed, including automatic Prisma Client generation |
| `npm run format:check` | Passed |
| `npm run typecheck` | Passed, frontend/backend/E2E |
| `npm run lint` | Passed |
| `npm run db:validate` | Passed |
| `npm test` | 31 passed: frontend 9, backend 22 |
| `npm run test:db` | 43 passed, plus populated legacy upgrade/SUSPENDED guard/repeated migration assertions |
| `npm run test:e2e` | 28 passed on desktop/mobile Edge, single worker (4.9 minutes) |
| `npm run build` | Frontend and backend passed; existing Zod annotation warnings are non-blocking |

Earlier parallel suite execution produced subscription E2E 503 responses while the 16 GB workstation had about 1.4 GB available memory. Resource contention is the suspected cause; the final standalone single-worker run passed all 28 tests, including subscription creation and maintenance on both viewports. Database concurrency checks remain enabled and passed. E2E radio/login synchronization and mobile long-list selection interactions were corrected without forced clicks, sleeps or weakened assertions. Desktop/mobile subscription screenshots were visually inspected.

The unchanged dependency versions/lockfile produced an `npm ci` summary of 13 high-severity advisories. A separate `npm audit` detail request failed because the npm registry TLS connection disconnected. No automatic dependency upgrades or force fixes were performed; dependency remediation remains separate review work.

Screenshots/traces and test credentials are ignored local artifacts, never committed. The development database has not been migrated or seeded. After review/backup, the operator must separately authorize the new migration. The PR targets main and must not be automatically merged.

## Changed files

The feature changes these 58 files; existing migration files, dependency versions/lockfile, development configuration and order/payment modules are unchanged. The root E2E script and Playwright worker count are adjusted for local verification.

```text
AGENTS.md
README.md
package.json
playwright.config.ts
backend/prisma/migrations/20261117030000_user_subscription_core/migration.sql
backend/prisma/schema.prisma
backend/scripts/prisma.ts
backend/scripts/test-database.ts
backend/src/contracts/form-data.ts
backend/src/db/migration-preflight.ts
backend/src/db/seed.ts
backend/src/db/transaction.ts
backend/src/http/routes.ts
backend/src/modules/subscriptions/idempotency.ts
backend/src/modules/subscriptions/routes.ts
backend/src/modules/subscriptions/scheduler.ts
backend/src/modules/subscriptions/schemas.ts
backend/src/modules/subscriptions/service.ts
backend/src/modules/users/schemas.ts
backend/src/modules/users/service.ts
backend/src/server.ts
backend/test/integration/auth.test.ts
backend/test/integration/database.test.ts
backend/test/integration/products-restart.test.ts
backend/test/integration/products.test.ts
backend/test/integration/subscriptions.test.ts
backend/test/integration/upgrade.ts
backend/test/security.test.ts
backend/test/subscriptions.test.ts
docs/01-product-requirements.md
docs/02-user-and-operations-flows.md
docs/03-system-architecture.md
docs/04-data-model.md
docs/05-api-contract.md
docs/06-security-and-operations.md
docs/07-development-roadmap.md
docs/08-interface-specification.md
docs/10-local-operations-mvp.md
docs/11-database-foundation.md
docs/12-authentication-customers-invitations.md
docs/13-products-settings-forms.md
docs/14-user-subscription-core.md
e2e/auth.spec.ts
e2e/prototype.spec.ts
e2e/subscriptions.spec.ts
frontend/src/api/client.ts
frontend/src/api/subscriptions.ts
frontend/src/components/ProductFormInputs.vue
frontend/src/layouts/AdminLayout.vue
frontend/src/layouts/StoreLayout.vue
frontend/src/router/index.ts
frontend/src/stores/business-time.ts
frontend/src/stores/user-name.test.ts
frontend/src/stores/user-name.ts
frontend/src/style.css
frontend/src/views/account/Profile.vue
frontend/src/views/admin/Subscriptions.vue
frontend/src/views/admin/Users.vue
```
