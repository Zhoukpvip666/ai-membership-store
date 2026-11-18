# Security, Privacy, and Operations

> **Current Phase 2 override (2026-11-17):** The owner separately authorized user-name refactoring and administrator-only subscription management before offline orders. `displayName` becomes nullable `username` (customer-owned, no new editing/activation flow yet) and `adminLabel` (admin-only). Admin naming is adminLabel → username → login-email prefix; customer responses exclude adminLabel. Subscription sources are ADMIN/SYSTEM, stored states ACTIVE/TERMINATED. Admin creates independent subscription records and directly edits/renews/terminates them without orders, payments, email or automatic duration arithmetic. Product/form snapshots are frozen; archived products block new subscriptions/renewals but allow maintenance of existing unexpired subscriptions. Expired ACTIVE rows grant no entitlement and cannot be edited/renewed, even before the minute worker terminates them. [Phase 2 details](14-user-subscription-core.md) supersede conflicting legacy subscription rules below. No development database migration is performed by implementation/tests.


## 1. Customer information

Collect only information necessary for the selected product.

MVP may support non-sensitive identifiers and contact details:
- Customer contact email.
- Target account email or account identifier.
- Product-specific non-sensitive text/selection fields.

MVP must not collect or email:
- Account passwords.
- One-time passwords or SMS verification codes.
- 2FA secrets or backup codes.
- Recovery codes.
- Session cookies or access tokens.
- Payment card numbers, security codes, or banking credentials.

If supplier says one of these secrets is required, do not add a generic form field. Pause and design a separate, explicitly authorized secure workflow with the owner. Prefer official user-authorized invitation/OAuth flows that do not disclose credentials to reseller.

## 2. Email security

- Configure SMTP credentials through environment variables or secret manager.
- Use TLS for SMTP.
- Restrict supplier recipients to configured addresses.
- Validate recipients server-side.
- Use separate supplier/customer templates.
- Include minimum required order information.
- Escape user values in HTML templates.
- Record delivery metadata, not credentials or full sensitive values.
- Retry failed messages with bounded backoff.
- Avoid duplicate supplier requests through idempotency keys.

## 3. Payment verification

- MVP has no automated payment gateway.
- Admin verifies payment in actual merchant/payment account before confirming order.
- Screenshot, browser redirect, customer claim, or client-side status is insufficient alone.
- Store amount, method, external reference if available, verifier, and verification time.
- Never store card data or payment account credentials.
- Explain that order is not confirmed until verification.

## 4. Supplier transfer and fulfillment

- Application does not initiate WeChat transfers or other money movement.
- Operator transfers externally and records it.
- Do not mark supplier payment complete without operator confirmation.
- Do not mark fulfillment complete merely because email was sent.
- Keep customer payment, supplier transfer, and fulfillment as independent states.
- Record operator actions/timestamps.

## 5. Account and application security

- Hash passwords with Argon2id or maintained equivalent.
- Use HTTP-only, Secure, SameSite cookies in production.
- Enforce CSRF protection for cookie-authenticated mutations.
- Enforce backend role checks.
- Rate-limit login, registration, password reset, sensitive admin actions.
- Validate request bodies and query parameters.
- Use Prisma parameterized queries.
- Use secure headers and restrictive CORS.
- Avoid leaking stack traces/secrets in production errors.
- Keep dependencies patched and run dependency audits.

## 6. Data protection and retention

- Mask customer account identifiers in list views where practical.
- Restrict full order-form values to submitting customer and authorized admins.
- Do not include raw form values in logs/analytics.
- Define retention for fulfilled order data and delete/redact data no longer needed, subject to applicable legal/accounting retention obligations.
- Provide process for applicable data access/correction/deletion requests.
- Back up DB and test restoration before production data.

## 7. Auditability

Audit:
- Customer payment verification.
- Supplier email send/retry.
- Supplier transfer record/correction.
- Fulfillment success/failure.
- Subscription activation/expiry changes.
- Product price/form changes.
- User disable/enable.
- Refund records.

Audit logs must not contain secrets.

## 8. Email reminders

- Initial proposed subscription reminder offsets: 7, 3, and 1 day before expiry.
- Make offsets configurable.
- Record subscription ID, expiry snapshot, offset, recipient, and send result.
- Unique reminder key prevents duplicate logical reminders.
- Failed reminders can be retried.
- Admin can view failed reminders.

## 9. Production launch checklist

- Confirm supplier authorization and relevant service provider terms permit planned resale/invitation workflow.
- Confirm accurate product descriptions, service terms, refund/cancellation policy, and support contact.
- Confirm business/payment arrangement is eligible for product category and merchant entity.
- Verify SMTP domain authentication (SPF, DKIM, DMARC) where supported.
- Enable HTTPS.
- Configure secrets outside Git.
- Configure backups and test restore.
- Configure log rotation/monitoring.
- Create least-privilege admin account.
- Test payment verification, supplier email, manual transfer record, fulfillment completion, customer email end-to-end.
- Test access boundaries between two customer accounts.
- Test duplicate actions and email retry behavior.
