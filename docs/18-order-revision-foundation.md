# Order revisions and generic idempotency foundation

Implements the infrastructure authorized after [D34–D36, D40–D48 and T1/T5/T12/T14/T15](17-order-creation-and-lifecycle-design.md). No order creation/edit, history browsing, payment, cancellation, fulfillment, renewal or new frontend endpoint is implemented.

## Schema and compatibility

Migration eleven is `20261119000000_order_revision_foundation`. The ten earlier migration files remain unchanged. It performs:

1. Add `Order.version INT NOT NULL DEFAULT 1` and a positive-version CHECK. Existing orders become V1 without changing timestamps, source, snapshots or payment facts. No historical revisions or actors are fabricated.
2. Rename `IdempotencyRecord.actorAdminId` to `actorUserId`, rename its unique index and replace the restrictive FK, in place in one ALTER. No record deletion/reinsertion, hashing, payload rewriting or cleanup. Existing IDs, actor IDs, keyHash, requestHash, operation, responseJson and createdAt survive unchanged.
3. Create `OrderRevision` and its restrictive order/actor references, CHECKs, unique `(orderId,version)` and indexes `(orderId,createdAt)` / `(actorUserId,createdAt)`.
4. Create two Order version guards and three OrderRevision guards. The existing five Order source/renewal/deletion guards remain intact. Final totals: 13 business tables plus `_prisma_migrations`, 11 migrations, seven Order triggers and three OrderRevision triggers.

`OrderRevision` stores UUID id, orderId, positive version, snapshotSchemaVersion, snapshotJson, nullable actorUserId, OrderActorType USER/ADMIN/SYSTEM, optional reason (500 characters), and UTC createdAt. USER/ADMIN require an existing User ID; SYSTEM may use NULL. Actor role and customer ownership must be verified by the future service using Session, not accepted from the browser.

New orders must INSERT version 1. Every successful Order UPDATE must set exactly old version +1; omission, repeats, backwards movement and jumps are rejected. This applies to notes and state transitions. Paid SYSTEM_RENEWAL orders remain wholly immutable under the earlier trigger. A revision INSERT takes a shared lock on the parent and requires its current version; missing parent/actor references fail restrictive FKs. There is no global revision sequence across different orders.

## Snapshot V1 contract

Internal history is distinct from both HTTP DTOs. `buildOrderSnapshot` selects an explicit allowlist from the persisted order, normalizes dates to UTC ISO strings, copies JSON values, and validates strict Zod objects. MySQL independently checks the complete JSON field whitelist, envelope version, matching order ID and matching version:

```text
{ snapshotSchemaVersion: 1, order: { ...the following fields... } }
```

| Group | Exact order keys |
| --- | --- |
| Identity / creation | id, orderNo, userId, productId, subscriptionId, kind, source, hidden, createdByAdminId, createdByUserId |
| Frozen purchase terms | productNameSnapshot, productDescriptionSnapshot, productTypeSnapshot, priceSnapshotFen, termSnapshot, servicePeriodUnitSnapshot, servicePeriodCountSnapshot, renewalPriceSnapshotFen |
| Form / contact / price | formSchemaSnapshot, formData, contactEmailSnapshot, targetIdentifier, amountFen |
| Renewal cycle | renewalPeriodStartAt, renewalPeriodEndAt, renewalForPeriodStartAt, billingAnchorSnapshotAt, billingTimezoneSnapshot, billingRevisionSnapshot |
| Business state | paymentStatus, fulfillmentStatus, cancellationReason, internalNote |
| Times / version | paidAt, paymentRecordedAt, paymentConfirmedAt, fulfilledAt, cancelledAt, createdAt, updatedAt, version |

All keys are required even when the historical value is NULL. `paymentRecordedAt` is legacy metadata only; it never substitutes actual `paidAt`. No current Product join/recalculation or period inference occurs. Renewal request hashes, auth fields, Session/token/password data, request headers and audit relations are excluded. Frozen form data still requires the existing non-sensitive form contract; this helper is not a substitute for validating future order submissions. Internal notes/contact/form values in permanent revisions must never be logged or exposed as customer responses.

History UPDATE and DELETE unconditionally signal `ORDER_REVISION_IMMUTABLE`, including conflicting UPSERT, REPLACE (primary or order/version unique collision), UPDATE IGNORE and DELETE IGNORE. INSERT IGNORE on an existing key can only skip the insert; it cannot replace or change the stored snapshot. The MySQL behavior is documented in [CREATE TRIGGER](https://dev.mysql.com/doc/refman/8.4/en/create-trigger.html) and [JSON Schema validation](https://dev.mysql.com/doc/refman/8.4/en/json-validation-functions.html).

## Future transaction boundary

No write API exists in this delivery. Future creation must atomically write Order V1, Revision V1, ORDER_CREATED event, ADMIN audit where applicable, and idempotency response. Future changes use a conditional update by ID + expectedVersion + authorized editable-state/deadline predicates, increment once, then insert the same-version snapshot, events and audit in the same transaction. Zero affected rows returns 409 with no side effects. Customer/system operations must not invent an administrator audit actor.

The database cannot defer a cross-table “every Order write has a revision/event/audit” assertion until COMMIT. These guards protect version progression/history and do **not** replace the future transaction service. A privileged direct writer can still omit a revision when updating Order; application write accounts and services must enforce the documented transaction boundary. Isolated tests demonstrate the intended atomic pattern and full rollback on revision/event/audit/idempotency failures, but are not new business APIs. Concurrent conditional writes yield one version winner and one set of side effects.

## Generic idempotency

The existing subscription mutation helper now uses `actorUserId_keyHash`. Everything else remains unchanged: SHA-256 of the raw key (never store the key), request hash including operation plus recursively sorted object keys, preserved array ordering and Date ISO normalization, original committed response replay, changed input/target/operation 409, and unique-key race recovery after full transaction rollback. ADMIN and CUSTOMER share one table with distinct per-identity namespaces; no operation-specific key namespace or TTL is added. Records are permanent. No lookup may cross identity boundaries and stored responses must not be logged.

## Existing order DTO extensions

The four GET routes and their Session/role/ownership/hidden predicates are unchanged. Both DTOs now return positive `version`, UTC ISO `expiresAt = original createdAt +24h`, and server-computed `remainingSeconds`. Seconds are floored and clamped at 0. Only UNPAID + NOT_STARTED without paidAt/paymentConfirmedAt/fulfilledAt/cancelledAt receives a positive countdown. Paid, pending verification, refund, processing, completed, failed, cancelled or expired orders return 0; the original deadline remains available as metadata. No timeout cancellation task or payment action is added. List rows use one clock sample per response.

ADMIN additionally receives nullable internalNote. CUSTOMER projection/DTO strictly exclude it and retain existing no-other-user/no-auth/no-audit guarantees. Complete independent field white-lists cover list/detail and nested customer/creator objects; HTTP tests also compare all business tables and revisions before/after reads.

## Deployment requirements and failure handling

Implementation tests never use development `.env` or the development database. Development migration needs separate authorization, backup, maintenance window and read-only preflight. Deploy matching application code/Prisma Client with the rename: an old Client still querying actorAdminId cannot run against the new column.

The migration account needs SELECT for preflight, ALTER/CREATE/INSERT for the affected ALTER TABLE statements, REFERENCES on referenced tables, CREATE for OrderRevision, and TRIGGER on the subject tables. Indexes here are defined/renamed inside CREATE TABLE/ALTER TABLE; a separate CREATE INDEX statement would need INDEX. Prisma additionally needs its migration tracking table privileges. See [ALTER TABLE privileges](https://dev.mysql.com/doc/refman/8.4/en/alter-table.html) and [CREATE TABLE](https://dev.mysql.com/doc/refman/8.4/en/create-table.html). Migration-created trigger DEFINER defaults to the migration account; no explicit foreign DEFINER is set, and no extra SET_ANY_DEFINER privilege is requested. The definer must continue to have TRIGGER and the SELECT permissions needed by OLD/NEW/parent-order reads. A distinct application runtime account can retain business SELECT/INSERT/UPDATE privileges without DDL/TRIGGER administration. Never give a runtime account DROP/ALTER to bypass history protections; TRUNCATE and DBA schema changes are outside row-trigger protection.

With binlog enabled, DBA approval may be necessary for CREATE TRIGGER (SUPER or a DBA-controlled temporary log_bin_trust_function_creators configuration). Do not silently grant SUPER or change globals. Follow [MySQL stored-object access control](https://dev.mysql.com/doc/refman/8.4/en/stored-objects-security.html) and existing DBA preflight/recovery procedures. This task changes no grants or global variables on development MySQL.

MySQL DDL is not one transaction across the migration: Order ALTER, IdempotencyRecord ALTER, table creation and each trigger creation can commit separately. On any failure stop, inspect `_prisma_migrations`, columns/FKs/indexes and information_schema.TRIGGERS (including DEFINER/ACTION_ORDER), and obtain DBA recovery approval. Do not retry blindly, reset, edit applied SQL or assume rollback. Repeated successful Prisma deploy must report no pending migrations. Maintenance must end only after full schema/trigger verification.

## Isolated verification

Commands run only in this independent worktree; no root `.env` is copied or read:

```powershell
npm ci
npm run db:validate
npm run db:generate
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:db -w backend -- --revisions-only
npm run test:db -w backend -- --revisions-only --fresh
npm run test:db -w backend -- --orders-only
npm run test:db -w backend -- --models-only --fresh
npm run test:e2e -w backend -- --revisions-only
npm run build
```

`--revisions-only` extends the existing guarded runner: random Compose project/loopback port/temporary credentials/exclusive MySQL8.4 volume. Its historical path applies the exact first ten SQL files, creates fictional fixtures in all twelve old business tables (not Seed), captures every record, then deploys migration eleven. Comparison permits only Order.version=1 and the actor column name change. It replays a genuinely pre-migration stored administrator request/response without invoking the action or writing data. `--fresh` applies all eleven from empty. Both check repeated deploy/status/schema diff and run revision tests plus the complete existing subscription HTTP regression. `--orders-only` separately exercises all read permission/DTO/search/LIKE/pagination tests against fresh isolated MySQL. Model suites verify existing renewal/source guards still work. Browser mode establishes only fictional login/settings fixtures, runs existing desktop/mobile regression and never calls Seed. Cleanup removes only that runner's random resources.

Execution results are recorded below after verification. No claim here authorizes a migration on the development database or starts order creation API work.

## Executed results (2026-11-19)

| Check | Actual result |
| --- | --- |
| npm ci; Prisma validate / generate | Passed using locked Prisma 7.10.1; no dependency-version changes |
| format:check; typecheck; lint | Passed on the final code/tests |
| npm test | Backend 27/27; frontend 9/9 |
| --revisions-only historical upgrade | Passed: all twelve populated old business tables retained; version=1; original idempotency hashes/response replay; no invented revisions; repeat deploy/schema diff passed |
| --revisions-only --fresh | Revision/idempotency database tests 9/9; complete existing subscription HTTP regression 10/10 |
| --orders-only | Real HTTP/MySQL order tests 14/14, including exact DTO/nested keys, countdown, ownership/hidden filtering, LIKE controls and read-only record comparisons |
| --models-only | Historical first-schema upgrade and existing model suites all passed: 10 + 11 + 20 = 41/41 |
| --models-only --fresh | All eleven migrations from empty and the same model suites: 41/41 |
| --revisions-only browser mode | Existing desktop/mobile Edge E2E 34/34 (17 each), one complete run in 7.9 minutes |
| npm run build | Frontend and backend passed; dependency-only Zod PURE annotation warnings remain non-blocking |
| Repository/data isolation | Original shopping files, HEAD and three layout edits unchanged; .env content never read or modified (metadata unchanged); no development DB connection, migration, Seed, permission/global-variable or original-volume operation |

Initial read-suite equality failed because remainingSeconds advanced naturally between HTTP requests; its replacement still asserts every static field exactly and bounds the countdown by measured request duration. The old trigger metadata assertion initially expected five Order triggers; it now checks all seven in execution order and the three revision triggers. Both complete affected suites were rerun successfully. No production behavior was loosened. The final ninth revision test additionally verifies rollback of an existing order's version and all appended records; it passed in the fresh-database run after the earlier historical run.

Seed-dependent default database suites were deliberately not invoked; the focused no-Seed suites above and complete existing browser regression are the actual validation performed. All random test containers/volumes were removed by their owning runner.

## Changed files

- `README.md`
- `backend/prisma/migrations/20261119000000_order_revision_foundation/migration.sql`
- `backend/prisma/schema.prisma`
- `backend/scripts/test-database.ts`
- `backend/src/modules/orders/dto.ts`
- `backend/src/modules/orders/revisions.ts`
- `backend/src/modules/orders/service.ts`
- `backend/src/modules/subscriptions/idempotency.ts`
- `backend/test/integration/database.test.ts`
- `backend/test/integration/order-models.test.ts`
- `backend/test/integration/order-revisions.test.ts`
- `backend/test/integration/order-source-upgrade.ts`
- `backend/test/integration/order-source.test.ts`
- `backend/test/integration/order-upgrade.ts`
- `backend/test/integration/orders.test.ts`
- `backend/test/integration/products-restart.test.ts`
- `backend/test/integration/renewal-integrity.test.ts`
- `backend/test/integration/revision-upgrade.ts`
- `backend/test/orders.test.ts`
- `docs/04-data-model.md`
- `docs/05-api-contract.md`
- `docs/07-development-roadmap.md`
- `docs/16-order-read-api.md`
- `docs/17-order-creation-and-lifecycle-design.md`
- `docs/18-order-revision-foundation.md`
