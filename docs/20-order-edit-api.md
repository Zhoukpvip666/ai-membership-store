# Order edit API — implementation contract

- Document: ORDER-EDIT-API
- Version: 1.1
- Status: T15 merged in PR #14 (`5826593cbebcf9d8f4770dace10d85433813121f`); no development deployment
- Date: 2026-11-19
- Related: [Order lifecycle decisions](17-order-creation-and-lifecycle-design.md), [Order creation API](19-order-creation-api.md), [Order revision foundation](18-order-revision-foundation.md), [Order read API](16-order-read-api.md)

This document specifies the next order-write stage only: editing an existing ordinary order's allowed fields while it is eligible for editing. It does not authorize cancellation, timeout processing, payment confirmation/refund, fulfillment, renewal, notifications, frontend order-center integration, or development database deployment.

## 1. Scope and endpoints

Implement exactly:

| Method | Path | Principal | Editable fields |
|---|---|---|---|
| PATCH | /api/v1/customer/orders/:id | ACTIVE CUSTOMER | formData |
| PATCH | /api/v1/admin/orders/:id | ADMIN | formData, amountFen |

Use one shared domain service with separate strict role DTOs and authorization. Preserve existing GET and POST routes.

internalNote is expressly excluded from both core edit DTOs. It remains a separate ADMIN-only endpoint under D48. That separate endpoint must still require expectedVersion, increment Order.version, append a complete OrderRevision and OrderEvent, and atomically write AdminAuditLog plus idempotency response. It is outside this T15 implementation.

## 2. Authentication and ownership

### CUSTOMER
- Require a valid persisted Session, role CUSTOMER and ACTIVE account.
- Derive actor and ownership from Session only.
- Query order by both id and authenticated userId. Return the existing safe 404 response for missing or non-owned order; do not disclose whether another customer's order exists.
- CUSTOMER cannot submit amountFen, priceAdjustmentReason, userId, productId, source, creator IDs, statuses, dates, snapshot fields, internalNote or any unknown property.

### ADMIN
- Require a valid persisted ADMIN Session.
- May edit any visible ordinary USER/ADMIN order subject to the same editable-state/time conditions.
- Hidden/system renewal orders are not editable through these endpoints.
- ADMIN cannot change order userId, productId, source, creator, kind, hidden, payment facts, fulfillment state, cancellation fields, period, product snapshots or formSchemaSnapshot.

## 3. Editable-state predicate

The edit must be authorized and rechecked inside the transaction after locking the order row.

A core edit is permitted only when all are true:
- hidden = false
- paymentStatus = UNPAID
- fulfillmentStatus = NOT_STARTED
- cancelledAt IS NULL
- paidAt IS NULL
- paymentConfirmedAt IS NULL
- current server time is strictly before createdAt + 24 hours (D10/D14/D39)
- the order is an ordinary editable USER/ADMIN order, not SYSTEM_RENEWAL or another immutable kind/source.

Zero-price orders (NOT_REQUIRED + PROCESSING) are not editable through this API: they are already in the fulfillment queue under D37/D51/D52. Completed, cancelled, paid, expired, processing or otherwise ineligible orders return HTTP 409 without writes.

Do not extend or reset createdAt/expiresAt when editing. expiresAt remains derived from original createdAt + 24 hours.

## 4. Request contracts

Both requests require JSON, existing CSRF protections, no-store responses and a required Idempotency-Key. Both require a positive integer expectedVersion.

### 4.1 CUSTOMER

```json
{
  "expectedVersion": 1,
  "formData": {
    "stableFieldId": "updated customer value"
  }
}
```

- formData is required and is a complete replacement object, not a patch.
- expectedVersion is required.
- No amount or administrative fields.

### 4.2 ADMIN

```json
{
  "expectedVersion": 1,
  "formData": {
    "stableFieldId": "updated customer value"
  },
  "amountFen": 8000,
  "priceAdjustmentReason": "Approved customer discount"
}
```

- formData is required and is a complete replacement object.
- amountFen is optional. If omitted, current amount remains unchanged.
- If supplied, amountFen must be a nonnegative integer Fen in the existing supported DB/API range.
- If supplied amountFen differs from the current order amountFen, priceAdjustmentReason is required, nonblank and within the established 500-character limit.
- If supplied amountFen equals the current amountFen, reason may be omitted. A supplied reason without an actual price change (including omitted amountFen) is rejected with 400 INVALID_INPUT. This implementation chooses rejection, not normalization.
- ADMIN may submit formData and amountFen together. This is one atomic edit and creates exactly one new version.
- If neither effective formData nor amountFen changes, return a no-op validation error (400 INVALID_INPUT); do not increment version or create history.

Both DTOs are strict. Reject unknown/server-managed fields rather than silently stripping them.

## 5. Form validation and replacement semantics

- Load formSchemaSnapshot from the order, never from the current Product.
- Validate the complete submitted formData against the frozen schema using the same canonical eight-field-type validator and security restrictions as order creation.
- Reject missing required fields, unknown field IDs, invalid option/type/length/date values and credential-like secret fields/payloads under the existing non-sensitive form policy.
- No coercion, default filling, partial merge or implicit preservation of omitted fields.
- Store the validated canonical formData as the new complete value.
- Product edits after order creation must not affect edit validation.
- A legacy NULL formSchemaSnapshot cannot establish valid input: return 400 INVALID_INPUT without reading the current Product or guessing a schema.

## 6. Price editing

- Only ADMIN can edit amountFen.
- priceSnapshotFen and all Product price/period snapshots remain immutable.
- A changed amountFen requires a reason, including discount, markup or changing to zero.
- If ADMIN changes an eligible UNPAID + NOT_STARTED order amountFen from a positive value to 0, the same atomic edit must transition it to NOT_REQUIRED + PROCESSING under D37/D51 and D64. Keep paidAt/paymentConfirmedAt NULL and create no PaymentTransaction. This is one version increment and one revision/event/audit/idempotency transaction. The order then leaves the editable state and enters manual fulfillment. If any payment fact/PaymentTransaction already exists, reject the conversion and require cancellation/refund under D17/D18/D59.
- CUSTOMER never sees priceAdjustmentReason or admin audit details unless the existing safe DTO contract explicitly allows a non-sensitive customer-visible field (default: do not expose).

## 7. Atomic transaction, revision and concurrency

Use the existing serializable transaction and idempotency helper.

1. Authenticate role and validate strict request/header syntax.
2. Canonicalize intent for idempotency, including operation, order ID, expectedVersion and all submitted editable values. A retry with identical actor/key/intent must replay the first successful response. Same actor/key with different intent returns 409 IDEMPOTENCY_CONFLICT.
3. Inside the transaction, check idempotency before evaluating current order state so successful retries still replay after the order has since changed.
4. Lock the order row; CUSTOMER lookup must include owner ID. Recheck editable-state predicate and expiry using server time.
5. Compare expectedVersion with current version. A mismatch returns 409 VERSION_CONFLICT and performs no writes.
6. Validate formData against frozen formSchemaSnapshot. For ADMIN, validate optional amount and reason against current amount.
7. Apply all effective field changes in one conditional/optimistic update: version = version + 1, updating formData and optional amountFen. The database version trigger remains authoritative; no bypass, REPLACE, IGNORE or blind upsert.
8. Build complete OrderRevision for the new version from the persisted updated Order. actorUserId is the authenticated user for both USER and ADMIN; actorType is USER or ADMIN. Preserve price reason where applicable.
9. Create one OrderEvent for the edit with the correct exclusive actor FK columns (USER -> actorUserId, ADMIN -> actorAdminId). Never write CUSTOMER identity into AdminAuditLog. For ADMIN only, create a sanitized AdminAuditLog in the same transaction. Audit/event payloads must not include raw sensitive form values.
10. Build the role-specific complete order DTO and persist the original response in IdempotencyRecord in the same transaction.
11. Commit all writes together. Any failure rolls back Order update, version, Revision, Event, applicable Audit and IdempotencyRecord.

Concurrent edits with the same expectedVersion: only one succeeds. The other returns 409 with no revision/event/audit/idempotency success record. Do not automatically retry a stale-version business edit; the client must GET current order and let the user decide whether to reapply.

Implementation uses parameterized SQL FOR UPDATE and an optimistic UPDATE that rechecks UTC_TIMESTAMP(3) against original createdAt. This prevents both lock waits and validation time from extending the deadline. Existing confirmed transaction facts block core editing even if a legacy order incorrectly still says UNPAID; any PaymentTransaction blocks zero conversion. Deprecated paymentRecordedAt is not inferred to mean actual paidAt. The existing NOTE event enum stores an ORDER_EDITED operation marker with version/amount/status before and after; full form values remain in the protected revision, not event/audit payloads. No internalNote update or migration is introduced.

## 8. Response contract

- Successful edit: HTTP 200 with the complete role-safe order resource DTO in the same {order} envelope as create/read (D58 response shape applies; status is 200 for PATCH).
- Return the new version and updated formData/amountFen plus unchanged frozen product/schema fields and original expiresAt.
- CUSTOMER response must never expose internalNote, creator/admin metadata, cancellation reason, adjustment reason, audit payloads or secrets.
- ADMIN response uses existing admin DTO allowlist.
- Same-key retry returns the exact originally stored successful response; GET detail may be used for a fresh remainingSeconds.
- All responses remain no-store.

## 9. Errors

Reuse existing error envelope and codes where possible:

| Condition | HTTP | Semantic code |
|---|---:|---|
| Missing/invalid Session | 401 | UNAUTHENTICATED |
| Wrong role | 403 | FORBIDDEN |
| Customer order missing/not owned | 404 | NOT_FOUND |
| Order not editable/expired/paid/processing/cancelled/hidden | 409 | ORDER_NOT_EDITABLE |
| expectedVersion missing/invalid | 400 | INVALID_INPUT |
| expectedVersion stale | 409 | VERSION_CONFLICT |
| Invalid complete formData | 400 | INVALID_INPUT |
| ADMIN amount invalid | 400 | INVALID_INPUT |
| Amount changed without reason | 400 | PRICE_ADJUSTMENT_REASON_REQUIRED |
| Missing/malformed Idempotency-Key | 400 | INVALID_IDEMPOTENCY_KEY |
| Same actor/key, different intent | 409 | IDEMPOTENCY_CONFLICT |
| No effective change | 400 | INVALID_INPUT |

Do not leak order existence across customer ownership boundaries.

## 10. Explicit non-goals

This task does not implement:
- Internal note edits (D48 separate; must still increment version and append revision/event/audit).
- Order cancellation or 24-hour expiry worker.
- Payment confirmation, PaymentTransaction or refunds.
- Fulfillment, supplier APIs or subscription entitlement.
- Renewal.
- Notifications/email.
- Frontend order edit pages or UI integration.
- Development database migration/deployment.

## 11. Acceptance

- Both role-specific PATCH routes work over real HTTP with persisted Session and strict DTOs.
- CUSTOMER ownership is enforced without order-existence leakage.
- Admin may edit formData and amountFen together in one version; customer can edit only formData.
- An eligible unpaid order changed to amountFen=0 transitions atomically to NOT_REQUIRED + PROCESSING under D64; orders with existing payment facts cannot be converted.
- Form replacement validates against frozen formSchemaSnapshot.
- All eligibility/time/status checks are rechecked while holding the order lock.
- expectedVersion concurrency permits only one winner and leaves no side effects for stale loser.
- Every success produces exactly one version increment, complete immutable Revision, one Event, ADMIN-only audit and persisted idempotent response.
- Failure injection at each side-effect write proves full rollback.
- Sequential/concurrent idempotency and same-key/different-intent conflicts pass.
- Existing order creation, read, revision, subscription and browser regression suites pass.
- Run isolated fresh and historical database migration verification only as required by code changes; never use development .env, database, volume or Seed.
- Update API contract, data model if needed, roadmap and implementation report.
- T15 merged in PR #14. Do not proceed to cancellation/payment/fulfillment without separate authorization.

## 12. T15 implementation report (2026-11-19)

### Files and architecture

- `backend/src/modules/orders/edit-schemas.ts`: strict role-specific request DTOs; required full formData and positive bounded expectedVersion; optional ADMIN integer Fen/reason.
- `backend/src/modules/orders/edit.ts`: shared edit transaction, owner-scoped lock, frozen-form validation, database-time eligibility, conditional versioned UPDATE, zero transition, immutable Revision, sanitized Event/Audit and persisted original-response idempotency.
- `backend/src/modules/orders/routes.ts`: only the two PATCH routes, using existing Session/role/CSRF guards and shared key validation. Existing POST/GET behavior remains intact.
- `backend/test/order-edit.test.ts`: four strict DTO unit tests.
- `backend/test/integration/order-edit.test.ts`: nineteen real HTTP/MySQL tests, including all eight frozen form types, ownership/roles, state/deadline failures, exact role DTOs, price/no-op rules, zero conversion, concurrency/replay and all-write failure injection.
- `backend/test/integration/orders.test.ts`: retain read-only GET assertions and unsupported DELETE/fulfillment assertions; remove the obsolete assertion that PATCH is unavailable.
- `backend/scripts/test-database.ts`: no-Seed `--edit-only` mode. Read assertions use a separate random isolated database, then the editing/creation/Revision/subscription suites run against another. Protected history is never deleted to make test counts pass.
- `e2e/order-edit.spec.ts`: ADMIN and CUSTOMER browser fetches through the real proxy, HttpOnly persisted Session cookies and CSRF headers on desktop and mobile. Covers full replacement after catalog changes, stale version, original-response replay, untouched V1 and no payment/subscription side effects. No order-management UI is added.
- `e2e/products.spec.ts`: the existing listing/archive test explicitly reapplies its product-name filter after navigation/reload. New retained fixtures can exceed the first 20-item page; assertions and timeout remain unchanged.
- `README.md`, `docs/04-data-model.md`, `docs/05-api-contract.md`, `docs/07-development-roadmap.md`, `docs/17-order-creation-and-lifecycle-design.md` and this report: current API/model boundaries and verification instructions.

### Validation procedure

All database tests use the existing runner's random MySQL 8.4 Compose project, disposable test-only volume, random credentials/loopback ports and fictional records. No development .env is read and no Seed command is invoked. The historical mode applies migrations one through eleven in the isolated fixture, captures every business table and immutable revision, applies twelve, compares all retained rows, repeats deployment and verifies schema diff. The browser mode verifies all twelve migrations on a separate fresh database and runs the full desktop/mobile regression suite. No migration or Prisma Schema file changes are part of T15.

Commands executed in this worktree:

```powershell
npm ci
npm run db:validate
npm run db:generate
npm run typecheck
npm run lint
npm test
npm run format:check
npm run build
npm run test:db -w backend -- --edit-only
npm run test:e2e -w backend -- --edit-only
npm run test:e2e -w backend -- --edit-only --project=mobile-edge --grep "unlisted products remain manageable"
```

Static checks, builds and unit tests passed (backend 34/34; frontend 9/9). The final isolated HTTP/database run passed 67/67: editing 19, creation 15, Revision 9, reading 14, subscriptions 10. Historical upgrade, exact retained-row comparisons, repeat deployment and schema diff passed. The final complete browser rerun passed 42/42 on desktop/mobile Edge (7.1 minutes), including all four new order-edit cases. Vite reports existing dependency annotation warnings from Zod; build succeeds without dependency changes.

During verification, the initial type check found a test snapshot return-type annotation, which was corrected. The first combined database run exposed pristine read-suite count assertions being contaminated by earlier append-only fixtures (102 versus 17 visible orders). The runner now uses separate random databases for that suite; none of its assertions were weakened. The rerun of read regression passed 14/14. Initial formatting detected Windows checkout CRLF endings; only this isolated worktree was normalized to repository LF content, with no unrelated content included in the diff. The complete format check then passed.

The first full browser run passed 41/42, including all four new edit checks. Its existing mobile product archive test timed out after navigation cleared the search: the target was beyond page one among 23 retained products. The unchanged test passed by itself in a fresh isolated database (1/1), confirming the data-size dependency. Reapplying the exact name filter after each navigation/reload removes that assumption without changing product APIs, frontend behavior, assertions or timeout. After this correction, the entire 42-test suite passed, including both desktop and mobile listing/archive checks. Format, typecheck and Lint were rerun after the test-only correction and passed. Builds and unit/database tests above were executed in this task; no production code changed after those runs.

### Scope and deployment limits

The original shopping checkout stays on its existing main commit with its three layout changes and existing services preserved. The new worktree is based on the latest fetched origin/main; the original checkout was not advanced or overwritten. No development database inspection/write, migration, Seed, permission/global-variable change, .env read/write or original-volume operation occurs. Existing twelve migration files, Prisma Schema, dependency versions and frontend application source remain unchanged.

The internal-note endpoint, cancellation/expiry worker, payments/refunds, fulfillment/subscription entitlement, renewals, notifications and frontend order editing remain separately authorized future work. In particular, T15 does not claim to implement any of those APIs merely because its zero transition enters PROCESSING.


## T20 D48 internal-note endpoint — approved design, not implemented

The T15 core edit endpoints continue to reject `internalNote`; this field is not part of formData or price editing. T20 adds the separate ADMIN-only `PATCH /api/v1/admin/orders/:id/internal-note` defined in [docs/25-admin-order-center.md](25-admin-order-center.md). It requires expectedVersion and Idempotency-Key, accepts a trimmed nullable string up to 2000 characters, and may update visible USER/ADMIN orders even after payment, completion or cancellation. It increments Order.version once and atomically appends a full Revision, existing NOTE Event, AdminAuditLog and original idempotency response. SYSTEM_RENEWAL remains immutable; CUSTOMER never receives or edits internalNote. This is a T20 addition, not part of the historical T15 implementation.
