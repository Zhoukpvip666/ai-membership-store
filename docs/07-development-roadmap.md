# Development Roadmap

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

**Status: Task 1.1 complete; Task 1.2.1 implemented for owner review; Task 1.2.2 not started**

### Task 1.1 — Responsive Mock UI prototype

**Status: Complete.** See [Task 1.1 implementation report](09-task-1.1-report.md).

- Vue 3 + TypeScript + Vite frontend.
- Node.js 24 + TypeScript + Express health API.
- MySQL 8.4 Docker Compose development service.
- Customer storefront and unified owner/admin console with Mock data.
- Responsive desktop/mobile layouts and local interactions.
- No business database, authentication, payment, email, or supplier integration.

### Task 1.2 — Local offline customer and order management

**Status: Database foundation implemented for owner review. Remaining subtasks have not started.**

Use [10-local-operations-mvp.md](10-local-operations-mvp.md) as the scope and implementation source of truth. Use [04-data-model.md](04-data-model.md) for the database model and [05-api-contract.md](05-api-contract.md) for API boundaries.

The target is a usable local application for managing existing customers who pay offline. It is not deployed and is not an online store yet.

#### Task 1.2.1 — Prisma and local database foundation

**Status: Implemented for owner review.** Schema, commands, verification and known boundaries: [11-database-foundation.md](11-database-foundation.md). Stop here until owner approval.

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

- Replace product Mock state with database-backed CRUD.
- Persist listed, purchaseEnabled, and renewalEnabled independently.
- Add archive instead of hard delete.
- Persist storeName, ownerEmail, and timezone.

Acceptance:
- Product edits survive refresh/restart.
- Listing/new-purchase/renewal semantics match docs/08-interface-specification.md.
- Historical snapshots remain unchanged after product edits.
- No supplier cost fields.

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

#### Task 1.2.5 — Subscriptions and renewals

- Admin creates subscriptions from completed orders, manual grants, or historical imports.
- Pending-activation customers may own subscriptions.
- Admin enters actual start/expiry dates and renewal price.
- Renewal creates a separate offline order linked to the subscription.
- On renewal fulfillment, admin enters supplier-confirmed expiry; update subscription and append event atomically.
- Add suspension, resumption, termination, and date correction with reasons.

Acceptance:
- Manual grant/history import creates no fake order/payment.
- Each renewal creates a new order.
- Product edits do not rewrite existing subscription renewal price snapshots.
- Expiry is not auto-extended by guessed durations.
- Subscription event history is preserved.

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

## First Codex task

After owner approval, execute **Task 1.2.1 only**. Read AGENTS.md and docs/10-local-operations-mvp.md first. Do not begin Task 1.2.2 or implement business CRUD until the owner reviews the database foundation.
