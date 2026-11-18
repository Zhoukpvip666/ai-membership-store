# Instructions for Codex and contributors

## Before changing code

1. Read this file and every document listed in the README documentation reading order.
2. Treat the documents as the current product baseline. For UI work, follow docs/08-interface-specification.md as the approved source of truth.
3. Check the existing repository before creating or replacing files. Preserve user changes.
4. Work on only the explicitly requested task or the next not-yet-completed task in the roadmap. Do not implement the entire roadmap in one run.
5. If a requirement is ambiguous or conflicts with the current implementation, stop and report the exact decision needed instead of inventing business rules.

## Working style

- Keep the architecture a modular monolith for the MVP.
- Prefer small, reviewable changes.
- Before each phase, state the task, expected files, and acceptance criteria.
- After each task, run the relevant tests, type checks, lint, and build commands that exist.
- Report changed files, commands executed, results, known gaps, and the next recommended task.
- Wait for approval before starting the next substantial task.
- Update the relevant documentation whenever an implementation decision changes the documented behavior.

## Product and workflow constraints

- The MVP is a manual-fulfillment reseller storefront, not an automated supplier integration.
- Customer payment verification, supplier transfer, and service fulfillment are separate states.
- The supplier request email is sent only after an administrator has verified the customer's payment.
- The operator manually transfers the supplier's per-order amount and records the result.
- The operator manually confirms that the supplier completed the service before the customer completion email is sent.
- Subscription renewal creates a new order. It is not an automatic recurring charge.
- Do not assume that a renewal extends an existing expiry date by a fixed number of days. The operator must record the expiry date confirmed by the supplier until a product-specific renewal rule is verified.
- Do not add a real payment gateway or supplier API integration unless the user explicitly approves the provider, credentials, product eligibility, and integration scope.

## UI prototype constraints

- The customer storefront and the unified owner/admin console are the only two application surfaces.
- The owner/admin console combines merchant operations and administrator functions; do not create separate merchant and administrator portals.
- Follow docs/08-interface-specification.md for layout, responsive behavior, navigation, and page content.
- The first UI prototype uses mock data only. Clearly label simulated checkout, completion, and refund actions.
- Never connect mock buttons to real payment, refund, settlement, supplier, or email operations.
- Do not add procurement-cost, gross-profit, merchant-wallet, or merchant-withdrawal UI to the first version.

## Security and privacy constraints

- Never commit real API keys, SMTP passwords, access tokens, private keys, customer data, supplier secrets, or production configuration.
- Provide .env.example with placeholders only. Ensure .env and local secret files are ignored by Git.
- Never log passwords, one-time passwords, 2FA codes, recovery codes, payment credentials, or full sensitive form values.
- The MVP must not collect account passwords, one-time passwords, 2FA codes, recovery codes, session cookies, or other authentication secrets in ordinary order forms or email.
- Product-specific forms may collect only necessary, non-sensitive identifiers and contact details. If the supplier claims a secret is required, stop and request a separate security and authorization design; do not quietly add a password field.
- Do not automate login to third-party AI services or bypass their access controls.
- Use role-based access control for administrator functions.
- Verify ownership before showing an order or subscription to a customer.
- Validate all input on the server. Do not trust prices, roles, order statuses, or payment states sent by the browser.
- Use parameterized database access through the ORM, secure password hashing, HTTP-only session cookies, CSRF protection where applicable, and rate limits for authentication endpoints.
- Record important administrator actions in an audit log.
- Minimize customer data collection and define a retention/deletion process.

## Engineering constraints

- Store money as integer minor units (for example, CNY fen), never floating-point values.
- Store timestamps in UTC and render them in the configured business timezone (initial default: Asia/Shanghai).
- Use database transactions for order creation, payment verification, and membership updates where multiple records must remain consistent.
- Make email delivery retryable and idempotent. Persist an email/outbox record before sending.
- Do not mark an email as delivered merely because an attempt was queued.
- Do not mark a customer payment as paid based only on a screenshot or a client-side claim. The administrator must verify the actual transaction in the relevant payment account or provider console.
- Keep secrets out of API responses and frontend bundles.
- Add tests for authorization, state transitions, duplicate actions, and failure paths.

## Definition of done

A task is complete only when:

1. Its acceptance criteria are met.
2. Relevant tests and build checks pass, or failures are explicitly explained.
3. No secrets or real customer data are added.
4. Documentation is updated when needed.
5. The final report identifies any manual setup still required.


## Task 1.2 local-only operating constraints

- Follow docs/10-local-operations-mvp.md, docs/04-data-model.md, and docs/05-api-contract.md as the current source of truth for Task 1.2.
- This milestone is a local offline customer/order/subscription manager, not a public online store.
- Implement only OFFLINE_MANUAL orders. Do not implement online checkout, payment-provider APIs/webhooks, settlement, funds holding, or withdrawal.
- Never send email in Task 1.2. Invitation links are generated for the admin to copy manually. No SMTP package, email outbox, or email worker.
- The app must make clear that localhost invitation links cannot be opened by external customers.
- Pending-activation customers may own orders and subscriptions. Do not gate admin operations on customer activation status.
- Do not create fake orders/payment records for MANUAL_GRANT or HISTORICAL_IMPORT subscriptions.
- Payment status must be based on recorded/confirmed PaymentTransaction rows. Fulfillment status is a separate dimension. Do not directly trust a browser-supplied status.
- Offline refund is only recorded after private agreement; mark it confirmed only after the owner has actually returned funds externally. The application never moves money.
- Keep the app bound to loopback during local development. Do not deploy or expose it publicly.
- Do not add supplier cost, supplier transfer, merchant wallet, multi-merchant, or profit accounting features.

## Phase 2 owner-approved override

- Phase 2 follows docs/14-user-subscription-core.md for user names and subscriptions. This explicitly supersedes older subscription-renewal/order linkage rules for this phase.
- Only ADMIN can create/manage subscriptions. Direct renewal changes the existing subscription, using a manually entered expiry; never create an order/payment or infer duration.
- Keep username separate from private adminLabel. Customer responses must exclude adminLabel; do not add a new activation or username editing flow.
- Persist frozen product/form snapshots and validate changes against the subscription's own snapshot.
- ADMIN/SYSTEM sources and ACTIVE/TERMINATED states only. Preserve all historical event types/rows and restrictive references.
- Legacy ORDER/MANUAL_GRANT/HISTORICAL_IMPORT sources migrate to ADMIN without changing creators, IDs, dates, price or status. Any SUSPENDED row blocks migration before persistent changes; report its count and IDs for operator decision.
- Versioned migration and tests run on isolated databases only during implementation. Never migrate/reset the development database or edit its .env.
- Subscription writes, events, sanitized audits and idempotency responses commit atomically. Enforce optimistic version checks and database-time expiry checks, including races with the minute expiry worker.
- No order/payment, email/SMTP, notifications, verification codes, upstream API or API-key feature in this phase. Stop at the new PR for review.

## Order/subscription model stage 1 override (2026-11-18)

- Follow docs/15-order-subscription-foundation.md for the separately authorized additive database model stage. Future business uses order → confirmed full offline payment → fulfillment → order-linked subscription; this supersedes Phase 2 direct creation/renewal for the future workflow.
- This stage implements schema, versioned migration, compatibility tests and documentation only. Do not implement new pages, order/payment APIs, calendar calculations, renewal jobs or fulfillment services.
- Retain OFFLINE_MANUAL orders, ADMIN/SYSTEM subscriptions, all old states/columns/records and nullable legacy sourceOrderId. Add USER/ADMIN/SYSTEM_RENEWAL order sources and ORDER subscription source without converting history.
- Unknown historical periods/anchors/order forms stay NULL. Never infer from termLabel, invent source orders/payments or alter original snapshots.
- Only isolated databases may be migrated/tested during development. Preserve the original checkout, .env, running services and data volume. Review and backup precede any separately authorized development migration.
