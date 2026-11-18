# Order and subscription model refactoring — Stage 1

This separately authorized stage prepares the database for **order → confirmed full offline payment → fulfillment completion → automatic subscription creation**. It does not implement that workflow. No page, order business API, payment integration, calendar calculation, fulfillment handler or renewal scheduler is added. Existing Phase 2 services remain compatible; they do not yet adopt the new fields or enforce the future order-first workflow.

**Latest payment-time contract:** the seventh migration below adds Order.paidAt for actual payment occurrence. paymentConfirmedAt is administrator receipt confirmation; PaymentTransaction.createdAt is database entry time. Deprecated paymentRecordedAt is preserved only for history and is never an alias/fallback for paidAt. This supersedes the provisional sixth-migration payment-time wording and historical test reports below.

## Isolation and scope

Development is on `codex/order-subscription-model-foundation` in the separate `shopping-order-models` worktree. The original `shopping` checkout has accepted uncommitted layout changes, which are left untouched. No `.env` or backup is copied. Dependencies and the generated Prisma Client are independent, so running services against the not-yet-migrated development database keep their existing client. The development database, its data volume, accounts, records and services are not changed by implementation or verification.

The modular monolith, MySQL 8.4, integer Fen, UTC DateTime(3), restrictive foreign keys, Session/invitation logic and existing 12 business tables are retained. There is no additional business table in this stage.

## Added database contract

| Model | Fields / changes |
|---|---|
| Product | Nullable `servicePeriodUnit` and `servicePeriodCount`; unit is `DAY`, `MONTH`, `YEAR`, quantity is a positive Int. `termLabel` remains descriptive and unchanged. |
| Order | `source` appends `USER`, `ADMIN`, `SYSTEM_RENEWAL` after legacy `OFFLINE_MANUAL`; `hidden` defaults false. Nullable `createdByUserId` and now-nullable `createdByAdminId` support genuine user/system creation without dummy accounts. |
| Order snapshots | Nullable `productDescriptionSnapshot`, `priceSnapshotFen`, `servicePeriodUnitSnapshot`, `servicePeriodCountSnapshot`, `formSchemaSnapshot`, `formData`. Existing name/type/term/amount/renewal-price/contact/target snapshots stay intact. Configured product price and agreed `amountFen` remain distinct. |
| Order lifecycle | Nullable `paidAt` (actual payment), `paymentConfirmedAt` (administrator receipt confirmation), `fulfilledAt` (actual completion), `cancelledAt`, `cancellationReason` (500 chars). Deprecated `paymentRecordedAt` is retained unchanged for history only; new flows leave it NULL. |
| OrderEvent | `actorType` (`USER`, `ADMIN`, `SYSTEM`) defaults ADMIN; existing `actorAdminId` becomes nullable and `actorUserId` is added. `CANCELLED` is appended after all existing event enum values. Shared subscription/audit `ActorType` remains ADMIN/SYSTEM. |
| Subscription | `sourceType` appends `ORDER`; existing nullable unique `sourceOrderId` remains, with a conditional mandatory-link CHECK for ORDER records. Existing ADMIN/SYSTEM rows are not rewritten. |
| Subscription period | Nullable `servicePeriodUnitSnapshot`, `servicePeriodCountSnapshot`, `billingAnchorAt`, `billingTimezone`, `currentPeriodStartAt`, `currentPeriodEndAt`, `earlyRenewedPeriodStartAt`, `earlyRenewalOrderId` (unique restrictive Order FK). All existing snapshots/form data/dates/status/version/source links remain. |
| AppSettings | `paymentInstructions` VarChar(4000), default empty string. Plain text only; no secrets or execution. Existing settings PATCH inputs are unchanged. |
| PaymentTransaction | Columns unchanged: integer amount, pending/confirmed/failed, actual occurrence/confirmation and ADMIN references. `occurredAt` for the corresponding confirmed full PAYMENT matches Order.paidAt; `createdAt` is entry time, not payment time. No synthetic rows or automatic charges. |

Additional index: `Order(source, hidden, createdAt)`. Additional restrictive FKs cover the customer creator, user event actor and early-renewal order. No cascading deletion is introduced.

### Periods and early renewal

`DAY` represents a fixed-day duration; `MONTH` and `YEAR` represent calendar periods, not 30/365-day approximations. New services must freeze the unit/count and original calendar anchor plus its IANA timezone. All stored instants are UTC. The approved month-end policy retains the original anchor: Jan 31 → Feb 28/29 → Mar 31 → Apr 30 → May 31; YEAR similarly retains the original calendar anchor. The calculator, leap-year/DST tests and rollover service remain next-stage work. Manual expiry correction resets the anchor to the newly confirmed expiry. No arithmetic is implemented or backfilled here.

`expiresAt` remains paid-through expiry and must not be used as the only current-cycle identifier after an advance renewal. Current period start/end persist the active cycle independently. A successful early renewal records both its order ID and the start of the period in which it was consumed. Comparing `earlyRenewedPeriodStartAt` with `currentPeriodStartAt` answers whether that cycle has already consumed its early renewal. For ORDER subscriptions, earlyRenewalUsed is explicitly false with both markers NULL initially, and true with the current cycle start/order after success. Rollover or manual anchor reset clears that eligibility state atomically; durable history stays on immutable orders/events rather than the replaceable marker. The unique order FK prevents sharing the same marker order between subscriptions.

This is storage, not a concurrency algorithm: the next service must use the existing `version` plus transactions/conditional updates, check order ownership/linkage/state, and atomically create/complete the renewal and claim the marker. A nullable marker alone is not a lock. Cancelled/failed attempts must not be mistaken for successful advance renewals. Existing direct Phase 2 renewal does not touch these fields.

### Database CHECK constraints

Prisma cannot describe CHECK constraints; they are intentionally in the versioned SQL and exercised against MySQL:

- Product/order/subscription period unit/count are either both NULL or both present with count > 0.
- New USER/ADMIN orders permit only visible INITIAL/SUBSCRIPTION or ONE_TIME/ONE_TIME and no subscription link. USER has its owning user as creator; ADMIN has an admin reference only. SYSTEM_RENEWAL has no fake creator, is hidden, is RENEWAL/SUBSCRIPTION and references a subscription. Legacy OFFLINE_MANUAL is exempt from new creator rules.
- OrderEvent stores the single corresponding actor reference, or no actor reference for SYSTEM. Existing required administrator references safely receive actorType ADMIN.
- Subscription source ORDER requires SUBSCRIPTION, complete positive period, anchor, supported canonical IANA timezone, positive billingRevision, complete increasing bounds and explicit earlyRenewalUsed. It also requires sourceOrderId. Its existing unique key and restrictive FK retain one originating order per subscription and protect history.
- Current-period bounds are both absent or increasing. Successful early-renewal marker time/order are both absent or both present.
- The seventh migration requires SYSTEM_RENEWAL to be PAID/COMPLETED at INSERT with non-NULL paidAt <= paymentConfirmedAt <= fulfilledAt and cancelledAt NULL. USER/ADMIN orders reject reversed known time pairs while allowing unknowns; OFFLINE_MANUAL history is exempt. No condition reads paymentRecordedAt.

FK presence does not prove a User role, a source order's ownership, full payment or fulfillment. Those are service-layer checks. Renewal purchase snapshots and paid renewal rows are protected by the sixth migration triggers; ordinary-order immutability, payment state derivation and plain-text rendering remain future service work. A static IANA timezone allowlist is enforced for ORDER billing and SYSTEM_RENEWAL snapshots without MySQL timezone tables.

## Migration and compatibility

Foundation migration: `20261118000000_order_subscription_foundation`. Review follow-up: `20261118010000_order_subscription_integrity`. All five preceding migration files remain unchanged by the follow-up. The foundation adds columns/indexes/FKs/CHECKs, extends enums preserving old values, and relaxes the old required administrator creator/actor columns. It performs no data UPDATE, DELETE, table replacement, source conversion or date inference.

Actual-payment-time repair: `20261118020000_order_paid_at`. This separately versioned seventh migration keeps all six preceding SQL files byte-for-byte unchanged. It adds nullable paidAt and replaces only the provisional final-state check, plus a new optional-timestamp ordering check. The two immutable triggers are unchanged.

The Prisma SubscriptionEventType declaration is reordered to match the already-committed Phase 2 SQL enum order, retaining every value and database ordinal without changing that column or any old migration. Payment instructions use a bounded VARCHAR with a literal empty default to avoid MySQL/Prisma TEXT expression-default normalization drift. A post-migration Prisma diff must report no schema changes, on both upgraded and fresh isolated databases.

Unknown historic periods, anchors, current-cycle information, order form schemas/data and lifecycle times remain SQL NULL. In particular, neither `termLabel` nor `termSnapshot` is parsed, and current Product forms are not copied into historical Order snapshots. Existing Subscription snapshots were created by the older Phase 2 migration and are not rewritten by this migration. Never replace those snapshots with today's Product during later reads.

Existing OFFLINE_MANUAL orders retain their source, creators, amounts, statuses, links and timestamps. Existing unlinked ADMIN/SYSTEM subscriptions retain their IDs, sourceOrderId NULL, creators, dates, status, prices and events. Existing settings receive empty payment instructions; old events receive ADMIN actorType. Defaults do not forge payment evidence, completed fulfillment or a known service period.

New mandatory behavior is phased through a distinct ORDER source rather than a global NOT NULL on sourceOrderId that would break history. Existing Phase 2 direct APIs still create ADMIN and accept manual expiry updates for backward compatibility. **The future business rule is not fully enforced until those entry points are integrated/restricted in the next authorized stage.** Merely adding nullable fields does not authorize new order/payment APIs now.

Do not run this migration on development data as part of implementation/testing. After review, a separate operator-authorized step must check the target/volume, current migration state, backup and existing SUSPENDED preflight, stop incompatible services as needed, apply committed migrations, generate a matching client and restart/verify. Do not use `db push`, `migrate reset`, reset/reseed accounts or restore a backup automatically on failure. MySQL DDL is not an all-or-nothing migration transaction; report failures for operator decision.

## Verification

From this isolated worktree, without a `.env`:

```powershell
npm ci
npm run db:validate
npm run db:generate
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:db
npm run test:db -w backend -- --fresh
npm run test:e2e
npm run build
```

`test:db` creates a random `membership-foundation-*` Compose project with its own database, credentials, random loopback port and volume; fixture entry points reject the development database. It installs the original migrations, populates legacy tables and exercises the original SUSPENDED guard. Before the seventh migration, all 12 business tables (including IdempotencyRecord) contain fixtures under migration six. After Prisma Migrate deploy, all old columns/rows are compared without printing secrets. An old recording timestamp and existing transaction explicitly do not cause paidAt backfill. Existing legacy-source mapping, sessions and login are checked independently. Repeated deploy must be a no-op. Fresh installs of all seven migrations run with --fresh, independently of E2E. Both paths test repeated deploy and schema drift. Only migration deployment uses disposable DBA credentials; fixtures use foundation_test. Use --models-only for this task's no-Seed boundary. Only the runner's exact random test project/volume is removed.

The new model suite covers all period units, positive/pair validation, three creators, hidden system renewals, three event actors and invalid combinations, immutable snapshot round trips after product edits, lifecycle timestamps, full-payment/manual confirmer storage, ORDER source requirements/unique/FK protection, pending customers, billing anchors/current cycles/advance markers, reconnect persistence and plain-text settings persistence. Existing backend/frontend unit, integration and E2E suites remain regression checks; no new frontend acceptance flow is claimed.

### Original foundation results (2026-11-18, before review follow-up)

| Check | Final result |
|---|---|
| `npm run db:validate` / `npm run db:generate` | Passed, Prisma 7.10.1 |
| `npm run format:check` / `npm run typecheck` / `npm run lint` | Passed |
| `npm test` | 31 passed: frontend 9, backend 22 |
| `npm run test:db` | 52 passed across the model and existing integration suites, including the model parent/subtests |
| Populated migration upgrade | All original columns/rows in 12 populated business tables preserved; includes unpaid, completed/paid and cancelled/refunded orders; unknown new historical values remain NULL |
| Fresh migration / repeat deploy / schema drift | All five migrations applied on fresh isolated MySQL; repeat deploy no-op; Prisma diff reports no changes on both fresh and upgraded databases |
| `npm run test:e2e` | 28 passed, desktop and mobile Edge, existing UI regression; 8.5 minutes |
| `npm run build` | Frontend and backend passed; existing Zod/Rollup annotation warnings are non-blocking |

The first strict diff check exposed a TEXT-default normalization mismatch and a pre-existing subscription-event enum declaration-order mismatch; both are resolved by the documented VARCHAR/default and schema-order compatibility choices above. All final checks passed after the corrections. The four old migration files and dependency lockfile are unchanged. `npm ci` reported 13 high-severity dependency advisories; dependency remediation was not performed in this model-only stage. Temporary test containers/volumes were removed by the isolated runner; the development container/volume were not operated on.

## Review follow-up — integrity and renewal cycle snapshots

Migration `20261118010000_order_subscription_integrity` is additive and does not change existing data. It tightens only new USER/ADMIN/SYSTEM_RENEWAL orders and ORDER subscriptions. OFFLINE_MANUAL and ADMIN/SYSTEM history retain NULL periods/anchors and all old states, links, timestamps and records. No parsing of termLabel, copying current forms into old orders, fabricated payments or global NOT NULL changes. If a separately deployed fifth-migration database contains incompatible new-flow rows, the CHECK/unique build must fail for operator review; never infer/fix them automatically. MySQL DDL can partially commit, so a failure is not permission to resolve/reset/retry blindly.

Added columns (all nullable globally for history):

| Model | Columns | Contract |
|---|---|---|
| Subscription | billingRevision | Positive explicit 1 for ORDER; increment only when the anchor is reset, never for a note/ordinary version change |
| Subscription | earlyRenewalUsed | Explicit false initially; NULL for unknown legacy eligibility; true requires both current-cycle markers |
| Order | renewalPeriodStartAt / renewalPeriodEndAt | Actual purchased next-cycle start/end, not merely an extension amount |
| Order | renewalForPeriodStartAt | The existing current cycle consuming its one advance-renewal entitlement |
| Order | billingAnchorSnapshotAt / billingTimezoneSnapshot / billingRevisionSnapshot | Original calendar context at purchase, independent of future subscription/settings changes |
| Order | renewalRequestKeyHash / renewalRequestHash | Unique SHA-256 of a stable, server-scoped renewal request identity and SHA-256 of its canonical intent; neither raw keys nor sensitive form values are logged |

All renewal columns are required for SYSTEM_RENEWAL and absent on new ordinary orders. Positive revisions, increasing purchased bounds, eligibility-cycle start before target start, valid hash syntax and complete new subscription periods are CHECK-protected. Timezones must be a case-sensitive member of the versioned Node 24/ICU canonical IANA list plus UTC aliases and validated Etc/GMT zones; valid aliases must be normalized before storage. History is exempt. Updating the allowlist later requires another reviewed migration, not environment-dependent DDL.

Three persistent unique claims protect:

1. `(subscriptionId, billingRevisionSnapshot, renewalForPeriodStartAt)` — at most one successful purchase per current cycle/revision.
2. `(subscriptionId, billingRevisionSnapshot, renewalPeriodStartAt)` — at most one purchase of a target cycle/revision.
3. `renewalRequestKeyHash` — one original identified request across retries, period rollover and anchor resets. Scope the hash to the authenticated principal, subscription and stable intent identifier, never a mutable current revision. A request hash mismatch must conflict; a match replays the original order, not a new purchase.

New system orders are created only once payment is verified/successful and are finalized in that same transaction. SQL CHECK now requires their INSERT to be PAID/COMPLETED with all three ordered lifecycle times and no cancelledAt; unpaid/intermediate system fixtures are rejected too. These unique claims therefore reserve successful purchases; do not commit failed/unpaid renewal attempts as system orders, or delete old orders to free a claim. No partial/unique-success predicate or additional table is required by this create-after-payment contract.

`Order_renewal_immutable_update` rejects changes to a system renewal's identity, original subscription, product/price/form snapshots, target/eligibility cycles, calendar context and request hashes from creation (byte comparisons also catch case-only edits). Every valid system renewal is already paid/confirmed/fulfilled, so every UPDATE is rejected, including cancellation, clearing fulfillment and changing back to UNPAID. `Order_paid_renewal_delete` rejects deletion. The next service must insert final paid/completed orders in its successful transaction rather than patch already-paid rows. Purchase history remains immutable through refunds too; a future separately reviewed refund design must use separate records.

### Required next-stage transaction (not implemented here)

- Administrator renewal: authenticate/authorize, verify full external receipt, then the system creates the renewal order and immediately fulfills it. Customer renewal: only a trusted successful payment result may trigger the same system transaction; no real payment integration is included now.
- Lock/conditionally claim the subscription using general version plus current billingRevision/cycle. Check owner/product eligibility, trusted full payment, supported frozen period/timezone, current entitlement, adjacent target cycle and unused advance-renewal eligibility. USER/ADMIN share this rule; neither creates a RENEWAL-source ordinary order.
- Resolve the stable request identity first. A completed original order is returned on retry even if the subscription anchor has since changed. Never re-execute it using the new revision. Per-cycle/request unique conflicts must roll back, then be resolved as an idempotent replay or business conflict.
- In one transaction persist the final PAID/COMPLETED SYSTEM_RENEWAL order and its confirmed PaymentTransaction, update the existing subscription/expiry/eligibility/version, and append OrderEvent, SubscriptionEvent and sanitized audit. Never create another subscription for renewal. A failure in any step rolls back every write.
- Manual expiry correction sets billingAnchorAt to the newly confirmed expiresAt, increments billingRevision, resets current-cycle bounds/eligibility and increments general version with an event/audit, without touching any old order. Ordinary note changes increment only general version. The new create-after-success/atomic-fulfillment contract has no committed paid pending renewal to cancel; unexpected inconsistent records must stop for review, never be rewritten.
- Initial orders still require confirmed full payment, appropriate INITIAL/SUBSCRIPTION and once-only fulfillment before creating a new ORDER subscription. Cross-table roles/ownership/product identity, full payment and completed fulfillment cannot be established by same-row CHECK; they remain mandatory service checks. Existing direct Phase 2 APIs must be integrated/restricted before ORDER records are enabled. The minute expiry worker remains unchanged.

### Migration privileges and isolated verification

Creating triggers on binlog-enabled MySQL requires elevated migration privileges in addition to normal table DDL/TRIGGER privileges. The first isolated run with the application user stopped with MySQL 1419; its disposable volume was removed. The runner now deploys with that isolated container's temporary root account only, redacts both temporary passwords, and runs all application fixtures/API/seed as the restricted test user. The loopback-only test container explicitly permits its random temporary DBA account on the test network; a native client performs its initial caching_sha2_password exchange inside that container before the Node preflight. No password is passed on the command line. It does not change binary logging, grants or configuration on the development instance. A real migration requires operator-authorized DBA credentials/approved privileges; do not put root credentials in the application's .env or automatically relax server security.

The current runner populates all 12 old tables under the first six migrations, deploys the seventh, compares every old field/row and verifies unknown paidAt stays NULL. --fresh deploys all seven into an independent empty project. Both paths check repeat deploy/no drift. Without --models-only the existing full API/seed regressions remain available; this task runs only --models-only. Paid fixtures intentionally remain until the exact disposable project is removed; tests never disable guards to delete them. The earlier result tables below describe their original migration versions, not the latest repair.

Review follow-up verification (2026-11-18, before the P1 final-state repair below):

| Check | Final result |
|---|---|
| Prisma format / generate / validate | Passed; generated client in this worktree only |
| format:check / typecheck / lint | Passed, including frontend/backend/E2E types |
| npm test | 31 passed (frontend 9, backend 22) |
| npm run build | Frontend/backend passed; existing Zod/Rollup annotation warnings only |
| npm run test:db | 62 passed (including model parent/subtests), full API/restart regressions |
| Populated upgrade | First five migrations populated; sixth applied; every old column/row in all 12 tables preserved; unknown history remains NULL; sessions/invitations/login preserved |
| npm run test:db -w backend -- --fresh | 27 passed; independent empty MySQL with all six migrations and both model suites |
| Repeat deploy / Prisma drift | No pending migrations and no schema differences on both final paths |
| Cleanup | Both final disposable projects/volumes removed by their runners; earlier failed test projects were also removed |
| E2E | Not rerun in this database-only repair; the original foundation table above records prior UI coverage, not this repair |

Initial verification exposed MySQL 1419 for trigger DDL under the application user, cold temporary DBA connection setup, and incomplete Etc/GMT timezone coverage. The disposable DBA setup and versioned timezone checks were corrected, then both final database paths passed. No development configuration, binary-log settings, grants, credentials, data or volume were changed. Four committed older migrations and the uncommitted fifth foundation SQL remain unchanged; dependency versions/lockfile and all production API/frontend source remain unchanged. This repair is uncommitted, with no PR, push or merge. The real development migration still requires review, backup and separate operator authorization with appropriate DBA privileges.

This review repair changes the following 13 files. Previously uncommitted AGENTS.md, the fifth migration, upgrade.ts, docs/10 and docs/14 are preserved without further edits:

```text
README.md
backend/prisma/schema.prisma
backend/prisma/migrations/20261118010000_order_subscription_integrity/migration.sql
backend/scripts/test-database.ts
backend/test/compose.yaml
backend/test/integration/database.test.ts
backend/test/integration/order-models.test.ts
backend/test/integration/order-upgrade.ts
backend/test/integration/renewal-integrity.test.ts
docs/04-data-model.md
docs/05-api-contract.md
docs/07-development-roadmap.md
docs/15-order-subscription-foundation.md
```

## Historical P1 repair — sixth-migration final INSERT

Repository inspection found the sixth migration untracked, absent from Git history and without a remote feature branch. Recorded earlier deployment was limited to removed disposable test databases; no persistent deployment is recorded. This repair therefore updates the unpublished sixth migration, not any of the first five. No development database was connected to inspect migration metadata. If an operator has separately applied that migration to another persistent environment, stop and use a new incremental repair there; never overwrite an applied checksum or reset/resolve the database automatically.

The sixth-only version closed the paid-but-processing dead end with a provisional paymentRecordedAt-based check. Its earlier mapping of recording time to actual paidAt was incorrect. The seventh migration supersedes that time condition with a distinct paidAt column; the sixth SQL is preserved as migration history. See the current authoritative payment-time repair below. No historical actual payment time may be inferred from recording/confirmation timestamps.

Both immutable triggers are unchanged. INSERT the final order once, then write PaymentTransaction, Subscription, events and audit in the same future transaction without updating Order. Tests keep legitimate paid fixtures until the exact isolated project is removed; they neither delete paid evidence nor disable guards. Order model suites now run after API/Seed regressions in the full runner, so their preserved fixtures do not contaminate those suites.

For this repair's no-Seed boundary, run:

```powershell
npm run test:db -w backend -- --models-only
npm run test:db -w backend -- --models-only --fresh
```

Each mode creates a separate random isolated MySQL project, using temporary migration-only DBA credentials, a restricted fixture connection, repeat-deploy and schema-drift checks. The first mode preserves/compares all old columns/rows in twelve populated tables through migration six; --fresh starts empty. Neither executes Seed CLI, seedAdministrator, API or browser suites. A disabled, passwordless fictional ADMIN and singleton test settings are ordinary guarded fixtures for model FKs, never development accounts. Both model suites test actual MySQL CHECK/Trigger rejection, not Zod. Tests reject every unfinished payment/fulfillment state, omitted/NULL times, cancellation and reversed timestamps; accept final INSERT and same-transaction subscription/payment/event/audit writes; reject later UPDATE/DELETE via Prisma and direct SQL; and compare the entire Subscription plus all related record counts after audit or trigger failures roll back.

P1 repair verification (2026-11-18); earlier result tables above remain historical evidence only:

| Check | Result |
|---|---|
| `npm run db:validate` | Passed; Prisma Schema unchanged by this repair |
| `npm run format:check` / `npm run typecheck` / `npm run lint` | Passed, including frontend/backend/E2E types |
| `npm test` | 31 passed: frontend 9, backend 22 |
| `npm run build` | Frontend/backend passed; Zod/Rollup annotation warnings only |
| `npm run test:db -w backend -- --models-only` | 20 passed (9 foundation + 11 integrity, including parent tests); all twelve populated old business tables/columns preserved through the sixth migration |
| `npm run test:db -w backend -- --models-only --fresh` | 20 passed; independent empty MySQL 8.4, all six migrations deployed successfully |
| Migration metadata / drift / repeat deploy | Both paths verified 6 successful migrations, 12 business tables plus the Prisma migration table, no schema differences and no pending migrations on repeat deploy |
| CHECK / Trigger / transaction evidence | All requested negative INSERT cases rejected by MySQL; final INSERT accepted; Prisma/direct-SQL UPDATE and DELETE rejected; audit and trigger failure rolled back all related rows and the complete subscription state |
| Cleanup / preservation | Both disposable projects and volumes removed; existing worktree changes, original checkout layout edits, prior five migrations, dependency lockfile and production API/frontend source preserved |
| Scope | No development database connection/migration, .env edits, administrator initialization, business API/browser integration suite, commit, push or PR |

The P1 repair changes only these nine files, relative to the already modified worktree: README.md; the sixth migration SQL; backend/scripts/test-database.ts; backend/test/integration/order-models.test.ts; backend/test/integration/renewal-integrity.test.ts; docs/04-data-model.md; docs/05-api-contract.md; docs/07-development-roadmap.md; and this guide. The Prisma Schema requires no further field changes. Cross-table payment verification and atomic production fulfillment remain deferred service work.

## Actual payment time repair — seventh migration

No remote feature branch or sixth-migration commit was found, but repository inspection cannot prove the absence of a manual persistent deployment. Rather than rewrite the sixth again, this repair adds `20261118020000_order_paid_at`; the previous six SQL files and immutable triggers remain unchanged. No persistent database is connected to discover deployment state.

| Field | Authoritative meaning |
|---|---|
| Order.paidAt | Actual full-payment occurrence, frozen from the corresponding confirmed PAYMENT's occurredAt. Nullable for unknown history. |
| Order.paymentConfirmedAt | When the administrator confirmed receiving the full payment. |
| Order.fulfilledAt | Actual service fulfillment completion. |
| Order.cancelledAt | Order cancellation time. |
| Order.paymentRecordedAt | Deprecated legacy entry timestamp. Preserve old values; do not write in new flows, fall back to it or use it to compute paidAt. |
| PaymentTransaction.occurredAt | Actual external payment/refund occurrence; for the corresponding confirmed full PAYMENT, equal to Order.paidAt. |
| PaymentTransaction.createdAt | When the payment record was entered into the database, default now(). It can follow confirmation/fulfillment when the system order and its record are created after payment success. |

No receivedAt field is introduced. The order copy is a deliberate immutable payment snapshot, not a second independently supplied time. Future confirmation/fulfillment services must set paidAt from the trusted full confirmed PAYMENT's occurredAt and match confirmation times, amounts and order ownership in the same transaction. Same-row CHECK cannot verify cross-table equality; no business API or equality trigger is added in this stage.

The final SYSTEM_RENEWAL CHECK now requires all final source/type/visibility/reference/status fields, non-NULL paidAt/paymentConfirmedAt/fulfilledAt, cancelledAt NULL and paidAt <= paymentConfirmedAt <= fulfilledAt. Equal instants are accepted. Explicit NULL guards prevent UNKNOWN bypass. Deprecated paymentRecordedAt is neither required nor consulted. Optional known pairs on new USER/ADMIN orders must also be chronological; unknown and OFFLINE_MANUAL legacy values remain compatible. Do not impose createdAt <= paidAt: system orders are intentionally created after payment confirmation.

The seventh SQL is one MySQL 8.4/InnoDB ALTER TABLE, with no UPDATE/backfill, record deletion, trigger replacement or data inference. Existing ordinary/legacy orders receive paidAt NULL even if they have recording timestamps or transaction rows. If an earlier environment already contains SYSTEM_RENEWAL rows, paidAt would be unknown; this strict migration must fail its CHECK instead of fabricating times or weakening protection. That environment needs a separately reviewed migration plan based on genuine verified payment evidence. Never bypass checks, disable immutable triggers, repair checksums or reset the database automatically. Atomic table DDL does not make Prisma migration metadata or the whole migration chain transactional.

Use the two --models-only commands above: populated six-to-seven upgrade and fresh seven-migration install, without Seed. Tests use distinct actual-payment, confirmation, fulfillment and entry timestamps, reject legacy recording time as a substitute for missing paidAt, permit NULL legacy history and equal instants, and retain final INSERT/immutability/concurrency/all-related-record rollback coverage.

Payment-time repair verification (2026-11-18); all earlier test tables remain historical:

| Check | Result |
|---|---|
| `npm run db:format -w backend` / `npm run db:generate` / `npm run db:validate` | Passed; Prisma 7.10.1 client generated only in this worktree |
| `npm run format:check` / `npm run typecheck` / `npm run lint` | Passed, including frontend/backend/E2E types; the new fixture regex lint issue was corrected before the final run |
| `npm test` | 31 passed: frontend 9, backend 22 |
| `npm run test:db -w backend -- --models-only` | 21 passed (10 foundation + 11 integrity, including parent tests), plus the migration-guard script. Populated migration-six to migration-seven upgrade preserves every original column/row in all 12 business tables; actual payment times stay NULL despite recording/transaction data |
| `npm run test:db -w backend -- --models-only --fresh` | 21 passed; independent empty MySQL 8.4 with all 7 versioned migrations |
| Migration rejection guard | Exact sixth CHECK and seventh ALTER reused on an isolated InnoDB scratch table: an existing system renewal with unknown paidAt is rejected; its row, CHECK and columns remain intact |
| Repeat deploy / drift / metadata | Both paths verify 7 successful migrations, 12 business tables plus Prisma metadata, no pending migrations and no Prisma schema differences |
| Time semantics / immutable transactions | Actual payment differs from confirmation, fulfillment and transaction entry; corresponding occurredAt equals paidAt. Missing paidAt cannot use paymentRecordedAt as a substitute. Equal instants pass; reversed known pairs fail. Later paid-order UPDATE/DELETE remain blocked and audit/trigger failures roll back all related records |
| `npm run build` | Frontend/backend passed; existing Zod/Rollup annotation warnings only |
| Preservation / cleanup | All six preceding migrations, dependencies, production API/frontend source and original checkout layout edits unchanged. Both random test projects/volumes removed by their runners |
| Scope | No development database connection/migration, .env change, database Seed initialization, order API/frontend development, commit, push or PR. No API/browser integration suite rerun |

Relative to the already modified worktree, this repair changes 12 files: README.md; backend/prisma/schema.prisma; the new seventh migration; backend/scripts/test-database.ts; backend/test/integration/order-models.test.ts; backend/test/integration/order-upgrade.ts; backend/test/integration/paid-at-migration-guard.ts; backend/test/integration/renewal-integrity.test.ts; docs/04-data-model.md; docs/05-api-contract.md; docs/07-development-roadmap.md; and this guide.

## Deferred to the next separately authorized stage

- Customer/admin order APIs, ownership/RBAC, hidden-order read projections and safe validated form submission.
- Mandatory structured periods for newly sold subscription products; strict period/form snapshot validation and freezing. Unknown legacy records require explicit confirmation before calculation.
- A single full confirmed payment matching the server-calculated amount, idempotent manual confirmation, independent payment/fulfillment transitions, cancellation policy and lifecycle time/event/audit updates.
- Atomic exactly-once subscription creation only after confirmed payment and completed fulfillment, always using source ORDER and the originating order snapshot. One-time products do not automatically become subscriptions.
- Calendar arithmetic, current-period rollover and one successful advance renewal per current period, with concurrency/idempotency and failure handling.
- Transition of existing direct subscription entry points and worker behavior to the new workflow without rewriting old history; payment-instructions input/output limits and safe plain-text UI rendering.

No next-stage work, commit/push, PR creation or merge is performed by this task.

## Cumulative stage 1 changed files

- `backend/prisma/migrations/20261118010000_order_subscription_integrity/migration.sql`
- `backend/prisma/migrations/20261118020000_order_paid_at/migration.sql`
- `backend/test/compose.yaml`
- `backend/test/integration/renewal-integrity.test.ts`
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20261118000000_order_subscription_foundation/migration.sql`
- `backend/scripts/test-database.ts`
- `backend/test/integration/database.test.ts`
- `backend/test/integration/upgrade.ts`
- `backend/test/integration/order-upgrade.ts`
- `backend/test/integration/paid-at-migration-guard.ts`
- `backend/test/integration/order-models.test.ts`
- `AGENTS.md`
- `README.md`
- `docs/04-data-model.md`
- `docs/05-api-contract.md`
- `docs/07-development-roadmap.md`
- `docs/10-local-operations-mvp.md`
- `docs/14-user-subscription-core.md`
- `docs/15-order-subscription-foundation.md`
