# Development Roadmap

## Order/subscription refactoring — Stage 1 database foundation

**Scope: schema/migration/compatibility/tests only; review before further development.** See [stage guide](15-order-subscription-foundation.md).

- Structured DAY/MONTH/YEAR periods and quantities; retain termLabel and unknown legacy NULLs.
- Order product/period/form/data snapshots; USER/ADMIN/SYSTEM_RENEWAL origins, hidden renewals, lifecycle times and USER/ADMIN/SYSTEM events.
- ORDER subscription source requiring a unique source order, frozen billing period/anchor/timezone, current cycle and early-renewal marker. Retain legacy unlinked ADMIN/SYSTEM records.
- Site-wide plain-text paymentInstructions; preserve PaymentTransaction and all old states/records.
- Fifth foundation, sixth review-integrity and seventh actual-payment-time migrations; verify all twelve populated legacy business tables, repeated deploy and fresh installation in isolated MySQL 8.4 only.
- Review follow-up: strict source/kind/visibility, complete ORDER subscriptions, validated timezone, independent billingRevision/explicit renewal eligibility, immutable renewal target/anchor/revision snapshots, two durable unique cycle claims and paid-renewal update/delete guards.
- P1 final-state and payment-time repair: SYSTEM_RENEWAL INSERT requires PAID/COMPLETED and non-NULL paidAt <= paymentConfirmedAt <= fulfilledAt with no cancellation; keep immutable triggers. paidAt is actual payment, matching the confirmed PAYMENT's occurredAt in the future transaction; PaymentTransaction.createdAt is entry time. Retain deprecated paymentRecordedAt unchanged and unused by new flows. Verify populated upgrades and fresh installs with --models-only (no Seed), including rejected intermediate states, distinct occurrence/entry/confirmation times and complete transaction rollback.
- Verification includes a populated six-migration upgrade and fresh seven-migration installation, SQL rejection/immutability/concurrent uniqueness/transaction rollback fixtures. No historical actual payment time is inferred or backfilled.
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

- Admin creates OFFLINE_MANUAL INITIAL, RENEWAL, and ONE_TIME orders.
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

Tasks 1.2.1–1.2.2 are merged. The owner separately authorized Task 1.2.3, which stops at its PR for human review. Do not begin Task 1.2.4 or later business work without separate authorization.
