# Offline payment attempts and confirmation — implementation contract

- Document: OFFLINE-PAYMENT-API
- Version: 1.1
- Status: Implemented for PR review; no development database deployment
- Date: 2026-11-19
- Related: [Order lifecycle decisions](17-order-creation-and-lifecycle-design.md), [Order creation](19-order-creation-api.md), [Order edit](20-order-edit-api.md), [Order cancellation/timeout](21-order-cancellation-timeout.md), [Order revision foundation](18-order-revision-foundation.md), [Order read API](16-order-read-api.md)

T17 implements ADMIN-only offline payment-attempt listing, registration, confirmation and failure. It records money received externally; the application never initiates, transfers or verifies money automatically. It does not implement refunds, fulfillment, subscription entitlement, payment-provider callbacks, customer payment uploads, frontend order/payment UI, or development database deployment.

## Decision conflict reconciliation

D70-D75 are additive clarifications; no existing ACTIVE decision is superseded or revoked. D38 remains SUPERSEDED by D39.

| Existing decision | T17 relationship | Resolution |
|---|---|---|
| D19 | ADMIN-only manual confirmation | Retained; no customer/provider confirmation |
| D20 | A confirmed payment must equal the full order amount | Registration may retain a mismatched actual attempt as PENDING evidence, but confirmation rejects it; no partial/overpayment allocation |
| D21 | occurredAt is actual external payment occurrence; paidAt copies it; paymentConfirmedAt is server time | Registration's occurredAt is only an unverified claim until confirmation; only confirmation writes Order.paidAt/paymentConfirmedAt |
| D22 | Existing channel/reference/note fields | Reused without schema expansion |
| D23 | PAID + PROCESSING after confirmation | Applied atomically with the confirmed PaymentTransaction |
| D39 | No late confirmation after the original 24-hour deadline | Registration and confirmation both stop at the inclusive deadline; D39 does not prohibit a pre-deadline PENDING_VERIFICATION summary. At expiry T16 closes pending attempts and cancels the order |
| D59 | Offline/manual receipt verification only | No payment provider, webhook, automated screenshot verification or money movement |
| D65-D69 | Cancellation and SYSTEM timeout use Order-first row locking | T17 uses the same Order-then-PaymentTransaction lock order; cancelled/expired orders cannot be registered, confirmed or failed through T17 |
| D34-D36/D40/D54 | Actor-scoped idempotency and immutable order history | Each successful mutation creates one version/revision/event/audit/idempotency response |

D20 governs what may be accepted as a successful full payment, not whether an inaccurate attempted transfer may be retained as evidence. D39's prohibition is against late confirmation/revival after expiry; it does not prevent an administrator from recording a pending attempt while the order is still valid.

## 1. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | /api/v1/admin/orders/:id/payment-transactions | Paginated list of PAYMENT attempts for one order |
| POST | /api/v1/admin/orders/:id/payment-transactions | Register a PAYMENT attempt as PENDING |
| POST | /api/v1/admin/payment-transactions/:id/confirm | Confirm one verified full PAYMENT |
| POST | /api/v1/admin/payment-transactions/:id/fail | Mark one unconfirmed PAYMENT attempt FAILED |

All routes require a persisted ADMIN Session and existing CSRF/rate-limit/no-store protections. Mutation routes require positive expectedVersion and Idempotency-Key. The actor is derived only from Session. Reject client-supplied actor IDs, order payment/fulfillment statuses, transaction status, confirmation timestamps, paidAt, createdAt, version, or unknown properties.

## 2. Payment-attempt listing

- Only ADMIN can view transaction evidence. No CUSTOMER payment-transaction endpoint is added.
- Query the specified ordinary order; missing/hidden/ineligible order uses the established safe order-not-found/not-visible response.
- Return PAYMENT rows only; do not mix REFUND rows into this T17 listing.
- Pagination: page defaults 1, pageSize defaults 20, max 100; sort `createdAt DESC, id ASC`.
- Safe admin item fields: id, orderId, kind, channel, amountFen, status, externalReference, occurredAt, confirmedAt, createdByAdminId, confirmedByAdminId, note, createdAt, updatedAt. No user credentials/session data or raw audit payload.
- Response shape `{items,total,page,pageSize}`. This read has no order version increment, Revision, Event, Audit or idempotency record.

## 3. Registration request and eligibility

POST `/admin/orders/:id/payment-transactions` accepts a strict JSON body:

```json
{
  "expectedVersion": 2,
  "amountFen": 10000,
  "channel": "WECHAT",
  "occurredAt": "2026-11-19T10:30:00.000Z",
  "externalReference": "optional-bank-or-wallet-reference",
  "note": "optional operator note"
}
```

- amountFen: positive integer Fen within the existing supported DB/API range (1..2147483647).
- channel: WECHAT, ALIPAY, BANK_TRANSFER, CASH or OTHER.
- occurredAt: required UTC ISO-8601 timestamp with milliseconds; it is the actual claimed external occurrence, not record creation time.
- externalReference: optional, trimmed, maximum 120 characters.
- note: optional, trimmed, maximum 500 characters.
- expectedVersion: required positive integer matching the locked Order.version.

After locking the Order row, registration is allowed only for a visible ordinary USER/ADMIN order in `UNPAID` or `PENDING_VERIFICATION` + `NOT_STARTED`, with amountFen > 0, no cancelledAt/fulfilledAt/paidAt/paymentConfirmedAt and no confirmed PAYMENT facts. Both request handling time and occurredAt must be before the original `createdAt + 24 hours`; occurredAt must be >= order.createdAt and <= database UTC now. The order's createdAt/deadline is never reset by payment registration.

An amount different from Order.amountFen is still recorded as PENDING so the evidence/attempt is preserved. It cannot be confirmed; ADMIN must later mark it FAILED with a reason. Do not silently rewrite the received amount to the order amount and do not accept partial payment as successful.

On success, create PaymentTransaction with kind=PAYMENT, status=PENDING, amount/channel/occurredAt/reference/note from the validated request, createdByAdminId from Session, confirmedAt=NULL and confirmedByAdminId=NULL. Set Order.paymentStatus=PENDING_VERIFICATION. If it was already PENDING_VERIFICATION, it remains so. Registration does not mean that funds have been verified or received in the business ledger.

Do not register payment for NOT_REQUIRED zero-price orders, PAID/REFUND_PENDING/REFUNDED orders, cancelled/fulfilled/hidden/system-renewal orders, expired orders or orders with confirmed payment facts.

## 4. Confirm request and eligibility

POST `/admin/payment-transactions/:id/confirm` accepts `{expectedVersion}` only. Confirmation requires ADMIN to have independently checked the actual external account and verified full receipt.

Lock ordering must match T16: first lock the parent Order row, then lock/re-read the target PaymentTransaction row. The initial non-locking lookup of transaction.orderId is only a locator; after the Order lock, re-read the transaction and verify its orderId is unchanged. Never lock PaymentTransaction first and then Order.

After both locks are held, require:
- Order is visible, ordinary USER/ADMIN, positive amount, `UNPAID` or `PENDING_VERIFICATION`, `NOT_STARTED`, not cancelled/fulfilled, and has no paidAt/paymentConfirmedAt facts.
- Current database UTC time is strictly before original `createdAt + 24 hours`; exactly at the deadline is expired (D39/T16 inclusive cutoff).
- Target transaction belongs to the order, kind=PAYMENT, status=PENDING, confirmedAt=NULL, and amountFen exactly equals current Order.amountFen.
- Target occurredAt is >= Order.createdAt, <= database UTC now and strictly before deadline.
- No other PAYMENT row for the order is PENDING. ADMIN must first process every other pending attempt as FAILED after separately verifying that it did not represent another receipt (D74).
- No other PAYMENT row is CONFIRMED/has confirmedAt, and no Order paidAt/paymentConfirmedAt facts exist.

An amount mismatch, another PENDING attempt, expired order, cancelled order or any existing confirmed payment rejects confirmation with 409 and no writes. A mismatched attempt remains PENDING until ADMIN explicitly fails it; it is never silently discarded.

On success, in one transaction:
1. Update target PaymentTransaction to CONFIRMED, set confirmedAt=database UTC now and confirmedByAdminId=Session ADMIN.
2. Set Order.paymentStatus=PAID, fulfillmentStatus=PROCESSING, paidAt=target.occurredAt and paymentConfirmedAt=the exact same database UTC timestamp written to transaction.confirmedAt.
3. Keep paymentRecordedAt unchanged and NULL for new flows; never use it as paidAt.
4. Do not create Subscription or mark fulfillment complete.

## 5. Failure request and eligibility

POST `/admin/payment-transactions/:id/fail` accepts a strict body `{expectedVersion, reason}`. reason is required, trimmed, nonblank and maximum 500 characters.

Lock Order first, then target PaymentTransaction, and use the same visible ordinary-order, no-cancellation, no-confirmed-payment and before-deadline checks as registration. The target must be a PENDING PAYMENT with confirmedAt=NULL. CONFIRMED or already FAILED attempts cannot be failed again.

Update only target transaction status to FAILED and updatedAt. Preserve amountFen, channel, externalReference, occurredAt, createdByAdminId, createdAt and the original PaymentTransaction.note. Store the failure reason in the OrderEvent and AdminAuditLog reason fields; do not overwrite the original payment note or evidence.

Recompute Order.paymentStatus from payment facts while holding the Order lock: if any PENDING PAYMENT remains, keep PENDING_VERIFICATION; if none remain and no confirmed PAYMENT exists, set UNPAID. Never change a PAID/REFUND_PENDING/REFUNDED/NOT_REQUIRED summary through this endpoint.

## 6. Multiple attempts and payment summary

- Multiple PAYMENT attempts may be retained for one order, including multiple simultaneous PENDING attempts.
- Every pending attempt must be individually reviewed. Before confirming one, all other pending attempts must already be FAILED (D74). Never auto-fail siblings when one payment is confirmed.
- A PENDING amount mismatch can be retained and then failed; a FAILED row remains immutable evidence and cannot be reactivated.
- If one attempt is FAILED but another remains PENDING, order summary remains PENDING_VERIFICATION.
- If all attempts are FAILED and no confirmed payment exists, summary returns to UNPAID.
- Exactly one full PAYMENT can be CONFIRMED for an ordinary order. If an external account shows multiple actual receipts, do not confirm a second one; escalate the excess receipt for offline handling outside this T17 workflow.
- No partial payment, overpayment allocation, split tender, or partial fulfillment is introduced.

## 7. Version, revision, event, audit and idempotency

Every successful mutation (attempt registration, confirmation, or failure) must, in the same serializable transaction:
1. Lock Order, then relevant PaymentTransaction rows in deterministic order.
2. Recheck status, payment facts, database UTC deadline and expectedVersion after locks.
3. Apply the PaymentTransaction change and Order paymentStatus/timestamps update.
4. Increment Order.version exactly once using the existing protected version mechanism/conditional update.
5. Append exactly one complete OrderRevision from the persisted updated Order, snapshotSchemaVersion=1, actorType=ADMIN and actorUserId=authenticated admin ID. Preserve the failure reason in Revision.reason when applicable; for registration/confirmation use NULL unless a documented operational reason exists.
6. Append exactly one OrderEvent: PAYMENT_RECORDED for registration, PAYMENT_CONFIRMED for confirmation, and existing NOTE with safe `operation: PAYMENT_FAILED` marker for failure (do not add an enum or migration). State JSON describes the transaction at that point in time: registration's before-state has NULL transactionId, amountFen, channel and transactionStatus because the new attempt does not yet exist, even if the order already has other attempts. Its after-state includes the new transaction ID, actual amount/channel and PENDING status. Confirmation/failure before-states reference the existing PENDING transaction; their after-states retain that ID/amount/channel with CONFIRMED/FAILED status. Apply these same states to Event.fromStateJson/toStateJson and Audit.beforeJson/afterJson. Do not include externalReference, raw note, credentials or customer formData.
7. Append exactly one sanitized AdminAuditLog with action PAYMENT_RECORDED / PAYMENT_CONFIRMED / PAYMENT_FAILED, entityType PaymentTransaction, entityId transaction ID, requestId, before/after state and reason where applicable.
8. Build and store the original response in IdempotencyRecord scoped to actorUserId + keyHash.
9. Commit. Any failure rolls back PaymentTransaction, Order, version, Revision, Event, Audit and idempotency response.

Every mutation requires expectedVersion. A stale version returns 409 VERSION_CONFLICT and writes nothing. Same actor/key/canonical intent replays the original status/body; same key with different route, transaction/order or payload returns 409 IDEMPOTENCY_CONFLICT. A duplicate confirmation/failure with a new key is rejected because the transaction is no longer PENDING; it must not create another version/event.

## 8. Concurrency with timeout and cancellation

- All payment mutation paths acquire Order before PaymentTransaction locks, matching T16 cancellation and SYSTEM timeout. Do not introduce inverse lock order.
- Confirmation and T16 timeout cancellation race on the same Order row. If confirmation commits first before deadline, timeout recheck sees PAID and skips. If timeout commits first, confirmation sees CANCELLED/expired and rejects. At the exact deadline, timeout wins by the inclusive `createdAt + 24 hours <= UTC_TIMESTAMP(3)` rule.
- Manual cancellation also locks Order first. A pending attempt closed by cancellation/timeout cannot later be confirmed.
- Registration and failure use the same original deadline. They cannot reopen, extend or revive an expired/cancelled order.
- Add real MySQL tests for both lock winners, lock waits crossing the deadline, same-order concurrent registration/confirm/fail, and stale expectedVersion.

## 9. Response and error contract

- GET list returns `{items,total,page,pageSize}` with ADMIN-safe PaymentTransaction fields.
- POST registration returns HTTP 201 `{order, paymentTransaction}`; confirm/fail return HTTP 200 `{order, paymentTransaction}`. Responses are no-store.
- Payment transaction response must never include session tokens, passwords, provider secrets, raw audit payloads or other users' private data. It may include the optional externalReference/note to ADMIN only.
- Errors reuse the existing envelope: 401 unauthenticated; 403 wrong role; 404 missing/not-visible order or transaction; 400 invalid body/reason/channel/time/amount/key; 409 order/transaction state ineligible, stale version, expired order, amount mismatch, other pending attempts, or idempotency conflict.
- Never return a success-shaped response if the database transaction did not commit.

## 10. Explicit non-goals

- Online payment API, provider SDK, webhook, automatic verification or screenshot/OCR.
- Customer payment upload or customer payment status mutation.
- Refund registration/confirmation (separate future stage; D59).
- Order cancellation/timeout worker changes (already merged T16; do not alter its semantics).
- Fulfillment, supplier API, subscription entitlement or renewal.
- Frontend order/payment management UI.
- Development database migration/deployment.

## 11. Acceptance

- Four ADMIN endpoints work over real HTTP with persisted Session, CSRF, strict DTO and role protection.
- Payment attempts support multiple PENDING rows; amount mismatch can be recorded but cannot be confirmed.
- Confirmation requires exact full amount, one target pending row, no sibling pending rows, no confirmed facts, and database time before the original 24-hour deadline.
- Failure preserves original transaction evidence and requires a reason; summary is PENDING_VERIFICATION while any pending attempt remains, otherwise UNPAID absent confirmed payment.
- Each successful mutation increments Order.version exactly once and appends exactly one complete Revision, Event, AdminAuditLog and idempotent original response.
- T16 timeout/cancel and T17 payment paths use identical Order-first lock order; both concurrency winners and exact deadline behavior are proven against real MySQL.
- Fault injection at every write stage proves full rollback; sequential/concurrent idempotency and same-key/different-intent conflicts pass.
- Existing cancellation, creation, edit, read, revision and subscription suites pass.
- No migration expected. If current triggers/constraints make the contract impossible, stop and report the exact blocker before adding a migration.
- Update API contract, data model, roadmap and implementation report. Use random isolated MySQL/no Seed; never read development .env or touch development DB/volume.
- Stop at one PR for review; do not merge or start refund/fulfillment without separate authorization.

## 12. Implementation report (2026-11-19)

### Implementation and compatibility

`payment-schemas.ts` defines strict role-safe DTOs, bounded integer Fen/version, UTC ISO timestamps with exactly three fractional digits, trimmed evidence fields and reason, and bounded pagination. `payments.ts` provides the explicit fourteen-field PAYMENT evidence projection/DTO, read-only paginated listing, and shared register/confirm/fail transaction. `payment-routes.ts` exposes only the four ADMIN endpoints through the existing Session/role/CSRF/rate-limit/no-store stack. Existing customer routes and T16 worker semantics are unchanged.

The three mutations reuse permanent actorUserId-scoped `mutation()`, canonical operation/target/input hashing, original-response replay and database-enforced concurrency. Replay occurs before current state checks. A registration retry with a different key and the original expectedVersion conflicts; an intentional subsequent attempt requires the refreshed version. Multiple actual attempts remain supported without any automatic sibling closure.

Confirmation/failure locate the parent with an autocommit read before opening the Serializable transaction. This locator never authorizes a write: a Serializable read of PaymentTransaction on the transaction connection could acquire an implicit shared lock before Order. Locating first also avoids holding a transaction connection while waiting for a second connection from the same five-connection pool. The idempotency check still precedes all state checks. After Order is exclusively locked, the service locks PAYMENT rows in deterministic ID order and re-reads their current order membership and state. A missing/moved/non-PAYMENT target returns safe 404. The existing T16 Order-first protocol serializes cancellation and timeout with payment changes.

Eligibility uses a fresh `UTC_TIMESTAMP(3)` query after all locks. The conditional Order UPDATE checks the original deadline again after the PaymentTransaction write, so a lock wait or delayed write cannot extend the window. Confirmation freezes paidAt from occurredAt and writes exactly the same database clock value to confirmedAt/paymentConfirmedAt. paymentRecordedAt is untouched, including non-NULL legacy metadata. Registration and failure never invent payment/confirmation times; no operation creates a subscription or completes fulfillment.

Every success updates one Order version, appends one complete protected Revision from the persisted Order, one Event and one sanitized ADMIN Audit, and saves the original response in the same transaction. PAYMENT_FAILED uses NOTE plus its operation marker; it preserves the transaction's original note and all receipt evidence. Event/Audit JSON excludes references, raw payment/order notes, form values and authentication fields; only the explicit failure reason is saved in its designated history fields. GET changes no business/history records.

### Error codes

Alongside existing authentication/input/key/404/VERSION_CONFLICT/IDEMPOTENCY_CONFLICT errors, this implementation uses ORDER_NOT_PAYABLE (409) for ineligible/expired orders or confirmed facts, PAYMENT_NOT_PENDING (409) for a processed attempt, PAYMENT_AMOUNT_MISMATCH (409), OTHER_PENDING_PAYMENTS (409), and PAYMENT_TIME_INVALID (400 for an out-of-range registration claim; 409 for an existing attempt that cannot be confirmed). No private request values are echoed.

### Isolated test procedure

`--payments-only` extends the existing no-Seed runner. Before payment tests it runs the existing cancellation/read/edit/create/Revision/subscription regression on separate random databases, then verifies the migration-twelve historical upgrade and all thirteen business tables/revisions in another random MySQL 8.4 project. `--payments-only --fresh` additionally supports installation from empty. Both verify repeat deploy/status/schema diff. Browser mode installs the same twelve migrations independently for each viewport: the full desktop suite runs first, then the full mobile suite, each with its own API process and random database. Explicit `--project` selection still runs only that project. Only runner-owned resources are cleaned; no development .env, database, original volume or running service is accessed or changed.

The HTTP suite exercises all channels, USER/ADMIN sources and INITIAL/ONE_TIME kinds, mismatched attempts, strict inputs, ADMIN isolation, safe listing/DTO allowlists, every state/deadline branch, original evidence, full immutable snapshots, all six write-stage faults for all three operations, sequential/concurrent idempotency and version races. Eight real simultaneous confirmations exceed the five-connection pool and check that locating does not starve nested connection acquisition. Deadline tests wait on real MySQL locks/time and delay a transaction write. A confirmation transaction is held at an audit barrier while concurrent SYSTEM workers cross the deadline; the reverse race holds the production SYSTEM cancellation core while the actual HTTP confirmation waits. No mock payment service or mock Prisma establishes correctness.

### Failures and corrections during validation

The first HTTP payment run passed 15/21 cases but exhausted the unchanged 120-request ADMIN limit across the suite's single long-lived application. Six later scenarios returned 429 or could not reach their transaction barriers. Each independent scenario now starts a fresh real Express application with its original limiter, while keeping the same isolated database and real Session authentication. This isolates test lifetimes without changing production security limits or weakening any assertions. The complete historical-upgrade/regression/payment command is rerun after the correction.

A parallel rerun completed read/edit/create/Revision/subscription regression, but the new payment mode's parent command terminated the aggregate cancellation regression after its inherited ten-minute wall-clock budget. This budget includes three separate database startups, migrations and complete suites. Only that aggregate parent budget is now twenty minutes; all individual suite budgets/assertions and existing database modes' budgets remain unchanged. Timeout diagnostics now report this distinction without exposing command credentials. Final database and browser runs execute sequentially to avoid resource contention; the interrupted runner's uniquely labelled disposable container/volume was removed separately, leaving the development volume untouched.

The first combined-viewports browser run passed 44/52, including the four new T17 cases; eight later mobile regressions failed. Saved network traces confirmed HTTP 429 on the existing product endpoints after the shared API's production mutation allowance was exhausted. Browser execution now isolates API/database lifetime per viewport instead of weakening limits, adding sleeps, skipping cases or changing assertions. The complete desktop/mobile suite is rerun under the corrected isolation.

Review also corrected the hidden SYSTEM_RENEWAL fixture to use NULL creator IDs as required by the published CHECK, and moved the read-only transaction locator before transaction acquisition to avoid connection-pool starvation. An eight-request real HTTP regression covers the latter. Initial full formatting encountered Windows checkout CRLF; normalizing line endings for verification leaves all unrelated Git file content unchanged.

### Changed files

- `backend/src/modules/orders/payment-schemas.ts` (new), `payments.ts` (new), `payment-routes.ts` (new), and `routes.ts` (ADMIN route mount).
- `backend/test/offline-payments.test.ts` (new), `backend/test/integration/offline-payments.test.ts` (new), `e2e/offline-payments.spec.ts` (new), and `backend/scripts/test-database.ts` (`--payments-only` mode).
- `README.md`, `docs/04-data-model.md`, `docs/05-api-contract.md`, `docs/07-development-roadmap.md`, and this report.

### Validation and boundaries

The final `npm run test:db -w backend -- --payments-only` completed successfully: payment HTTP tests **22/22**, cancellation/timeout **25/25**, order read **14/14**, edit **19/19**, creation **15/15**, Revision **9/9**, and subscription **10/10** (**114/114** total; no skipped/cancelled tests). The payment project's historical migration-twelve upgrade preserved every row and revision in all thirteen business tables, with no invented payment or zero-order reclassification. Repeated deploy had no pending migrations; schema diff passed. The other regression databases also verified fresh installation.

Actual commands executed in this task:

| Command | Result |
|---|---|
| `npm ci` | Passed; Prisma Client generated by existing postinstall |
| `npm run db:validate` | Passed |
| `npm run db:generate` | Passed, Prisma Client 7.10.1 |
| `npm run format:check` | Passed after final runner/test changes |
| `npm run typecheck` | Passed for frontend, backend and E2E after final runner/test changes |
| `npm run lint` | Passed after final runner/test changes |
| `npm test` | Frontend 9/9; backend 41/41, including four new payment-schema unit tests |
| `npm run build` | Frontend Vite and backend TypeScript builds passed |
| `npm run test:db -w backend -- --payments-only` | Passed, 114/114 and historical-upgrade/repeat-deploy/schema checks described above |
| `npm run test:e2e -w backend -- --payments-only` | Passed, desktop Edge 26/26 and mobile Edge 26/26 (52/52 total; no skipped cases), in separate fresh no-Seed environments |

`npm ci` reported three high-severity audit findings in the existing locked dependencies; dependency versions were not changed. Frontend builds retain existing third-party Zod comment-annotation warnings.

No Schema, Migration, dependency version, frontend application source, authentication, T16 business logic or original layout is changed. All twelve published migrations remain byte-for-byte unchanged. No development database migration/deployment, Seed, refund, payment-provider integration, fulfillment or next-stage work is included. Work started from fetched `origin/main` at `72d24a3`; the original shopping checkout's older local main and three layout edits were deliberately preserved. Their SHA-256 values and original API/frontend PIDs were rechecked unchanged; the development MySQL container remained healthy. Development .env and database data were not read or modified by implementation/testing.

## 13. PR #20 review correction — accurate payment history (2026-11-19)

The registration state serializer previously used the newly saved transaction as a fallback when there was no prior target. This incorrectly put its ID, amount and channel into the before-state. The serializer now uses only the explicitly supplied transaction: registration before-state has NULL transactionId, amountFen, channel and transactionStatus; after-state contains the newly created PENDING attempt. Existing attempts on the same order are not substituted for the not-yet-created attempt. Confirmation and failure still use the original PENDING target for before-state and the updated target for after-state. Event.fromStateJson/toStateJson and Audit.beforeJson/afterJson share these corrected states.

Three added real HTTP/MySQL tests assert all four complete JSON objects independently of the production serializer. Registration covers both the first attempt and another attempt while the order is already PENDING_VERIFICATION, with different amounts/channels. Confirmation/failure cover the existing transaction ID, original amount/channel/PENDING status, and final CONFIRMED/FAILED state. The existing sensitive-value exclusion, all-stage transaction rollback, concurrent/version/idempotency and original-response replay tests remain unchanged.

This follow-up changes only `backend/src/modules/orders/payments.ts`, `backend/test/integration/offline-payments.test.ts` and this report. No existing history is rewritten, and no Schema, Migration, business decision, frontend code, dependency or original-worktree file is changed. Tests use the existing random isolated MySQL 8.4/no-Seed runner; development .env, database and original volume remain outside the test environment.

Actual checks rerun for this correction:

| Command | Result |
|---|---|
| `npm run format:check` | Passed |
| `npm run typecheck` | Passed for frontend, backend and E2E |
| `npm run lint` | Passed |
| `npm test` | Backend 41/41; frontend 9/9 |
| `npm run build` | Frontend Vite and backend TypeScript builds passed |
| `npm run test:db -w backend -- --payments-only` | Passed, payment HTTP 25/25, cancellation 25/25, read 14/14, edit 19/19, creation 15/15, Revision 9/9, subscription 10/10: 117/117 total, no skipped/cancelled tests |
| `npm run test:e2e -w backend -- --payments-only e2e/offline-payments.spec.ts` | Desktop payment browser tests passed 2/2; automatic mobile selection failed before running tests, as explained below |
| `npm run test:e2e -w backend -- --payments-only e2e/offline-payments.spec.ts --project=mobile-edge` | Mobile payment browser tests passed 2/2; four focused browser cases passed across both viewports |

The historical upgrade again preserved every row/revision in all thirteen business tables. Repeat deploy had no pending migrations and the database matched the Prisma schema. Existing unrelated third-party Zod build warnings remain unchanged.

The initial focused browser command returned nonzero after its successful desktop cases: the existing runner prepends a variadic `--project mobile-edge` option before the positional filename, so Playwright treated that filename as another project name. Explicit `--project=mobile-edge` selected only mobile and passed in a separate fresh random database. No runner, application code or assertion was relaxed for this invocation issue. This correction reran only the four payment browser cases; the full 52-case result in section 12 remains the earlier implementation run, not a new full-suite run.
