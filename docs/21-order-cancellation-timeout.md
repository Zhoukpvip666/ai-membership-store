# Order cancellation and timeout API — implementation contract

- Document: ORDER-CANCEL-TIMEOUT
- Version: 1.2
- Status: Merged in PR #17 (`56b0ba40ff803179bf8e2ce6849b345a0ec3caf9`); no development database deployment
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
- May cancel their own visible ordinary USER/ADMIN order in `UNPAID + NOT_STARTED` or `PENDING_VERIFICATION + NOT_STARTED`, provided no confirmed PAYMENT exists and it is not already cancelled or fulfilled. This follows D16: a pending verification record is not confirmed payment.
- Query by both order ID and Session userId; missing and foreign IDs return the same safe 404.
- Customer reason is optional, trimmed, maximum 500 characters. Empty/whitespace is normalized to NULL.
- Customer cannot cancel `PAID`, `NOT_REQUIRED`, `REFUND_PENDING`, `REFUNDED`, `PROCESSING`, completed, hidden or SYSTEM_RENEWAL orders. A pending unconfirmed PAYMENT attempt is retained and marked FAILED in the cancellation transaction; the order summary returns to UNPAID. Any claim that money was actually transferred is handled outside the order system under D39.

### ADMIN
- Must provide a nonblank reason, trimmed and maximum 500 characters.
- May cancel ordinary `UNPAID + NOT_STARTED` or `PENDING_VERIFICATION + NOT_STARTED` orders when there are no confirmed PAYMENT transactions, paidAt or paymentConfirmedAt facts, including orders still within their 24-hour window. A pending verification summary is not confirmed payment (D16).
- May cancel a `PAID + PROCESSING` order only before fulfillment completion, after verifying a confirmed full PAYMENT transaction exactly matches `amountFen` and the order's paidAt/paymentConfirmedAt facts.
- May cancel `NOT_REQUIRED + PROCESSING` zero-price orders under D53; no payment/refund transaction is created.
- Cannot cancel completed, already cancelled, hidden/system renewal, or otherwise ineligible orders.

All eligibility is rechecked after locking the Order row inside the transaction. Both endpoints require the submitted expectedVersion to match the locked row. A stale version returns 409 VERSION_CONFLICT and writes nothing.

## 3. State transitions

| Starting state | Actor/action | Result | Payment transaction behavior |
|---|---|---|---|
| UNPAID + NOT_STARTED or PENDING_VERIFICATION + NOT_STARTED | CUSTOMER cancel | fulfillmentStatus=CANCELLED; paymentStatus=UNPAID | Any pending unconfirmed PAYMENT attempt is marked FAILED and retained; no refund |
| UNPAID + NOT_STARTED or PENDING_VERIFICATION + NOT_STARTED | ADMIN cancel | fulfillmentStatus=CANCELLED; paymentStatus=UNPAID | All pending unconfirmed PAYMENT attempts are marked FAILED and retained; no refund |
| PAID + PROCESSING | ADMIN cancel | fulfillmentStatus=CANCELLED; paymentStatus=REFUND_PENDING | Preserve confirmed PAYMENT; do not create/confirm refund |
| NOT_REQUIRED + PROCESSING | ADMIN cancel | fulfillmentStatus=CANCELLED; paymentStatus remains NOT_REQUIRED | No payment/refund transaction |

Every successful cancellation sets `cancelledAt` from database UTC time and persists the reason in `cancellationReason`. Do not overwrite `paidAt`, `paymentConfirmedAt`, `fulfilledAt`, or original `createdAt`. Cancellation is terminal and cannot be reversed or deleted.

An unconfirmed PENDING PAYMENT transaction must not remain confirmable after the order is cancelled. Mark it FAILED in the same transaction, retain the row and its external details, and record a clear timeout/cancellation failure note. If the order summary was PENDING_VERIFICATION, recompute it to UNPAID because no payment was confirmed. Never treat a PENDING transaction as proof that money was received. If the customer claims money was actually transferred but the order never reached confirmed PAID before cancellation, handling that money/claim remains outside the order system under D39.

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
1. Update fulfillmentStatus to CANCELLED, set cancelledAt to UTC_TIMESTAMP(3), set cancellationReason to the fixed `PAYMENT_TIMEOUT`; paymentStatus remains UNPAID, or changes from PENDING_VERIFICATION back to UNPAID after pending attempts are marked FAILED.
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
- Update API contract, roadmap, implementation report and tests. T16 was merged in PR #17. Do not start payment/refund/fulfillment UI or deploy to the development database without separate authorization.

## 11. Implementation report (2026-11-19)

The two role-specific POST handlers reuse the existing persisted Session/role/CSRF guards, strict DTO parsing and actorUserId-scoped idempotency helper. A shared cancellation function runs only after the caller has exclusively locked the Order. It checks the locked version and exact eligible state, then commits Order/version, pending-attempt closure, complete V1-schema Revision, CANCELLED Event, ADMIN-only sanitized Audit and the original manual response together. Frozen product/form/contact fields and existing payment timestamps are not changed. A different key with the current version cannot cancel a terminal order again; a stale expectedVersion returns VERSION_CONFLICT.

Paid cancellation requires exactly one confirmed PAYMENT: its amount must equal amountFen, occurredAt must equal paidAt, confirmedAt must equal paymentConfirmedAt, and actual payment cannot follow confirmation. Inconsistent or missing facts return ORDER_NOT_CANCELLABLE. A valid paid cancellation sets REFUND_PENDING without creating a refund. CUSTOMER, ADMIN and SYSTEM accept PENDING_VERIFICATION without confirmed facts under their respective ownership/role/deadline rules. ADMIN must still provide a nonblank reason. Zero-price ADMIN cancellation retains NOT_REQUIRED and creates no money/entitlement rows.

Pending unconfirmed PAYMENT rows are retained. Only their status, failure note and updatedAt change; the failure note is replaced by the fixed sanitized ORDER_CANCELLED or PAYMENT_TIMEOUT marker. IDs, external references, channel, amount, occurrence/confirmation information and creation details remain intact. Existing confirmed/failed transactions and REFUND rows are not changed. Revision stores the protected full snapshot; Event/Audit state JSON contains only the operation, version, amount, statuses and cancellation time, plus the supplied cancellation reason in its dedicated field.

The worker starts once after API listen and then every 60000ms. Each pass selects at most 100 deterministic candidates (createdAt/id), using database UTC time and the inclusive 24-hour boundary. Each candidate gets its own serializable transaction and FOR UPDATE SKIP LOCKED recheck. Concurrent instances share no correctness state outside MySQL. A failed row rolls back and increments the pass's failed count while healthy candidates continue; the next minute retries. The scheduler reports only a sanitized failure message and does not spin to drain a poisoned batch. Shutdown stops both order and existing subscription schedulers and waits for in-flight work before database disconnect.

No Schema or Migration changed: all twelve committed migrations, CHECKs and history/source/renewal triggers are reused unchanged. No frontend page, payment/refund confirmation service, fulfillment, subscription entitlement or internal-note endpoint is added.

### Reproducible isolated verification

```powershell
npm ci
npm run db:validate
npm run db:generate
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:db -w backend -- --cancellation-only
npm run build
npm run test:e2e -w backend -- --cancellation-only
```

The new no-Seed mode first runs the existing edit/create/revision/subscription regression in a separate fresh random database (`--edit-only --fresh`), with read tests in their own pristine project. Another random database exercises migration-twelve historical upgrade, preservation of all thirteen business tables, repeated deploy and schema diff, followed by the cancellation suite. This keeps append-only cancellation fixtures out of regression suites that compare entire tables; no history is deleted to reset tests. Browser mode installs all twelve migrations fresh in a separate random environment. Neither path reads development .env or touches the development database/volume. Build before browser preview; do not rebuild its assets during E2E.

Integration coverage includes role/ownership/CSRF/reason validation, paid/zero/pending states, exact safe DTO parity, immutable history, all-stage database-trigger fault injection, same-key concurrency and competing versions, inclusive database-clock expiry, bounded batches/locked rows, two concurrent worker instances, repeated/restarted sweeps and per-row failure recovery. Payment race coverage uses a **test-only** writer following the shared Order lock/deadline protocol, to demonstrate both winners and rejection after timeout. The production payment-confirmation implementation remains future work and must reapply this protocol and its own full transaction tests.

### Changed files

- `backend/src/modules/orders/cancel-schemas.ts`: strict role-specific cancellation bodies.
- `backend/src/modules/orders/cancel.ts`: shared locked cancellation transaction, history and manual idempotency.
- `backend/src/modules/orders/timeout.ts`: bounded database-time scan and minute scheduler wrapper.
- `backend/src/modules/orders/routes.ts`: the two guarded cancellation POST handlers.
- `backend/src/server.ts`: start/stop order worker alongside the existing subscription scheduler.
- `backend/scripts/test-database.ts`: isolated no-Seed cancellation mode and separate existing regression databases.
- `backend/test/order-cancellation.test.ts`: schema/scheduler unit tests.
- `backend/test/integration/order-cancellation.test.ts`: real HTTP/MySQL state, concurrency and fault-injection tests.
- `e2e/order-cancellation.spec.ts`: ADMIN/CUSTOMER browser cancellation and replay on both viewport projects.
- `README.md`, `docs/04-data-model.md`, `docs/05-api-contract.md`, `docs/07-development-roadmap.md`, `docs/17-order-creation-and-lifecycle-design.md`, this report and `docs/superpowers/plans/2026-11-19-order-cancellation-timeout.md`: contract, scope, implementation status, plan and validation record.

### Initial implementation verification (before PR review correction)

This report does not claim production deployment or physical-device testing. Microsoft Edge runs cover desktop and emulated mobile viewports.

| Command | Actual result |
|---|---|
| `npm ci` | Passed; no dependency version/lockfile changes |
| `npm run db:validate` | Passed |
| `npm run db:generate` | Passed; Prisma Client 7.10.1 |
| `npm run format:check` | Passed |
| `npm run typecheck` | Passed frontend, backend and E2E; backend rechecked after the final lock-wait fixture |
| `npm run lint` | Passed |
| `npm test` | Backend 37/37; frontend 9/9 |
| `npm run test:db -w backend -- --cancellation-only` | 90/90: read 14, edit 19, creation 15, Revision 9, subscription 10, cancellation/timeout 23; three independent random MySQL projects, no Seed |
| `npm run build` | Frontend and backend passed |
| `npm run test:e2e -w backend -- --cancellation-only` | 46/46 passed, desktop Edge + mobile viewport; fresh random MySQL, no Seed |

The first run exposed two fixture issues (compound MySQL CLI delimiter and an adapter idle timeout from holding a test lock across 100 other writes). They were corrected while retaining the throughput and short-lock assertions. A later mixed-history run passed cancellation 22/22 but hit the existing edit subprocess's 180-second limit while comparing the enlarged fixture tables. The final runner gives cancellation and existing write regressions separate random databases without deleting history or changing suite timeouts. Final cancellation coverage also includes the post-lock deadline test: 23/23 passed in 86 seconds. The complete command exited 0, preserving all thirteen historical business tables through migration twelve, with no pending migrations on repeat deploy and no Prisma schema difference. All runner-owned projects/volumes were removed afterward; the development volume was not addressed.

The initial independent whole-branch review reported no blockers. Both suggested tests (concurrent different cancellation reasons sharing a key, and paid cancellation final-stage rollback) were added and passed. A follow-up verified the no-Seed nested runner and the test-only payment writer's separate post-lock database-time query. Subsequent owner review found the ADMIN pending-verification eligibility mismatch; its correction and new verification are recorded below. The future payment service must still supply its own implementation and validation.

Original-worktree checks confirmed the same three unstaged layout files and identical SHA-256 values. Existing API/frontend PIDs 1936/1720 were preserved. Development .env was neither read nor modified; no development database/volume operation or service restart was performed. There is no development deployment or manual database setup in this PR. Future payment confirmation must implement the tested lock/deadline protocol in its own production transaction; refund confirmation, fulfillment and subscription entitlement remain out of scope.

### Review delivery

[PR #17](https://github.com/lear111/ai-membership-store/pull/17) merged into `main` using squash commit `56b0ba40ff803179bf8e2ce6849b345a0ec3caf9`. Implementation branch: `codex/order-cancellation-timeout`; final reviewed implementation commit: `28ba356fff092f3a928e792d81e8b3455119ee67`; 16 changed files. No GitHub CI checks were configured/reported; all results above are local isolated verification. The development database remains unmigrated and no deployment was performed.

## 12. PR #17 review correction — ADMIN pending verification (2026-11-19)

The original implementation incorrectly excluded ADMIN from the unpaid PENDING_VERIFICATION branch and included an HTTP test requiring that rejection. This restriction was not part of D16. Remove only that actor exclusion; D16 and all other lifecycle decisions are unchanged.

ADMIN may now cancel PENDING_VERIFICATION + NOT_STARTED ordinary orders when there are no confirmed payment facts. A nonblank reason remains mandatory. The existing transaction retains every PAYMENT row and its external evidence, changes all pending/unconfirmed attempts to FAILED, restores the order summary to UNPAID, sets fulfillmentStatus=CANCELLED, and atomically commits version+1, complete Revision, Event, ADMIN Audit and the original idempotency response. Already-FAILED attempts remain unchanged; REFUND rows are not touched. Confirmed PAYMENT status, a non-NULL transaction confirmedAt, or an order paidAt/paymentConfirmedAt still blocks the unpaid path. The established confirmed-paid cancellation path and REFUND_PENDING behavior are unchanged.

The real HTTP/MySQL regression verifies multiple pending attempts, missing/blank reason rejection without writes, full row/evidence preservation, full V2 snapshot and ADMIN history, replay with no extra history, and defensive rejection of inconsistent confirmation facts. Every ADMIN transaction-stage failure is now injected into a PENDING_VERIFICATION cancellation and compared across all business/history rows, followed by a clean same-key retry. Existing CUSTOMER pending-verification and SYSTEM expiry cases remain in the suite. Browser tests add ADMIN pending-verification cancellation through real cookies/CSRF/Vite proxy on desktop/mobile viewports.

Changed files in this follow-up: `backend/src/modules/orders/cancel.ts`, `backend/test/integration/order-cancellation.test.ts`, `e2e/order-cancellation.spec.ts`, `docs/05-api-contract.md`, and this contract/report. No migration, Schema, dependency, frontend business code or original checkout change; no development .env/database/volume access or Seed.

All results below were rerun for this review correction. Initial results in section 11 are historical and are not presented as rerun results.

| Command | Actual follow-up result |
|---|---|
| `npm run format:check` | Passed |
| `npm run typecheck` | Passed frontend, backend and E2E |
| `npm run lint` | Passed |
| `npm test` | Backend 37/37; frontend 9/9 |
| `npm run db:validate` / `npm run db:generate` | Passed; Prisma Client 7.10.1 |
| `npm run test:db -w backend -- --cancellation-only` | 92/92: read 14, edit 19, creation 15, Revision 9, subscription 10, cancellation/timeout 25; exit 0 |
| `npm run build` | Frontend and backend passed |
| `npm run test:e2e -w backend -- --cancellation-only e2e/order-cancellation.spec.ts e2e/order-creation.spec.ts e2e/order-edit.spec.ts` | 14/14 passed: cancellation 6, creation 4, edit 4, desktop Edge and emulated mobile viewport; exit 0 |

Before the production fix, the new pending-verification browser test reproduced HTTP 409 instead of the required 200 on both viewports. After removing the incorrect ADMIN exclusion, both cases and all selected order browser regressions passed. This follow-up reran those 14 relevant browser cases, not the entire original 46-case suite.

The database command used three random isolated MySQL 8.4 projects and retained all thirteen historical business tables/revisions through migration twelve. Repeat deploy had no pending migrations and Prisma schema diff passed. The browser command used a fourth independent fresh random project. No path executed Seed or read development .env; only runner-owned resources were removed. The original checkout still has exactly the same three layout edits with identical SHA-256 values. Existing CUSTOMER and SYSTEM pending-verification cases passed unchanged.
