# Order edit API — implementation contract

- Document: ORDER-EDIT-API
- Version: 1.0
- Status: Approved design baseline; implementation not started
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

internalNote is expressly excluded. It remains a separate ADMIN-only concern under D48 and must not be accepted by either core edit DTO.

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
- If supplied amountFen equals the current amountFen, reason may be omitted. If a reason is supplied without a price change, reject it as an invalid/no-op combination or normalize it away consistently; choose one documented behavior and test it.
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

## 6. Price editing

- Only ADMIN can edit amountFen.
- priceSnapshotFen and all Product price/period snapshots remain immutable.
- A changed amountFen requires a reason, including discount, markup or changing to zero.
- Do not change paymentStatus as a side effect of setting amountFen to zero. D51/D37 zero-price initial-order semantics apply at order creation. An existing positive-price UNPAID order edited to amountFen=0 remains within the UNPAID pre-fulfillment model unless a separate approved decision explicitly defines conversion to NOT_REQUIRED. Do not infer or silently convert it to a zero-price gift order.
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
- Internal note edits (D48 separate).
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
- Form replacement validates against frozen formSchemaSnapshot.
- All eligibility/time/status checks are rechecked while holding the order lock.
- expectedVersion concurrency permits only one winner and leaves no side effects for stale loser.
- Every success produces exactly one version increment, complete immutable Revision, one Event, ADMIN-only audit and persisted idempotent response.
- Failure injection at each side-effect write proves full rollback.
- Sequential/concurrent idempotency and same-key/different-intent conflicts pass.
- Existing order creation, read, revision, subscription and browser regression suites pass.
- Run isolated fresh and historical database migration verification only as required by code changes; never use development .env, database, volume or Seed.
- Update API contract, data model if needed, roadmap and implementation report.
- Stop at a PR for review; do not merge or proceed to cancellation/payment/fulfillment without separate authorization.