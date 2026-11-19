# Order cancellation and timeout API — implementation contract

- Document: ORDER-CANCEL-TIMEOUT
- Version: 1.0
- Status: Approved design baseline; implementation not started
- Date: 2026-11-19
- Related: [Order lifecycle decisions](17-order-creation-and-lifecycle-design.md), [Order creation](19-order-creation-api.md), [Order edit](20-order-edit-api.md), [Order revision foundation](18-order-revision-foundation.md), [Order read API](16-order-read-api.md)

This stage implements manual cancellation and the 24-hour automatic cancellation worker. It does not implement payment confirmation, refund completion, fulfillment, supplier APIs, notifications, frontend order-management UI, or development database deployment.

## 1. Endpoints and roles

| Method | Path | Principal |
|---|---|---|
| POST | /api/v1/customer/orders/:id/cancel | ACTIVE CUSTOMER; own order only |
| POST | /api/v1/admin/orders/:id/cancel | ADMIN |

Both manual endpoints require persisted Session, existing CSRF protections, no-store response, positive `expectedVersion`, and required `Idempotency-Key`. Use strict request DTOs. The customer body is `{expectedVersion, reason?}`; the admin body is `{expectedVersion, reason}`. Reject unknown fields.

The automatic SYSTEM worker is internal only; do not expose a SYSTEM cancellation route or accept actor/source fields from clients.

## 2. Manual cancellation eligibility

### CUSTOMER
- May cancel only their own visible ordinary USER/ADMIN order that is not paid, not in fulfillment and not already cancelled.
- Query by both order ID and Session userId; missing and foreign IDs return the same safe 404.
- Customer reason is optional, trimmed, maximum 500 characters. Empty/whitespace is normalized to NULL.
- Customer cannot cancel `PAID`, `PENDING_VERIFICATION` after a payment transaction is recorded, `NOT_REQUIRED`, `REFUND_PENDING`, `REFUNDED`, `PROCESSING`, completed, hidden or SYSTEM_RENEWAL orders.

### ADMIN
- Must provide a nonblank reason, trimmed and maximum 500 characters.
- May cancel ordinary `UNPAID + NOT_STARTED` orders, including orders still within their 24-hour window.
- May cancel a `PAID + PROCESSING` order only before fulfillment completion, after verifying a confirmed full PAYMENT transaction exactly matches `amountFen` and the order's paidAt/paymentConfirmedAt facts.
- May cancel `NOT_REQUIRED + PROCESSING` zero-price orders under D53; no payment/refund transaction is created.
- Cannot cancel completed, already cancelled, hidden/system renewal, or otherwise ineligible orders.

All eligibility is rechecked after locking the Order row inside the transaction. Both endpoints require the submitted expectedVersion to match the locked row. A stale version returns 409 VERSION_CONFLICT and writes nothing.

## 3. State transitions

| Starting state | Actor/action | Result | Payment transaction behavior |
|---|---|---|---|
| UNPAID + NOT_STARTED | CUSTOMER cancel | fulfillmentStatus=CANCELLED; paymentStatus remains UNPAID | No confirmed payment exists; any pending unconfirmed PAYMENT attempt is marked FAILED and retained |
| UNPAID + NOT_STARTED | ADMIN cancel | fulfillmentStatus=CANCELLED; paymentStatus remains UNPAID | Same as above; no refund |
| PAID + PROCESSING | ADMIN cancel | fulfillmentStatus=CANCELLED; paymentStatus=REFUND_PENDING | Preserve confirmed PAYMENT; do not create/confirm refund |
| NOT_REQUIRED + PROCESSING | ADMIN cancel | fulfillmentStatus=CANCELLED; paymentStatus remains NOT_REQUIRED | No payment/refund transaction |

Every successful cancellation sets `cancelledAt` from database UTC time and persists the reason in `cancellationReason`. Do not overwrite `paidAt`, `paymentConfirmedAt`, `fulfilledAt`, or original `createdAt`. Cancellation is terminal and cannot be reversed or deleted.

An unconfirmed PENDING PAYMENT transaction must not remain confirmable after the order is cancelled. Mark it FAILED in the same transaction, retain the row and its external details, and record a clear timeout/cancellation failure note. Never treat a PENDING transaction as proof that money was received. If the customer claims money was actually transferred but the order never reached confirmed PAID before cancellation, handling that money/claim remains outside the order system under D39.

## 4. Refund boundary

- Cancelling a PAID order only moves paymentStatus to REFUND_PENDING. Preserve the original confirmed PAYMENT transaction.
- Do not create a successful refund record, set REFUNDED, or claim money has been returned as part of cancellation.
- Offline refund is a separate future ADMIN operation. Only after money has actually been returned may a separate refund transaction be confirmed and paymentStatus become REFUNDED (D18/D59).
- No partial refund is introduced in this stage. The default expected refund is the full confirmed receipt amount.
- Zero-price NOT_REQUIRED cancellation never creates a refund.

## 5. SYSTEM timeout worker

Run a background worker once per minute. It uses database UTC time, never a process-local clock, to find orders where `createdAt + 24 hours <= UTC_TIMESTAMP(3)` and payment confirmation has not completed.

Eligible timeout rows:
- Visible ordinary USER/ADMIN orders only; exclude hidden/system renewal orders.
- `paymentStatus IN (UNPAID, PENDING_VERIFICATION)` and `fulfillmentStatus=NOT_STARTED`.
- `cancelledAt IS NULL`, `paidAt IS NULL`, `paymentConfirmedAt IS NULL`, and no fulfillment completion.
- The original createdAt deadline has passed.

Use bounded batches with deterministic ordering and row-level locking (`FOR UPDATE SKIP LOCKED`, or an equivalent proven MySQL 8.4 pattern). Each order is processed in its own short transaction or a bounded transaction batch. The transaction must recheck the complete eligibility predicate against database time after acquiring the lock.

For each eligible order, atomically:
1. Update fulfillmentStatus to CANCELLED, set cancelledAt to UTC_TIMESTAMP(3), set cancellationReason to the fixed `PAYMENT_TIMEOUT`, preserve paymentStatus as UNPAID or PENDING_VERIFICATION only if the chosen payment-state invariant permits it; otherwise apply the pending-attempt close rule below.
2. Increment Order.version exactly once.
3. Mark every unconfirmed PENDING PAYMENT transaction for that order FAILED, preserving the transaction row and setting a sanitized `PAYMENT_TIMEOUT` note. Confirmed transactions must never be altered by this worker.
4. Append exactly one complete OrderRevision with actorType=SYSTEM and actorUserId=NULL.
5. Append exactly one OrderEvent with eventType=CANCELLED, actorType=SYSTEM, actorAdminId=NULL and actorUserId=NULL. Include safe from/to state and PAYMENT_TIMEOUT reason; do not include customer formData.
6. Do not create AdminAuditLog, refund transaction, PaymentTransaction success, Subscription, or IdempotencyRecord.
7. Commit. Any failure rolls back the order update, version, pending-transaction closure, revision and event together.

Concurrency and retries:
- Multiple worker instances may run simultaneously. Row locks/conditional updates ensure only one worker wins for an order.
- Manual payment confirmation and timeout cancellation race under the same Order row lock. The first valid transaction to commit wins. If confirmation commits first, timeout predicate fails; if cancellation commits first, payment confirmation must reject the cancelled order.
- Manual customer/admin cancellation and timeout cancellation use the same state predicate and lock order. Only one transition creates history.
- Repeated scans skip already cancelled orders and never increment version or append duplicate events.
- Worker failure is retried on a later minute. A per-order transaction prevents one bad row from blocking the whole batch.
- No process-local lock or in-memory schedule is a correctness mechanism. Scheduler/worker lifecycle must be safe on startup, shutdown and multiple app instances.

## 6. SYSTEM actor and history

- Order.version increments exactly once for each successful manual or SYSTEM cancellation.
- Every cancellation appends one complete OrderRevision from the persisted updated Order.
- Manual CUSTOMER cancellation: actorType=USER, actorUserId=customer ID; no AdminAuditLog.
- Manual ADMIN cancellation: actorType=ADMIN, OrderEvent uses actorAdminId; append sanitized AdminAuditLog.
- SYSTEM timeout: actorType=SYSTEM, OrderRevision.actorUserId=NULL, OrderEvent actorAdminId/actorUserId both NULL; no AdminAuditLog and no fake system user.
- OrderEvent uses the existing CANCELLED enum value. Do not add a new enum value or migration unless the existing schema/trigger constraints make this impossible; if impossible, stop and report the exact constraint rather than bypassing it.
- Revision/event/audit must not expose raw formData, credentials, contact email or other unnecessary private data. OrderRevision remains the protected complete snapshot.

## 7. Idempotency and HTTP responses

Manual cancellation uses the shared actorUserId + keyHash mutation helper. Canonical intent includes operation, order ID, expectedVersion and normalized reason. Same actor/key/intent replays the exact original response; different intent returns 409 IDEMPOTENCY_CONFLICT.

Manual cancellation success returns HTTP 200 `{order}` using the role-specific safe DTO and stored original response. If the order is already cancelled and a different key is used, return 409 ORDER_NOT_CANCELLABLE; do not create another version/event.

SYSTEM timeout does not use IdempotencyRecord because there is no authenticated User actor. Idempotency is provided by the locked state predicate, terminal cancellation state, and one version/revision/event transaction.

## 8. Error mapping

| Condition | HTTP | Semantic code |
|---|---:|---|
| Missing/invalid Session | 401 | UNAUTHENTICATED |
| Wrong role | 403 | FORBIDDEN |
| Customer order missing/not owned | 404 | NOT_FOUND |
| Invalid/missing expectedVersion or body | 400 | INVALID_INPUT |
| Admin reason missing/blank/too long | 400 | INVALID_INPUT |
| Stale version | 409 | VERSION_CONFLICT |
| Ineligible/already cancelled/fulfilled order | 409 | ORDER_NOT_CANCELLABLE |
| Same actor/key with different intent | 409 | IDEMPOTENCY_CONFLICT |

Reuse existing error codes where an equivalent already exists. Never disclose another customer's order existence.

## 9. Explicit non-goals

- Payment confirmation API and UI.
- Refund transaction creation/confirmation API and UI.
- Fulfillment or subscription entitlement.
- Supplier APIs or automatic delivery.
- Customer/admin order-management frontend.
- Notifications/email.
- Internal-note editing.
- Renewal.
- Development database migration/deployment.

## 10. Acceptance

- Customer/admin cancellation endpoints enforce exact D16/D17/D53 role/state rules.
- Customer optional reason and admin mandatory reason are validated.
- Paid cancellation enters REFUND_PENDING and preserves the confirmed payment transaction; no fake refund completion.
- Zero-price cancellation remains NOT_REQUIRED and creates no refund.
- Worker runs every minute, uses database time, and cancels expired unpaid/unconfirmed orders with SYSTEM history.
- Pending unconfirmed PAYMENT attempts are retained but marked FAILED and cannot later be confirmed after cancellation.
- Payment-confirmation/timeout and manual-cancel/timeout races produce exactly one valid terminal transition.
- Every successful cancellation increments version once and appends one complete revision/event; only manual ADMIN actions append AdminAuditLog.
- Fault injection proves atomic rollback for Order, PaymentTransaction, Revision, Event, Audit and idempotency writes.
- Worker is safe with multiple instances, repeated scans, bounded batches, process restart and transient failure.
- Existing order creation/edit/read/revision/subscription suites pass.
- Use random isolated MySQL and no-Seed runner; never read development .env or touch development DB/volume.
- Update API contract, roadmap, implementation report and tests. Stop at PR for review; do not merge or start payment/refund/fulfillment UI without review.