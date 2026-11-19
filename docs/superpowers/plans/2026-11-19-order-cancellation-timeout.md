# Order cancellation and timeout implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. This task is executed in the current session under the user's approved T16 contract.

**Goal:** Implement the two manual cancellation endpoints and the minute SYSTEM timeout worker under D65–D69.

**Architecture:** Reuse persisted Session/role/CSRF guards, serializable mutation transactions and the immutable V1 snapshot builder. Manual paths and worker share the locked state-transition implementation; the worker selects bounded candidates and processes each in a separate SKIP LOCKED transaction. Reuse the existing scheduler lifecycle without changing subscription logic.

**Tech Stack:** Node.js 24, TypeScript, Express, Prisma 7.10.1, MySQL 8.4, Playwright.

**Spec:** [Approved T16 contract](../../21-order-cancellation-timeout.md).

## Global constraints

- Do not modify any of the twelve historical migrations or Prisma Schema; stop if an existing constraint prevents the approved transition.
- Never read development .env, connect to the development database, run Seed, or touch existing Docker volumes.
- Preserve original checkout, three layout edits and running services; use codex/order-cancellation-timeout only.
- No payment/refund confirmation, fulfillment, entitlement, notifications or order-management UI.

## Review focus

- A PAID summary alone is insufficient: require exactly one confirmed full PAYMENT matching amountFen, paidAt and paymentConfirmedAt.
- Pending attempts must become FAILED atomically, while external references, amounts, occurrence times and confirmed records remain unchanged.
- Manual retries must replay their original role-safe DTO after cancellation; SYSTEM must never invent an actor or idempotency/audit row.
- A bad oldest row or a locked row must not prevent other candidates from completing; cap each minute at 100 candidates and retry failures on the next scan.
- Demonstrate the future payment writer's same-order-lock protocol with a test-only transaction; do not claim a production payment endpoint exists.

### Task 1: Manual cancellation transaction and HTTP contracts

**Files:** create orders/cancel-schemas.ts and orders/cancel.ts; modify orders/routes.ts; add backend/test/order-cancellation.test.ts and backend/test/integration/order-cancellation.test.ts.

**Interfaces:** orderCancellationService(database) takes role, parsed intent, orderId, authenticated actorId, key and requestId, returning the existing {order} DTO. cancelLockedOrder(tx, order, actor) shares the transition/history implementation with SYSTEM.

- [x] Add strict request-schema tests for positive expectedVersion, normalized optional CUSTOMER reason, mandatory ADMIN reason and rejected managed fields.
- [x] Implement owned row locking, exact state/payment-fact validation, one versioned cancellation update, pending-attempt closure and Revision/Event/ADMIN audit within mutation().
- [x] Test real HTTP authorization, all approved/rejected states, reason rules, exact DTOs, original immutable fields, concurrent versions/keys and rollback at every write.

### Task 2: Bounded SYSTEM worker and server lifecycle

**Files:** create orders/timeout.ts; modify backend/src/server.ts; add timeout tests to the same guarded integration suite and scheduler unit file.

**Interfaces:** orderTimeoutService(database) returns sweep(): Promise<{scanned,cancelled,failed}>. startOrderTimeoutScheduler(sweep,onError) returns an asynchronous stop function.

- [x] Select at most 100 visible expired USER/ADMIN ordinary candidates in database-time/order order; recheck under FOR UPDATE SKIP LOCKED in a per-order transaction.
- [x] Test exact 24-hour boundary, pending-verification closure, NULL SYSTEM actors, failed-row continuation/retry, two worker instances, repeated/restarted scans and manual/timeout races.
- [x] Use test-only payment confirmation transactions to exercise both lock winners and post-cancellation rejection, with complete history/fact rollback assertions.
- [x] Start immediately and every 60000ms; suppress overlap locally only for resource control. Stop both subscription and order schedulers before database disconnect; test startup, timer and in-flight stop behavior.

### Task 3: Isolated regressions, report and PR

**Files:** modify backend/scripts/test-database.ts; add e2e/order-cancellation.spec.ts; update README, model/API/roadmap, lifecycle decisions' implementation status and docs/21 implementation report.

- [x] Add no-Seed --cancellation-only mode with pristine read regression and separate random databases for existing edit/create/revision/subscription regression and cancellation. Preserve existing historical upgrade/repeat deploy/schema-diff assertions.
- [x] Run backend/frontend unit tests, real isolated MySQL HTTP tests and full desktop/mobile E2E. Keep builds outside any active preview run.
- [x] Run Prisma validate/generate, format:check, typecheck, lint and both builds. Record actual totals and any corrected failures without weakening assertions.
- [x] Compare all twelve migrations/Schema/dependencies/frontend source and original layout hashes; review tracked and untracked changes.
- [ ] Explicitly stage task files, commit, push and create one PR targeting main; verify file count/CI/clean feature worktree. Do not merge or start the next stage.

## Execution evidence

- Task 1 / Task 2 complete: scheduler/schema units 3/3; final isolated real HTTP/MySQL cancellation suite 23/23, including the two independent-review suggestions (same-key different-intent concurrency and paid final-stage rollback), plus the post-lock database-time deadline regression.
- Shared interface verified: both callers acquire the same Order lock before cancelLockedOrder; only SYSTEM uses the database-time timeout predicate and NULL actor. Manual paths retain the existing actorUserId-scoped original-response idempotency helper.
- First isolated run exposed test-harness failures: an idle lock-holder connection across 100 separate writes exceeded the adapter idle limit; a compound injection trigger needed the MySQL CLI DELIMITER. Split bounded-throughput and short lock-skip assertions, and fixed the fixture delimiter; retained all assertions. Second cancellation run passed every test.
- Independent fresh-context review and follow-up found no blocking issues; both nonblocking test suggestions implemented and exercised.
- Checkout CRLF caused format warnings. Normalized only this new worktree's text line endings; verified/staged only byte-identical existing Git objects to refresh stat entries. No unrelated content changed, and original checkout hashes/PIDs remain unchanged.
- Final validation passed: backend units 37/37, frontend units 9/9, isolated database regression 90/90, Edge desktop/mobile E2E 46/46, Prisma validate/generate, format, typecheck, lint and both builds. Exact command outcomes are in docs/21. Delivery evidence follows publication.
- Task 3 ruling: cancellation fixtures must not precede the old write suites in their shared database. Those suites compare every row after rejection; accumulated immutable cancellation history caused the existing edit subprocess to hit its unchanged 180-second guard. Nest the existing --edit-only no-Seed mode first, then run cancellation in another random database. Preserve all test assertions, process timeouts and protected history.
