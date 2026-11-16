# Instructions for Codex and contributors

## Before changing code

1. Read this file and every document listed in the README documentation reading order.
2. Treat the documents as the current product baseline.
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
