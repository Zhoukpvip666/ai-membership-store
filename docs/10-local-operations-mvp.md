# Task 1.2 — Local Offline Customer and Order Management

> **Later approved design (pending implementation):** [T25](34-customer-claim-registration.md) changes customer creation and invitation registration while preserving ADMIN-managed orders/subscriptions for unclaimed customer records. This historical milestone is not the new T25 implementation contract.

> **Historical milestone:** This document preserves the original Task 1.2 scope, exclusions and implementation sequence. It is not the current backlog or feature inventory. Public registration, catalog, customer purchasing, order centers and subscription reads were implemented in later stages; see the [current project status](00-project-status.md). Historical deployment restrictions and test records below do not establish the current state of any server.

> **Historical model-only stage (2026-11-18):** [Order/subscription stage 1](15-order-subscription-foundation.md) introduced the order-first data model while retaining Phase 2 runtime behavior. New workflow subscriptions require a source order after full manual payment confirmation and fulfillment. USER/ADMIN/SYSTEM_RENEWAL sources describe origins, not online payment. That stage added schema/migration/compatibility/tests only; later stages added order/payment APIs and UI. Unknown historical periods and unlinked subscriptions remain unchanged. Migration verification uses isolated databases only.

> **Historical Phase 2 override (2026-11-17):** The owner separately authorized user-name refactoring and administrator-only subscription management before offline orders. `displayName` becomes nullable `username` (customer-owned, no new editing/activation flow yet) and `adminLabel` (admin-only). Admin naming is adminLabel → username → login-email prefix; customer responses exclude adminLabel. Subscription sources are ADMIN/SYSTEM, stored states ACTIVE/TERMINATED. Admin creates independent subscription records and directly edits/renews/terminates them without orders, payments, email or automatic duration arithmetic. Product/form snapshots are frozen; archived products block new subscriptions/renewals but allow maintenance of existing unexpired subscriptions. Expired ACTIVE rows grant no entitlement and cannot be edited/renewed, even before the minute worker terminates them. [Phase 2 details](14-user-subscription-core.md) supersede conflicting legacy subscription rules below. No development database migration is performed by implementation/tests.


**Historical status at the Task 1.2.3 handoff:** Tasks 1.2.1–1.2.2 were merged; products/settings and dynamic form configuration were ready for review, and later workflows were outside that milestone. See [the original implementation report](13-products-settings-forms.md) and the current status index above for subsequent delivery.

## 1. Objective

Turn the Task 1.1 Mock prototype into a genuinely usable **local-only management tool** for the site owner to maintain existing customers who already bought through offline WeChat/Alipay transactions.

The first operational version is not a public online store. It must persist data in the local MySQL database and support customer records, offline orders, manual payment records, subscription entitlements, renewals, and audit history.

## 2. Explicit scope

### In scope

- Local MySQL + Prisma schema and migrations.
- One seeded ADMIN account; no merchant accounts or multi-tenant model.
- Admin-created customer accounts with PENDING_ACTIVATION status.
- Copyable, one-time invitation links. No invitation or notification email is sent.
- Customer activation by setting a password; customer can later log in and view only their own historical orders and subscriptions.
- Persistent product management with only listed (public visibility) and archivedAt (irreversible archive) as product state.
- Admin-created offline orders for existing/new customers.
- Manually recorded WeChat, Alipay, cash, bank-transfer, or other offline payments.
- Admin-controlled payment verification, fulfillment status, and manual refund records.
- Manually created subscriptions, historical subscription imports, free/manual grants, and renewals.
- Subscription event history and administrator audit logs.
- Persistent basic settings and dashboard metrics.
- Local development only. Bind services to loopback; do not deploy or expose the service publicly.

### Out of scope

- Online checkout and customer-initiated online orders.
- WeChat Pay API, Alipay API, payment webhooks, automatic settlement, funds holding, or withdrawal.
- Actual money movement or refund execution by the application.
- Supplier API, supplier email, SMTP, email outbox, expiry reminder emails, or any other outbound email.
- Supplier costs, profit accounting, merchant wallets, multi-merchant onboarding, and supplier transfer tracking.
- Coupons, stored-value balances, partial payments, installment payments, and automatic recurring billing.
- Public customer self-registration.

The customer storefront may remain available as a read-only portal after activation, but purchase buttons must not create online orders in this milestone. Clearly state that online purchasing is not yet available.

## 3. Business rules

### 3.1 Customer account and activation

- A customer is created by the administrator, not through public registration.
- Login email is unique and normalized to lowercase. Notification email is optional and defaults to login email for display/use.
- New customer status is PENDING_ACTIVATION; passwordHash is null until activation.
- A pending customer may have orders and subscriptions. Account status must never gate admin-side order or subscription creation.
- The administrator can generate an invitation URL and copy it manually. The application must not send email.
- Store only a hash of the invitation token. Return the raw token/link once to the authenticated administrator.
- Default invitation validity is 7 days; it is one-time use. Regeneration revokes prior unused invitations.
- Activation consumes the token, sets the password hash, sets status ACTIVE, and records activatedAt.
- No emails are sent to pending customers. In this milestone, no email is sent to any customer, including activated customers.
- The local default URL (http://localhost:5173) is only reachable on the machine running the application. A copied localhost invitation link cannot be opened by a customer on another device. Do not imply otherwise; external invitations become usable only after a separately approved deployment/network-access phase.

### 3.2 Products

- Product types: SUBSCRIPTION and ONE_TIME.
- Persist initial price and renewal price as integer CNY fen.
- Product state consists only of listed and archivedAt. type remains SUBSCRIPTION/ONE_TIME.
- Public catalog selection requires listed=true AND archivedAt=null. ADMIN may use unlisted/unarchived products for future offline orders; future manual subscription grants/imports require an unarchived SUBSCRIPTION product regardless of listing. No separate purchase/renewal permissions exist.
- Product edits must not rewrite historical order or subscription snapshots.
- Archive products instead of deleting rows. Set listed=false and archivedAt in the same transaction; archive is irreversible and prevents editing/relisting. Archived products cannot be used for new orders, renewals or new subscriptions. Existing orders and subscription entitlements remain queryable and unchanged.
- Do not add supplier cost fields.

### 3.3 Offline orders

- The original offline-order source is retired by the latest model stage: ADMIN/USER ordinary orders and final hidden SYSTEM_RENEWAL only. This source distinction does not introduce online payment. Order APIs remain unimplemented; follow docs/15-order-subscription-foundation.md.
- Order kinds: INITIAL, RENEWAL, ONE_TIME.
- Admin selects a customer (including PENDING_ACTIVATION), an unarchived product (listed may be false), kind, target service identifier, notification/contact email, and amount. Default amount comes from the product initial price or the subscription renewal price. If the administrator overrides it, record the override in the audit log.
- A RENEWAL order must link to an existing subscription belonging to the selected customer and matching the product.
- Snapshot product name/type/term, amount, renewal price, contact email, and target identifier on the order.
- Payment and fulfillment are separate dimensions.
- Payment status is driven by payment transaction records; it must not be changed by directly editing a status field.
- Fulfillment status is changed by explicit administrator actions with an audit reason.
- Only a fully paid order can be marked COMPLETED. An unpaid or unverified order cannot be treated as awaiting fulfillment.
- For an INITIAL subscription order, create/activate the subscription only after service completion and after the administrator supplies supplier-confirmed start/expiry dates.
- For a RENEWAL order, do not automatically add a fixed duration. On confirmed service completion, the administrator enters the new expiry date confirmed by the supplier; update the linked subscription and create a subscription event in the same database transaction.
- ONE_TIME orders do not create subscriptions.

### 3.4 Offline payments and refunds

- Payment channels: WECHAT, ALIPAY, CASH, BANK_TRANSFER, OTHER.
- The administrator records a payment with amount, channel, actual transaction time, optional external reference, and note.
- Payment may first be PENDING verification. It becomes CONFIRMED only after the administrator checks the actual WeChat/Alipay/bank account or other source.
- A customer screenshot or verbal claim alone does not automatically confirm payment.
- Payment status summary values: UNPAID, PENDING_VERIFICATION, PAID, REFUND_PENDING, REFUNDED.
- PaymentTransaction is the transaction record; Order.paymentStatus is a summary updated in the same database transaction.
- Refund discussions happen privately between customer and administrator. There is no customer refund-request UI.
- The administrator may record a refund as PENDING after agreeing to refund. Mark it CONFIRMED only after the money has actually been returned outside the application. The application never sends money.
- The first local version supports full-order refunds only. Do not implement partial refunds.
- A confirmed full refund before fulfillment completion changes fulfillment to CANCELLED. If fulfillment was already COMPLETED, retain that historical completion state.
- Failed refund attempts must not mark the order REFUNDED.

### 3.5 Subscriptions

- A subscription is an entitlement record and is independent of user activation status.
- Manual grants/imports select only unarchived SUBSCRIPTION products; listed may be false. Archived products cannot create new subscriptions or renewal orders. Product archive does not terminate existing entitlements.
- A customer with PENDING_ACTIVATION can have ACTIVE subscriptions.
- A subscription can be created from a completed INITIAL order, as a MANUAL_GRANT, or as a HISTORICAL_IMPORT.
- MANUAL_GRANT and HISTORICAL_IMPORT do not create a fake order or payment transaction.
- Historical imports may link to an actual historical offline order only when that order is separately recorded with truthful details.
- Subscription stores target identifier, start date, expiry date, and renewal price snapshot.
- Stored subscription states: ACTIVE, SUSPENDED, TERMINATED. Display EXPIRED when an ACTIVE subscription's expiresAt is in the past; do not require a scheduled email/job to calculate this display state.
- Renewal creates a separate offline order linked to the subscription. It does not immediately extend the expiry date.
- On renewal fulfillment, update expiresAt only to the date confirmed by the supplier and append a RENEWED event.
- Manual expiry corrections, grants, imports, suspension, resumption, and termination require a reason and create a subscription event plus admin audit log.
- Do not delete subscription or order history.

## 4. Initial database models

Use these 11 Prisma models. There is no separate Customer table: CUSTOMER is a User role.

1. **User** — ADMIN/CUSTOMER identity, loginEmail, notificationEmail, displayName, nullable passwordHash, role, account status, activatedAt, timestamps, createdByAdminId.
2. **Session** — hashed opaque session token, userId, expiresAt, revokedAt, lastSeenAt, timestamps. Never store the raw session token.
3. **InvitationToken** — userId, unique tokenHash, expiresAt, usedAt, revokedAt, createdByAdminId, createdAt. Never store the raw invitation token.
4. **Product** — slug, name, description, product type, priceFen, renewalPriceFen, termLabel, legacy targetField, listed, sortOrder, versioned formSchema JSON, archivedAt, timestamps.
5. **Order** — orderNo, userId, productId, optional subscriptionId for renewals, orderKind, source USER/ADMIN/SYSTEM_RENEWAL (latest model override), immutable product/price/contact/target snapshots, amountFen, paymentStatus summary, fulfillmentStatus, internalNote, createdByAdminId, timestamps.
6. **PaymentTransaction** — orderId, kind PAYMENT/REFUND, channel, amountFen, status PENDING/CONFIRMED/FAILED, externalReference, occurredAt, confirmedAt, createdByAdminId, confirmedByAdminId, note, timestamps. Records customer money only; it is not a supplier-transfer table.
7. **OrderEvent** — orderId, event type, actorAdminId, note, safe metadata/before-after snapshot, createdAt. Used for order timeline and status history.
8. **Subscription** — userId, productId, optional unique sourceOrderId, sourceType ORDER/MANUAL_GRANT/HISTORICAL_IMPORT, targetIdentifier, startedAt, expiresAt, renewalPriceFen, stored status ACTIVE/SUSPENDED/TERMINATED, createdByAdminId, timestamps.
9. **SubscriptionEvent** — subscriptionId, optional orderId, event type, old/new start and expiry, actorAdminId, reason/note, createdAt.
10. **AdminAuditLog** — actorAdminId, action, entityType, entityId, sanitized beforeJson/afterJson, reason, requestId, createdAt.
11. **AppSettings** — singleton row for storeName, ownerEmail, timezone, updatedAt. No SMTP or payment secrets.

Use string IDs (CUID/UUID) consistently. Store money as integer fen and timestamps in UTC. Use foreign keys with restrictive delete behavior. Users and products are disabled/archived, not hard-deleted. Add indexes for unique loginEmail, tokenHash, product slug, orderNo, user/order creation time, order payment/fulfillment states, subscription user/status/expiry, and event timelines.

No EmailOutbox, SupplierFulfillment, ProductFormField, Merchant, MerchantWallet, or Withdrawal model is needed in this local milestone.

## 5. Local authentication and bootstrap

- Seed exactly one ADMIN user from local environment variables (for example ADMIN_EMAIL and ADMIN_PASSWORD); do not hard-code credentials or commit them.
- Seed must be idempotent and must not overwrite an existing administrator password on every run.
- Hash passwords with Argon2id or a maintained equivalent.
- Use opaque server-side sessions stored in Session and HTTP-only SameSite cookies. Secure cookie behavior must distinguish localhost development from future HTTPS deployment.
- Protect every admin API on the backend, not only through Vue route guards.
- Customers can activate only with a valid invitation and then log in. There is no public registration.
- Rate-limit login and invitation activation.
- No email/SMTP package or sending path is part of Task 1.2.

## 6. API surface for this milestone

All routes use /api/v1. Every /admin route requires ADMIN authorization.

### Authentication
- POST /auth/login
- POST /auth/logout
- GET /auth/me
- POST /auth/activate (invitation token + new password)

### Customers
- GET /admin/users
- POST /admin/users
- GET /admin/users/:id
- PATCH /admin/users/:id
- POST /admin/users/:id/invitations (generate/reissue and return copyable URL once)
- GET /me/orders
- GET /me/subscriptions

### Products and settings
- GET /admin/products
- POST /admin/products
- PATCH /admin/products/:id
- POST /admin/products/:id/archive
- GET /admin/settings
- PATCH /admin/settings

### Offline orders and transactions
- GET /admin/orders (search, customer, payment status, fulfillment status, date filters)
- POST /admin/orders
- GET /admin/orders/:id
- POST /admin/orders/:id/payment-transactions
- POST /admin/payment-transactions/:id/confirm
- POST /admin/orders/:id/refunds
- POST /admin/payment-transactions/:id/confirm-refund
- PATCH /admin/orders/:id/fulfillment
- POST /admin/orders/:id/complete

### Subscriptions
- GET /admin/subscriptions
- POST /admin/subscriptions (ORDER, MANUAL_GRANT, or HISTORICAL_IMPORT source)
- GET /admin/subscriptions/:id
- PATCH /admin/subscriptions/:id
- POST /admin/subscriptions/:id/renewal-orders
- POST /admin/subscriptions/:id/terminate

### Dashboard
- GET /admin/dashboard

Do not add public checkout, payment-provider webhook, online payment, supplier, email, settlement, or withdrawal endpoints.

## 7. UI changes to existing Task 1.1 prototype

Keep the existing visual design and route structure. Replace Mock data with API-backed data in the admin console.

- Users: add customer form; show PENDING_ACTIVATION/ACTIVE/DISABLED; generate/reissue invitation link and copy it; show a warning that localhost links are not externally reachable.
- Products: persist list/detail/create/edit, listing visibility and irreversible archive; no physical deletion or separate purchase/renewal controls.
- Orders: add offline order creation; filter by payment and fulfillment separately; record/confirm offline payment; record/confirm manual refund; update fulfillment with reason; show transaction and order event history.
- Subscriptions: add subscription; select existing customer including pending activation; choose ORDER/MANUAL_GRANT/HISTORICAL_IMPORT; enter target identifier, start/expiry, renewal price; create renewal order; update expiry only after supplier confirmation; show event history.
- Overview: calculate sales from confirmed payment transactions minus confirmed refund transactions; distinguish unpaid/pending verification from paid orders; show pending fulfillment and subscription counts.
- Settings: persist store name, owner email, timezone.
- Customer portal: activation/login and read-only own order/subscription history. Online checkout remains disabled.

## 8. Implementation sequence

Implement one subtask at a time and wait for owner review after each PR.

- **Task 1.2.1 — Prisma and local database foundation:** add Prisma, all 11 models, initial migration, environment validation, database readiness health check, idempotent ADMIN seed, migration/test scripts. Do not implement business CRUD yet.
- **Task 1.2.2 — Authentication, customers, and invitations:** admin login/session, customer creation, invitation generation/copy, activation route, no email.
- **Task 1.2.3 — Products and settings persistence:** admin CRUD and persistent settings.
- **Task 1.2.4 — Offline orders, payments, refunds, and fulfillment:** create offline orders, manual transaction records/verification, manual refund records, fulfillment state machine, order timeline/audit.
- **Task 1.2.5 — Subscriptions and renewals:** manual grant/import, order-linked activation, renewal orders, supplier-confirmed expiry updates, event history.
- **Task 1.2.6 — Dashboard and customer read-only portal:** reconciled metrics, own-order/subscription views, full end-to-end tests and local operating guide.

Tasks 1.2.1–1.2.2 were merged and Task 1.2.3 was separately authorized by the owner. Stop after the Task 1.2.3 PR and wait for human review. Task 1.2.4 requires separate authorization. Product forms are configuration/preview only; no customer values or order submissions are stored.

## 9. Acceptance criteria for the full local milestone

- Data survives browser refresh, API restart, and MySQL container restart.
- Admin can create a customer who remains PENDING_ACTIVATION.
- Admin can create orders and subscriptions for pending customers.
- Invitation links can be copied; token is hashed at rest, one-time, expires, and can be revoked/reissued.
- No email is sent to any user.
- Admin can create offline WeChat/Alipay/etc. orders, record and confirm payment, manage fulfillment, and record a manual refund without moving money through the app.
- Manual grants and historical imports create subscriptions without fake orders or payment transactions.
- Renewals create separate orders; expiry changes only from administrator-entered supplier-confirmed dates.
- Dashboard totals reconcile with confirmed transaction records.
- Every sensitive admin state change is audited.
- No online checkout, gateway, webhook, supplier API, SMTP, external email, or public deployment is present.
- npm run format:check, npm run typecheck, npm run lint, npm test, npm run build, and relevant Playwright E2E tests pass.
