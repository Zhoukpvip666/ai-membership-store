# Manual order fulfillment and initial subscription entitlement — implementation contract

- Document: MANUAL-FULFILLMENT-API
- Version: 1.0
- Status: Implemented and isolated acceptance passed; awaiting PR review; not deployed
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

1. Lock/read the AppSettings singleton row (id=1) with `FOR SHARE` after the Order and related PaymentTransaction locks. This prevents a settings update until commit while allowing independent fulfillments to read the same configuration. Read the current `timezone` setting and validate it using the repository's canonical IANA timezone validator/allowlist. Do not silently fall back to UTC or a process-local timezone if invalid; stop with a server configuration error and no writes.
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
4. For subscription orders, read-lock AppSettings singleton id=1 with `FOR SHARE` after the order/transaction locks, before checking the Subscription sourceOrderId claim. Settings writes must wait, but concurrent readers remain compatible.
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

## 12. Dependency and D86 preflight — 2026-11-19

This section records the earlier dependency-only increment. After subsequent owner approval, the exact tested resolver/calendar functions were promoted into `backend/src/modules/orders/service-period.ts`; the same unit tests now import that production module. Complete T19 implementation and subsequent validation are recorded in section 13.

### Dependency scope and runtime

- Add the backend runtime dependency `"@js-temporal/polyfill": "0.5.1"` with an exact version, without `^` or `~`.
- Root `package-lock.json` adds that backend declaration, polyfill 0.5.1 and its new transitive dependency `jsbi` 4.3.2. A structural comparison against the base lockfile confirms all 494 pre-existing package entries are unchanged apart from the new backend dependency declaration. No frontend/root dependency declaration or existing dependency version changes.
- Installation uses `npm install --workspace backend --save-exact --ignore-scripts --no-audit --no-fund @js-temporal/polyfill@0.5.1`. The complete existing toolchain is then restored from the updated lockfile with `npm ci --ignore-scripts --include=dev --no-audit --no-fund`. Lifecycle scripts are disabled; no environment file, migration or Seed is needed.
- Actual runtime: Node.js **v24.13.0**, ICU **77.1**, timezone data **2025b**. Use ESM `import { Temporal } from '@js-temporal/polyfill'`; the package does not install `globalThis.Temporal`. A fresh-process test verifies that import leaves any pre-existing global value unchanged.
- `getTimeZoneTransition` is present in the installed 0.5.1 runtime and TypeScript declarations. No built-in/global Temporal is assumed.

### Resolution tested

For a local calendar target, first resolve with explicit `disambiguation: 'earlier'`. If converting back yields the requested local time, it is an ordinary instant or the first occurrence of a fold. For a gap, the earlier candidate lies before the gap: call its `getTimeZoneTransition('next')` and use that exact boundary. Verify that the local times immediately before and at the boundary bracket the nonexistent target; reject if they do not. No manual offset arithmetic, host-local Date arithmetic, hourly/minute scanning, or silent UTC fallback is used.

Independent tests inspect the exact transition and the preceding nanosecond, their local wall times and UTC offsets for both New York gap/fold transitions. Lord Howe tests verify its 30-minute gap/fold rather than assuming every transition lasts one hour.

| Case | Requested local time | Expected and actual UTC |
|---|---|---|
| New York DST gap | 2026-03-08 02:30 | `2026-03-08T07:00:00.000Z` |
| New York DST fold, first occurrence | 2026-11-01 01:30 | `2026-11-01T05:30:00.000Z` |
| Lord Howe 30-minute gap | 2026-10-04 02:15:00.123 | `2026-10-03T15:30:00.000Z` |
| Lord Howe 30-minute fold, first occurrence | 2026-04-05 01:45:00.123 | `2026-04-04T14:45:00.123Z` |

The New York `later` result is explicitly asserted as `07:30Z` and rejected as the D86 gap answer. The correct result is local 03:00, the first valid instant after the transition, not local 03:30. Lord Howe `later` similarly yields 15:45:00.123Z rather than the required 15:30Z boundary. Gap inputs with milliseconds intentionally resolve to the exact `.000` boundary; ordinary and fold inputs preserve their milliseconds.

The 19 independent unit tests also cover ordinary local times and exact transition edges, UTC/Asia-Shanghai without future DST, original January-31 monthly anchors through February/March/April/May, leap-year February 29 and later restoration, MONTH/YEAR targets inside a gap/fold, fixed 24-hour DAY arithmetic across DST, explicit multi-unit counts, millisecond precision, invalid timezones/counts and out-of-range dates. Each calendar target is calculated from the original anchor, never from a previously clamped end. Production integration must still apply the existing canonical IANA timezone policy and freeze AppSettings.timezone inside the future transaction.

### Actual validation

```powershell
node --test backend/test/manual-fulfillment-timezone.test.ts
```

Result on Node 24.13.0: **19/19 passed**, no skipped tests. This is a dependency/arithmetic preflight, not an HTTP or database fulfillment acceptance result. No development `.env` is read; no database connection, Seed, migration, original Docker volume operation or running-service change is performed. No PR, push, merge or deployment is included in this increment.

The same 19 tests also pass independently with child-process host timezone `TZ=UTC` and `TZ=Pacific/Honolulu` (19/19 each), without changing the operating-system timezone. Supporting checks actually executed in this increment:

| Command | Actual result |
|---|---|
| `npm run db:generate` | Prisma Client 7.10.1 generated offline; no database access |
| `npm test` | Backend 64/64 (including 19 preflight tests); frontend 9/9 |
| `npm run typecheck` | Passed frontend, backend and E2E TypeScript checks |
| `npm run lint` | Passed |
| `npm run build` | Frontend and backend passed; existing third-party Zod/Rollup annotation warnings |
| `npm run format:check` | After LF normalization, only unchanged baseline `README.md` fails because of an extra blank line; not altered in this increment |
| `node node_modules/prettier/bin/prettier.cjs --check backend/package.json backend/test/manual-fulfillment-timezone.test.ts` | Passed both changed backend files |

The initial format check reported Windows Git CRLF checkout endings rather than content changes. Only this newly created worktree's unmodified tracked files were normalized to their exact LF HEAD contents after byte comparisons; the original shopping worktree and its three layout edits were untouched. A separate Prettier check of `git show HEAD:README.md` reproduces the remaining README format failure, and the working README exactly matches HEAD (the formatter would remove one blank line). No tracked content change outside the four intended files is included. Database integration and browser E2E tests were not run in this dependency-only increment.

## 13. T19 implementation report — 2026-11-20

### Delivered behavior

- `fulfill-schemas.ts` and the existing ADMIN router provide the strict POST contract in sections 2/9: expectedVersion, mandatory actor-scoped key, optional normalized fulfillmentNote, no query or managed-field overrides. Existing persisted Session, ADMIN role, CSRF, rate limiting and no-store middleware remain in force. No customer fulfillment route is added.
- `fulfill.ts` uses the existing serializable mutation helper. It locks Order, every PaymentTransaction in ID order and, for INITIAL, AppSettings id=1. It rechecks version, ordinary source/kind, terminal/cancellation facts, sourceOrderId consumption, exact paid receipt or transaction-free zero-price eligibility. No 24-hour fulfillment cutoff is added. Invalid or missing snapshots/configuration fail before any committed write.
- The single DB `UTC_TIMESTAMP(3)` becomes fulfilledAt and every new start/anchor/current-period-start and explicit history timestamp. INITIAL uses the approved `service-period.ts` arithmetic and freezes canonical IANA settings at that instant; ONE_TIME does not need billing settings. Aliases are canonicalized against the runtime IANA names plus the existing supported UTC/Etc-GMT names. Invalid zones never fall back silently.
- INITIAL copies frozen Order product, price, period, form Schema/data and renewal-price snapshots, initializes all ORDER billing/renewal fields and creates one unique sourceOrderId entitlement. Current Product values and account activation status after purchase do not rewrite that history. ONE_TIME creates no entitlement or subscription history. Neither branch inserts/updates payment evidence.
- Subscription, Order/version, complete V+1 Revision, COMPLETED event, optional CREATED subscription event, separate entity audits and original response commit together. Safe before/after event/audit JSON excludes form values, payment evidence and private internal notes. The separate subscription DTO has an explicit complete field whitelist. Existing Phase 2 ADMIN/SYSTEM subscription code is unchanged.

### Isolation and acceptance coverage

`--fulfillment-only` extends the existing runner without Seed. HTTP regression first runs read/edit/create/revision/subscription/T16/T17/T18 suites in their own fresh random projects, then runs the existing populated migration-twelve upgrade/data-preservation check, repeat deploy/schema comparison and T19 HTTP suite in another random MySQL 8.4 project. An explicit `--focused` skips only the prior suites for targeted T19 debugging; omitting `--fresh` still exercises the populated upgrade. Default full regression remains unchanged. The browser mode gives desktop/mobile Edge separate disposable databases. All environment files and credentials are generated outside the checkout; no development `.env`, database, service or original volume is used.

The HTTP suite covers authorization, strict input, frozen snapshot copying after Product changes/archive, paid and zero INITIAL/ONE_TIME, receipt/refund anomalies, pre-existing sourceOrderId uniqueness, hidden system renewal exclusion, settings failures/aliases, unchanged disabled purchased accounts, original-response replay after API reconstruction, same/different-key races and more simultaneous independent requests than pool connections. A real T16 cancellation competes for the same parent lock; completed orders reject T18 refund registration.

Eight SQL failure triggers independently abort Subscription INSERT, Order UPDATE, Revision INSERT, OrderEvent INSERT, SubscriptionEvent INSERT, Order Audit INSERT, Subscription Audit INSERT and IdempotencyRecord INSERT. Every failed HTTP request compares all business tables and immutable revisions with its pre-request snapshot, then the same key succeeds after removing only that test trigger. Existing CHECK/version/immutable-history triggers are never disabled or loosened.

Calendar HTTP tests use a real MariaDB adapter `initSql: SET timestamp=...` on that test client's own connections. Production code still obtains MySQL `UTC_TIMESTAMP(3)` and persists the result. These cases cover New York gap/fold, original January-31 anchors, leap-day restoration, Lord Howe's 30-minute gap, fixed DAY arithmetic and milliseconds; separate unit tests directly inspect transition boundaries. This is not a mocked Prisma service or injected production clock. Browser tests use actual fetch, Session cookies, CSRF and Vite proxy with real isolated DB assertions, without adding order-management UI.

### Actual validation

All checks use Node **v24.13.0**. A prior format failure caused by the baseline README blank line is corrected while updating that requested README; no original-worktree file is reformatted.

| Executed command/check | Actual result |
|---|---|
| `npm run format:check` | Passed for the whole worktree |
| `npm run typecheck` | Passed frontend, backend and E2E TypeScript |
| `npm run lint` | Passed; repeated after the final HTTP assertions |
| `npm test` | Backend **67/67**, frontend **9/9**, no skipped tests |
| `npm run build` | Frontend Vite and backend TypeScript passed |
| `npm run db:validate` | Passed offline; no database connection |
| Production timezone unit suite under `TZ=UTC` and `TZ=Pacific/Honolulu` | **19/19** independently in each environment |
| `npm run test:e2e -w backend -- --fulfillment-only` | Edge desktop **4/4** and mobile viewport **4/4**, total **8/8**; both use real isolated HTTP/MySQL |
| `npm run test:db -w backend -- --fulfillment-only --focused` | **21/21** T19 HTTP tests; populated migration-twelve upgrade preserved all business rows/revisions; repeated deploy and Schema comparison passed |
| `npm run test:db -w backend -- --fulfillment-only` | **156/156**, exit 0: read **14/14**, edit **19/19**, creation **15/15**, revisions **9/9**, subscriptions **10/10**, cancellation **25/25**, payment **25/25**, refunds **18/18**, fulfillment **21/21**; historical upgrade/data retention, repeat deploy and Schema comparison passed |

The build reports existing third-party Zod/Rollup PURE-annotation warnings; builds succeed without changing those dependencies. The two viewport projects are browser emulation, not a physical-device acceptance test.

An initial aggregate run passed all 135 prior regression cases but exposed one intermittent 503 among eight independent fulfillment requests. The targeted suite then passed, including six successive eight-request batches. An additional deterministic shared-settings-reader case exposed the unnecessary exclusive settings lock: waiting readers reached the existing 3000ms socket boundary and a real driver connection closed (45013). The service now uses a transaction-held shared settings lock and checks sourceOrderId after the required locks. It still prevents concurrent settings edits, preserves the Order → PaymentTransaction → AppSettings sequence and leaves all connection timeouts, transaction retry limits, checks and uniqueness constraints unchanged. The final tests retain six batches and the shared-reader case. Temporary diagnostics were removed; tests use the original real Prisma client, no query replacement or Mock.

A subsequent attempt overlapped three isolated MySQL workflows and native checks on this 16-GiB host. It encountered another pool-stress 503, an existing environment-test child-process timeout and the existing nested regression's 600-second aggregate limit. The exact environment suite passed 5/5 on its own. After all browser/database workflows ended, the targeted historical-upgrade/T19 run passed 21/21 (including all 48 independent requests and the held shared-reader case), and the normal `npm test` command passed backend 67/67 and frontend 9/9. Tests and assertions were not weakened, and production connection limits/timeouts were not increased. Parallel overload failures are recorded separately from these successful serial results; the original 503 was not retrospectively assigned an unobserved driver error.

The final complete `--fulfillment-only` aggregate was then run by itself and exited 0 with all 156 tests passing, including the final 21-case fulfillment suite. Its populated upgrade retained all thirteen business tables and immutable revisions, repeated deployment had no pending migrations, and the database matched Prisma Schema. Each disposable project was removed by its own runner. Existing individual-suite and nested regression budgets were retained. This final run supersedes the unsuccessful aggregate attempts; it does not claim unlimited-load or production deployment acceptance.

### Files and remaining boundary

- Backend runtime: `backend/src/modules/orders/fulfill.ts`, `fulfill-schemas.ts`, `service-period.ts`, and `routes.ts`.
- Test runner/cases: `backend/scripts/test-database.ts`, `backend/test/manual-fulfillment.test.ts`, `backend/test/manual-fulfillment-timezone.test.ts`, `backend/test/integration/manual-fulfillment.test.ts`, `e2e/manual-fulfillment.spec.ts`.
- Exact dependency/lock: `backend/package.json`, root `package-lock.json`. Only Temporal 0.5.1 and its new transitive jsbi 4.3.2 are added; existing dependency versions are unchanged.
- Documentation: this report, README, data model, API contract and roadmap (16 changed/new files in total).

No Schema/Migration change: all twelve committed migrations are retained verbatim. No development deployment, frontend page, renewal/SYSTEM_RENEWAL handling, refund behavior change, automatic fulfillment, provider API, email or notification is included. Original shopping Header/Sidebar/layout documentation hashes are unchanged. Database/service deployment and any subsequent task require separate operator authorization after PR review.
