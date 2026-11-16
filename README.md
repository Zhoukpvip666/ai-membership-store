# AI Membership Store

A private, independently operated storefront and order-management system for AI membership services and other digital services.

**Project status:** Planning baseline. No application code has been implemented yet.

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
- UI: Element Plus for the first implementation; visual style remains to be confirmed.
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

## Important launch gates

Before accepting real orders, the operator must verify that the supplier is authorized to provide and resell the relevant service, that the service provider's terms permit the intended invitation/resale workflow, that customer-facing descriptions are accurate, and that the selected payment/settlement arrangement is permitted for the merchant and product category. The project documents do not constitute legal or payment-provider approval.

## Repository structure

~~~text
.
├── AGENTS.md
├── README.md
└── docs/
    ├── 01-product-requirements.md
    ├── 02-user-and-operations-flows.md
    ├── 03-system-architecture.md
    ├── 04-data-model.md
    ├── 05-api-contract.md
    ├── 06-security-and-operations.md
    └── 07-development-roadmap.md
~~~
