# Order creation API — implementation contract

- Document: ORDER-CREATE-API
- Version: 1.0
- Status: Merged in PR #11 (`b1f5d147ce8be27780740d187ebace63c29629cf`); T22.3A customer request upgrade implemented and awaiting review
- Date: 2026-11-19
- Related: [Order lifecycle decisions](17-order-creation-and-lifecycle-design.md), [Order read API](16-order-read-api.md), [Order revision foundation](18-order-revision-foundation.md)

This document converts the currently ACTIVE decisions into the first order-write API task. It does not authorize payment confirmation, order editing, cancellation, fulfillment, renewal, notifications, payment gateway integration, supplier integration, frontend order-center integration, or deployment.

## 1. Scope

Implement exactly two order creation endpoints, sharing one domain service:

| Method | Path | Principal | Result |
|---|---|---|---|
| POST | /api/v1/customer/orders | ACTIVE CUSTOMER | Create USER ordinary order |
| POST | /api/v1/admin/orders | ADMIN | Create ADMIN ordinary order for an existing CUSTOMER |

The existing GET paths keep their role and ownership checks. T22.3A applies the safe customer form projection to creation, list and detail.

Order source is server-derived:
- customer route -> USER, createdByUserId = authenticated customer, createdByAdminId = NULL
- admin route -> ADMIN, createdByAdminId = authenticated administrator, createdByUserId = NULL

Never accept source, creator IDs, order number, order ID, hidden, statuses, paidAt, paymentConfirmedAt, fulfilledAt, cancelledAt, version, or snapshot fields from clients.

## 2. Authentication and customer eligibility

### USER route

- Require a valid persisted Session and role CUSTOMER.
- The account must be ACTIVE at request authorization and must be rechecked inside the creation transaction while its User row is locked.
- Derive order.userId exclusively from the authenticated principal. Reject any userId field as unknown input.
- PENDING_ACTIVATION and DISABLED accounts cannot create orders. Return the existing safe account-state error contract; use 403 for PENDING_ACTIVATION and 403/401 according to the existing disabled-account authentication behavior. Do not reveal another account's existence.

### ADMIN route

- Require a valid persisted ADMIN Session.
- Require userId identifying an existing CUSTOMER whose status is ACTIVE or PENDING_ACTIVATION. Reject DISABLED, ADMIN, missing and non-customer targets; use consistent safe 404 for missing/non-customer and 409 for disabled.
- Do not create customers implicitly.
- This is the existing D1 rule; it is not replaced by D55, which governs customer self-order eligibility.

## 3. Product eligibility and snapshots

Read the Product inside the transaction and lock it for the duration of validation and order creation.

- USER: product must match the reviewed version, be listed and be unarchived.
- ADMIN: product may be listed or unlisted, but must not be archived.
- Both: reject missing/archived products.
- Both: only SUBSCRIPTION and ONE_TIME products can be ordered.
- SUBSCRIPTION: require valid non-NULL servicePeriodUnit DAY/MONTH/YEAR, positive integer servicePeriodCount, and valid renewalPriceFen. Historical NULL periods are not inferred from termLabel; reject new subscription order creation until explicitly configured.
- ONE_TIME: structured period and renewal price must be NULL according to the Product contract.
- Do not mutate Product.

Create the order from one validated Product record. Freeze the purchase terms using the D17/D16 field mapping: product identity, name/description/type, price, renewal price, descriptive term, structured period, form schema, and normalized form data. Do not copy catalog-only fields such as listed, sortOrder, archivedAt, or slug as purchase terms. Never re-read current Product to construct an existing order's response.

## 4. Request contracts

All requests use JSON, existing CSRF headers, no-store response policy, and a required Idempotency-Key header.

### 4.1 CUSTOMER

```json
{
  "productId": "uuid",
  "expectedProductUpdatedAt": "2026-11-21T10:00:00.123Z",
  "formData": {
    "stableFieldId": "customer-provided value"
  }
}
```

- expectedProductUpdatedAt is required and must match the UTC ISO-8601 millisecond timestamp returned by GET /customer/products/:slug.
- No userId, amountFen, price, source, creator, status, snapshot, or internalNote.
- Final amountFen is derived server-side from the locked Product.priceFen.
- The customer cannot override the price.

### 4.2 ADMIN

```json
{
  "userId": "customer-uuid",
  "productId": "product-uuid",
  "amountFen": 8000,
  "priceAdjustmentReason": "老客户优惠",
  "formData": {
    "stableFieldId": "customer-provided value"
  },
  "internalNote": "仅管理员可见，可选"
}
```

- userId and productId are required.
- amountFen is required, integer Fen, range 0..2147483647. The frontend initially pre-fills the currently loaded Product.priceFen, but the API never silently defaults a missing amountFen.
- priceAdjustmentReason is required and nonblank when amountFen differs from the locked Product.priceFen (including discount, markup, or zero-price adjustment). When amountFen equals priceFen, the reason may be omitted.
- internalNote is optional, nullable only if the established field contract permits it, and never exposed to CUSTOMER.
- ADMIN may target ACTIVE or PENDING_ACTIVATION CUSTOMER, not DISABLED.
- The selected Product may be unlisted but must not be archived.

Both request schemas are strict: reject unknown fields rather than silently stripping fields that could represent forged server-managed values.

## 5. Dynamic form validation

- Validate formData on the server against the locked Product.formSchema using the same canonical validation/normalization rules as the existing product form contract.
- USER and ADMIN must satisfy identical required-field, field-type, option, length and other schema rules (D8/D56).
- All required fields must be complete at creation. Never create a draft or incomplete order.
- Reject unknown field IDs and invalid values.
- Reject credential-like secrets prohibited by AGENTS.md and docs/06-security-and-operations.md: passwords, OTPs, 2FA/recovery codes, session cookies, access tokens, payment credentials and similar authentication secrets. Do not add secret collection as a generic form capability.
- Persist normalized formData and the exact formSchemaSnapshot used for validation.
- Subsequent customer edits are out of scope here; when implemented, they must validate against the frozen order formSchemaSnapshot, not today's Product.formSchema.

## 6. Initial order state

For amountFen > 0:
- paymentStatus = UNPAID
- fulfillmentStatus = NOT_STARTED
- paidAt, paymentConfirmedAt, fulfilledAt, cancelledAt = NULL

For amountFen = 0:
- paymentStatus = NOT_REQUIRED
- fulfillmentStatus = PROCESSING
- paidAt and paymentConfirmedAt = NULL
- Do not create PaymentTransaction.

Both cases:
- kind = INITIAL for SUBSCRIPTION, ONE_TIME for ONE_TIME Product.
- hidden = false.
- version = 1.
- source and creator fields follow the authenticated route.
- createdAt/updatedAt are database/server controlled.
- expiresAt is derived from createdAt + 24 hours; do not accept a client deadline.
- No Subscription is created during order creation. Subscription entitlement is created only in the future successful fulfillment transaction (D25/D28).

## 7. Atomic transaction and idempotency

Use the shared actor-scoped idempotency contract from D33-D36 and PR #9.

1. Authenticate the principal and validate the route's role. The USER principal must currently be ACTIVE; the ADMIN principal must be ADMIN.
2. Validate header syntax/length and strict request shape. Compute requestHash from the normalized client business intent, including operation and route-specific input. Include the CUSTOMER expectedProductUpdatedAt and the ADMIN amountFen, price adjustment reason and internalNote where applicable. Exclude requestId, headers other than Idempotency-Key, network metadata and current Product-derived values.
3. Enter the transaction and look up (actorUserId, keyHash). If found, compare requestHash: same -> return the stored original response; different -> 409 IDEMPOTENCY_CONFLICT. Do this before revalidating current Product state or repricing.
4. For a first request, lock/recheck the User row, then lock and read Product. Compare the CUSTOMER version at millisecond precision and verify eligibility, derive price and snapshots, and validate the form schema and data.
5. Create Order with version 1 and the complete frozen snapshots.
6. Build strict OrderRevision V1 from the persisted Order using the PR #9 whitelist; actorType USER or ADMIN and actorUserId is the real acting user. Do not invent SYSTEM actor for a human request.
7. Create ORDER_CREATED OrderEvent with the existing exclusive actor columns: USER uses actorUserId, ADMIN uses actorAdminId, with actorType and the other actor FK NULL. OrderRevision and IdempotencyRecord use generic actorUserId for both roles. Never forge an AdminAuditLog actor. For ADMIN only, create the corresponding sanitized AdminAuditLog in the same transaction. For USER, D54 requires OrderRevision + OrderEvent; do not write a customer into AdminAuditLog.
8. Build the role-specific full order resource DTO from the persisted order and store the original successful response in IdempotencyRecord.responseJson in the same transaction.
9. Commit only after all writes succeed. Any failure rolls back Order, Revision, Event, applicable Audit and IdempotencyRecord.

Concurrency:
- The unique (actorUserId,keyHash) database constraint is the final arbiter for simultaneous duplicate requests.
- If two requests race, the loser transaction must roll back all its business writes, then read the committed idempotency row outside the failed transaction and replay or return 409 based on requestHash.
- No process-local Map/lock as the correctness mechanism.
- Lock ordering must be consistent across all order creation paths to reduce deadlocks. Retry only recognized transient/deadlock failures with a bounded policy; do not retry validation, authorization or business conflicts.
- Do not weaken the database version/revision triggers or use REPLACE/IGNORE/upsert to bypass them.

The responseJson stores only the original sanitized role-specific API response; never store raw Idempotency-Key or log responseJson indiscriminately. Existing D35 permanent retention applies.

## 8. Response contract

- First successful creation: HTTP 201 with the complete role-specific order resource DTO, not merely an ID (D58).
- The DTO reuses the explicit CUSTOMER/ADMIN allowlists from the existing order read API, including frozen purchase fields, amount, statuses, timestamps, version, expiresAt and remainingSeconds. ADMIN additionally receives its permitted customer/creator/internalNote/cancellation fields; CUSTOMER never receives internalNote, creator/source, cancellationReason, audit or payment-private metadata.
- Never include raw idempotency key, requestHash, session data, password hashes, credentials or audit payloads.
- Same-key/same-request replay returns the exact stored original response and original success status; it does not create a second order.
- Since remainingSeconds is time-dependent, the replayed original response may contain the original countdown value. Clients needing a fresh countdown must call the existing order detail GET after replay; do not mutate the stored response or weaken D34 replay semantics.
- Set no-store and retain the established safe error envelope/requestId behavior.

## 9. Error mapping

Use the existing API error envelope and do not echo sensitive request values.

| Condition | HTTP | Expected semantic code |
|---|---:|---|
| Missing/invalid Session | 401 | UNAUTHENTICATED |
| Wrong route role | 403 | FORBIDDEN |
| USER account not ACTIVE | 403 | ACCOUNT_NOT_ELIGIBLE |
| ADMIN target absent/not CUSTOMER | 404 | CUSTOMER_NOT_FOUND |
| ADMIN target DISABLED | 409 | CUSTOMER_DISABLED |
| Product absent | 404 | PRODUCT_NOT_FOUND |
| CUSTOMER product version differs | 409 | PRODUCT_CHANGED |
| Product archived | 409 | PRODUCT_ARCHIVED |
| USER selects unlisted Product | 409 | PRODUCT_NOT_AVAILABLE |
| Invalid/missing subscription period | 409 | PRODUCT_PERIOD_UNCONFIGURED |
| Strict DTO/form validation failure | 400 | INVALID_INPUT |
| ADMIN amountFen missing/invalid | 400 | INVALID_INPUT |
| Price differs and adjustment reason missing | 400 | PRICE_ADJUSTMENT_REASON_REQUIRED |
| Missing/malformed Idempotency-Key | 400 | INVALID_IDEMPOTENCY_KEY |
| Same actor/key, different request | 409 | IDEMPOTENCY_CONFLICT |
| Optimistic/state conflict in a future concurrent mutation | 409 | CONFLICT |

Final error-code names should reuse an existing equivalent where one already exists; do not create duplicate codes for the same condition.

## 10. Explicit non-goals

This task does not implement:
- Order edit API (including customer formData edit or admin price edit).
- Order cancellation or 24-hour expiry worker.
- Payment transaction creation/verification/refund.
- Fulfillment or subscription entitlement creation.
- Renewal order creation/calendar arithmetic/renewal workers.
- Notifications, SMTP, payment gateways, supplier APIs or third-party login automation.
- Customer order center/admin order-management frontend integration.
- Public catalog purchase UI, public self-registration or email verification.
- Development database migration, Seed, reset, or production deployment.

## 11. Implementation sequence and acceptance

One implementation task and one PR:

1. Re-read AGENTS.md and README documentation reading order, then docs/15, 16, 17, 18 and this document.
2. Inspect current route/service/schema/DTO/event/audit/idempotency implementations before changing files. Preserve all user work and the three existing shopping layout edits.
3. Implement strict schemas, two POST routes, shared service and transaction helper integration.
4. Add real HTTP + isolated MySQL tests for both roles and every eligibility/validation/error branch.
5. Verify exact DTO allowlists, D1/D3/D5-D10/D33-D36/D40/D44/D51-D58 behavior, and full transaction rollback.
6. Verify duplicate requests sequentially and concurrently, same key/different payload conflict, separate actor namespaces, historical subscription idempotency regression, and response replay after Product changes.
7. Run format, typecheck, lint, unit tests, focused isolated database tests, relevant full regression suites and frontend/backend builds.
8. Update API contract, data model if needed, roadmap and implementation report with actual results.
9. Implementation was merged in PR #11. Do not apply the migration to the development database or proceed to order editing/payment/fulfillment without separate authorization.

Definition of done:
- Both POST routes work over real HTTP with Session/role enforcement.
- Customer and product eligibility are enforced inside the transaction.
- Every created order has one V1 revision and the correct event/audit records.
- The order and all side effects roll back together on injected failure.
- No duplicate order can be created by retries or concurrent duplicate requests using the same actor/key.
- Response DTOs exactly match the documented role allowlists.
- No out-of-scope write/payment/fulfillment/notification behavior is introduced.
- No development .env/database/volume or unrelated worktree changes.

## 12. Implementation report (2026-11-19)

### Implementation choices

- Two POST routes only. Separate strict request contracts in `create-schemas.ts`; one `orderCreationService` in `create.ts`. No frontend page or existing shop layout change.
- Idempotency-Key reuses the established ASCII syntax (1–128 letters/digits or `_.:-`); the existing shared mutation helper hashes raw keys and canonical route-specific intent. Stored responses remain permanent and actor-scoped. Neither live catalog terms nor network metadata enter requestHash.
- The existing serializable transaction helper handles recognized transient MySQL conflicts with at most three retries. After idempotency lookup, both paths lock target User then Product with parameterized `SELECT ... FOR UPDATE`, reread/validate them and commit all side effects together. A unique actor/key collision rolls back the losing transaction before persisted replay.
- Complete product validation rejects historical unknown subscription periods without interpreting termLabel. Form values use the existing eight-type strict validator without coercion or filling missing required values. Stored formSchemaSnapshot is the exact catalog schema, while formData is its validated result. No catalog metadata is copied as purchase terms.
- Explicit credential-field names/labels/hints and recognizable credential payload patterns are refused before persistence. This guard is intentionally not a general secret classifier: ordinary free-text account identifiers cannot prove arbitrary text is non-secret. Catalog authors/operators must still follow the approved non-sensitive form policy; authentication secrets are never an authorized input capability.
- New order numbers are nine random digits, from `100000000` through `999999999`. Earlier orders retain their original numbers, including the `O`-prefixed format. Order source, creator, version, hidden flag, amount rules, initial states and timestamps are trusted server values. Contact email prefers notificationEmail, otherwise loginEmail; legacy targetIdentifier staysNULL.
- Customer and administrator creation share the same allocator. It uses Node's cryptographic random integer generator and retries the insert up to five total attempts, only when MySQL reports a collision on `Order_orderNo_key`. Exhaustion rolls back with HTTP 503 `ORDER_NUMBER_UNAVAILABLE`. Other database errors propagate to the existing handlers. An idempotent replay returns the previously committed response, including its original order number, without allocating another one.
- V1 history uses the existing complete business whitelist. Revision.reason retains an explicit price-adjustment reason; sanitized events/audits retain state/price facts and that reason, excluding form contents and internalNote. The existing OrderEvent exclusive actor FKs are preserved (ADMIN -> actorAdminId; USER -> actorUserId). Revision/idempotency actors are generic actorUserId. Customer actions never write AdminAuditLog.
- Both create responses reuse the GET DTO functions. CUSTOMER excludes private notes, creator/customer expansion, cancellation reason and audits. ADMIN receives only its established additional fields. Exact replay includes the original countdown; a subsequent GET refreshes it.

### Migration and deployment boundary

Migration twelve is `20261119010000_order_creation`; all eleven committed migration files remain byte-for-byte unchanged. It appends NOT_REQUIRED to the payment ENUM, adds a same-row zero-payment CHECK, and extends the existing strict revision snapshot payment enum without changing its fields/version. It does not rewrite records, invent payments/revisions or reclassify historical zero-price UNPAID rows. Existing source/version/renewal/delete/revision guards remain intact. No new trigger or definer is introduced.

The two ALTER statements are separate MySQL DDL commits. Stop on failure; inspect migration state, payment ENUM and both CHECK definitions before any approved recovery. Migration twelve needs the existing ALTER prerequisites, but no new TRIGGER privilege. A fresh installation still requires the prior migrations' DBA/trigger prerequisites. Do not apply this development branch to an existing development/production database without separately authorized backup/preflight/maintenance. This implementation applies migrations only to random isolated test databases.

### Isolated test mechanism

`--creation-only` extends the existing MySQL8.4 runner with a random Compose project, loopback port, temporary credentials and its own disposable volume. It never loads development `.env` or invokes Seed. Its historical path applies exactly the eleven committed migrations, captures all thirteen business tables (including old zero/paid/refunded orders, revisions and idempotency responses), deploys migration twelve and compares every saved value. `--fresh` installs all twelve from empty. Both verify repeated deploy/status/schema diff. The final creation mode runs creation HTTP tests, revision database tests and subscription HTTP regression. Focused read/model modes provide independent regression; browser mode runs all existing desktop/mobile tests plus the new browser cookie/CSRF/proxy creation/replay scenarios. Cleanup targets only the runner's own random project.

### Verification results

All commands run in the independent `shopping-order-creation-api` worktree against temporary isolated configuration. No development database migration/Seed/reset was executed.

| Command / coverage | Actual result |
| --- | --- |
| `npm ci` | Passed with locked dependencies, Prisma7.10.1 Client generated, no dependency changes |
| `npm run db:generate`; `npm run db:validate` | Passed on the final Schema |
| `npm run format:check`; `npm run typecheck`; `npm run lint` | Passed; rerun after the subscription browser helper change |
| `npm test` | Backend30/30; frontend9/9 |
| `npm run test:db -w backend -- --creation-only` historical path | Complete follow-up run passed with exit code 0: Migration 12 upgrade, exact thirteen-table/revision retention, repeated deploy/status/schema diff; creation 15/15, revisions 9/9, existing subscription HTTP/idempotency 10/10. See the dated follow-up below |
| `npm run test:db -w backend -- --creation-only --fresh` final HTTP/database regression | Creation15/15; revisions9/9; existing subscription HTTP/idempotency10/10; all twelve migrations installed from empty, repeat deploy/status/schema diff passed |
| `npm run test:db -w backend -- --orders-only` | Existing read HTTP/MySQL14/14: ownership, hidden orders, exact DTOs, search/LIKE, countdown, read-only preservation |
| `npm run test:db -w backend -- --models-only --fresh` | Existing source/renewal/immutability suites10+11+20 =41/41; twelve migrations, thirteen business tables plus migration table |
| `npm run test:e2e -w backend -- --creation-only` final complete run | Passed38/38 across desktop/mobile Edge, including all four new creation/replay cases (7.5 minutes) |
| Focused product/subscription regression reruns | Each1/1 passed without changing assertions/timeouts; the corrected helper also passed the focused desktop subscription case before the final38/38 run |
| `npm run build` | Frontend and backend passed; only existing dependency Zod PURE-annotation warnings |
| Original-worktree preservation | All tracked/nonignored file hashes, HEAD and three layout changes unchanged; `.env` metadata unchanged and contents never read; existing ports3000/5173 still owned by PIDs1936/1720 |

Initial creation tests uncovered a mismatch with the existing exclusive OrderEvent actor FK CHECK, plus Express mount-path handling of the pending-account403 branch. The fix uses the established ADMIN/USER actor columns and narrowly identifies the customer creation route; both the fresh and the complete historical follow-up HTTP tests passed15/15. No database constraint, timeout, retry standard or authorization assertion was weakened. Historical migration verification initially passed before those service-only fixes; the follow-up now confirms the entire historical path with the corrected service. Migration SQL has not changed since. Existing default Seed-dependent database suites were deliberately not invoked; the no-Seed modes above are the actual executed database checks. All runner-owned test resources are removed by their runner.

### Historical upgrade follow-up (2026-11-19)

- Command: `npm run test:db -w backend -- --creation-only`, executed against PR #11 code commit `e4a4c07090d0cc678da41481a3009873ad192963` in the independent worktree. The complete command exited with code 0; no code, migration or test changes were needed.
- Random isolated MySQL 8.4 project: `membership-foundation-0db488057b5c`, with its own loopback port, temporary credentials and disposable volume. Development `.env` was not read, the development database was not connected, and no Seed entrypoint was invoked.
- Installed migrations 1–11, prepared synthetic historical rows, and captured all thirteen business tables including historical zero-price UNPAID, PAID and REFUNDED orders, immutable OrderRevision snapshots and IdempotencyRecord responses. Migration 12 preserved every captured business value and revision exactly, without reclassifying zero-price orders or fabricating payment facts.
- Repeated Prisma deploy had no pending migrations; migrate status and database-to-Prisma Schema diff passed.
- Real HTTP/MySQL creation suite 15/15, Revision database suite 9/9 and existing subscription HTTP/idempotency suite 10/10 all passed: 34 tests, zero failures, zero skipped/cancelled tests.
- The runner removed only this isolated project's container/volume and temporary configuration/snapshot files. Other test/build/E2E results in the table remain the earlier execution records; they were not rerun for this documentation-only follow-up.

### Remaining scope and manual setup

No order editing/cancellation/expiry task/payment confirmation/refund/fulfillment/entitlement/renewal/email/notification/provider API or order frontend integration is added. The future admin creation UI must explicitly submit amountFen, initially prefilled from the selected product; this API task does not add that UI. The original shopping checkout, three layout edits, configuration and running services are preserved. No development database, root `.env` content, original data volume, grants or global MySQL configuration is accessed/changed. PR #11 is merged. Do not automatically begin the next lifecycle stage; each subsequent lifecycle stage still requires separate authorization.

### Changed files

- `README.md`
- `backend/prisma/migrations/20261119010000_order_creation/migration.sql`
- `backend/prisma/schema.prisma`
- `backend/scripts/test-database.ts`
- `backend/src/http/routes.ts`
- `backend/src/modules/auth/service.ts`
- `backend/src/modules/orders/create-form.ts`
- `backend/src/modules/orders/create-schemas.ts`
- `backend/src/modules/orders/create.ts`
- `backend/src/modules/orders/revisions.ts`
- `backend/src/modules/orders/routes.ts`
- `backend/src/modules/orders/schemas.ts`
- `backend/test/integration/creation-upgrade.ts`
- `backend/test/integration/database.test.ts`
- `backend/test/integration/order-creation.test.ts`
- `backend/test/integration/orders.test.ts`
- `backend/test/order-creation.test.ts`
- `backend/test/orders.test.ts`
- `docs/04-data-model.md`
- `docs/05-api-contract.md`
- `docs/07-development-roadmap.md`
- `docs/17-order-creation-and-lifecycle-design.md`
- `docs/19-order-creation-api.md`
- `e2e/order-creation.spec.ts`
- `e2e/subscriptions.spec.ts`

The existing subscription browser selector now searches editable remote controls before choosing an exact option, preventing large cross-suite catalogs from requiring popup scrolling inside a mobile dialog. Read-only ordinary selects still use their existing keyboard/open and exact-option flow. All business assertions, timeouts and retries remain unchanged; no force click or fixed wait is introduced.

Browser observations: an earlier concurrent build temporarily replaced the preview dist/index.html and one navigation received404; its request preceded the rewritten index by1.6s, and the exact failed test passed alone. A later full run observed pointer interception when selecting from a long existing mobile subscription dropdown; the exact subscription test also passed alone. The first search-helper revision incorrectly tried to fill a read-only form select; an explicit editable-control check corrects that test error. The lifecycle regression now uses the selector's actual search API where available before exact selection, retaining every business assertion and original timeouts. This is test isolation/stability work, not a claimed fix for the pre-existing long-dropdown mobile pointer behavior; manual UI review of that separate case remains outside this API task. No production UI/CSS was modified.


## 13. T22.3A customer version guard and DTO safety

T22.3A implements the strict CUSTOMER request {productId,expectedProductUpdatedAt,formData}. Legacy two-field bodies receive 400 INVALID_INPUT. The ADMIN request retains its existing fields.

The value is the exact UTC ISO-8601 millisecond timestamp returned by the T22 ACTIVE-CUSTOMER-only GET /customer/products/:slug. The order service performs the existing actor-scoped idempotency lookup first, then locks and re-reads Product. It compares the submitted timestamp with the locked Product.updatedAt and rechecks listed/unarchived eligibility. A mismatch returns 409 PRODUCT_CHANGED before creating Order, OrderRevision, OrderEvent, or a successful idempotency response. The timestamp participates in the canonical request hash. An exact replay of a successfully committed request under this contract returns its original response before checking later Product changes, preserving D33-D35. Existing idempotency records retain their original hashes and stored responses.

The CUSTOMER creation, list and detail share the T22.2 form allowlist. The existing unsafe-schema and credential checks run against the complete frozen schema and values before projection. Order, Revision and ADMIN responses retain the original schema. No new database field or Migration is required. Storefront order submission, online payments and deployment are outside T22.3A. See the [T22.3A verification record](27-customer-storefront-and-order-placement.md#14-t223a-implementation-report).
