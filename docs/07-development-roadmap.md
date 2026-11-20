# Development Roadmap

## Order creation API — merged

**Status: Merged in PR #11 (`b1f5d14`); historical and fresh isolated verification passed. Development database remains unmigrated.** [Implementation contract](19-order-creation-api.md).

- Implement POST `/customer/orders` and POST `/admin/orders` only; retain existing GET routes.
- USER self-order requires ACTIVE account and listed/unarchived Product. ADMIN may target ACTIVE/PENDING_ACTIVATION CUSTOMER and listed/unlisted unarchived Product; DISABLED/archived are rejected.
- Both routes validate complete required formData against the Product schema inside the transaction and freeze Product/form snapshots.
- ADMIN must submit final amountFen; the future integrated UI must pre-fill current Product.priceFen. Any deviation requires a reason. USER amount is server-derived.
- Create Order V1, OrderRevision V1, OrderEvent, ADMIN-only audit and generic actorUserId idempotency response atomically.
- Return complete role-safe order resource DTO with HTTP 201. Exact idempotent replay retains the original response; clients may GET detail for a fresh countdown.
- No order edit/cancel/expiry worker/payment/refund/fulfillment/renewal/frontend integration or development DB migration.
- Twelfth incremental migration adds NOT_REQUIRED and compatible zero-price/revision CHECKs; no historical rewrite or development deployment.
- Implementation merged; actual isolated HTTP/MySQL, concurrency/replay/rollback, DTO, browser and regression results are recorded in the implementation report.

## Order edit API — merged

**Status: T15 merged in PR #14 (`5826593`); isolated regression passed. No development database deployment.** [Implementation contract and actual validation](20-order-edit-api.md).

- PATCH `/customer/orders/:id`: owner-only formData complete replacement.
- PATCH `/admin/orders/:id`: formData complete replacement and optional amountFen change in one atomic edit.
- Both require expectedVersion + Idempotency-Key; stale concurrent edits return 409.
- Use frozen formSchemaSnapshot, append exactly one OrderRevision per successful edit, one OrderEvent and ADMIN-only audit.
- internalNote remains a separate D48 endpoint; it still increments Order.version and appends Revision/Event/AdminAuditLog atomically, but is outside T15.
- If ADMIN changes an eligible UNPAID order amountFen to 0, the same transaction changes it to NOT_REQUIRED + PROCESSING (D64); paid orders cannot be converted this way.
- Implementation merged; no development database deployment.

T15 reuses all twelve committed migrations unchanged. Actual amount changes require a reason; supplied reasons without a price change are rejected, as are effective no-ops. Database-time eligibility is checked after the row lock and again in the conditional UPDATE. Fault-injection, real concurrent HTTP, exact DTO/replay and desktop/mobile browser coverage accompany the implementation. The read regression suite runs in its own isolated database to retain its complete-dataset assertions without deleting protected order history. No internal-note, cancel, timeout, payment, fulfillment or frontend order-management feature is included.

## Order cancellation and timeout — merged

**Status: T16 merged in PR #17 (`56b0ba40`); ADMIN pending-verification correction included; final isolated regression passed. No development database deployment.** [Implementation contract and validation](21-order-cancellation-timeout.md).

- POST `/customer/orders/:id/cancel`: owner-only cancellation of eligible unpaid order; reason optional.
- POST `/admin/orders/:id/cancel`: ADMIN cancellation of eligible unpaid, paid-before-fulfillment or zero-price order; reason mandatory.
- Both require expectedVersion and Idempotency-Key; cancellation is terminal and versioned.
- Paid cancellation enters CANCELLED + REFUND_PENDING; confirmed payment transaction is retained. Refund completion is separate and not included.
- Zero-price cancellation follows D53; no refund.
- SYSTEM timeout worker runs every minute using DB UTC time; cancels expired UNPAID/PENDING_VERIFICATION ordinary orders, closes pending payment attempts as FAILED, and writes SYSTEM Revision/Event without AdminAuditLog.
- Payment confirmation, refund, fulfillment, notifications and frontend remain out of scope. Stop at PR review; no development DB deployment.

Reuses all twelve migrations unchanged. Both manual handlers share the locked atomic cancellation service, with normalized original-response idempotency and exact role-safe DTOs. The worker processes at most 100 deterministic candidates per minute, with per-order SKIP LOCKED transactions, SYSTEM NULL actors, per-row rollback/retry and graceful shutdown. Real HTTP/MySQL tests cover payment facts, pending-attempt closure, all-stage fault injection, manual/worker/payment-lock races, repeated scans and existing write/read/subscription regressions. Payment-race tests use a synthetic writer only; no production payment-confirmation API is implemented.

## T17 offline payment attempts and confirmation — merged

**Status: Merged in PR #20; implementation and isolated validation recorded in [T17 report](22-offline-payment-api.md). No development deployment.** [Implementation contract and actual results](22-offline-payment-api.md).

- ADMIN-only GET payment attempts; POST register PENDING; POST confirm full payment; POST mark one attempt FAILED.
- Registration is separate from confirmation. Amount mismatch may be recorded as PENDING but must fail verification; never rewrite actual amount.
- Confirmation requires exact amount, no other PENDING attempts, no confirmed payment facts and DB time strictly before original 24-hour deadline.
- Failure requires a reason, preserves original payment evidence and recomputes order summary based on remaining PENDING/confirmed attempts.
- Every successful register/confirm/fail operation increments Order.version once and writes Revision/Event/AdminAuditLog/idempotency atomically.
- Payment routes lock Order before PaymentTransaction, matching T16 timeout/cancellation. No payment gateway, refunds, fulfillment, subscriptions or frontend UI.
- Reuses all twelve migrations unchanged; stop at PR review and do not deploy to development DB. Use `npm run test:db -w backend -- --payments-only` for historical-upgrade and existing order/subscription regression, and `npm run test:e2e -w backend -- --payments-only` after building for fresh desktop/mobile browser checks. No Seed or development configuration is used.

## T18 offline refund management — merged

**Status: Merged in PR #23 (`e9cb429f`); 135/135 isolated HTTP regression and 22/22 focused desktop/mobile browser regression passed. No development database deployment.** [Full implementation contract and validation](23-offline-refund-api.md).

- ADMIN-only GET refund attempts; POST register externally initiated full refund as PENDING; POST confirm after verifying actual return; POST fail with mandatory reason.
- Only CANCELLED + REFUND_PENDING orders with exactly one confirmed full PAYMENT are eligible. No refunds for completed fulfillment or zero-price orders.
- Refund amount and channel must exactly match the original confirmed PAYMENT.
- At most one PENDING REFUND and one CONFIRMED full REFUND per order. FAILED attempts remain in history and may be retried with a new attempt.
- PENDING does not mean money returned. Confirmation changes paymentStatus to REFUNDED while fulfillmentStatus remains CANCELLED.
- Every successful mutation increments Order.version once and writes Revision/Event/AdminAuditLog/idempotency atomically. Lock order remains Order -> PaymentTransaction, matching T16/T17.
- No partial refunds, provider APIs, money movement, fulfillment or subscription work. All twelve migrations unchanged; stop at PR review and do not deploy to development DB. Use `npm run test:db -w backend -- --refunds-only` for isolated HTTP refund and existing regression; browser checks use the same no-Seed runner.

## T19 manual fulfillment and initial subscription entitlement — merged

**Status: Merged in PR #26 (`b64d608a`); 156/156 isolated MySQL regression, 8/8 desktop/mobile E2E and all unit/type/lint/format/build/Schema checks passed. No development database deployment.** [Implementation contract and actual verification](24-manual-fulfillment-api.md).

- ADMIN-only POST `/admin/orders/:id/fulfill`; supports ordinary USER/ADMIN INITIAL subscription and ONE_TIME orders only. RENEWAL and SYSTEM_RENEWAL are excluded.
- Eligible paid orders require PAID + PROCESSING and exactly one matching confirmed full PAYMENT. Zero-price orders require NOT_REQUIRED + PROCESSING, amount=0, NULL payment times and no transaction rows.
- ONE_TIME completes without Subscription. INITIAL creates one unique sourceType=ORDER Subscription, copying every frozen Order product/period/form snapshot; no merging or extension of existing subscriptions.
- startedAt, billingAnchorAt and currentPeriodStartAt equal the same DB UTC fulfilledAt. AppSettings.timezone is read and frozen at fulfillment. DAY is fixed 24-hour duration; MONTH/YEAR use timezone-aware calendar arithmetic with original day anchor, month-end clamp and defined DST behavior.
- One transaction commits Order COMPLETED/version/Revision/Event, optional Subscription + CREATED SubscriptionEvent, separate Order and Subscription AdminAuditLog rows, and idempotency response. Any failure rolls back all writes.
- No fulfillment FAILED state; undeliverable orders reuse T16 cancellation and T18 refund. No renewal, system renewal, subscription expiry worker, supplier API, customer subscription UI or notifications.
- No migration expected. Stop at PR review; no development database deployment.

## T20 administrator order center — approved design, implementation not started

**Status: D89-D97 confirmed and documented; awaiting one implementation PR.** [Full implementation contract](25-admin-order-center.md). No development database deployment.

- Replace only the ADMIN `/admin/orders` Mock page with a real API-driven order workspace; keep the CUSTOMER order page and operating overview unchanged.
- Reuse T14-T19 create/edit/cancel/payment/refund/fulfillment APIs. Add only ADMIN OrderEvent timeline GET, minimal linkedSubscription detail summary, frozen productType list filter, and D48 internal-note PATCH.
- The list uses separate payment/fulfillment states; `fulfillmentStatus=PROCESSING` includes PAID and NOT_REQUIRED zero-price orders.
- The detail includes safe order/customer/form snapshots, payment/refund evidence, linked subscription summary, internal note and a safe OrderEvent timeline. Never expose raw event JSON, AdminAuditLog or OrderRevision; D41 remains active.
- Internal-note update is ADMIN-only, allowed for visible USER/ADMIN orders including terminal states, requires expectedVersion and Idempotency-Key, increments version once, and writes complete Revision/Event/Audit/idempotency atomically. SYSTEM_RENEWAL remains immutable.
- Refund is only available after cancellation to REFUND_PENDING; fulfillment reuses T19. Unsupported renewal/system/legacy states are read-only.
- Add desktop/mobile E2E for create → payment → fulfillment and cancel → refund, plus note/version/idempotency and safe timeline tests.
- No Prisma Schema/Migration or new dependency expected. No customer UI, overview, online payment, supplier, email, renewal or deployment work.

## Order revision / generic idempotency foundation

**Status: Merged in PR #9; development database migration remains a separately authorized operation.** [Schema, immutable history and test guide](18-order-revision-foundation.md).

- Eleventh incremental migration: Order.version, strict V1 append-only OrderRevision, in-place actorUserId idempotency rename. Ten historical migration files unchanged.
- Existing order GET DTOs add version and server-derived deadline/countdown; ADMIN additionally receives internalNote, CUSTOMER excludes it.
- New isolated historical/fresh tests and existing subscription idempotency/read API regressions; no order write API or frontend change.
- Order creation has since been implemented in PR #11; the next lifecycle stage requires separate authorization.

## Order API stage 1 — lists and details

**Status: Implemented for owner acceptance after merged model PR #6.** [Contract and isolated verification](16-order-read-api.md).

- ADMIN and Session-authenticated CUSTOMER order list/detail GETs only; hidden=false in every database predicate, CUSTOMER ownership derived only from Session.
- Strict pagination/search/kind/payment/fulfillment/sort filters; explicit per-role snapshot DTOs without authentication/audit data (subsequent foundation adds ADMIN-only internalNote) or current-Product substitutions.
- Random isolated MySQL8.4 HTTP tests, including all-table preservation after reads; orders-only runner executes no Seed and never uses development configuration.
- No order creation/edit/cancellation/payment/fulfillment/renewal, frontend page, database migration or development data change. Stop for acceptance; no automatic next stage.

## T13 — Product structured service periods

**Status: Product periods merged in PR #8 (`c426ae0`); order creation is merged as described above.** See [T13 contract and isolated verification](17-order-creation-and-lifecycle-design.md#g-商品周期能力缺口创建订单前置任务).

- Product ADMIN API/DTO/editor expose DAY/MONTH/YEAR and positive integer count; termLabel remains descriptive.
- New subscriptions require complete periods. ONE_TIME stores NULL periods and renewal price. Type changes validate the merged record.
- Legacy NULL/NULL subscriptions can save unrelated edits without inference. Explicit period edits require both valid fields; future order creation must reject unknown periods.
- No Schema/Migration/dependency changes. Unit, real HTTP isolated MySQL and desktop/mobile browser regression use the no-Seed `--products-only` runner.

## Order/subscription refactoring — Stage 1 database foundation

**Scope: schema/migration/compatibility/tests only; review before further development.** See [stage guide](15-order-subscription-foundation.md).

- Structured DAY/MONTH/YEAR periods and quantities; retain termLabel and unknown legacy NULLs.
- Order product/period/form/data snapshots; USER/ADMIN/SYSTEM_RENEWAL origins, hidden renewals, lifecycle times and USER/ADMIN/SYSTEM events.
- ORDER subscription source requiring a unique source order, frozen billing period/anchor/timezone, current cycle and early-renewal marker. Retain legacy unlinked ADMIN/SYSTEM records.
- Site-wide plain-text paymentInstructions; preserve PaymentTransaction and all old states/records.
- Fifth foundation, sixth review-integrity, seventh actual-payment-time, eighth explicit-source-guard, ninth immutable-source/history-protection and tenth final-source migrations; verify all twelve populated legacy business tables, repeated deploy and fresh installation in isolated MySQL 8.4 only.
- Review follow-up: strict source/kind/visibility, complete ORDER subscriptions, validated timezone, independent billingRevision/explicit renewal eligibility, immutable renewal target/anchor/revision snapshots, two durable unique cycle claims and paid-renewal update/delete guards.
- P1 final-state and payment-time repair: SYSTEM_RENEWAL INSERT requires PAID/COMPLETED and non-NULL paidAt <= paymentConfirmedAt <= fulfilledAt with no cancellation; keep immutable triggers. paidAt is actual payment, matching the confirmed PAYMENT's occurredAt in the future transaction; PaymentTransaction.createdAt is entry time. Retain deprecated paymentRecordedAt unchanged and unused by new flows. Verify populated upgrades and fresh installs with --models-only (no Seed), including rejected intermediate states, distinct occurrence/entry/confirmation times and complete transaction rollback.
- Verification includes populated upgrades through the tenth migration after explicit disposable test-order cleanup and fresh ten-migration installation, SQL rejection/immutability/concurrent uniqueness/transaction rollback fixtures. No historical actual payment time is inferred or backfilled.
- Final-source model: only USER/ADMIN/SYSTEM_RENEWAL; retire the old source and every exemption/special trigger. Keep permanent source identity, all-order DELETE/REPLACE protection and the original renewal guards. Nullable ENUM storage plus a required-source Trigger/CHECK rejects missing/NULL/invalid sources under strict and non-strict SQL.
- Preserve the first nine migration files, including the first four published on main. Migration ten fails fast while retired-source orders exist. Verify old migration compatibility before explicit isolated-fixture cleanup, then compare all twelve business tables through the final upgrade; never inspect or clean development data in this task.
- No new page, order/payment API, calendar algorithm, automatic fulfillment or renewal worker. Do not begin the next service stage without approval.

The new business target is order → confirmed full offline payment → fulfillment → order-linked subscription. Older direct-subscription descriptions below document the Phase 2 compatibility runtime, not the future workflow.

## Phase 2 — User Model Refactoring & Subscription Management Core

**Status: Merged; preserved as compatibility runtime while the model stage above is reviewed.** [Design, migration, tests and operation guide](14-user-subscription-core.md).

This separately authorized phase supersedes the earlier order-first subscription sequence. Deliver user names/privacy, additive migration with SUSPENDED preflight, immutable subscription snapshots/eight-type form data, ADMIN list/create/detail/edit/renew/terminate/history, optimistic versions, persistent idempotency and minute expiry termination. Preserve accounts/sessions/invitations/history. Only isolated databases are migrated/tested; development migration is a manual post-review step. Run format/typecheck/lint/unit/database/E2E/build. Stop at a new PR; no order/payment, notification, verification-code, API-key or upstream work.

## Delivery rules

- Implement one task at a time.
- Do not skip acceptance criteria.
- Do not implement online payment, supplier API, SMTP, or deployment during the local offline operations milestone.
- Keep docs synchronized with implementation.
- Owner reviews each milestone/PR before the next substantial task.

## Architecture decision — single merchant

**Status: Confirmed by owner**

- [x] One site owner is the only merchant.
- [x] Customers are buyers only; no customer sub-merchant accounts.
- [x] No multi-merchant onboarding, merchant wallets, merchant balances, merchant withdrawals, or split settlement.
- [x] Payment provider account and settlement relationship belong to the site owner.
- [x] Provider-level delayed settlement/held funds are optional external capabilities, never simulated by application order status.

## Phase 0 — Planning baseline

**Status: Complete**

- [x] Record business model and manual fulfillment workflow.
- [x] Define customer pages and one unified owner/admin console.
- [x] Define subscription versus one-time product behavior.
- [x] Define proposed stack and modular-monolith architecture.
- [x] Define initial domain model and API contract.
- [x] Define security boundaries and launch gates.
- [x] Create roadmap and Codex instructions.

## Phase 1 — Repository scaffold and local operations

**Status: Tasks 1.1–1.2.2 merged; Task 1.2.3 implemented for owner review. Task 1.2.4 has not started.**

### Task 1.1 — Responsive Mock UI prototype

**Status: Complete.** See [Task 1.1 implementation report](09-task-1.1-report.md).

- Vue 3 + TypeScript + Vite frontend.
- Node.js 24 + TypeScript + Express health API.
- MySQL 8.4 Docker Compose development service.
- Customer storefront and unified owner/admin console with Mock data.
- Responsive desktop/mobile layouts and local interactions.
- No business database, authentication, payment, email, or supplier integration.

### Task 1.2 — Local offline customer and order management

**Status: Database foundation and authentication/customers/invitations merged; product/settings persistence and form configuration implemented for owner review. Later subtasks have not started.**

Use [10-local-operations-mvp.md](10-local-operations-mvp.md) as the scope and implementation source of truth. Use [04-data-model.md](04-data-model.md) for the database model and [05-api-contract.md](05-api-contract.md) for API boundaries.

The target is a usable local application for managing existing customers who pay offline. It is not deployed and is not an online store yet.

#### Task 1.2.1 — Prisma and local database foundation

**Status: Complete, reviewed before Task 1.2.2 was authorized.** Historical schema/verification report: [11-database-foundation.md](11-database-foundation.md).

- Add Prisma and a MySQL datasource.
- Implement all 11 models in docs/04-data-model.md.
- Add an initial migration and migration scripts.
- Add environment validation for DATABASE_URL, APP_BASE_URL, ADMIN_EMAIL, and ADMIN_PASSWORD.
- Add database readiness to the health endpoint.
- Add an idempotent seed for exactly one ADMIN account. Do not overwrite an existing admin password on each seed run.
- Keep services bound to loopback for local use.
- Do not implement business CRUD, customer activation UI, online checkout, email, or payment/supplier integrations in this subtask.

Acceptance:
- Migration succeeds against a clean MySQL 8.4 volume.
- Re-running migration/seed is safe.
- Seed creates one ADMIN with a hashed password from local env configuration.
- Database health is reported accurately; API health does not claim DB-ready when DB is unavailable.
- Environment errors fail clearly without printing secrets.
- Format, typecheck, lint, tests, build pass.
- Stop and wait for owner review.

#### Task 1.2.2 — Authentication, customers, and invitations

**Status: Merged and separately followed by owner-authorized Task 1.2.3.** Historical report: [12-authentication-customers-invitations.md](12-authentication-customers-invitations.md).

- Implement admin login/logout/me with server-side sessions.
- Implement admin customer creation/edit/disable.
- Create customers as PENDING_ACTIVATION with nullable passwordHash.
- Generate/reissue/revoke one-time invitation links; store only token hashes.
- Add customer activation page and login.
- Allow subscriptions/orders to reference pending customers.
- No email sending of any kind.

Acceptance:
- Admin APIs reject unauthenticated/non-admin requests.
- Invitation is one-time, expires after 7 days, and reissue revokes prior unused token.
- Admin can copy the raw invitation URL once.
- Pending customer can own order/subscription records.
- No email is sent.
- Localhost-link reachability limitation is shown.

#### Task 1.2.3 — Product and settings persistence

**Status: Implemented for owner review.** See [13-products-settings-forms.md](13-products-settings-forms.md). Stop after this PR; do not start Task 1.2.4.

- Replace product Mock state with database-backed CRUD.
- Persist only listed (catalog visibility) and archivedAt (irreversible archive) as product state. Unlisted/unarchived products remain ADMIN-selectable for future offline operations.
- Add archive instead of hard delete; atomically set listed=false, prohibit edits/relisting, preserve historical orders and existing entitlements.
- Persist storeName, ownerEmail, and timezone.
- Configure/preview eight dynamic field types with stable IDs, server validation and safe JSON defaults.
- Keep the committed additive form migration and add a versioned follow-up removing obsolete permission columns and unlisting archived rows; preserve all eleven business tables, saved forms and remaining data.
- Verify real admin product/settings UI at desktop and mobile sizes using isolated MySQL fixtures.

Acceptance:
- Product edits survive refresh/restart.
- Listing/archive semantics match docs/08-interface-specification.md; no separate purchase or renewal controls remain.
- Historical snapshots remain unchanged after product edits.
- No supplier cost fields.

Future order selection must allow unlisted/unarchived products and reject archived products. Phase 2 now implements independent ADMIN subscriptions for unlisted/unarchived SUBSCRIPTION products and rejects archived or ONE_TIME products. Task 1.2.3 itself added no subscription writes.

#### Task 1.2.4 — Offline orders, payments, refunds, and fulfillment

- Admin creates ADMIN INITIAL/ONE_TIME orders. SYSTEM_RENEWAL creates only final paid/completed hidden RENEWAL orders; ordinary admin/customer renewal handling is a future service task.
- Record payment channel, amount, actual time, reference, and note.
- Admin confirms actual offline payment after checking the external account.
- Record full refunds as pending/confirmed/failed after private customer discussion; application never sends money.
- Admin updates fulfillment status with a reason.
- Add order events and audit logs.

Acceptance:
- Payment and fulfillment states are independent.
- Unpaid/unverified orders are not counted as paid or awaiting fulfillment.
- Payment summary reconciles with transaction records.
- Only paid orders can complete.
- Refund is marked successful only after external refund is actually sent.
- Refund and fulfillment transitions are atomic and audited.

#### Task 1.2.5 — Superseded subscription sequence

The owner-authorized Phase 2 above replaces this earlier order-first design. Its implementation is ready for review; do not start a duplicate subscription task or restore the former suspension/resumption states.

- ADMIN creates independent subscriptions for active or pending customers, with frozen product/form snapshots.
- Direct renewal changes the existing unexpired subscription using an explicit expiry, without orders/payments or guessed durations.
- Version checks, persistent idempotency, event/audit history and automatic expiry termination protect state changes.
- ADMIN/SYSTEM sources and ACTIVE/TERMINATED states are the current contract. Preserve old event rows and legacy source-order references.
- Development migration still requires separate operator authorization after PR review. See [Phase 2 operation and verification guide](14-user-subscription-core.md).

#### Task 1.2.6 — Dashboard and customer read-only portal

- Replace overview Mock metrics with database-backed metrics.
- Customer can activate/login and view only their own orders/subscriptions.
- Keep online catalog purchase/checkout disabled.
- Add E2E tests for complete local offline workflows.
- Document local start, backup, and reset procedures.

Acceptance:
- Dashboard reconciles with confirmed transaction records.
- Customer cannot access another user's data or admin APIs.
- Data survives refresh and service/container restart.
- No online payment, supplier, or email calls occur.
- All checks pass and owner reviews the milestone.

## Future phases — not authorized by Task 1.2

These remain future work and must not be pulled into Task 1.2:

- Public online checkout and payment provider integration.
- Supplier email/API and automated fulfillment.
- SMTP notifications and expiry reminders.
- Production deployment, public access, and external customer invitation links.
- Advanced accounting, supplier costs, or multi-merchant features.

## Current review boundary

Tasks 1.2.1–1.2.3, Phase 2 and order foundation/read/create/edit/cancel/payment/refund/fulfillment stages through T19 are merged. T20 design is approved and documented; its implementation PR is the next authorized task. Do not begin T21 customer UI, renewal or deployment automatically.


T19 supersedes the earlier generic Task 1.2.4 fulfillment placeholder below: use the merged D24-D32/D37/D52/D59/D64/D83-D88 contract in [docs/24-manual-fulfillment-api.md](24-manual-fulfillment-api.md). In particular, NOT_REQUIRED zero-price orders are fulfillable, and renewal/SYSTEM_RENEWAL are excluded.


## T19 — Manual fulfillment and first ORDER entitlement

- [x] ADMIN-only POST `/api/v1/admin/orders/:id/fulfill`, strict version/key/note and safe DTOs.
- [x] INITIAL/ONE_TIME, exact PAID/NOT_REQUIRED eligibility and retained receipt evidence.
- [x] Unique ORDER Subscription from frozen Order snapshots; locked fulfillment-time settings and D86 arithmetic.
- [x] Atomic Order/version/Revision/Event, optional Subscription/Event, one/two audits and original idempotency response.
- [x] Isolated HTTP/SQL-fault/calendar/concurrency tests and desktop/mobile browser acceptance added.
- [ ] Implementation PR review and separately authorized deployment.

No Migration, development database operation, renewal, provider integration, email or frontend page. Actual validation is recorded in docs/24.


T20 supersedes only the ADMIN order-page Mock boundary in the original Task 1.2.3 UI prototype. CUSTOMER order UI and the operating overview remain Mock. See [the T20 contract](25-admin-order-center.md).
