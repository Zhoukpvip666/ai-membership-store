# Interface Specification

> **Current Phase 2 override (2026-11-17):** The owner separately authorized user-name refactoring and administrator-only subscription management before offline orders. `displayName` becomes nullable `username` (customer-owned, no new editing/activation flow yet) and `adminLabel` (admin-only). Admin naming is adminLabel → username → login-email prefix; customer responses exclude adminLabel. Subscription sources are ADMIN/SYSTEM, stored states ACTIVE/TERMINATED. Admin creates independent subscription records and directly edits/renews/terminates them without orders, payments, email or automatic duration arithmetic. Product/form snapshots are frozen; archived products block new subscriptions/renewals but allow maintenance of existing unexpired subscriptions. Expired ACTIVE rows grant no entitlement and cannot be edited/renewed, even before the minute worker terminates them. [Phase 2 details](14-user-subscription-core.md) supersede conflicting legacy subscription rules below. No development database migration is performed by implementation/tests.


Task 1.2.3 persistence update: product management and settings use local ADMIN APIs, alongside persistent customer management. Product dialogs add description, sort order and a responsive field editor/preview for eight supported types; archive replaces deletion, immediately unlists and cannot be reversed. Only listed/archivedAt represent product state; there are no separate purchase or renewal switches. Every field has a fixed read-only ID, editable label/hint/required/default, optional choices and move/delete controls. Schema limits/errors are visible before saving. Preview input is ephemeral and has no submission action. Existing order/subscription/overview screens remain explicitly Mock. The catalog shows persisted listed/unarchived products only to ADMIN as a preview; public/customers see a not-yet-open notice. All purchasing and renewal creation are disabled in this stage, and no public product API is added. The desktop/mobile layout baseline below remains applicable. See [13-products-settings-forms.md](13-products-settings-forms.md).

This document is the approved first-version UI baseline for the customer storefront and the single-owner management console. It is intentionally simple and should be implemented before real payment, supplier, or database workflows.

## 1. Product surfaces

There are exactly two application surfaces:

1. **Customer storefront** — public catalog plus the signed-in customer's subscriptions, orders, and profile.
2. **Unified owner/admin console** — one private management area used by the site owner. Do not create separate merchant and administrator portals.

The same Vue application may serve both surfaces with route-level layouts and authorization.

## 2. Shared visual direction

- Clean, light, modern interface.
- White cards on a very light cool-gray background.
- Blue is the primary action/accent color.
- Rounded cards and controls, subtle borders and shadows.
- Concise Chinese UI copy. Avoid marketing hero banners, long introductory text, redundant page descriptions, and decorative content.
- Emphasize the actual content: product name, price, order status, expiry date, and primary actions.
- Responsive behavior must be designed, not merely scaled down.

## 3. Customer storefront

### 3.1 Desktop layout

- Top header with compact logo/site name, navigation, and signed-in account/avatar.
- Navigation items: 商品, 我的订阅, 我的订单, 个人中心.
- Product catalog is the default page.
- Category filters: 全部, 订阅服务, 一次性服务.
- Product cards in a three-column grid on typical desktop widths.
- Each card shows only:
  - Product type badge.
  - Product name.
  - Selling price.
  - Renewal price/period for subscriptions, or one-time payment note.
  - Primary button: 立即购买.
- Do not add a large marketing banner or verbose introductory copy.

### 3.2 Mobile layout

- Compact top header with logo/site name and account/avatar entry.
- Fixed bottom navigation with four items: 商品, 订阅, 订单, 我的.
- Product cards become a single-column compact list. Each card keeps product type, name, price, short renewal/one-time note, and purchase button visible without excessive vertical padding.
- Bottom navigation must respect iOS safe-area insets and must not cover page content.
- Checkout should use a mobile-friendly bottom sheet or full-width dialog.
- On desktop, use the top navigation and do not show the mobile bottom bar.

### 3.3 Customer pages

**商品**
- Show only listed=true and archivedAt=null products with simple category filters. In Task 1.2.3 this is an ADMIN preview with a disabled 暂未开放线上购买 button; public/customer catalog access remains unavailable.
- Subscription and one-time products are visually distinguishable.
- Product prices and terms come from product configuration.

**购买**
- Show product name, price, and term.
- Collect customer notification email and only product-required non-sensitive information.
- Never collect passwords, OTPs, 2FA codes, recovery codes, session cookies, or payment credentials.
- Show concise fulfillment note: merchant handles the order manually and emails the customer when service is complete.
- The first UI prototype uses mock data and must not claim a real payment was processed.

**我的订阅**
- Show subscription product, masked target identifier, status, expiry date, renewal price, and renewal action when allowed.
- A product being delisted does not itself terminate an existing subscription.
- Archived products retain current entitlements/expiry and historical details, but cannot start new renewals. In Task 1.2.3 all renewal creation remains unavailable with a short explanation; no separate renewal switch exists.

**我的订单**
- Customer-facing primary order statuses are only 待发货 and 已完成.
- Payment is a separate dimension: an unpaid local order displays 未付款 with fulfillment 未开始. Only confirmed-paid pending orders display 待发货. The unpaid filter is a payment-derived view, not a new fulfillment state.
- A refunded order may display 已退款 as a terminal outcome.
- Show product, order number, date, amount, and status.
- Detail view can show a concise timeline.
- Refund requests are handled privately between customer and merchant outside the first-version UI; do not build a customer refund-request workflow in the MVP.

**个人中心**
- Show login email, notification email, password/security entry, and logout.
- Keep profile minimal.

## 4. Unified owner/admin console

### 4.1 Navigation

Use one unified management console with the following six navigation items:

1. 经营概览
2. 商品管理
3. 订单管理
4. 订阅管理
5. 用户管理
6. 系统设置

No merchant registration, merchant onboarding, merchant wallet, merchant balance, merchant withdrawal, sub-merchant, or multi-merchant navigation.

### 4.2 Desktop and mobile layout

**Desktop**
- Compact top bar with site name, management-console label, owner email, and avatar.
- Left sidebar navigation.
- Main content area on the right.
- Keep pages concise and data-focused.

**Mobile/tablet**
- Top bar remains compact.
- Sidebar becomes a horizontally scrollable navigation row below the top bar.
- Tables may scroll horizontally; do not force dense tables into unreadable cards unless needed.
- Modals become mobile-friendly sheets/dialogs.

### 4.3 Management pages

**经营概览**
- Four simple metrics: 今日已确认收款, 本月已确认收款, 累计订单, 待发货订单.
- Recent orders list/table.
- Subscription summary: active and expired counts.
- 待发货订单 counts only confirmed-paid pending orders; unpaid orders remain in total orders but do not enter the delivery queue.
- Do not show supplier procurement cost, gross profit, merchant wallet balance, or withdrawable balance in this first version.
- Sales figures count verified customer payments and account for recorded refunds. They are not the same as provider settlement/withdrawal figures.

**商品管理**
- List products with name, type, selling price, renewal price where applicable, and listing state.
- Add/edit product.
- Show one listing switch and an archive action. Listing only controls public visibility.
- Unlisted/unarchived products remain editable and available to ADMIN for future offline orders. Future manual subscription grants/imports may select any unarchived SUBSCRIPTION product, regardless of listing.
- Archive confirmation explicitly states that it immediately unlists, cannot be reversed, and prevents edits/relisting. Archived rows/details remain readable, their listing switches are off/disabled, and edit/archive actions are hidden. Future new orders, renewals and subscription creation must reject archived products.
- Delisting must not delete historical orders or subscriptions.
- Archiving must preserve existing subscription entitlements and historical orders.
- No supplier cost field in the first-version UI.

**订单管理**
- List/search/filter by order number, customer, and primary status.
- Customer-facing primary states: 待发货, 已完成; show 已退款 after confirmed refund.
- Display payment separately from order/fulfillment state. Unpaid pending orders display 未付款 in lists, details and linked history; they must not match the 待发货 filter.
- Order detail shows order number, product snapshot, customer contact email, approved non-sensitive form data, amount, payment status, and fulfillment state.
- Main actions for a paid pending order: 确认已完成 and 申请退款.
- 确认已完成 means the owner confirms service fulfillment; it does not automatically prove payment settlement or release funds.
- Refund action creates a refund request through the payment provider when integrated. Keep internal refund states separate: 未申请, 处理中, 成功, 失败.
- Never mark an order refunded merely because the owner clicked the refund button. Only a confirmed provider result changes refund status to success.
- In the local mock flow, simulated success also changes fulfillment to CANCELLED (已取消), while retaining historical payment confirmation. A pending/failed refund leaves fulfillment unchanged. Refunded fixtures and detail views must follow the same rule.
- No customer self-service refund application in the first version; customers contact the merchant privately.

**订阅管理**
- List customer, subscription ID, product, expiry date, renewal price, and status.
- Filters: 全部, 有效, 已过期, 已终止.
- Detail shows target identifier (masked where appropriate), start/expiry dates, renewal price, and linked initial/renewal order history.
- Owner may correct dates only based on confirmed supplier information; record an audit event.
- Termination requires an explicit reason and must not delete orders.

**用户管理**
- List/search customers.
- Show basic account information, registration date, order count, subscription count, and account status.
- Detail links to that customer's orders and subscriptions.
- Do not expose passwords or authentication tokens.

**系统设置**
- Storefront name.
- Owner/notification email.
- Email notification preferences.
- Business timezone.
- Payment provider configuration status (not secret values).
- SMTP credentials and payment secrets remain deployment secrets, never displayed or edited as plaintext in the UI.

## 5. Prototype behavior

The first implementation is a frontend prototype using mock data:
- Navigation between all customer and management pages works.
- Product filters work.
- Product add/edit/listing and irreversible archive persist through the local ADMIN API.
- Unlisted/unarchived products remain manageable; archived products are unlisted, cannot be edited/relisted, and retain readable details. Product changes never rewrite historical orders or current entitlement dates. Dynamic form configuration and preview remain available.
- Order list filters and detail view work.
- Mock 确认已完成 updates the local mock order state.
- Mock 申请退款 shows a confirmation and a clearly labelled simulated result; it must not call a real provider or claim real money moved.
- Subscription filters and detail views work.
- Customer checkout creates a local mock order only.
- No real authentication, database, SMTP, payment gateway, supplier API, refund, settlement, or funds-hold behavior is implemented in this prototype.
- Clearly mark mock data and simulated actions in the UI or README.

## 6. Implementation acceptance criteria

### Task 1.2.2 persistent slice

- Keep the visual style and all navigation. Add /admin/login, /login and /activate; guard admin routes by a real backend-checked session and role.
- User management now shows real CUSTOMER rows, status filters, paging, profile-only add/edit forms, disable/restore with reason, real counts and invitation metadata. It never asks the administrator to set a customer password.
- Show a copyable invitation only after issuance; closing the detail clears it. Reissue/revoke are explicit actions. Show the 7-day, one-use, local-machine-only and no-email limits.
- Customer activation asks for a new password and confirmation. Expired/revoked/used tokens share a clear failure message. Customer login/profile/logout uses the real account.
- Keep unrelated admin screens explicitly Mock. Real customer profiles must not show fictitious customer histories; own history remains a later task. Public/customer catalog purchasing stays disabled.

- Customer storefront and owner/admin console share the approved visual language.
- Desktop and mobile navigation behave as specified.
- Customer catalog uses three columns on desktop and one column on mobile.
- Admin navigation is sidebar on desktop and horizontally scrollable on mobile.
- All six admin sections and four customer sections are navigable.
- Main prototype interactions listed above work without a backend.
- No real payment, refund, settlement, email, or supplier operation is triggered.
- No sensitive customer credential fields exist.
- npm run build and available lint/type-check commands pass.
