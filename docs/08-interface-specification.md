# Interface Specification

> **T21 CUSTOMER order center override (2026-11-20):** `/account/orders` is the real API-backed view of the signed-in customer's own orders, using the existing customer list/detail/edit/cancel APIs plus `GET /customer/order-guidance`. This override applies to existing-order management and is merged in PR #31. See [T21 contract](26-customer-order-center.md).

> **T22 customer storefront override (2026-11-20):** T22.1 lets visitors browse listed, unarchived products and product details. Product detail never loads dynamic formSchema. T22.2 enables 立即购买 and loads the safe form projection on the protected purchase route for ACTIVE CUSTOMERS. Guests are redirected to login and automatically returned to the same purchase route after successful login. T22 reuses the existing customer order-creation API for offline-payment orders only; no online payment, proof upload, cart, renewal, email, or deployment. See [T22 contract](27-customer-storefront-and-order-placement.md).


> **T20 administrator order center override (2026-11-20):** `/admin/orders` is the real ADMIN order workspace, not Mock. It uses the merged order list/detail/create/edit/cancel/payment/refund/fulfillment APIs plus the T20 OrderEvent timeline and internal-note API. The order detail actions are state-driven: paid pending orders must be cancelled before a refund; PAID and NOT_REQUIRED PROCESSING orders may be fulfilled; zero-price orders remain in the fulfillment queue. The original Task 1.2.3 statement that order screens remain Mock is superseded only for the ADMIN order page. T21 has since replaced the CUSTOMER order page; the operating overview remains Mock. See [T20 contract](25-admin-order-center.md).


> **Current Phase 2 override (2026-11-17):** The owner separately authorized user-name refactoring and administrator-only subscription management before offline orders. `displayName` becomes nullable `username` (customer-owned, no new editing/activation flow yet) and `adminLabel` (admin-only). Admin naming is adminLabel → username → login-email prefix; customer responses exclude adminLabel. Subscription sources are ADMIN/SYSTEM, stored states ACTIVE/TERMINATED. Admin creates independent subscription records and directly edits/renews/terminates them without orders, payments, email or automatic duration arithmetic. Product/form snapshots are frozen; archived products block new subscriptions/renewals but allow maintenance of existing unexpired subscriptions. Expired ACTIVE rows grant no entitlement and cannot be edited/renewed, even before the minute worker terminates them. [Phase 2 details](14-user-subscription-core.md) supersede conflicting legacy subscription rules below. No development database migration is performed by implementation/tests.


Task 1.2.3 persistence update: product management and settings use local ADMIN APIs, alongside persistent customer management. Product dialogs add description, sort order and a responsive field editor/preview for eight supported types; archive replaces deletion, immediately unlists and cannot be reversed. Only listed/archivedAt represent product state; there are no separate purchase or renewal switches. Every field has a fixed read-only ID, editable label/hint/required/default, optional choices and move/delete controls. Schema limits/errors are visible before saving. Preview input is ephemeral and has no submission action. The original Task 1.2.3 prototype kept order/subscription/overview screens Mock; T20 supersedes the ADMIN order page and T21 supersedes the CUSTOMER order page. The operating overview remains Mock. T22.1 replaces the storefront ADMIN preview with a public catalog and product detail. T22.2 opens the protected purchase form and local checks. Order submission remains a later stage. The desktop/mobile layout baseline below remains applicable. See [13-products-settings-forms.md](13-products-settings-forms.md).

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
- On desktop and mobile, show 管理控制台 only for a confirmed ADMIN session. Restore the role from the server on load and refresh. While the ADMIN storefront is open, recheck the session when the window regains focus or the tab becomes visible and every 30 seconds while visible.
- Navigation items: 商品, 我的订阅, 我的订单, 个人中心. ACTIVE administrators use the same storefront to purchase at the listed price, manage their own eligible orders, submit payment claims and view their own subscriptions. The management console retains its separate controls.
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
- Show only listed=true and archivedAt=null products with simple category filters. T22.1 opens the catalog to guests and keeps 暂未开放线上购买 disabled on product detail.
- Subscription and one-time products are visually distinguishable.
- Product prices and terms come from product configuration.

**购买**
- Show product name, price, and term.
- Collect customer notification email and only product-required non-sensitive information.
- Never collect passwords, OTPs, 2FA codes, recovery codes, session cookies, or payment credentials.
- Show concise fulfillment note: merchant handles the order manually and emails the customer when service is complete.
- The first UI prototype uses mock data and must not claim a real payment was processed.

**我的订阅**
- `/subscriptions` shows the signed-in ACTIVE storefront account's own subscriptions. Cards show the frozen product name and term, the subscription status, expiry date and renewal price.
- Filter by all, active, expired or terminated. Support server-side pagination, a loading state, an empty state and a retry action after a failed request.
- Details show the start and expiry times in the business timezone and link to the source order when it belongs to the customer and is visible. Historical subscriptions can have no source order.
- Product delisting and archival leave the subscription's frozen display data and expiry intact. Keep subscription form values and internal notes private. Renewal actions are out of scope.

**我的订单（T21 CUSTOMER 真实订单中心）**
- `/account/orders` 从 Mock 改为真实 CUSTOMER API，只读取当前 ACTIVE Session 用户自己的 `hidden=false` 订单；列表、详情、修改、取消复用现有 customer order API。
- 列表支持订单号/冻结商品名称搜索、服务端分页和状态筛选。默认创建时间倒序；每页 20 条，最大 100 条。
- 客户和管理员订单列表及详情将 9 位纯数字订单号显示为三组，例如 `583 024 917`。详情中的「复制订单号」复制原始值 `583024917`。剪贴板不可用时，提供只读原始号码供手动复制。历史订单号按原格式显示和复制。
- 付款状态和履约状态分开存储/展示。UNPAID + NOT_STARTED=待付款；PENDING_VERIFICATION=付款待核实；PAID + PROCESSING 与 NOT_REQUIRED + PROCESSING=处理中；COMPLETED=已完成；CANCELLED + REFUND_PENDING=待退款；CANCELLED + REFUNDED=已退款；其他 CANCELLED=已取消。
- REFUND_PENDING 只表示订单取消后待退款，不能证明外部退款已经发起，客户文案必须使用“待退款”；只有管理员确认实际退款完成后才显示“已退款”。
- 详情使用订单冻结的商品、周期、formSchemaSnapshot 和 formData，显示商品原价、最终金额、付款状态、履约状态和 24 小时剩余时间；不得用当前 Product 覆盖历史快照。
- 订单时间线只由 createdAt、paidAt、paymentConfirmedAt、fulfilledAt、cancelledAt 生成；不读取 OrderEvent/OrderRevision/AdminAuditLog，不伪造退款时间。
- 客户只能在 T15 允许的未付款/未开始/未过期条件下修改完整 formData；只能按 T16 取消本人未付款或待核实且无已确认付款事实的订单。PENDING_VERIFICATION 取消前必须警告可能存在未核实线下转账。
- 客户不能取消已付款订单、零元待履约订单或已完成订单；不能修改金额、付款状态或履约状态。
- 只展示订单级退款状态；不展示付款/退款尝试、流水号、渠道、管理员备注或审计数据，不提供客户退款申请。
- T24.2 的正金额、未过期 UNPAID + NOT_STARTED 订单显示「微信扫码付款」，包括应付金额、订单号、保存二维码入口和倒计时。二维码未启用或不可用时显示联系商家的提示，「我已付款」仍可申报。
- 「我已付款」打开确认步骤，成功后进入付款待核实并隐藏扫码入口。提醒勿重复转账，满 24 小时仍未核实可能自动取消，已转账的顾客应联系商家线下处理。
- 「商家备注」来自原 CUSTOMER order-guidance API，所有订单状态都可显示非空纯文本备注。
- 客户可从商城购买页提交订单，并进入本页查看订单详情。「我的订阅」提供本人订阅的只读列表和详情。在线支付、付款凭证上传及邮件通知仍不在本阶段范围内。

**个人中心**
- Show login email, notification email, password/security entry, and logout.
- Keep profile minimal.

### 3.4 T22 商品目录与购买流程

**商品目录 /**
- Visitors and customers can browse listed, unarchived products without signing in.
- Show product name, description, type, initial price, service term, and renewal price for subscription products.
- Use public server-side search, category filters, and pagination.
- Do not load or expose formSchema, default values, targetField, archive/listing internals, or administrator fields.

**商品详情 /products/:slug**
- Show customer-facing product information. 立即购买 opens the protected purchase route.
- Do not render dynamic fields or request the purchase form schema on this page.

**购买 /purchase/:slug（T22.2、T22.3B）**
- Route requires an ACTIVE CUSTOMER Session. The page fetches the customer-safe form projection when the guard accepts navigation.
- A guest is sent to customer login with a validated same-origin redirect; after login the customer returns to the same purchase route and the form loads automatically.
- Render the existing eight-type ProductFormInputs component with empty customer values; do not apply administrator preview defaults.
- Show server-provided prices as read-only. 检查填写信息 validates answers locally and shows field-level errors. A valid draft opens 核对订单, with the amount, service period, renewal price if applicable, and customer answers using the configured option labels. 返回修改 requires another review before confirmation.
- 确认下单 submits one product through the existing customer order API. Disable editing and repeated submissions while a request is in flight. If the outcome is uncertain, offer 重试原请求 with the original in-memory request and key, and warn before leaving. On PRODUCT_CHANGED, discard the draft and reload the product for explicit review.
- Open the T21 order detail using /account/orders?orderId=:id. The dialog loads the authorized detail separately and shares its selection with browser navigation. Payable orders display the T21 offline payment guidance and countdown. Zero-amount orders show 处理中 without a payment prompt.
- No cart, online payment, proof upload, customer subscription/renewal, email, or provider integration.

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
- 「收款设置」供管理员上传、更换和预览微信经营收款码，并启用或停用微信收款。未配置二维码时禁用启用开关。停用后仍可预览或更换图片。
- 「商家备注」复用全店统一的纯文本 `paymentInstructions`。留空表示无备注。T24.2 在客户订单详情显示非空备注。
- Storefront name.
- Owner/notification email.
- Email notification preferences.
- Business timezone.
- Payment provider configuration status (not secret values).
- SMTP credentials and payment secrets remain deployment secrets, never displayed or edited as plaintext in the UI.

## 5. Prototype behavior and current implementation boundary

The original Task 1.1 prototype uses Mock data. T20 supersedes that baseline for the ADMIN order page; T21 supersedes it for CUSTOMER `/account/orders` on the review branch:
- `/admin/orders` uses real API-backed list/detail/create/edit/cancel/payment/refund/fulfillment and safe event history.
- Mock confirmation/refund actions must not appear in the real ADMIN order workspace.
- The operating overview retains its Mock behavior.
- Product filters and product add/edit/listing/archive continue to use the existing local ADMIN APIs.
- Unlisted/unarchived products remain manageable; archived products are unlisted, cannot be edited/relisted, and retain readable details. Product changes never rewrite historical orders or current entitlement dates. Dynamic form configuration and preview remain available.
- T22.1 provides public catalog and product details. T22.2 provides the protected purchase form and local checks.
- Mock data and simulated actions outside the T20 ADMIN order page must be clearly labelled.
- The ADMIN order center never claims that the application itself transferred customer money, initiated a refund, contacted a supplier, or sent email.
- T21 replaces the CUSTOMER order-history Mock branch with the existing own-order list/detail/edit/cancel APIs and the safe order-guidance endpoint.
- T22.3 will integrate the existing customer order-creation API for offline orders.

## 6. Implementation acceptance criteria

### Task 1.2.2 persistent slice

- Keep the visual style and the separate `/admin/login`, `/login` and `/activate` routes. Guard admin routes with the backend-checked session and role.
- The customer login page links back to the store. The separate administrator login page also links to customer login. The store link to the console follows the signed-in role. Direct access still requires ADMIN authorization.
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


## T22 acceptance criteria

- Public visitors can browse only listed/unarchived products; public DTOs exclude form schemas and administrator fields.
- Product detail never requests dynamic form schema.
- Guest purchase redirects through login and returns to the same purchase route after successful customer login.
- Only ACTIVE CUSTOMER can load purchase schema and submit an order.
- Form schema projection excludes defaultValue and rejects prohibited credential fields.
- Stale Product.updatedAt is rejected with 409 PRODUCT_CHANGED and no order writes.
- Customer order creation remains atomic/idempotent and server-priced; successful creation opens the existing T21 detail.
- Desktop/mobile E2E and T20/T21 regressions pass. No migration, dependency, online payment, or deployment.

## T20 implementation details

The ADMIN order workspace now uses typed real APIs. Create/edit use the existing dynamic form inputs; detail, evidence, notes and safe event timeline use responsive dialogs. Payment and fulfillment remain separate columns; the fulfillment queue includes NOT_REQUIRED. For more than one evidence page, lifecycle controls remain disabled until explicit full-evidence review. Network-uncertain mutations retain their exact body/key in memory and offer original-request retry; version conflicts refresh for human review. The operating overview remains unchanged; the CUSTOMER order center was implemented separately in T21.
