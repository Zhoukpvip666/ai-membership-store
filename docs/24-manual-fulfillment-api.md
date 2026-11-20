# Manual order fulfillment and initial subscription entitlement — implementation contract

- Document: MANUAL-FULFILLMENT-API
- Version: 1.0
- Status: Approved design baseline; implementation not started
- Date: 2026-11-19
- Related: [Order lifecycle decisions](17-order-creation-and-lifecycle-design.md), [Order revision foundation](18-order-revision-foundation.md), [Order creation](19-order-creation-api.md), [Order cancellation/timeout](21-order-cancellation-timeout.md), [Offline payment](22-offline-payment-api.md), [Offline refund](23-offline-refund-api.md), [Order/subscription foundation](15-order-subscription-foundation.md), [Subscription core compatibility](14-user-subscription-core.md)

T19 implements one ADMIN-only manual fulfillment action for ordinary first-purchase subscription orders and one-time orders. It does not implement renewal orders, system renewals, fulfillment failure state, refund operations, provider/supplier integration, automated fulfillment, customer subscription APIs/UI, notifications, or development database deployment.

## 1. Decision reconciliation

D83-D88 add operational details to D24-D32, D37, D40, D52, D59 and D64. No existing ACTIVE decision is superseded or revoked. D38 remains superseded by D39.

| Existing decision | T19 relationship | Resolution |
|---|---|---|
| D24 | ADMIN manually fulfills eligible paid orders | Retained; T19 adds the concrete ADMIN action and excludes system renewals |
| D25 | Order completion, subscription, events and audit are atomic | Implemented as one serializable transaction with complete rollback |
| D26 | First subscription starts at actual fulfillment | `startedAt = fulfilledAt`; all initial cycle start/anchor instants use the same DB UTC instant |
| D27 | ONE_TIME completes without subscription | Only Order completion, OrderRevision/Event and Order Audit; no Subscription/Event/Audit |
| D28-D29 | Each initial subscription order creates an independent ORDER subscription | Copy frozen order snapshots; never merge or extend an existing subscription |
| D30 | Renewal targets an explicit subscription | Renewal and SYSTEM_RENEWAL excluded from T19 |
| D31-D32 | Account identifiers live in formData; subscription inherits order form | Copy form snapshots; no dedicated account field and no reverse mutation of the order |
| D37/D52 | Zero-price orders use NOT_REQUIRED + PROCESSING and remain manually fulfillable | Explicit separate eligibility branch; no fake PAYMENT transaction or payment times |
| D40 | Every Order update increments version and appends full immutable revision | Exactly one Order.version increment and one complete Revision per fulfillment |
| D59 | First phase has no supplier API; cannot deliver means cancel/refund | T19 has no FAILED/partial fulfillment path; reuse T16 cancellation and T18 refund |
| D64 | Zero-price conversion is only before payment and enters NOT_REQUIRED/PROCESSING | T19 consumes that state as a valid fulfillment candidate without creating payment evidence |

## 2. Endpoint and authorization

| Method | Path | Principal |
|---|---|---|
| POST | /api/v1/admin/orders/:id/fulfill | Persisted ADMIN Session only |

Strict request body:

```json
{
  "expectedVersion": 3,
  "fulfillmentNote": "已完成第三方会员充值"
}
```

- expectedVersion: required positive integer.
- fulfillmentNote: optional, trimmed, maximum 500 characters; whitespace-only becomes NULL.
- Require Idempotency-Key, existing CSRF/rate-limit protections and Cache-Control no-store.
- Reject unknown fields and every client-supplied actor, source, order state, fulfilledAt, subscription ID, dates, period, timezone, version or payment field.
- Actor and administrator identity are derived only from the persisted Session.
- No CUSTOMER endpoint and no SYSTEM endpoint.

## 3. Eligible order predicate

Lock the Order row before reading/locking its PaymentTransaction rows. After the lock, re-read the full order and all related transactions and check expectedVersion.

Order must satisfy all common conditions:
- `hidden = false`.
- `source IN (USER, ADMIN)`.
- `kind IN (INITIAL, ONE_TIME)`; reject RENEWAL and all SYSTEM_RENEWAL.
- `fulfillmentStatus = PROCESSING`.
- `fulfilledAt IS NULL`, `cancelledAt IS NULL`, `cancellationReason IS NULL`.
- no existing Subscription with `sourceOrderId = order.id`.
- customer and Product foreign-key relations still exist; do not require customer to remain ACTIVE after purchase.
- no payment/refund transaction facts that contradict the appropriate payment branch.

Paid branch:
- `paymentStatus = PAID` and `amountFen > 0`.
- Exactly one PAYMENT row is CONFIRMED with non-NULL confirmedAt.
- That PAYMENT amountFen equals Order.amountFen.
- PAYMENT.occurredAt equals Order.paidAt; PAYMENT.confirmedAt equals Order.paymentConfirmedAt.
- No other PAYMENT rows are PENDING or CONFIRMED; failed historical attempts may remain.
- No REFUND row exists; no refund may be pending/confirmed/failed on a fulfillable order.

Zero-price branch:
- `paymentStatus = NOT_REQUIRED` and `amountFen = 0`.
- `paidAt IS NULL`, `paymentConfirmedAt IS NULL` and `paymentRecordedAt` is not used to infer payment.
- No PAYMENT or REFUND transaction of any status exists.

All other payment/fulfillment combinations are rejected with 409 ORDER_NOT_FULFILLABLE. Never infer eligibility from a frontend button or status label.

Product/order snapshot consistency:
- `kind=ONE_TIME` requires `productTypeSnapshot=ONE_TIME` and creates no subscription.
- `kind=INITIAL` requires `productTypeSnapshot=SUBSCRIPTION` plus non-NULL positive servicePeriodUnitSnapshot/servicePeriodCountSnapshot and non-NULL renewalPriceSnapshotFen in the supported integer range.
- Reject mismatched kind/product type, unknown legacy period snapshots, invalid period count or missing renewal price; do not consult current Product to repair or infer a missing historical snapshot.
- `INITIAL` with ONE_TIME snapshot and `ONE_TIME` with SUBSCRIPTION snapshot are invalid.

## 4. Database time and fulfillment timestamp

After acquiring the Order lock and all required related-row locks, obtain one `UTC_TIMESTAMP(3)` value from MySQL. This single `fulfilledAt` instant is used for Order.fulfilledAt, Subscription.startedAt, billingAnchorAt, currentPeriodStartAt and the order/subscription event timestamps where explicitly stored. Do not use the browser clock or Node process local clock.

Do not impose the original 24-hour payment deadline on fulfillment. D39 limits initial payment confirmation and timeout cancellation; a successfully PAID or NOT_REQUIRED order remains fulfillable until cancelled or otherwise made ineligible.

## 5. One-time fulfillment

For a valid ONE_TIME order, in one transaction:
1. Conditionally update Order to `fulfillmentStatus=COMPLETED`, set `fulfilledAt=DB UTC now`, increment version exactly once and update updatedAt.
2. Re-read persisted Order.
3. Append one complete OrderRevision V+1 with snapshotSchemaVersion=1, actorType=ADMIN, actorUserId=authenticated ADMIN ID, reason=fulfillmentNote (or NULL).
4. Append one OrderEvent with existing eventType=COMPLETED, actorType=ADMIN, actorAdminId=ADMIN ID, sanitized before/after state and note=fulfillmentNote.
5. Append exactly one AdminAuditLog: action=ORDER_FULFILLED, entityType=Order, entityId=order.id, sanitized before/after state, reason=fulfillmentNote and requestId.
6. Persist exact original `{order}` response in IdempotencyRecord.
7. Commit. Do not create Subscription, SubscriptionEvent or subscription audit.

## 6. Initial subscription fulfillment

For a valid `INITIAL + SUBSCRIPTION` order, use the order's frozen snapshots, not mutable current Product fields. In the same transaction:

1. Lock/read the AppSettings singleton row (id=1) after the Order and related PaymentTransaction locks. Read the current `timezone` setting and validate it using the repository's canonical IANA timezone validator/allowlist. Do not silently fall back to UTC or a process-local timezone if invalid; stop with a server configuration error and no writes.
2. Obtain the one DB UTC `fulfilledAt` instant after required locks and validation.
3. Compute `expiresAt` from the order's frozen servicePeriodUnitSnapshot/count and the frozen fulfillment-time timezone according to section 7.
4. Create exactly one Subscription with:
   - userId/productId from Order.
   - sourceType=ORDER; sourceOrderId=Order.id.
   - productNameSnapshot, productDescriptionSnapshot, productTypeSnapshot, priceSnapshotFen, termSnapshot from the matching Order snapshots.
   - servicePeriodUnitSnapshot/count from Order.
   - formSchemaSnapshot and formData deep-copied from Order frozen snapshots.
   - renewalPriceFen from Order.renewalPriceSnapshotFen.
   - startedAt=fulfilledAt; expiresAt=computed end.
   - billingAnchorAt=fulfilledAt; billingTimezone=canonical AppSettings.timezone; billingRevision=1.
   - currentPeriodStartAt=fulfilledAt; currentPeriodEndAt=expiresAt.
   - earlyRenewalUsed=false; earlyRenewedPeriodStartAt=NULL; earlyRenewalOrderId=NULL.
   - status=ACTIVE; version=1; createdByAdminId=authenticated ADMIN ID.
   - Do not populate the legacy targetIdentifier from guessed or separately inferred account fields; account data remains in formData.
5. Conditionally update Order to COMPLETED, set fulfilledAt to the exact same DB instant and increment Order.version exactly once.
6. Re-read persisted Order and Subscription.
7. Append one complete OrderRevision V+1 and one OrderEvent COMPLETED, actor ADMIN, with sanitized state and optional fulfillmentNote.
8. Append exactly one SubscriptionEvent with eventType=CREATED, orderId=Order.id, actorType=ADMIN, actorAdminId=ADMIN ID, newStartedAt=fulfilledAt, newExpiresAt=expiresAt, beforeJson=NULL and sanitized afterJson describing initial entitlement state. Never include raw formData, private note or credentials in event JSON.
9. Append two separate AdminAuditLog rows in the same transaction: `ORDER_FULFILLED` for entityType=Order/entityId=Order.id, and `SUBSCRIPTION_CREATED` for entityType=Subscription/entityId=Subscription.id. Both use the same actor/requestId and safe before/after state. If either audit insert fails, roll back both entities and all histories.
10. Persist exact original `{order, subscription}` role-safe ADMIN response in IdempotencyRecord and commit.

The unique Subscription.sourceOrderId constraint is the final exactly-once guard. Do not catch a unique violation and return a fake success; a genuine same-key retry must replay IdempotencyRecord, while a new key against an already completed order returns 409.

## 7. Structured service-period arithmetic

All calculations start from the same fulfilledAt instant and use the canonical IANA timezone read from AppSettings inside the fulfillment transaction. Persist all instants as UTC DateTime(3).

- DAY: `expiresAt = fulfilledAt + servicePeriodCount * 24 hours` as a fixed duration. Timezone is still frozen for later calendar/renewal behavior.
- MONTH: convert fulfilledAt to local calendar date/time in billingTimezone, add servicePeriodCount calendar months to the original local date while preserving the original day-of-month anchor and local wall-clock time; if the target month lacks that day, clamp only that target occurrence to its last day. Do not derive future anchors by adding to a previously clamped date.
- YEAR: same rule, adding calendar years; clamp leap-day/year-end to the last valid day of the target month while retaining the original anchor for later calculations.
- Preserve milliseconds and local wall-clock time where valid.
- DST gap: resolve a nonexistent local wall time to the first valid instant after the gap. DST fold: choose the earlier offset/first occurrence. Implement through a tested timezone-aware date-time library already present in the repository or a small isolated utility; do not use host local Date arithmetic.
- Require computed expiresAt > fulfilledAt. Reject invalid/unsupported timezone or arithmetic rather than creating an invalid subscription.

Examples for MONTH with original anchor day 31: Jan 31 → Feb 28/29 → Mar 31 → Apr 30 → May 31. The original anchor is retained; February's clamped date must not become the next month's anchor.

## 8. Atomicity, locking and idempotency

Use the existing serializable mutation/idempotency helper and one transaction for the complete operation.

Canonical idempotency intent includes operation, order ID, expectedVersion and normalized fulfillmentNote. Same actor/key/intent replays the exact original status/body after restart or after the order has completed. Same actor/key with different intent returns 409 IDEMPOTENCY_CONFLICT.

Lock order:
1. Check same-key idempotency replay using the existing helper.
2. Lock Order row (`FOR UPDATE`).
3. Lock all order PaymentTransaction rows in deterministic ID order, matching T16/T17/T18's Order-first convention.
4. For subscription orders, lock AppSettings singleton id=1 after the order/transaction locks.
5. Re-read all facts and check expectedVersion/eligibility.
6. Create Subscription if needed; update Order with conditional `WHERE id AND version AND eligibility`.

Concurrent fulfill requests with different keys: only one may commit. The loser receives 409 ORDER_NOT_FULFILLABLE/VERSION_CONFLICT with no duplicate subscription, event, audit or revision. Same-key retry returns the first exact response. No in-memory lock is a correctness mechanism.

Every write (Subscription, Order, Revision, OrderEvent, SubscriptionEvent, one/two AdminAuditLog rows, IdempotencyRecord) must roll back together on any failure, including unique constraint, trigger, revision, event, audit or idempotency insert failures.

## 9. Response and error contract

- Success HTTP 200 with `{order}` for ONE_TIME and `{order,subscription}` for INITIAL subscription.
- Use explicit ADMIN DTO allowlists. The subscription response may include its frozen product/period/form snapshots and dates, but must not expose auth/session data or raw audit internals.
- 401 unauthenticated; 403 wrong role; 404 missing/hidden/non-visible order; 400 malformed body, expectedVersion or Idempotency-Key; 409 stale version, order not eligible, already fulfilled/cancelled, invalid payment facts, invalid product snapshot, source/kind mismatch or sourceOrderId already consumed; 500/503 invalid AppSettings timezone or internal configuration error without partial writes.
- no-store on every response.

## 10. Explicit non-goals

- RENEWAL or SYSTEM_RENEWAL order processing.
- Subscription renewal, renewal order creation, calendar rollover worker or early renewal.
- Subscription expiry/termination worker.
- Subscription PATCH/formData/note maintenance APIs (existing Phase 2 compatibility APIs are not integrated into this task).
- Customer subscription list/detail/entitlement APIs.
- Supplier API, automated recharge, automatic fulfillment, external credentials or provider callbacks.
- Fulfillment FAILED state or a separate failure/retry endpoint.
- Cancellation/refund APIs (reuse merged T16/T18).
- Admin/customer order-management frontend, notifications/email or dashboard.
- Development database migration/deployment.

## 11. Acceptance

- POST `/api/v1/admin/orders/:id/fulfill` requires persisted ADMIN Session, CSRF, strict DTO, expectedVersion and Idempotency-Key.
- Only visible ordinary USER/ADMIN INITIAL subscription or ONE_TIME orders in exact PAID/PROCESSING or NOT_REQUIRED/PROCESSING states can be fulfilled.
- PAID branch verifies exactly one matching full confirmed PAYMENT and exact actual/confirmation timestamps; NOT_REQUIRED branch verifies zero amount, NULL payment times and no payment/refund rows.
- ONE_TIME completes without any Subscription row/event/audit.
- INITIAL creates exactly one sourceType=ORDER Subscription linked uniquely to sourceOrderId, copying all frozen order snapshots and no current Product substitution.
- Subscription start/anchor/currentPeriodStart share exact DB fulfilledAt; expiry is correctly computed from structured period and fulfillment-time canonical AppSettings timezone.
- DAY fixed-duration and MONTH/YEAR anchor/clamp/DST cases have deterministic unit and MySQL integration tests.
- Order becomes COMPLETED with fulfilledAt and exactly one version increment/revision/COMPLETED event.
- Subscription path writes one CREATED SubscriptionEvent and two separate AdminAuditLog rows; ONE_TIME path writes only Order Audit.
- Fault injection at every write stage proves full rollback, including when second Audit or IdempotencyRecord fails.
- Sequential and concurrent same-key/different-key requests prove exactly-once fulfillment; duplicate sourceOrderId cannot create a second Subscription.
- T16 cancellation and T18 refund cannot race a successful fulfillment into an invalid state; all writers lock Order first.
- Existing order creation/edit/cancel/payment/refund/read/revision and subscription compatibility regression suites pass.
- No migration expected. If current Schema/trigger prevents a required atomic write, stop and report the exact blocker; do not bypass immutable guards or add a migration without approval.
- Use random isolated MySQL/no Seed; never read development .env or touch development DB/volume/data volume.
- Update API contract, data model, roadmap and implementation report. Stop at one PR for review; do not merge or start renewal/customer entitlement UI without separate authorization.