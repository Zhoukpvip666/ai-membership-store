# Order creation API — implementation contract

- Document: ORDER-CREATE-API
- Version: 1.0
- Status: Approved design baseline; implementation not started
- Date: 2026-11-19
- Related: [Order lifecycle decisions](17-order-creation-and-lifecycle-design.md), [Order read API](16-order-read-api.md), [Order revision foundation](18-order-revision-foundation.md)

This document converts the currently ACTIVE decisions into the first order-write API task. It does not authorize payment confirmation, order editing, cancellation, fulfillment, renewal, notifications, payment gateway integration, supplier integration, frontend order-center integration, or deployment.

## 1. Scope

Implement exactly two order creation endpoints, sharing one domain service:

| Method | Path | Principal | Result |
|---|---|---|---|
| POST | /api/v1/customer/orders | ACTIVE CUSTOMER | Create USER ordinary order |
| POST | /api/v1/admin/orders | ADMIN | Create ADMIN ordinary order for an existing CUSTOMER |

Existing GET routes remain unchanged. No order mutation routes other than creation are added.

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

- USER: product must be listed and not archived.
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
  "formData": {
    "stableFieldId": "customer-provided value"
  }
}
```

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
2. Validate header syntax/length and strict request shape. Compute requestHash from the normalized client business intent, including operation and route-specific input. Include admin amountFen, price adjustment reason and internalNote where applicable. Exclude requestId, headers other than Idempotency-Key, network metadata and current Product-derived values.
3. Enter the transaction and look up (actorUserId, keyHash). If found, compare requestHash: same -> return the stored original response; different -> 409 IDEMPOTENCY_CONFLICT. Do this before revalidating current Product state or repricing.
4. For a first request, lock/recheck the User row (for USER and target customer), and lock/read the Product row. Verify status/eligibility, derive price and snapshots, validate the frozen form schema and data.
5. Create Order with version 1 and the complete frozen snapshots.
6. Build strict OrderRevision V1 from the persisted Order using the PR #9 whitelist; actorType USER or ADMIN and actorUserId is the real acting user. Do not invent SYSTEM actor for a human request.
7. Create ORDER_CREATED OrderEvent with actorUserId/actorType and no forged AdminAuditLog actor. For ADMIN only, create the corresponding sanitized AdminAuditLog in the same transaction. For USER, D54 requires OrderRevision + OrderEvent; do not write a customer into AdminAuditLog.
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
9. Stop at a PR for review. Do not apply the migration to the development database or proceed to order editing/payment/fulfillment without separate authorization.

Definition of done:
- Both POST routes work over real HTTP with Session/role enforcement.
- Customer and product eligibility are enforced inside the transaction.
- Every created order has one V1 revision and the correct event/audit records.
- The order and all side effects roll back together on injected failure.
- No duplicate order can be created by retries or concurrent duplicate requests using the same actor/key.
- Response DTOs exactly match the documented role allowlists.
- No out-of-scope write/payment/fulfillment/notification behavior is introduced.
- No development .env/database/volume or unrelated worktree changes.
