# Interface Specification

> **T20 administrator order center override (2026-11-20):** `/admin/orders` is the real ADMIN order workspace, not Mock. It uses the merged order list/detail/create/edit/cancel/payment/refund/fulfillment APIs plus the T20 OrderEvent timeline and internal-note API. The order detail actions are state-driven: paid pending orders must be cancelled before a refund; PAID and NOT_REQUIRED PROCESSING orders may be fulfilled; zero-price orders remain in the fulfillment queue. The original Task 1.2.3 statement that order screens remain Mock is superseded only for the ADMIN order page. The customer order page and operating overview remain Mock until separately authorized. See [T20 contract](25-admin-order-center.md).


> **Current Phase 2 override (2026-11-17):** The owner separately authorized user-name refactoring and administrator-only subscription management before offline orders. `displayName` becomes nullable `username` (customer-owned, no new editing/activation flow yet) and `adminLabel` (admin-only). Admin naming is adminLabel → username → login-email prefix; customer responses exclude adminLabel. Subscription sources are ADMIN/SYSTEM, stored states ACTIVE/TERMINATED. Admin creates independent subscription records and directly edits/renews/terminates them without orders, payments, email or automatic duration arithmetic. Product/form snapshots are frozen; archived products block new subscriptions/renewals but allow maintenance of existing unexpired subscriptions. Expired ACTIVE rows grant no entitlement and cannot be edited/renewed, even before the minute worker terminates them. [Phase 2 details](14-user-subscription-core.md) supersede conflicting legacy subscription rules below. No development database migration is performed by implementation/tests.


Task 1.2.3 persistence update: product management and settings use local ADMIN APIs, alongside persistent customer management. Product dialogs add description, sort order and a responsive field editor/preview for eight supported types; archive replaces deletion, immediately unlists and cannot be reversed. Only listed/archivedAt represent product state; there are no separate purchase or renewal switches. Every field has a fixed read-only ID, editable label/hint/required/default, optional choices and move/delete controls. Schema limits/errors are visible before saving. Preview input is ephemeral and has no submission action. The original Task 1.2.3 prototype kept order/subscription/overview screens Mock; T20 supersedes only the ADMIN order page. CUSTOMER orders and the operating overview remain Mock until separately authorized. The catalog shows persisted listed/unarchived products only to ADMIN as a preview; public/customers see a not-yet-open notice. All purchasing and renewal creation are disabled in this stage, and no public product API is added. The desktop/mobile layout baseline below remains applicable. See [13-products-settings-forms.md](13-products-settings-forms.md).

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

**订单管理（T20 ADMIN 真实业务工作台）**
- `/admin/orders` 使用真实 ADMIN API，不读取 Mock store；客户订单页和经营概览仍保持各自的 Mock 状态。
- 列表按订单号、冻结商品名称、客户搜索；支持商品快照类型、订单 kind、付款状态、履约状态筛选和服务端分页。默认创建时间倒序。
- 付款状态与履约状态始终分开显示。待履约筛选使用 `fulfillmentStatus=PROCESSING`，必须同时包含 PAID 和 NOT_REQUIRED 零元订单；UNPAID/PENDING_VERIFICATION 不进入待履约队列。
- 详情显示冻结商品/表单快照、客户资料、原价与最终应付金额、订单版本、付款尝试、退款尝试、关联订阅的最小摘要、内部备注和安全 OrderEvent 时间线。
- OrderEvent 时间线只展示白名单字段和脱敏摘要，不展示原始事件 JSON、AdminAuditLog 或 OrderRevision。不得提供历史版本浏览、比较或恢复。
- 创建订单复用现有 ADMIN 创建 API；客户可选 ACTIVE/PENDING_ACTIVATION，商品可选未归档（允许未上架），表单按当前商品 Schema 完整填写，最终金额默认预填原价。
- 编辑仅在 T15 允许的未付款/未开始/有效期内状态开放，并使用订单冻结的 formSchemaSnapshot；内部备注使用独立 D48/D92 接口。
- 付款操作分为登记、确认、失败；金额不匹配可登记为待核实，但不能确认。确认时存在其他待核实尝试必须先逐笔关闭。
- 已付款未履约订单不能直接退款：管理员先取消订单，使其进入 CANCELLED + REFUND_PENDING，再按 T18 登记外部已发起的全额退款、确认实际到账或登记失败。
- 履约仅开放给 T19 支持的 INITIAL/ONE_TIME 普通订单；PAID + PROCESSING 和 NOT_REQUIRED + PROCESSING 均可履约。INITIAL 创建关联订阅，ONE_TIME 不创建订阅。
- 已完成、已退款、已取消以及不支持的 RENEWAL/SYSTEM_RENEWAL/历史异常订单仅显示可用的只读信息；普通订单仍可按 D92 修改内部备注。
- 不提供客户自助退款申请；客户与商户线下沟通。订单中心不发送邮件、不调用支付渠道或供应商接口。

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

## 5. Prototype behavior and current implementation boundary

The original Task 1.1 prototype uses Mock data. T20 supersedes that baseline only for the ADMIN order page:
- `/admin/orders` uses real API-backed list/detail/create/edit/cancel/payment/refund/fulfillment and safe event history.
- Mock confirmation/refund actions must not appear in the real ADMIN order workspace.
- Mock operating overview and CUSTOMER order history remain Mock until separately authorized.
- Product filters and product add/edit/listing/archive continue to use the existing local ADMIN APIs.
- Unlisted/unarchived products remain manageable; archived products are unlisted, cannot be edited/relisted, and retain readable details. Product changes never rewrite historical orders or current entitlement dates. Dynamic form configuration and preview remain available.
- Customer checkout remains a local mock order only.
- Mock data and simulated actions outside the T20 ADMIN order page must be clearly labelled.
- The ADMIN order center never claims that the application itself transferred customer money, initiated a refund, contacted a supplier, or sent email.

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
