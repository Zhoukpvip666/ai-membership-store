# AI Membership Store

A private, independently operated storefront and order-management system for AI membership services and other digital services.

**Project status:** Task 1.1 scaffold and local Mock UI prototype implemented. Task 1.2 has not started.

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

## Important launch gates

Before accepting real orders, the operator must verify that the supplier is authorized to provide and resell the relevant service, that the service provider's terms permit the intended invitation/resale workflow, that customer-facing descriptions are accurate, and that the selected payment/settlement arrangement is permitted for the merchant and product category. The project documents do not constitute legal or payment-provider approval.

## Repository structure

```text
.
├── AGENTS.md
├── README.md
├── package.json             # npm workspaces and common checks
├── frontend/                # Vue 3 / TypeScript / Vite / Element Plus
├── backend/                 # Node.js 24 / TypeScript / Express health API
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
    └── 08-interface-specification.md
```

## Local development — Task 1.1

Prerequisites: Node.js **24.x**, npm, and Docker with Compose. Run all commands from the repository root. On PowerShell, use `npm.cmd` if the local execution policy blocks `npm.ps1`.

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

For a fresh clone, replace the two password placeholders in your local `.env` before starting MySQL. Preserve an existing `.env` so that its credentials continue to match the initialized database volume. Never commit `.env`. The application database user is separate from root. The default host port is **3307**, to avoid a common local MySQL conflict; change `MYSQL_PORT` if needed.

```powershell
docker compose config --quiet
docker compose up -d --wait mysql
npm run dev
```

- Storefront: [http://localhost:5173](http://localhost:5173)
- Unified owner/admin console: [http://localhost:5173/admin](http://localhost:5173/admin)
- Health: [http://127.0.0.1:3000/api/v1/health](http://127.0.0.1:3000/api/v1/health), returns `{"status":"ok"}`. `/health` is an alias. This is a process-health check, not a database-readiness check.
- MySQL: `127.0.0.1:3307`, database/user from `.env`; named volume `mysql-data` preserves development data.

Frontend and backend can also run separately in two terminals:

```powershell
npm run dev:web
npm run dev:api
```

The frontend works with the API and MySQL stopped. There are **no business API calls or database connections** in this prototype.

To stop development, press Ctrl+C in the application terminal and run `docker compose stop mysql`. To remove the development container while retaining its data, use `docker compose down`; do not add `--volumes` unless you intend to delete the local database.

## Prototype behavior and boundaries

- Four customer pages: product catalog, subscriptions, orders, profile. Six unified management pages: overview, products, orders, subscriptions, users, settings.
- Responsive desktop top navigation / mobile safe-area bottom navigation; desktop admin sidebar / horizontally scrollable tablet and mobile navigation; horizontally scrollable tables and mobile dialogs.
- Product category filters, local add/edit, independent listing / new-purchase / renewal controls. Delisting preserves existing orders and subscriptions; a delisted subscription can still renew when renewal is enabled.
- Checkout collects notification email plus a configured target email or project name where required. It creates an **unpaid local mock order**, without a payment operation. Prices are integer CNY fen; orders retain product and price snapshots.
- Customer lists show only the fictitious demo customer's records. Renewal creates a separate order linked to the subscription and does not extend its expiry.
- Order search/status filters, details and timeline. Seeded paid pending orders support simulated completion and simulated refund. Refund request enters processing; an explicit simulated success/failure result is needed. Only success shows 已退款. Failed simulations can retry. Unpaid, completed, and refunded orders do not expose these pending-order actions.
- Subscription filters/details include confirmed sample dates, masked identifiers and linked initial/renewal order history. Disabling renewal preserves the current entitlement and explains why renewal is unavailable.
- User search/detail links to that customer's orders and subscriptions. Profile notification email, demo sign-out/re-entry, basic system settings and email preferences work locally.
- Overview computes verified mock receipts minus confirmed mock refunds by event date in the configured business timezone (default Asia/Shanghai), plus total/pending orders and active/expired subscriptions.

All fixture names, products, contacts (`example.com`), orders and metrics are fictitious. State is shared between the two surfaces **only in the same browser tab**, held in memory, and reset on refresh; there is no localStorage persistence. No payment, refund, funds transfer, settlement, SMTP, supplier service or network integration is configured. Both application surfaces are deliberately accessible for demo navigation; **no real authentication or authorization exists yet**. Do not enter real customer information.

The backend exposes health and JSON 404 responses only. Prisma, database schemas/migrations, shared environment validation, request logging, authentication, server-side authorization, business APIs, entitlement changes, subscription date correction/termination, email workers and production deployment remain future tasks. No business tables are created in Task 1.1.

## Checks

See [the Task 1.1 implementation report](docs/09-task-1.1-report.md) for implemented behavior, verification coverage, remaining scope, and the complete changed-file list.

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run test:e2e
```

Browser tests use installed **Microsoft Edge** via Playwright on desktop and at an iPhone-sized viewport. Install Edge first if it is unavailable; the tests do not require downloading Playwright's browser bundle. Mobile viewport emulation is not a physical iOS-device test. Playwright builds and serves the frontend automatically on loopback port 4175, without the backend, and fails on business API calls. Screenshots and failure traces are written to ignored `test-results/`.

The frontend tests cover checkout validation/snapshots, independent product controls, renewals, completion/refund transitions, duplicate actions and timezone-aware net receipts. Backend tests use an ephemeral HTTP port to check health JSON and absent business routes.

Build artifacts: `frontend/dist/` and `backend/dist/`. To serve compiled output locally, use `npm run preview -w frontend` (default port 4173) and `npm start -w backend` in separate terminals. These commands are development previews, not production deployment configuration.
