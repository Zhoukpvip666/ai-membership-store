# Development Roadmap

## Delivery rules

- Implement one task at a time.
- Do not skip acceptance criteria.
- Do not implement future payment or supplier integrations during MVP.
- Keep docs synchronized with implementation.
- Owner reviews each milestone before next substantial milestone.

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
- [x] Define customer pages and one unified owner/admin console (not separate merchant and administrator portals).
- [x] Define subscription versus one-time product behavior.
- [x] Define proposed stack and modular-monolith architecture.
- [x] Define initial domain model and API contract.
- [x] Define security boundaries and launch gates.
- [x] Create roadmap and Codex instructions.

## Phase 1 — Repository scaffold and foundation

**Status: Not started**

### Task 1.1 — Scaffold frontend and backend

- Create agreed repository structure.
- Initialize Vue 3 + TypeScript + Vite frontend.
- Initialize Node.js + TypeScript + Express backend.
- Add formatting, lint, type-check, and basic test scripts.
- Add .gitignore and .env.example.
- Add health endpoint.
- Add Docker Compose for local MySQL.
- Do not build product/order features in this task.

Acceptance:
- Frontend starts locally.
- Backend starts locally.
- Health endpoint returns stable JSON.
- MySQL starts with Docker Compose.
- No secrets committed.
- README includes exact setup commands.

### Task 1.2 — Database and shared configuration

- Add Prisma and MySQL.
- Add initial migration for users/admin role only.
- Add environment validation.
- Add request ID and structured logging with sensitive-data redaction.

Acceptance:
- Migration runs on clean local DB.
- Missing/invalid required env vars fail clearly.
- Logs contain no passwords/cookies/secrets.

### Task 1.3 — Authentication and authorization

- Implement customer register/login/logout.
- Implement server-side session cookie.
- Implement one ADMIN role for the site owner.
- Protect the unified owner/admin console and all its APIs with the ADMIN role.
- Add a minimal protected management-console route.

Acceptance:
- Customer can register/login/logout.
- Customer cannot access admin APIs.
- Unauthenticated user cannot access protected customer APIs.
- Passwords are hashed.
- Authentication endpoints rate-limited.

## Phase 2 — Product catalog and product forms

**Status: Not started**

### Task 2.1 — Product data and admin CRUD

- Implement products and product form-field configuration.
- Support SUBSCRIPTION and ONE_TIME.
- Support initial price, renewal price, term, supplier cost reference, status, sort order.
- Add admin product CRUD.

Acceptance:
- Admin can create/edit/archive products.
- Subscription products require renewal price and term.
- One-time products do not show renewal UI by default.
- Public APIs never expose supplier cost.

### Task 2.2 — Storefront catalog and detail

- Build responsive catalog and detail pages.
- Display price, term, renewal price, and service conditions.
- Render configured non-sensitive form fields.

Acceptance:
- Only active products are public.
- Product type is visually distinguishable.
- Required fields validated on client and server.
- Visual design follows owner-approved direction.

## Phase 3 — Orders and manual customer-payment verification

**Status: Not started**

### Task 3.1 — Order creation and snapshots

- Implement order creation.
- Calculate price on server.
- Snapshot product, price, term, and approved form values.
- Add customer order list/detail.

Acceptance:
- Customer sees only own orders.
- Historical product/price data does not change after product edits.
- Duplicate submissions do not create unintended duplicate orders.

### Task 3.2 — Manual payment workflow

- Add configurable payment instructions.
- Add customer payment-submitted action.
- Add admin verification queue/action.
- Record verifier and transaction reference.

Acceptance:
- Customer claim does not mark order paid.
- Only admin verification changes payment status to PAID.
- Supplier email cannot be queued for unpaid/unverified order.

## Phase 4 — Supplier email and manual fulfillment

**Status: Not started**

### Task 4.1 — Email outbox and supplier request

- Configure SMTP via environment.
- Add templates and DB-backed outbox.
- Queue supplier request email after payment verification.
- Support operator CC and safe retry.

Acceptance:
- Supplier request contains correct order snapshot and approved non-sensitive fields.
- No prohibited secret is emailed.
- Retry does not create duplicate supplier fulfillment.
- Delivery attempts/failures visible to admin.

### Task 4.2 — Supplier transfer and fulfillment console

- Add manual supplier transfer record.
- Add fulfillment progress and exception handling.
- Add admin completion/failure actions.
- Queue customer completion email after confirmed completion.

Acceptance:
- Supplier transfer is recorded, not initiated.
- Order cannot complete before valid transitions.
- Customer email sent only after admin completion.
- Important actions audited.

## Phase 5 — Subscriptions and renewals

**Status: Not started**

### Task 5.1 — Subscription records

- Create subscription on successful initial fulfillment.
- Store customer, product, target identifier, start, expiry, renewal price.
- Add customer My Subscriptions.
- Add admin subscription management.

Acceptance:
- Subscription not active before supplier completion.
- Customer sees renewal price and expiry.
- Customer cannot view another user's subscription.

### Task 5.2 — Renewal orders

- Add renewal action from subscription.
- Create new order linked to existing subscription.
- Snapshot renewal price.
- On supplier completion, operator records actual new expiry date.
- Preserve event history.

Acceptance:
- Renewal creates separate order.
- Old orders/events remain unchanged.
- Expiry updated only from supplier-confirmed information.
- No automatic charge.

### Task 5.3 — Expiry reminders

- Add scheduled reminder worker.
- Support configurable 7/3/1-day offsets.
- Add reminder idempotency and delivery history.

Acceptance:
- No duplicate reminder for same subscription, expiry date, and offset.
- Failed reminders can be retried.
- Expired subscriptions are not described as active.

## Phase 6 — Customer account and operations

- Complete profile and password change.
- Add user administration.
- Add dashboard metrics and operational queues.
- Add order/subscription search and filters.
- Add email outbox and audit-log views.
- Add documented manual refund record workflow.

Acceptance:
- Customer/admin permissions enforced server-side.
- Dashboard figures reconcile with order/payment records.
- Internal costs/notes never exposed to customers.

## Phase 7 — Hardening and deployment

- Add integration and end-to-end tests for critical workflows.
- Add backup/restore procedure.
- Add production deployment configuration.
- Add HTTPS/reverse-proxy guidance.
- Add monitoring/log rotation.
- Run security/dependency checks.
- Complete launch checklist.

Acceptance:
- Clean deployment reproducible from docs.
- Database restore tested.
- Critical state transitions tested.
- No secrets in repository history or runtime responses.
- Owner signs off supplier authorization, service terms, payment eligibility, and customer policies.

## First Codex task

Start with **Task 1.1 — Scaffold frontend and backend** only after owner confirms proposed stack and visual direction. Do not start product, payment, supplier, subscription, or UI feature implementation in scaffold task.
