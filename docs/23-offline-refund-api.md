# Offline refund attempts and confirmation — implementation contract

- Document: OFFLINE-REFUND-API
- Version: 1.0
- Status: Approved design baseline; implementation not started
- Date: 2026-11-19
- Related: [Order lifecycle decisions](17-order-creation-and-lifecycle-design.md), [Offline payment API](22-offline-payment-api.md), [Order cancellation/timeout](21-order-cancellation-timeout.md), [Order revision foundation](18-order-revision-foundation.md)

T18 implements ADMIN-only manual offline refund-attempt listing, registration, confirmation and failure. The application records an external refund transfer; it never sends money or calls a payment provider. A PENDING REFUND is an attempt record after the external refund has actually been initiated, not proof that the customer has received the money. Only confirmation after external completion changes the order to REFUNDED (D76 clarifies D59).

## 1. Decision reconciliation

No existing ACTIVE decision is superseded or revoked. D76-D82 add operational detail to D18/D59/D67 and reuse T17/D70-D75 transaction/history infrastructure.

| Existing decision | T18 relationship | Resolution |
|---|---|---|
| D18 | Cancellation is not refund completion | Keep the original PAYMENT and wait in REFUND_PENDING until separate refund confirmation |
| D59 | Default full offline refund; never claim success before actual return | D76 distinguishes a PENDING attempt (external refund initiated, not yet confirmed) from the completed refund fact (CONFIRMED + Order REFUNDED) |
| D67 | Only ADMIN cancels a paid, not-yet-fulfilled order and sets REFUND_PENDING | T18 operates only after that cancellation: fulfillmentStatus=CANCELLED and paymentStatus=REFUND_PENDING |
| D70-D75 | Existing PaymentTransaction, ADMIN-only operations, Order-first locks, versioned history and idempotency | Reuse the model and atomic mutation pattern; filter strictly by kind=REFUND and preserve PAYMENT rows |
| D22 | Payment channel and external reference/note fields | Refund channel must exactly match the original confirmed PAYMENT channel; reference/note remain optional |
| D39/D69 | 24-hour limit applies to unpaid order payment confirmation and timeout cancellation | Refund handling has no 24-hour expiry; an already-paid cancelled order remains REFUND_PENDING until resolved |
| D53/D68 | Zero-price cancellation creates no refund | NOT_REQUIRED orders are never eligible for T18 |

D76 clarifies the phrase in D59 about registering a refund transaction: a `REFUND/PENDING` row records only an externally initiated refund attempt. It does not represent a completed refund, is not counted as returned money, and must not set Order.paymentStatus=REFUNDED. The completed refund fact is recorded only when the attempt becomes CONFIRMED after the administrator verifies that money was actually returned.

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | /api/v1/admin/orders/:id/refunds | Paginated REFUND-attempt history for one order |
| POST | /api/v1/admin/orders/:id/refunds | Register an externally initiated full-refund attempt as PENDING |
| POST | /api/v1/admin/payment-transactions/:id/confirm-refund | Confirm that the full refund was actually completed externally |
| POST | /api/v1/admin/payment-transactions/:id/fail-refund | Mark a PENDING refund attempt FAILED with required reason |

All routes require a persisted ADMIN Session and existing CSRF/rate-limit/no-store protections. No customer or SYSTEM refund endpoint exists. Mutation routes require positive expectedVersion and Idempotency-Key. Actor identity comes only from Session. Reject client-supplied actor IDs, order status, transaction kind/status, confirmation fields, version, createdAt, or unknown fields.

## 3. Refund history listing

- ADMIN only. Query REFUND rows only; do not mix PAYMENT rows into this endpoint.
- The order must be a visible ordinary USER/ADMIN order; missing/hidden/system renewal returns the established safe 404.
- Pagination: page default 1, pageSize default 20, maximum 100; sort createdAt DESC then id ASC.
- Return an explicit admin-safe allowlist: id, orderId, kind, channel, amountFen, status, externalReference, occurredAt, confirmedAt, createdByAdminId, confirmedByAdminId, note, createdAt, updatedAt.
- Response `{items,total,page,pageSize}`.
- Read-only: no Order.version increment, Revision, Event, Audit or IdempotencyRecord.

## 4. Registration request and eligibility

POST `/api/v1/admin/orders/:id/refunds` accepts:

```json
{
  "expectedVersion": 5,
  "amountFen": 10000,
  "channel": "WECHAT",
  "occurredAt": "2026-11-19T14:20:00.000Z",
  "externalReference": "optional-refund-reference",
  "note": "optional operator note"
}
```

- amountFen: positive integer Fen; must equal both Order.amountFen and the unique confirmed PAYMENT.amountFen.
- channel: must equal the original confirmed PAYMENT.channel exactly. Do not permit choosing another channel.
- occurredAt: required UTC ISO-8601 timestamp with milliseconds; records when the external refund transfer was actually initiated/sent, not when it was entered into the application and not the later confirmation time.
- externalReference: optional trimmed string, maximum 120 characters.
- note: optional trimmed string, maximum 500 characters.
- expectedVersion: required positive integer matching the locked Order.version.

Before registration, the ADMIN must have actually initiated the offline full refund externally. Do not create a PENDING attempt merely because a refund is planned or approved but not yet sent. PENDING means the external transfer has been initiated and is awaiting verification of completion/receipt.

After locking the Order row, registration is permitted only when all conditions hold:
- Order is visible, ordinary USER/ADMIN source and INITIAL/ONE_TIME kind.
- paymentStatus=REFUND_PENDING and fulfillmentStatus=CANCELLED.
- cancelledAt is non-NULL; paidAt and paymentConfirmedAt are non-NULL.
- Exactly one PAYMENT transaction is CONFIRMED, with confirmedAt non-NULL, amountFen equal to Order.amountFen, channel as the refund channel, occurredAt equal to Order.paidAt and confirmedAt equal to Order.paymentConfirmedAt.
- No REFUND transaction is CONFIRMED and no refund attempt has confirmedAt set.
- No REFUND transaction is currently PENDING.
- There is no zero-price/NOT_REQUIRED order and no completed/fulfilled order.
- amountFen equals the original confirmed payment in full; no partial refund or overpayment allocation.
- refund occurredAt is not before the original PAYMENT.occurredAt and is not later than database UTC now.

There is no 24-hour restriction for refunds. The 24-hour D39 deadline governs initial unpaid order payment, not returning money for an already confirmed and cancelled order.

On success create PaymentTransaction with kind=REFUND, status=PENDING, amount/channel/occurredAt/reference/note from validated input, createdByAdminId from Session, confirmedAt=NULL and confirmedByAdminId=NULL. Keep Order.paymentStatus=REFUND_PENDING and fulfillmentStatus=CANCELLED. Registration does not mean money has been returned and does not set REFUNDED.

## 5. Refund confirmation

POST `/api/v1/admin/payment-transactions/:id/confirm-refund` accepts `{expectedVersion}` only.

ADMIN may confirm only after checking the external account/receipt and verifying that the entire refund has actually been returned to the customer. A transfer initiation screenshot or an outgoing instruction alone is not proof of completed return.

Lock order must match T16/T17: first identify the parent order using a non-locking locator, then lock Order, then lock that order's PAYMENT/REFUND transaction rows in deterministic ID order, re-read the target under locks and verify membership. Never lock PaymentTransaction first and then Order.

After locks, recheck all registration eligibility plus:
- Target is kind=REFUND, status=PENDING, confirmedAt=NULL.
- Target amount/channel exactly match the original unique confirmed full PAYMENT and Order.amountFen.
- Order remains REFUND_PENDING + CANCELLED.
- No other REFUND is CONFIRMED; there is at most one PENDING by D79.
- occurredAt is <= database UTC now.

On success in one transaction:
1. Update target REFUND status=CONFIRMED, confirmedAt=database UTC now and confirmedByAdminId=Session ADMIN.
2. Update Order.paymentStatus from REFUND_PENDING to REFUNDED.
3. Keep fulfillmentStatus=CANCELLED and preserve cancelledAt, cancellationReason, paidAt, paymentConfirmedAt, fulfilledAt (normally NULL under D67), and the original confirmed PAYMENT row exactly as they were.
4. Do not create a Subscription, restore the order, alter the original PAYMENT, or create any additional refund row.

## 6. Refund failure and retry

POST `/api/v1/admin/payment-transactions/:id/fail-refund` accepts `{expectedVersion,reason}`. reason is required, trimmed, nonblank and at most 500 characters.

Lock Order first, then relevant transaction rows. Target must be a PENDING REFUND with confirmedAt=NULL, and the order must remain eligible under D77. A CONFIRMED or already FAILED refund cannot be failed again.

Update only target status=FAILED and updatedAt. Preserve amountFen, channel, externalReference, occurredAt, createdByAdminId, createdAt and original note. Put failure reason in OrderRevision.reason, OrderEvent.note/sanitized state and AdminAuditLog.reason; never overwrite original transaction note/evidence.

Order remains paymentStatus=REFUND_PENDING and fulfillmentStatus=CANCELLED. Once the failed attempt is committed, a later new full-refund attempt may be registered under D79. Do not change the original payment or cancellation history.

## 7. Multiple refund attempts

- One order may have historical FAILED refund attempts.
- At most one REFUND/PENDING may exist at a time.
- While one PENDING exists, reject a second registration.
- A PENDING attempt must be explicitly confirmed or failed; never auto-fail it or silently replace it.
- After FAILED and with no other PENDING/CONFIRMED REFUND, ADMIN may register a new attempt with a new PaymentTransaction ID and a new idempotency key.
- At most one full REFUND may become CONFIRMED for the order. After confirmation, reject all further refund registration/confirmation/failure attempts.
- No split refunds, partial refunds, or multiple confirmed refunds whose sum reaches the full amount.

## 8. Version, revision, event, audit and idempotency

Every successful mutation (refund registration, confirmation or failure) must, in one serializable transaction:
1. Check IdempotencyRecord replay before current state checks.
2. Lock Order first, then related PaymentTransaction rows in deterministic ID order.
3. Re-read the order and transactions under lock; check expectedVersion and all D77 eligibility predicates.
4. Apply the PaymentTransaction mutation and Order payment summary update (registration keeps REFUND_PENDING; failure keeps REFUND_PENDING; confirmation changes it to REFUNDED).
5. Increment Order.version exactly once using the existing protected version mechanism/conditional update.
6. Append exactly one complete OrderRevision from the persisted updated Order, snapshotSchemaVersion=1, actorType=ADMIN, actorUserId=authenticated admin ID. Failure reason is stored in Revision.reason.
7. Append exactly one OrderEvent: REFUND_RECORDED, REFUND_CONFIRMED, or existing NOTE with safe `operation=REFUND_FAILED` marker. State JSON includes order ID, transaction ID, amount, channel, transaction status, paymentStatus, fulfillmentStatus and version; no raw external reference, private note, customer formData or credentials.
8. Append exactly one sanitized AdminAuditLog with action REFUND_RECORDED / REFUND_CONFIRMED / REFUND_FAILED, entityType=PaymentTransaction, entityId=refund transaction ID, requestId, before/after state and reason where applicable.
9. Persist the exact original role-safe `{order,paymentTransaction}` response in IdempotencyRecord scoped to actorUserId + keyHash.
10. Commit. Any failure rolls back transaction row, order state/version, Revision, Event, Audit and idempotency response.

Every POST requires expectedVersion and Idempotency-Key. Same actor/key/canonical intent replays the exact original response; same key with different route/order/transaction/payload returns 409 IDEMPOTENCY_CONFLICT. Repeating with a new key after a successful state transition is rejected without another version/event. Failed refund attempts can be retried only by creating a new attempt after the FAILED transition committed.

## 9. Locking and concurrency

- All refund mutation paths use Order -> PaymentTransaction lock order, consistent with T16 cancellation and T17 payment operations.
- Refund registration, confirm and fail on the same order serialize through the Order row.
- Concurrent refund registrations: only one may create PENDING; the other receives 409 and writes nothing.
- Concurrent confirm/fail on one refund: only one may transition PENDING; the loser sees the terminal state and writes nothing.
- Refund confirmation and any unexpected order state mutation must serialize; only REFUND_PENDING + CANCELLED can become REFUNDED.
- No process-local lock is a correctness mechanism; enforce with MySQL row locks and conditional updates.

## 10. Responses and errors

- GET list returns `{items,total,page,pageSize}`.
- POST registration returns HTTP 201 `{order,paymentTransaction}`.
- POST confirm/fail returns HTTP 200 `{order,paymentTransaction}`.
- All responses are no-store and use the existing ADMIN DTO allowlist.
- 401 unauthenticated; 403 wrong role; 404 missing/not-visible order or transaction; 400 invalid amount/channel/time/reason/body/key; 409 stale version, order not REFUND_PENDING, not cancelled, original payment mismatch, refund channel/amount mismatch, existing PENDING/CONFIRMED refund, transaction not PENDING, or idempotency conflict.
- Never disclose other customers' order details or payment evidence.

## 11. Explicit non-goals

- Partial or split refunds.
- Refunds for orders whose fulfillment is COMPLETED.
- Automatic/original-channel API refunds, payment provider SDKs, webhooks or money movement.
- Customer refund requests or customer visibility into admin payment evidence.
- Fulfillment, subscription entitlement, renewal or supplier APIs.
- Refund frontend UI, notifications/email or dashboard changes.
- Development database migration/deployment.

## 12. Acceptance

- Four ADMIN endpoints work over real HTTP with persisted Session, CSRF, strict DTOs and no-store responses.
- Refund registration only accepts cancelled REFUND_PENDING ordinary orders with exactly one confirmed full PAYMENT and no prior confirmed refund.
- Refund amount and channel must exactly match the original confirmed PAYMENT and Order.amountFen.
- PENDING is created only after external refund initiation; it never changes order to REFUNDED.
- Confirmation requires actual full external return; it sets REFUND CONFIRMED and Order REFUNDED atomically while preserving fulfillment CANCELLED and original payment facts.
- Failure requires reason, preserves original refund attempt evidence, leaves order REFUND_PENDING and permits a later new attempt.
- Only one PENDING and at most one CONFIRMED REFUND per order; concurrent attempts are serialized.
- Every successful mutation increments version exactly once and writes complete Revision/Event/AdminAuditLog/idempotency response; read-only GET writes none.
- Fault injection proves complete rollback at every write stage; idempotency replay/conflict and stale-version cases pass.
- Real MySQL tests cover registration/confirm/fail, channel/amount mismatch, retry, concurrent operations, order-state races, and all T16/T17 regressions.
- No schema or migration change is expected; if DB constraints block the contract, stop and report the exact constraint before modifying schema.
- Update API contract, data model, roadmap and implementation report. Use random isolated MySQL/no Seed; never read development .env or touch development DB/volume.
- Stop at PR review; do not merge or begin fulfillment/subscription work without separate authorization.