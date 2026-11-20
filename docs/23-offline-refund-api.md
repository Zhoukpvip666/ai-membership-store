# Offline refund attempts and confirmation — implementation contract

- Document: OFFLINE-REFUND-API
- Version: 1.1
- Status: Implemented for PR review; no development database deployment
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

## 13. Implementation report (2026-11-19)

### Implementation and preserved evidence

The four ADMIN routes reuse persisted Session/role, CSRF, mutation limits and no-store headers. Refund request schemas reuse the existing bounded offline evidence format; bodies and queries reject unknown fields. Listing filters only REFUND rows and uses the existing explicit 14-field ADMIN transaction DTO, with matching count/filter and createdAt DESC/id ASC ordering. It never creates history or changes Order.version.

Refund mutations use the existing actorUserId-scoped idempotency helper and serializable transaction/retry wrapper. The non-locking transaction locator runs before acquiring a transaction connection, avoiding a second pool acquisition and reversed Serializable locks. Replay precedes business-state validation. The action locks Order, then every related PaymentTransaction in ID order, re-reads the target and verifies its REFUND kind and membership. Locked eligibility requires a positive cancelled REFUND_PENDING order, complete payment/cancellation facts and exactly one consistent confirmed full PAYMENT. Any transaction with a confirmed status or confirmation timestamp counts as confirmation evidence, including malformed rows whose status disagrees with their timestamp.

Registration rejects any PENDING/CONFIRMED refund evidence. Confirm/fail require exactly the one PENDING target and no confirmed refund. The amount and channel must exactly match the full original payment on every mutation; occurrence must be between actual original payment time and database UTC now, inclusive. There is no createdAt+24h refund restriction. The conditional Order update changes only the payment summary, version and updatedAt; all purchase snapshots, payment times and cancellation fields remain unchanged. Only confirmation sets REFUNDED. Failure changes only refund status/updatedAt; the original note and other external evidence remain intact, and a later registration creates a different transaction ID.

Each success appends a complete persisted-order V1-schema Revision, one event and sanitized ADMIN audit, then saves the original response in the same transaction. Failure reason is stored in Revision.reason, Event.note and safe state JSON, and Audit.reason. Registration before-state has NULL transactionId/amount/channel/status; after-state identifies the new PENDING refund. Confirm/fail before-state describes the existing PENDING refund. Event and Audit share the same precise before/after state. Reference, original note, customer form data and credentials are excluded from event/audit state; protected Revision and explicit ADMIN evidence DTO retain their documented purposes.

No Schema or Migration changed. All twelve committed SQL files and version/source/renewal/history triggers remain unchanged. Existing T16/T17 services are reused without changing their rules; T17 only exports its existing DTO helper for reuse. No new business decision, frontend application code, provider SDK, money movement, fulfillment or entitlement operation is included.

### Error contract

Existing authentication, CSRF, INVALID_INPUT, NOT_FOUND, VERSION_CONFLICT and IDEMPOTENCY_CONFLICT errors are retained. Additional 409 codes are ORDER_NOT_REFUNDABLE (state or original payment facts invalid), REFUND_NOT_PENDING (terminal target), OTHER_PENDING_REFUNDS, REFUND_AMOUNT_MISMATCH and REFUND_CHANNEL_MISMATCH. REFUND_TIME_INVALID is 400 for a registration claim outside the permitted time range, and 409 for invalid stored target evidence. Missing, hidden, system-renewal or wrong-kind targets share safe NOT_FOUND responses. No raw private request values are echoed.

### Verification procedure

`--refunds-only` extends the existing random isolated MySQL 8.4/no-Seed runner. Its default path runs T17/T16/read/edit/create/Revision/subscription regressions on independent fresh databases, then uses another random project for the historical migration-twelve upgrade and refund HTTP tests. The upgrade compares every row and revision in all thirteen business tables, checks repeat deploy has no pending migrations and verifies schema diff. Existing row histories are not deleted to reset the suites. `--refunds-only --fresh` installs all twelve from empty; no new migration is introduced.

HTTP cases use real Express routing, persisted Sessions and real MySQL. Tests cover all five channels, USER/ADMIN ordinary sources, INITIAL/ONE_TIME, old orders beyond 24h, precise Event/Audit JSON, safe listing, all eligibility branches, failed-evidence preservation/retry, two ADMIN identities racing, simultaneous replay/version conflicts and eight confirmations exceeding the five-connection pool. Database trigger fault injection covers six write stages for each of the three operations (18 rollback scenarios), compares every business/history row after failure and retries the same key successfully. Browser cases exercise creation -> payment registration/confirmation -> paid cancellation -> refund registration/confirmation/failure/retry through actual cookies/CSRF/Vite proxy, without adding a refund page.

The E2E runner's automatic mobile project option now uses `--project=mobile-edge`: a positional filename after variadic `--project mobile-edge` was previously parsed as another project name. The project still has its own fresh API/database per viewport; no assertion, production rate limit or individual suite budget is relaxed. Refund aggregation receives the existing twenty-minute aggregate allowance used for the larger payment regression; individual database suites keep their original three-minute limit.

The existing checkout remains on its older local main with exactly its three layout edits, while this branch starts from current origin/main `9be1a02`. Neither development .env nor the development database is read by the implementation/tests; no Seed, development migration, development grants/global-variable changes or original-volume operation is performed. Existing API/frontend services are preserved. New development deployment requires separate authorization. Refund uniqueness and cross-table consistency rely on the shared Order-lock transaction protocol; future writers must use that protocol, since this stage does not add a database-level filtered unique index or deferred cross-table assertion.

### Actual verification results and repairs

The first isolated run passed all 117 existing regression tests and 16/18 new refund HTTP tests. Two refund fixture preparation errors prevented the remaining assertions from running: a deliberately missing cancelledAt was reused as the required transaction occurredAt, and an ordinary hidden order violated the existing source CHECK. The fixture now uses a valid fallback transaction time; the visibility test asserts that the database rejects hidden ordinary orders, then exercises every HTTP route with a valid hidden SYSTEM_RENEWAL. No production rule, constraint or assertion was relaxed.

The initial formatting check found CRLF in this fresh Windows worktree. Tracked source/document files were normalized to the repository's LF format; content-identical files are absent from the final diff. Prisma schema and migration files were not changed. npm ci used the committed lockfile and reported three existing high-severity audit findings; dependency versions were not changed in this task. Frontend build also retains existing third-party Zod PURE annotation warnings.

| Command | Actual result |
| --- | --- |
| `npm ci` | Passed; Prisma Client 7.10.1 generated by the existing postinstall |
| `npm run db:validate` | Passed |
| `npm test` | Passed: backend 45/45, frontend 9/9 |
| `npm run typecheck` | Passed for frontend, backend and E2E |
| `npm run lint` | Passed |
| `npm run format:check` | Passed after LF normalization |
| `npm run build` | Frontend and backend passed |
| `git diff --check` | Passed |
| `npm run test:db -w backend -- --refunds-only` | Full rerun passed 135/135: refunds 18, payments 25, cancellation/timeout 25, editing 19, creation 15, order reads 14, Revision 9, subscriptions 10; no skips |
| Selected browser command below | Passed 22/22: desktop-edge 11/11 and mobile-edge 11/11, including four new refund executions; no skips or retries |

The successful database rerun also passed historical migration-twelve upgrade/data-preservation checks, complete fresh twelve-migration installations for the regression projects, repeat deploy with no pending migration and Prisma schema diff. All thirteen business tables and historical immutable revisions were preserved in the upgrade fixture. The random isolated containers/volumes were removed by the guarded runner; the development container/volume was not used.

The actual browser command was:

```sh
npm run test:e2e -w backend -- --refunds-only e2e/offline-refunds.spec.ts e2e/offline-payments.spec.ts e2e/order-cancellation.spec.ts e2e/order-edit.spec.ts e2e/order-creation.spec.ts
```

These are the selected refund/payment/cancellation/edit/creation browser regressions, not a claim that every unrelated UI spec was rerun. Each viewport installed all twelve migrations into its own fresh random database, verified repeat deploy/schema diff, used no Seed and removed only its own disposable resources. Both browser projects passed on their first execution. Final format/diff checks also passed after the fixture repairs. The original checkout still has only its three pre-existing layout edits (all three SHA-256 values unchanged), API PID 1936 and Vite PID 1720 retain ports 3000/5173, and the original MySQL container remains healthy on ai-membership-store_mysql-data. Development database contents were not inspected or modified.

### Changed files

- Backend implementation: `backend/src/modules/orders/refund-schemas.ts`, `refund-routes.ts`, `refunds.ts`, existing `payments.ts` (DTO export only), and `routes.ts` (ADMIN mount).
- Tests and runner: `backend/test/offline-refunds.test.ts`, `backend/test/integration/offline-refunds.test.ts`, `e2e/offline-refunds.spec.ts`, `backend/scripts/test-database.ts`.
- Documentation: `README.md`, `docs/04-data-model.md`, `docs/05-api-contract.md`, `docs/07-development-roadmap.md`, this report.

These are the complete fourteen implementation files. No frontend application, Prisma schema/migration, dependency manifest/lockfile, original layout or development configuration file is included.
