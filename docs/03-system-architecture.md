# System Architecture

> **Current Phase 2 override (2026-11-17):** The owner separately authorized user-name refactoring and administrator-only subscription management before offline orders. `displayName` becomes nullable `username` (customer-owned, no new editing/activation flow yet) and `adminLabel` (admin-only). Admin naming is adminLabel → username → login-email prefix; customer responses exclude adminLabel. Subscription sources are ADMIN/SYSTEM, stored states ACTIVE/TERMINATED. Admin creates independent subscription records and directly edits/renews/terminates them without orders, payments, email or automatic duration arithmetic. Product/form snapshots are frozen; archived products block new subscriptions/renewals but allow maintenance of existing unexpired subscriptions. Expired ACTIVE rows grant no entitlement and cannot be edited/renewed, even before the minute worker terminates them. [Phase 2 details](14-user-subscription-core.md) supersede conflicting legacy subscription rules below. No development database migration is performed by implementation/tests.


## 1. Architecture style

Use a modular monolith for the MVP. Frontend and backend are separate applications in one repository. Keep domain modules separated in code, but deploy one API service and one database initially.

### Single-merchant boundary

The application serves one merchant: the site owner. There is one configured payment-provider merchant identity, not one payment account per customer. Do not add merchant tenant IDs, merchant onboarding, sub-merchant creation, merchant wallets, merchant withdrawal APIs, or platform split-payment logic. Customer accounts are buyer accounts only. Provider credentials and onboarding are configured for the owner outside the application. The application records provider payment/refund/settlement events; it does not custody funds. Delayed settlement or order-level fund holds are provider capabilities and must not be simulated in application logic.

Do not introduce microservices, Redis, Kubernetes, or a message broker without a measured requirement.

## 2. Proposed technology stack

| Layer | Proposed technology | Notes |
|---|---|---|
| Frontend | Vue 3 + TypeScript + Vite | Storefront and admin console |
| UI components | Element Plus | Initial component library; visual design requires owner approval |
| Backend | Node.js 24 + TypeScript + Express | REST API |
| Database | MySQL 8 | Persistent business data |
| ORM | Prisma | Schema and migrations |
| Validation | Zod | Validate requests/configuration |
| Authentication | Server-side session with HTTP-only cookie | No session token in localStorage |
| Email | Nodemailer over SMTP or transactional provider | Credentials from environment |
| Background work | Database-backed email outbox and scheduled worker | No separate queue service in MVP |
| Deployment | Docker Compose | Single-server deployment |

If a selected dependency/runtime is unavailable, report the issue and propose a compatible version before changing baseline.

## 3. Repository layout

~~~text
.
├── AGENTS.md
├── README.md
├── docs/
├── frontend/
│   └── src/
│       ├── api/
│       ├── components/
│       ├── layouts/
│       ├── router/
│       ├── stores/
│       ├── views/storefront/
│       ├── views/account/
│       ├── views/admin/
│       └── types/
├── backend/
│   ├── prisma/
│   └── src/
│       ├── config/
│       ├── middleware/
│       ├── modules/auth/
│       ├── modules/users/
│       ├── modules/products/
│       ├── modules/orders/
│       ├── modules/payments/
│       ├── modules/suppliers/
│       ├── modules/fulfillment/
│       ├── modules/subscriptions/
│       ├── modules/email/
│       └── modules/audit/
├── .env.example
├── .gitignore
└── compose.yaml
~~~

Exact structure may be refined during scaffold task, but preserve module boundaries.

## 4. Runtime components

### Frontend
- Follow [08-interface-specification.md](08-interface-specification.md) as the UI source of truth.
- Implement the first customer and owner/admin interfaces with local mock data before wiring backend business workflows.
- Public storefront routes.
- Authenticated customer routes.
- One unified owner/admin console route group protected by the ADMIN role. It combines merchant operations and administrative controls; do not build separate merchant and administrator frontends.
- Central API client and error handling.
- Form renderer based on product field definitions.
- Customer order and subscription views.
- Unified owner/admin tables, filters, detail views, product controls, customer management, and order/subscription state-transition actions.
- Customer desktop navigation is a top bar; customer mobile navigation is a fixed four-item bottom bar. Admin desktop navigation is a left sidebar; on mobile/tablet it becomes a horizontally scrollable navigation row.
- The first UI prototype must not call real payment, refund, settlement, SMTP, or supplier services.

Frontend route guards are UX only. Backend enforces authorization on every protected endpoint.

### Backend
- Authentication and session management.
- Product catalog and product-specific form configuration.
- Order creation and immutable order snapshots.
- Manual customer payment verification.
- Supplier email generation and outbox delivery.
- Manual supplier transfer records.
- Fulfillment state transitions.
- Subscription and renewal records.
- Expiry reminder scheduler.
- Audit logging.

### Database
MySQL is source of truth for users, products, orders, payment records, supplier fulfillment, subscriptions, email outbox, and audit logs.

### Email
Use one configured sender identity for supplier and customer messages, with separate templates and recipient rules. Operator may be CC'd on supplier requests.

SMTP host, port, username, password, sender address, and options belong in environment variables or a secret manager. Never commit actual values.

## 5. Order processing

Maintain three independent state dimensions:
1. Customer payment state.
2. Supplier procurement/payment state.
3. Service fulfillment state.

An overall status may be calculated for display, but underlying states remain separate.

When administrator confirms customer payment:
1. In a DB transaction, update customer payment state and create supplier fulfillment record.
2. Create an email outbox record with unique idempotency key.
3. Commit transaction.
4. Worker sends email.
5. Worker records sent/failed status and attempt metadata.

This avoids losing a supplier email if API process exits after payment transaction commits.

Operator separately records supplier transfer. It is an external action, not an automated payment.

## 6. Email delivery

- Use HTML and plain-text templates.
- Use stable internal order numbers in subjects.
- Persist email intent before attempting delivery.
- Track recipient, template, related order, status, attempts, last sanitized error, and timestamps.
- Support safe retry without duplicate business orders.
- Do not include authentication secrets or unnecessary customer information.
- Keep supplier and customer templates separate.

## 7. Authentication and authorization

- Customer accounts use email/password in MVP unless owner approves another login method.
- Store passwords using Argon2id or maintained equivalent.
- Use server-side sessions and secure, HTTP-only, SameSite cookies.
- Enforce administrator role on server.
- Apply CSRF protection for cookie-authenticated mutations.
- Rate-limit registration, login, password reset, and sensitive admin actions.
- Avoid account enumeration where possible.

## 8. Time and money

- Store money as integer minor units (CNY fen).
- Store timestamps in UTC.
- Display dates in Asia/Shanghai by default.
- Snapshot selling price, renewal price, and supplier cost on each order.

## 9. Payment integration boundary

MVP uses manual customer-payment verification and manual supplier transfers.

Define internal service boundaries for a compliant payment provider later, but do not implement or simulate a gateway now. Future provider adapter must verify signed notifications, query payment status where appropriate, handle duplicate notifications, and never trust browser-only payment claims.

## 10. Supplier integration boundary

MVP supplier integration is email plus operator action. Define a supplier module boundary for a documented API adapter later. Do not scrape or automate supplier website as substitute for approved API.

## 11. Deployment

- Docker Compose for API, frontend web server, and MySQL.
- Persistent DB volume and backups.
- HTTPS termination at reverse proxy.
- Health endpoint.
- Production secrets injected at deployment.
- Document backup and restore before storing real customer data.
