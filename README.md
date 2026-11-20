# AI Membership Store

A private, independently operated storefront and order-management system for AI membership services and other digital services.

**Project status:** Tasks 1.2.1–1.2.3, Phase 2 and order/subscription model PR #6 are merged. Products/customers/settings/subscriptions use the local API; overview/order UI remains Mock. [Order read API](docs/16-order-read-api.md) provides ADMIN and own-CUSTOMER list/detail endpoints. [Order creation API](docs/19-order-creation-api.md) provides the merged customer/admin creation POSTs (PR #11). [Order edit API](docs/20-order-edit-api.md) provides the merged role-specific PATCH endpoints (PR #14), with frozen-schema replacement, optimistic versions and persisted idempotency. [T16 cancellation and timeout](docs/21-order-cancellation-timeout.md) adds the two cancellation POSTs and SYSTEM minute worker for review. Payment/refund confirmation, fulfillment, notification, verification-code and API-key APIs remain absent.

**Order/subscription model stage 1:** [Database foundation and compatibility guide](docs/15-order-subscription-foundation.md). Adds structured periods, order snapshots/actors, billing anchors and renewal markers with six additive migrations (fifth through tenth). The review follow-up adds strict source/kind/completeness checks, immutable renewal-cycle snapshots, a separate billing revision and durable per-cycle unique claims. SYSTEM_RENEWAL must be inserted in final PAID/COMPLETED state with paidAt <= paymentConfirmedAt <= fulfilledAt (all non-NULL); updates/deletes remain forbidden. paidAt is actual payment occurrence; PaymentTransaction.createdAt is entry time, and deprecated paymentRecordedAt is retained only for history. The future order → full manual payment confirmation → fulfillment → subscription workflow supersedes direct subscriptions for new business once its services are implemented. This stage adds no order/payment APIs or pages and does not migrate the development database. Existing Phase 2 APIs remain in compatibility mode; the new business workflow is not operational yet.

Order sources are exclusively USER/ADMIN/SYSTEM_RENEWAL after migration ten. Source is immutable and every order rejects DELETE/REPLACE. OFFLINE_MANUAL and all its CHECK exemptions/special triggers are removed from the final database. Nullable ENUM storage with DEFAULT NULL is intentional: INSERT Trigger plus a non-NULL CHECK reject omitted/NULL sources even under non-strict SQL. The first nine SQL files remain unchanged; migration ten refuses databases still containing retired-source test orders. Development orders/relationships have not been inspected or cleaned. See the stage guide before any separately authorized migration.

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
12. docs/12-authentication-customers-invitations.md — Task 1.2.2 implementation, local operation, security boundaries and verification.
13. docs/13-products-settings-forms.md — Task 1.2.3 product/settings persistence, dynamic form contract, migration and isolated verification.
14. docs/14-user-subscription-core.md — Phase 2 user names, frozen subscription forms, direct renewal, concurrency, migration and operation guide.
15. docs/15-order-subscription-foundation.md — order-first model foundation, additive migration, legacy compatibility and deferred service constraints.
16. docs/16-order-read-api.md — administrator/customer order list/detail, safe DTOs, hidden-order/ownership rules and isolated no-Seed API tests.
17. docs/17-order-creation-and-lifecycle-design.md — approved order lifecycle decisions and implementation boundaries.
18. docs/18-order-revision-foundation.md — immutable order revisions, generic idempotency, version/deadline DTOs and isolated tests.
19. docs/19-order-creation-api.md — approved USER/ADMIN order creation endpoints, validation, transaction, idempotency and acceptance contract.
20. docs/20-order-edit-api.md — approved USER/ADMIN order edit endpoints, complete form replacement, price edits, zero-price transition, optimistic concurrency and transaction contract.
21. docs/21-order-cancellation-timeout.md — approved manual cancellation and SYSTEM 24-hour timeout worker contract.

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
    ├── 11-database-foundation.md
    ├── 12-authentication-customers-invitations.md
    ├── 13-products-settings-forms.md
    ├── 14-user-subscription-core.md
    └── 15-order-subscription-foundation.md
```

## Local development — Phase 2

Administrator subscriptions now persist with product/form snapshots, alongside products/settings and authentication/customers/invitations. Read the Phase 2 guide before applying the new migration; implementation tests never migrate the development database. See [Task 1.2.3 operation and verification guide](docs/13-products-settings-forms.md), [database setup](docs/11-database-foundation.md) and [authentication guide](docs/12-authentication-customers-invitations.md).

For an existing initialized Task 1.2.2 database, preserve your `.env` and MySQL volume. After review and an operator backup, apply only committed migrations; do not reset/reseed existing accounts:

```powershell
npm ci
npm run db:status
npm run db:migrate
npm run dev:api
# Another terminal:
npm run dev:web
```

Open `http://localhost:5173/admin/login`; product management is `/admin/products`, settings `/admin/settings`, customers `/admin/users`, subscriptions `/admin/subscriptions`. API defaults to `http://127.0.0.1:3000/api/v1`; APP_BASE_URL must match the frontend origin. Reuse existing correctly configured services instead of starting duplicates. Fresh installations follow the foundation guide for MySQL 8.4/environment/initial seed setup.

The product editor supports integer Fen prices, descriptive service term, sorting, listing visibility, irreversible archive and eight-type form configuration/preview. Settings save only store name, notification email and IANA timezone; notification email does not change the admin login. All endpoints require an ADMIN database session. Product/settings writes and sanitized audit records share transactions. The form migration adds an empty schema/default sort order. A separate follow-up migration removes the two obsolete purchase/renewal permission columns and unlists already archived products. Both existing migrations remain unchanged; all eleven business tables, saved forms and remaining data are retained. Existing targetField and order/subscription snapshots remain intact. Product state consists only of listed and archivedAt. Unlisted/unarchived products remain available to ADMIN for future offline orders and manual subscription operations (SUBSCRIPTION only); those writes are outside this task. Archive atomically sets listed=false, cannot be reversed and prevents edits/relisting.

The catalog is an ADMIN preview of persisted listed/unarchived products. Purchasing, renewal creation and form submission are disabled. Public/customer product/history pages remain explicit placeholders. Overview/order demo history remains marked Mock and separate from real products/customers/subscriptions. Customer history remains a placeholder; no customer subscription endpoint is added. Mock completion/refund demonstrations move no money and call no business API. Preview values are never saved. No SMTP, payment provider or upstream service is connected.

## Checks

```powershell
npm run format:check
npm run typecheck
npm run lint
npm run db:validate
npm test
npm run test:db
npm run test:e2e
npm run build
```

Database/E2E tests use random isolated MySQL 8.4 projects/volumes and temporary credentials, never the development `.env` or volume. Upgrade tests first compare every original table through the old compatible migrations, explicitly clean only disposable retired-source order fixtures before final-source deployment, then compare all remaining rows through migration ten; API tests cover strict schemas, authorization, persistence/restarts, audit rollback and unchanged history/accounts. Browser tests use installed Microsoft Edge on desktop and an iPhone-sized viewport against a real isolated API/database, plus explicitly stubbed Mock-history regressions. Viewport emulation is not a physical-device test. Screenshots/traces are ignored under test-results; runners remove only their own resources.

Build artifacts are frontend/dist and backend/dist. Preview can use `npm run preview -w frontend` with the port matching APP_BASE_URL and `npm start -w backend`; these are local previews, not production deployment configuration.

The order read API adds no frontend history integration. The order creation POST APIs (PR #11) and core order edit PATCH APIs (PR #14) are merged, specified with verification results in [docs/19-order-creation-api.md](docs/19-order-creation-api.md) and [docs/20-order-edit-api.md](docs/20-order-edit-api.md). Payment/fulfillment/renewal, customer subscription reads, notifications and API keys remain unimplemented. Use task-specific no-Seed isolated database modes; never target development configuration during implementation tests. Stop at each PR for review.

**Order revision foundation:** [Order versions, append-only history and generic idempotency](docs/18-order-revision-foundation.md). Migration eleven and existing order DTO extensions. The merged [order creation implementation](docs/19-order-creation-api.md) adds customer/admin creation POSTs and migration twelve. T15 reuses those twelve migrations unchanged for the [order edit implementation](docs/20-order-edit-api.md); payment/fulfillment remain deferred. Its no-Seed regression command is `npm run test:db -w backend -- --edit-only`, with read regression in a separate random isolated database. Browser regression uses `npm run test:e2e -w backend -- --edit-only` after building.

**T16 cancellation and timeout:** [Contract and actual validation](docs/21-order-cancellation-timeout.md) implements customer/admin cancellation POSTs and a database-clock SYSTEM minute worker, with versioned atomic history, paid REFUND_PENDING handling and pending-attempt closure. No new migration, refund/payment confirmation API or order UI. Run `npm run test:db -w backend -- --cancellation-only` for no-Seed historical-upgrade/read/cancel/edit/create/revision/subscription regression, and `npm run test:e2e -w backend -- --cancellation-only` after building for fresh isolated browser checks. The worker starts immediately with the API and every minute thereafter; shutdown waits for its in-flight work. Do not start the modified API against development data as an implementation test; deployment requires separate operator review.
