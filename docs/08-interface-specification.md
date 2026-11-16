# Interface Specification

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
- Show active/purchasable products and simple category filters.
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
- If renewals are disabled, show the current entitlement/expiry but hide or disable renewal action with a clear short explanation.

**我的订单**
- Customer-facing primary order statuses are only 待发货 and 已完成.
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
- Do not show supplier procurement cost, gross profit, merchant wallet balance, or withdrawable balance in this first version.
- Sales figures count verified customer payments and account for recorded refunds. They are not the same as provider settlement/withdrawal figures.

**商品管理**
- List products with name, type, selling price, renewal price where applicable, and listing state.
- Add/edit product.
- Separate controls:
  - Whether the product is listed/visible.
  - Whether new customers can purchase.
  - Whether existing subscribers can renew.
- Delisting must not delete historical orders or subscriptions.
- Disabling new purchases or renewals must not automatically terminate existing subscriptions.
- No supplier cost field in the first-version UI.

**订单管理**
- List/search/filter by order number, customer, and primary status.
- Customer-facing primary states: 待发货, 已完成; show 已退款 after confirmed refund.
- Order detail shows order number, product snapshot, customer contact email, approved non-sensitive form data, amount, payment status, and fulfillment state.
- Main actions for a paid pending order: 确认已完成 and 申请退款.
- 确认已完成 means the owner confirms service fulfillment; it does not automatically prove payment settlement or release funds.
- Refund action creates a refund request through the payment provider when integrated. Keep internal refund states separate: 未申请, 处理中, 成功, 失败.
- Never mark an order refunded merely because the owner clicked the refund button. Only a confirmed provider result changes refund status to success.
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
- Product add/edit/listing and purchase/renewal toggles work locally.
- Order list filters and detail view work.
- Mock 确认已完成 updates the local mock order state.
- Mock 申请退款 shows a confirmation and a clearly labelled simulated result; it must not call a real provider or claim real money moved.
- Subscription filters and detail views work.
- Customer checkout creates a local mock order only.
- No real authentication, database, SMTP, payment gateway, supplier API, refund, settlement, or funds-hold behavior is implemented in this prototype.
- Clearly mark mock data and simulated actions in the UI or README.

## 6. Implementation acceptance criteria

- Customer storefront and owner/admin console share the approved visual language.
- Desktop and mobile navigation behave as specified.
- Customer catalog uses three columns on desktop and one column on mobile.
- Admin navigation is sidebar on desktop and horizontally scrollable on mobile.
- All six admin sections and four customer sections are navigable.
- Main prototype interactions listed above work without a backend.
- No real payment, refund, settlement, email, or supplier operation is triggered.
- No sensitive customer credential fields exist.
- npm run build and available lint/type-check commands pass.
