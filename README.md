# AI Membership Store

A private, independently operated storefront and order-management system for AI membership services and other digital services.

**Project status:** Task 1.1 is merged. Task 1.2.1 database foundation is implemented for owner review; Task 1.2.2 and business CRUD have not started. The frontend remains the independent Task 1.1 Mock prototype.

## Operating model: single merchant

This is a **single-merchant storefront**. The site owner is the only merchant and the payment beneficiary. Customers are buyers, not merchants, and do not receive payment-provider sub-merchant accounts. Do not build merchant onboarding, multi-merchant balances, merchant withdrawals, merchant settlement wallets, or marketplace split payments. The payment provider account belongs to the site owner; the application records order, payment, refund, and settlement information returned by the provider. Any order-level delayed settlement or refund-from-held-funds capability must be explicitly supported by the selected provider and contract; it cannot be created by changing an order status in this application.

## Business model

The platform is a reseller storefront. It does not initially automate the supplier's membership activation process.

### Current fulfillment workflow

1. A customer selects a subscription service or a one-time service and submits the required, product-specific information.
2. The customer pays the reseller through an approved payment method.
3. In the MVP, payment is manually verified by an administrator because an automated payment API is not yet available.
4. After payment is verified, the system emails the supplier with the order request and copies the operator when configured.
5. The operator manually transfers the supplier's fixed per-order fee through the agreed channel and records the transfer.
6. The supplier completes the service and sends the invitation or activation instructions to the customer's designated email address.
7. The operator verifies the result and marks the order complete.
8. The system emails the customer to check the designated mailbox for the supplier's invitation or activation message.

The platform must distinguish customer payment, supplier payment, and service fulfillment. They are separate events and must not be represented by one ambiguous status.

## Product types

- **Subscription service:** Has an initial price, a renewal price, a service period, and a membership record with an expiry date. Renewal is a new manually paid order in the MVP; this is not automatic recurring billing.
- **One-time service:** Has a one-time price and does not create a renewable membership record unless a later product requirement explicitly says otherwise.

## MVP scope

- Public product catalog and product detail pages.
- Customer registration, login, and profile.
- Product-specific order forms using configurable, non-sensitive fields.
- Order creation and customer order history.
- Manual customer-payment verification.
- Supplier request email generated after payment verification.
- Manual recording of supplier transfer and supplier fulfillment.
- Customer completion email.
- Subscription list, renewal price, expiry date, renewal orders, and expiry reminders.
- One unified owner/admin console combining the dashboard, product management, order management, subscription management, user management, and settings. There is no separate merchant portal and administrator portal.
- Audit trail for important administrative actions.

## Explicitly out of scope for the MVP

- Automated card/payment collection until an approved payment product and merchant permissions are available.
- Automated transfer of money to the supplier.
- Supplier API integration. The supplier currently does not have an API; the first version uses email plus manual operations.
- Automatic recurring charges.
- Automatic account login or membership activation on third-party services.
- Collecting customer passwords, one-time passwords, 2FA codes, recovery codes, session cookies, or other authentication secrets through ordinary forms or email.
- Multi-supplier routing, affiliate distribution, coupons, wallet balances, and complex accounting.

## Proposed technical baseline

These are implementation defaults, not irreversible decisions. Confirm any change before implementation.

- Frontend: Vue 3, TypeScript, Vite.
- UI: Element Plus; approved visual baseline in docs/08-interface-specification.md.
- Backend: Node.js 24, TypeScript, Express.
- Database: MySQL 8.
- ORM and migrations: Prisma.
- Email: SMTP through a provider account; credentials must be environment variables.
- Deployment: Docker Compose for the initial single-server deployment.
- Architecture: modular monolith. Do not introduce microservices or Redis in the MVP without a demonstrated need.

## Documentation reading order

1. AGENTS.md — instructions for Codex and contributors.
2. docs/01-product-requirements.md — product scope and requirements.
3. docs/02-user-and-operations-flows.md — customer and operator workflows.
4. docs/03-system-architecture.md — proposed technical architecture.
5. docs/04-data-model.md — domain entities and database design.
6. docs/05-api-contract.md — initial API contract.
7. docs/06-security-and-operations.md — security, privacy, and operational rules.
8. docs/07-development-roadmap.md — phased implementation plan and acceptance criteria.
9. docs/08-interface-specification.md — approved customer and owner/admin responsive UI specification.
10. docs/10-local-operations-mvp.md — local-only customer, offline order, payment record, and subscription management milestone.
11. docs/11-database-foundation.md — Task 1.2.1 schema, local migration/seed instructions, tests and implementation report.

## Important launch gates

Before accepting real orders, the operator must verify that the supplier is authorized to provide and resell the relevant service, that the service provider's terms permit the intended invitation/resale workflow, that customer-facing descriptions are accurate, and that the selected payment/settlement arrangement is permitted for the merchant and product category. The project documents do not constitute legal or payment-provider approval.

## Repository structure

```text
.
├── AGENTS.md
├── README.md
├── package.json             # npm workspaces and common checks
├── frontend/                # Vue 3 / TypeScript / Vite / Element Plus
├── backend/                 # Node.js 24 / Express + Prisma database foundation
├── e2e/                     # desktop and mobile browser checks
├── compose.yaml             # development-only MySQL 8.4
├── .env.example
└── docs/
    ├── 01-product-requirements.md
    ├── 02-user-and-operations-flows.md
    ├── 03-system-architecture.md
    ├── 04-data-model.md
    ├── 05-api-contract.md
    ├── 06-security-and-operations.md
    ├── 07-development-roadmap.md
    ├── 08-interface-specification.md
    ├── 09-task-1.1-report.md
    ├── 10-local-operations-mvp.md
    └── 11-database-foundation.md
```

## Local development — Task 1.2.1

Prerequisites: Node.js **24.x**, npm, and Docker with Compose. Run all commands from the repository root. On PowerShell, use `npm.cmd` if the local execution policy blocks `npm.ps1`.

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

For a fresh clone, replace the database and administrator password placeholders in your local `.env`. Set `DATABASE_URL` to match `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_PORT` and `MYSQL_DATABASE`; percent-encode reserved characters in its credentials. Set `ADMIN_EMAIL` and a 12–128 character `ADMIN_PASSWORD`. Keep `APP_BASE_URL` on loopback (default `http://localhost:5173`). Existing `.env` files must be preserved: add missing keys manually and retain the database passwords that match the initialized volume. Never commit `.env`. The default host port is **3307**; update both `MYSQL_PORT` and `DATABASE_URL` if changed.

`npm ci` generates the Prisma client without needing local secrets. The API and seed validate all application variables; migration/status commands validate `DATABASE_URL`. Configuration errors list field names without values.

```powershell
docker compose config --quiet
docker compose up -d --wait mysql
npm run db:migrate
npm run db:status
npm run db:seed
npm run dev
```

- Storefront: [http://localhost:5173](http://localhost:5173)
- Unified owner/admin console: [http://localhost:5173/admin](http://localhost:5173/admin)
- Health: [http://127.0.0.1:3000/api/v1/health](http://127.0.0.1:3000/api/v1/health); `/health` is an alias. A database probe returns HTTP 200 with `{"status":"ok","database":"ready"}`, or HTTP 503 with `{"status":"degraded","database":"unavailable"}`. It checks connectivity, not migration currency; use `npm run db:status` for that.
- MySQL: `127.0.0.1:3307`, database/user from `.env`; named volume `mysql-data` preserves development data.

Frontend and backend can also run separately in two terminals:

```powershell
npm run dev:web
npm run dev:api
```

The frontend still works with the API and MySQL stopped and makes **no business API calls**. The backend connects through Prisma only for database readiness; the explicit seed initializes one ADMIN, one settings row and one sanitized bootstrap audit record. Re-running seed preserves the existing password, profile and settings. Changing `ADMIN_PASSWORD` does not reset an existing password; changing `ADMIN_EMAIL` conflicts rather than creating a second ADMIN. No login endpoint exists yet.

The migration contains the approved 11 domain tables plus Prisma's `_prisma_migrations` bookkeeping table. Use versioned migrations only; no `db push` or reset is required. Full schema, conflict handling and local setup details are in [the database foundation guide](docs/11-database-foundation.md).

To stop development, press Ctrl+C in the application terminal and run `docker compose stop mysql`. To remove the development container while retaining its data, use `docker compose down`; do not add `--volumes` unless you intend to delete the local database.

## Prototype behavior and boundaries

- Four customer pages: product catalog, subscriptions, orders, profile. Six unified management pages: overview, products, orders, subscriptions, users, settings.
- Responsive desktop top navigation / mobile safe-area bottom navigation; desktop admin sidebar / horizontally scrollable tablet and mobile navigation; horizontally scrollable tables and mobile dialogs.
- Product category filters, local add/edit, independent listing / new-purchase / renewal controls. Listing controls catalog visibility; disabling new purchases keeps a listed card visible with a disabled 暂不可购买 button. New checkout requires listing and new-purchase permission; eligible existing subscriptions can renew solely according to the renewal switch, even when delisted or closed to new purchases. Disabling renewal does not block permitted new purchases. These switches preserve historical orders and existing entitlement dates.
- Checkout collects notification email plus a configured target email or project name where required. It creates an **unpaid local mock order**, without a payment operation. Prices are integer CNY fen; orders retain product and price snapshots.
- Customer lists show only the fictitious demo customer's records. Renewal creates a separate order linked to the subscription and does not extend its expiry.
- Order search/status filters, details and timeline show payment independently: unpaid orders display 未付款 and fulfillment 未开始 in customer/admin lists, details, overview recent orders and linked subscription history. Only confirmed-paid pending orders match 待发货. Seeded paid pending orders support simulated completion and simulated refund. Refund request enters processing; an explicit simulated success/failure result is needed. Only success shows 已退款 and cancels fulfillment (已取消), retaining historical payment confirmation. Pending/failed refunds leave fulfillment unchanged and failed simulations can retry. Unpaid, completed, and refunded orders do not expose these pending-order actions.
- Subscription filters/details include confirmed sample dates, masked identifiers and linked initial/renewal order history. Disabling renewal preserves the current entitlement and explains why renewal is unavailable.
- User search/detail links to that customer's orders and subscriptions. Profile notification email, demo sign-out/re-entry, basic system settings and email preferences work locally.
- Overview computes verified mock receipts minus confirmed mock refunds by event date in the configured business timezone (default Asia/Shanghai), plus total orders, confirmed-paid pending orders and active/expired subscriptions. Unpaid orders increase the total but not the delivery queue count.

All fixture names, products, contacts (`example.com`), orders and metrics are fictitious. State is shared between the two surfaces **only in the same browser tab**, held in memory, and reset on refresh; there is no localStorage persistence. No payment, refund, funds transfer, settlement, SMTP, supplier service or network integration is configured. Both application surfaces are deliberately accessible for demo navigation; **no real authentication or authorization exists yet**. Do not enter real customer information.

The backend exposes database-aware health and JSON 404 responses only. Task 1.2.1 adds the schema, migration, environment validation and administrator seed; it does not connect the Mock UI to database records. Authentication, sessions/invitation behavior, business CRUD, payment/fulfillment state machines and customer activation remain future subtasks. No SMTP, outbound email, online payment or supplier integration is implemented. Services bind to loopback.

## Checks

See [the Task 1.1 implementation report](docs/09-task-1.1-report.md) for the UI and [the Task 1.2.1 report](docs/11-database-foundation.md) for database coverage and the complete changed-file list.

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run db:validate
npm test
npm run test:db
npm run build
npm run test:e2e
```

Browser tests use installed **Microsoft Edge** via Playwright on desktop and at an iPhone-sized viewport. Install Edge first if it is unavailable; the tests do not require downloading Playwright's browser bundle. Mobile viewport emulation is not a physical iOS-device test. Playwright builds and serves the frontend automatically on loopback port 4175, without the backend, and fails on business API calls. Screenshots and failure traces are written to ignored `test-results/`.

The frontend tests cover the existing Mock behavior. Backend unit/HTTP tests cover environment validation, sanitized startup failures, readiness responses/recovery and absent business routes. `npm run test:db` requires Docker and creates a uniquely named isolated MySQL 8.4 project with a fresh named volume and random loopback port/credentials. It migrates twice, verifies the schema and idempotent/concurrent seed, stops/restarts its own database to verify readiness and persistence, then removes only its own test resources. It does not load `.env` or touch the development volume.

Build artifacts: `frontend/dist/` and `backend/dist/`. To serve compiled output locally, use `npm run preview -w frontend` (default port 4173) and `npm start -w backend` in separate terminals. These commands are development previews, not production deployment configuration.

## Current local operations milestone

Task 1.2 is defined in [docs/10-local-operations-mvp.md](docs/10-local-operations-mvp.md). It will turn the Mock prototype into a local MySQL-backed tool for manually managed customers, offline WeChat/Alipay orders, recorded payments/refunds, and subscriptions. No online payment, SMTP, supplier API, or public deployment is included. Pending-activation customers may have subscriptions; invitations are copied manually and no email is sent. Task 1.2 will be implemented one reviewed subtask at a time, beginning with the Prisma/database foundation.
