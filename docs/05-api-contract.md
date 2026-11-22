# Local Operations API Contract (Task 1.2 and Phase 2)

> **Merged snapshot (2026-11-23, Asia/Shanghai):** Reconciled against `main` at `105e1514e6ce97853d5e83d0b5c131df6872551b`. See [project status](00-project-status.md) for the current implementation boundary. Milestone reports and test results below retain their original scope; this documentation update does not rerun tests or establish deployment status.

Base path: /api/v1. Payloads are JSON except for the explicitly documented binary image upload/read routes. Timestamps are UTC ISO-8601. Money is integer CNY fen. Validate all input with Zod or an equivalent schema validator. This contract covers the local-only offline operations milestone; online payment and supplier/email APIs are deliberately absent.

**Historical Stage 1 model-only update:** [Order/subscription foundation](15-order-subscription-foundation.md) reserves USER/ADMIN/SYSTEM_RENEWAL order sources, ORDER subscription linkage, structured periods/snapshots, lifecycle timestamps and plain-text payment instructions. It implements no order/payment/customer-history endpoint and does not add writable fields to existing product/settings/subscription payloads. Existing Phase 2 direct creation/renewal remains legacy compatibility behavior, not the future order-first workflow. At the original model-only stage the existing ADMIN PATCH did not edit paymentInstructions; T21 now approves a scoped extension of the existing ADMIN settings PATCH to update this already-persisted plain-text field. Next-stage APIs must enforce confirmed full payment → fulfillment → exactly-once linked subscription, ownership, hidden-order filtering and snapshot/period validation.

## Implemented surface

**Current order-read override:** [Order API stage 1](16-order-read-api.md) originally implemented ADMIN/CUSTOMER list/detail GETs. T20's merged extension (PR #29) extends ADMIN reads with GET `/admin/orders/:id/events`, a minimal linkedSubscription detail summary and an ADMIN-only productType list filter; it does not add CUSTOMER event/payment/refund reads. Both roles continue to exclude hidden rows in list/detail; CUSTOMER ownership comes only from Session. Explicit DTOs exclude authentication data and audits. ADMIN additionally receives internalNote; CUSTOMER never does. Both receive version, derived expiresAt and server-calculated remainingSeconds; see [revision foundation](18-order-revision-foundation.md). This supersedes the earlier reserved `/me/orders` paths below. The creation, T16 cancellation, T17 PAYMENT, T18 REFUND and T19 fulfillment routes are implemented and merged; order-based renewal remains future work.

**Order creation stage — implemented (PR #11):** [Order creation API contract](19-order-creation-api.md) defines POST `/customer/orders` for ACTIVE storefront self-order (CUSTOMER or ADMIN under T24.4B.1 below) and POST `/admin/orders` for ADMIN-created orders. Both use server-derived source/actor, strict role-specific DTOs, full form validation, frozen Product snapshots, required Idempotency-Key, atomic Order + V1 Revision + Event + applicable Audit + idempotency response. On /admin/orders, ADMIN may select ACTIVE or PENDING_ACTIVATION customers and unlisted/unarchived Products. On /customer/orders, either permitted role acts only for its own ACTIVE account and may select only listed/unarchived Products. Creation returns the complete role-safe order DTO with HTTP 201 (D58). Merged in PR #11; migration is included in main but development deployment requires separate authorization. Zero amount uses NOT_REQUIRED/PROCESSING without PaymentTransaction or payment times; positive amount uses UNPAID/NOT_STARTED. Responses are `{order}` and exact persisted role-specific DTOs are replayed for the same actor/key/input. See the contract for strict request/error definitions and isolated verification.

`GET /api/v1/health` and its `/health` alias retain their database-readiness behavior. Each request probes MySQL through Prisma. Successful connectivity returns HTTP 200 with `{"status":"ok","database":"ready"}`. Connection/query failure returns HTTP 503 with `{"status":"degraded","database":"unavailable"}`; driver errors and credentials are never returned. This does not verify migration currency: use the local `db:status` command. Authentication, customer/invitation, product/settings, Phase 2 subscription and the existing order list/detail GETs are implemented; the additional ADMIN event GET is implemented and merged in T20 (PR #29). Order creation, edit, cancellation, T17 payment, T18 refund and T19 fulfillment mutations are implemented; customer subscription list and detail GETs are implemented. Order-based renewal and dashboard APIs remain future work; the Phase 2 ADMIN direct-renewal API remains available in compatibility mode. All /admin routes, including unimplemented paths, first require a valid ADMIN session.

## T21 customer order center — implemented and merged in PR #31

See [the complete T21 contract](26-customer-order-center.md) and decisions D98-D105. T21 replaces only the CUSTOMER /account/orders Mock page with the existing own-order list/detail/edit/cancel APIs. It adds GET /customer/order-guidance requiring an ACTIVE storefront Session (CUSTOMER or ADMIN under T24.4B.1) and returning only storeName, businessTimezone and plain-text paymentInstructions. The existing ADMIN PATCH /admin/settings gains optional paymentInstructions (max 4000); the AppSettings column already exists, so no migration was needed. Customer refund visibility remains order-level only; no payment/refund attempts, OrderEvent, Revision, audit or customer refund request is exposed. No online payment, proof upload, subscription page, email or deployment was included in T21; the read-only subscription page was implemented separately. Implementation and actual tests are recorded in docs/26.

## T22 customer storefront and offline order placement

See [the T22 design baseline](27-customer-storefront-and-order-placement.md) and decisions D106-D112.

| Method | Path | Access | Status and purpose |
|---|---|---|---|
| GET | /catalog/products | Public | T22.1, listed and unarchived product list with public display fields |
| GET | /catalog/products/:slug | Public | T22.1, single public product object, 404 for all unavailable slugs |
| GET | /catalog/products/:slug/cover-image | Public | T24.5B, current WebP cover for a listed, unarchived product |
| GET | /customer/products/:slug | ACTIVE CUSTOMER or ADMIN | T22.2, read-only purchase projection with safe formSchema and Product.updatedAt |

The public list/detail JSON projections expose only slug, name, description, coverImageUrl, type, priceFen, renewalPriceFen, termLabel, servicePeriodUnit, and servicePeriodCount. T24.5B adds the nullable coverImageUrl; image bytes use the separate cover-image GET. The list accepts only search (trimmed, up to 120 characters, literal product-name match), type (SUBSCRIPTION or ONE_TIME), page (1–10000, default 1), and pageSize (1–100, default 20). Filters are AND-combined. Results are ordered by sortOrder, createdAt, then id, all ascending. The list returns `{items,total,page,pageSize}`. Invalid queries return 400 INVALID_INPUT. Missing, unlisted, and archived slugs return 404 NOT_FOUND.

The purchase GET reads the current listed, unarchived product. It returns the public display fields above plus id, updatedAt (UTC ISO-8601 with milliseconds), and formSchema. The form projection exposes version and ordered fields with id, type, label, required, hint, and options for select, radio, and checkbox only. Invalid or credential-collecting schemas return 409 PRODUCT_FORM_UNAVAILABLE. Guests and invalid or inactive Sessions get 401. T24.4B.1 permits both ACTIVE CUSTOMER and ACTIVE ADMIN sessions, using the same owner-scoped storefront rules. Missing, unlisted, and archived products share 404 NOT_FOUND.

T22.3A extends POST /customer/orders with required expectedProductUpdatedAt. After checking the saved idempotency response and locking User then Product, the service compares the exact UTC millisecond timestamp. A stale version returns 409 PRODUCT_CHANGED without business writes. See the addendum in docs/19. The login flow returns a guest to the same purchase route after successful CUSTOMER login. T22.3B submits the normalized form and the exact version from the purchase GET after the customer confirms their review. It uses a UUID idempotency key and holds the request and key in memory while the outcome is uncertain. T22 itself added no online payment, proof upload, cart, subscription UI, renewal, email, migration, or deployment. The current read-only subscription UI is documented in section 7; online payment and renewal remain out of scope.

## Order edit API (implemented and merged in PR #14)

PATCH `/customer/orders/:id` and PATCH `/admin/orders/:id` are implemented as specified in [docs/20-order-edit-api.md](20-order-edit-api.md). CUSTOMER may replace only the complete formData of their own eligible order; ADMIN may replace formData and optionally change amountFen in the same atomic edit. Both require expectedVersion and Idempotency-Key. Strict body shapes are `{expectedVersion,formData}` for CUSTOMER and `{expectedVersion,formData,amountFen?,priceAdjustmentReason?}` for ADMIN; unknown fields are rejected. Changed amount requires a nonblank reason (max500); a reason without an actual price change is rejected with 400 INVALID_INPUT. No effective change also returns 400. Validation uses the order's frozen formSchemaSnapshot, never current Product data or defaults. Missing/non-owned orders return the same 404. Ineligible/expired orders return 409 ORDER_NOT_EDITABLE; stale eligible versions return 409 VERSION_CONFLICT.

Success returns HTTP 200 `{order}` using the existing exact role-specific DTO. Locking, database-time expiry checks, one version increment, complete Revision, sanitized Event, ADMIN-only audit and the original idempotency response commit together. Exact retries replay the stored response even after later edits or zero conversion; another intent using the same actor/key returns 409 IDEMPOTENCY_CONFLICT. A positive-to-zero ADMIN change atomically enters NOT_REQUIRED/PROCESSING without payment timestamps, transactions or subscriptions; any existing PaymentTransaction prevents conversion. New events reuse NOTE with an ORDER_EDITED operation marker; no internal notes are changed. internalNote remains separate from core form/price edits per D48/D63. T20 implements its independent PATCH endpoint with expectedVersion, one version increment, complete Revision, NOTE Event, AdminAuditLog and idempotency response. Cancellation, timeout, payment, refund and fulfillment are out of scope. No new migration is added.

## Model review follow-up (no new endpoints)

The sixth migration tightens USER/ADMIN ordinary orders and hidden SYSTEM_RENEWAL, requires complete ORDER subscription billing data, and freezes target/eligibility cycles plus anchor/timezone/billing revision on renewal orders. See [the authoritative transaction and compatibility contract](15-order-subscription-foundation.md#remaining-database-foundation).

Future administrator renewal verifies full external receipt first; future customer renewal accepts only a trusted successful payment result (no provider integration here). The system then creates and fulfills one renewal order, updates the existing subscription and writes events/audit in one transaction. The seventh migration requires SYSTEM_RENEWAL to be inserted as PAID/COMPLETED, with paidAt <= paymentConfirmedAt <= fulfilledAt (all explicitly non-NULL) and cancelledAt NULL. Order.paidAt is actual payment occurrence, frozen from the corresponding confirmed full PAYMENT's occurredAt; paymentConfirmedAt is the administrator's receipt confirmation time. PaymentTransaction.createdAt is the database entry time and can follow confirmation. Preserve deprecated paymentRecordedAt only for old data; never accept it as paidAt, fall back to it, or write it in the new flow. Row-local SQL cannot check equality across tables; future payment/fulfillment transactions must validate and persist matching occurrence/confirmation times and amounts atomically. Never create a pending renewal requiring a subsequent update: these rows are immutable from INSERT. Existing Phase 2 APIs are unchanged and must be integrated/restricted before ORDER subscriptions are enabled.

The final model supports only USER/ADMIN/SYSTEM_RENEWAL. Migration ten removes the retired source, all its CHECK exemptions and its special triggers. Every create service must explicitly select a source from trusted server context; nullable ENUM storage is only an omission sentinel, rejected by the INSERT Trigger and a non-NULL CHECK. All order sources are immutable; every order rejects DELETE/REPLACE. Same-source ordinary payment/fulfillment/note updates remain possible, while SYSTEM_RENEWAL is immutable immediately after its final INSERT. Future APIs must not expose source mutation or physical order deletion. This repair adds no endpoint and does not inspect or clean development test orders.

## 1. Conventions

- Single merchant and one owner ADMIN account.
- All /admin routes require server-side ADMIN authorization.
- Storefront /customer routes require an ACTIVE CUSTOMER or ADMIN Session and enforce ownership; administrator management remains under the separate /admin guard.
- Customers may be PENDING_ACTIVATION and still have admin-managed orders/subscriptions.
- T24.4B.2 adds public CUSTOMER registration to the authentication API. Existing offline checkout uses the order APIs below. Payment-provider API, supplier API, SMTP, settlement and withdrawal endpoints are out of scope.
- Stable error shape with code, message, and requestId.
- Server generates IDs/order numbers and calculates/defaults prices. Never trust browser-supplied payment status, role, or transaction confirmation.
- Store money in integer fen. Store timestamps in UTC.
- Do not return password hashes, session token hashes, invitation token hashes, internal notes, or audit metadata to customers.

## 2. Authentication and invitation activation

| Method | Path | Purpose |
|---|---|---|
| POST | /auth/register | Create an ACTIVE CUSTOMER and sign in with the existing Session cookie |
| POST | /auth/login | Admin/customer login |
| POST | /auth/logout | Revoke current session |
| GET | /auth/me | Current account and role |
| POST | /auth/activate | Consume one-time invitation token and set customer password |

Admin is seeded from local environment configuration. Accounts provisioned by an administrator require a valid, unused, unexpired invitation token to activate. The raw invitation token is never returned by a read endpoint and is never emailed.

### Implemented request/response and session rules

- Login: JSON `{email, password}`; email is trimmed/lowercased. Password is 12–128 characters and is never trimmed before hashing/verifying. Invalid, inactive or unknown accounts share HTTP 401 `INVALID_CREDENTIALS`. Success returns `{user}` containing only public account fields and sets the session cookie; no token is returned in JSON.
- Current account: `GET /auth/me` returns `{user}` or HTTP 401. Each protected request checks the persisted session expiry/revocation and current ACTIVE account status.
- Logout: JSON `{}`; revoke the current session and clear its cookie, HTTP 204. Repeated logout is safe.
- Activation: JSON `{token, password}`; success is HTTP 200 `{status:"activated"}`, with no implicit login. Expired/revoked/used/unknown tokens or non-pending customers return the same HTTP 409 `INVITATION_INVALID`. Token consumption/account activation and other unused-token/session revocation are atomic.
- Password hashing uses Argon2id with the same parameters as the bootstrap seed. Sessions and invitations use independent random 32-byte base64url tokens; only SHA-256 hashes are stored.
- Session lifetime is fixed at 12 hours, with no rolling extension. The host-only `membership_session` cookie has `HttpOnly`, `SameSite=Strict`, `Path=/` and `Max-Age=43200`. `Secure` is set for HTTPS APP_BASE_URL and omitted only for local HTTP.
- All JSON mutation requests require an Origin exactly matching APP_BASE_URL, `X-Requested-With: MembershipStore` and Content-Type application/json. No permissive CORS is enabled. Browser fetch uses the same-origin Vite proxy; open the exact configured frontend origin.
- Login and activation each allow 30 requests per 15 minutes per source IP. Admin mutations allow 120 per 15 minutes per IP. Limits are bounded and local to the API process; a restart clears them.
- Error shape: `{error:{code,message,requestId}}`. Request IDs are server-generated. Responses are no-store; validation/database failures do not expose input, credentials, driver messages or hashes.

### Storefront registration (T24.4B.2)

POST /auth/register accepts exactly email and password. It reuses the email normalization and password validation used by login. The account starts as ACTIVE CUSTOMER, sets activatedAt on registration and has a null createdByAdminId. Registration returns HTTP 201 with the same safe user projection and 12-hour cookie used by login. One transaction inserts both the account and its Session.

HTTP 409 EMAIL_EXISTS applies to any existing normalized email, including pending invitations and administrator accounts. HTTP 409 ALREADY_AUTHENTICATED rejects a request with a valid active Session. Malformed input returns 400, CSRF failures return 403 and a separate five-attempt registration window returns 429 with Retry-After on the sixth attempt from the same connection IP within 15 minutes. If the response is lost, the user can sign in using the same credentials.

## 3. Admin customers and invitations

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/users | Search/list customers |
| POST | /admin/users | Create a PENDING_ACTIVATION customer |
| GET | /admin/users/:id | Customer detail and order/subscription counts |
| PATCH | /admin/users/:id | Update private label/notification email |
| PATCH | /admin/users/:id/status | Disable/enable customer account |
| POST | /admin/users/:id/invitations | Generate/reissue invitation and return copyable URL once |
| POST | /admin/invitations/:id/revoke | Revoke an unused invitation |

Creating a user and creating a subscription are independent. A pending customer may have orders and subscriptions. Reissuing an invitation revokes previous unused tokens. The UI must warn that localhost invitation URLs are not externally reachable.

### Implemented customer payloads

- List query: optional search, status (PENDING_ACTIVATION/ACTIVE/DISABLED), page (1–10000, default 1), pageSize (1–100, default 20). Response: `{items,total,page,pageSize}`; each item contains public account fields and `_count:{orders,subscriptions}`. Only CUSTOMER rows are listed.
- Create: `{adminLabel?,loginEmail,notificationEmail?}`. adminLabel is nullable or 1–80 trimmed characters; username is customer-owned and cannot be assigned by admin; emails are validated, normalized and at most 254 characters. Null/omitted notification email falls back to login email in the UI. Response HTTP 201 `{user}`; account is CUSTOMER/PENDING_ACTIVATION with null passwordHash and activatedAt. Duplicate email returns 409 EMAIL_EXISTS.
- Detail: `{user}`, including real order/subscription counts and the latest 10 invitation metadata rows (id/createdAt/expiresAt/usedAt/revokedAt). No password/token hash or original URL is exposed.
- Edit: nonempty `{adminLabel?,notificationEmail?}`. Login email is immutable after creation, matching the profile-only PATCH contract. Supplied role, status, password, passwordHash or unknown fields are rejected with 400; administrators cannot set customer passwords.
- Status: `{disabled:boolean,reason:string}` (1–500 trimmed characters). Disabling revokes all sessions and unused invitations atomically, preserving orders/subscriptions. Restoring returns to ACTIVE only for an already activated/password-bearing account, otherwise PENDING_ACTIVATION. Repeating the current status returns 409.
- Issue/reissue: JSON `{}`, allowed only for unactivated PENDING_ACTIVATION customers. Response HTTP 201 `{invitation,url}`; invitation contains safe metadata only, and url is returned once. It has the form APP_BASE_URL/activate#TOKEN so the browser never sends the token in a URL to the web server; the activation page removes the fragment from browser history and submits the token only in the activation body. Regeneration transactionally revokes earlier unused invitations.
- Revoke: JSON `{}`; HTTP 204. Already used/revoked invitations return 409. The UI retains no recoverable URL after closing the detail.
- Customer creation/edit/disable/restore, invitation issue/revoke and administrator login/logout append sanitized audit records transactionally. Audit snapshots omit names/emails, raw tokens and password/token hashes; edit logs name changed fields only.

Customer order reads are implemented at `/customer/orders` as documented above; customer subscription reads are available at `/customer/subscriptions`. Merged T21 connects the storefront order UI to those existing endpoints; T24.4B.1 also permits administrators to manage their own orders through the same owner-scoped surface. Administrator products/subscriptions, order GETs, order creation/edit/cancel, offline payment/refund and manual fulfillment APIs are implemented; both administrator and storefront order management UIs are implemented; order-based renewal APIs remain future work, separately from the retained Phase 2 ADMIN direct-renewal API.

## 4. Admin products and settings

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/products | List products including archived |
| POST | /admin/products | Create product |
| GET | /admin/products/:id | Read product and versioned form configuration |
| PATCH | /admin/products/:id | Edit unarchived product and catalog listing |
| POST | /admin/products/:id/archive | Irreversibly archive and unlist product |
| GET | /admin/products/:id/cover-image | Read the current WebP cover behind the ADMIN guard |
| PUT | /admin/products/:id/cover-image | Upload or replace a cover, 4 MiB octet-stream |
| DELETE | /admin/products/:id/cover-image | Clear the cover reference with a JSON {} body |
| GET | /admin/settings | Read ADMIN settings including store name, owner email, timezone and paymentInstructions |
| PATCH | /admin/settings | Update store name, owner email and timezone; T21 accepts optional plain-text paymentInstructions (max 4000) |
| GET | /admin/settings/wechat-payment | Read `{enabled,imageUrl}`; imageUrl is null when no QR has been uploaded |
| PATCH | /admin/settings/wechat-payment | Set `{enabled:boolean}` and return the same metadata |
| GET | /admin/settings/wechat-qr | Read the current validated image as `image/png` |
| PUT | /admin/settings/wechat-qr | Upload one binary PNG, JPEG or WebP image and return the same metadata |

T24.1 routes require ADMIN and use no-store responses. PUT accepts `application/octet-stream` with a 2 MiB body limit. It retains the exact Origin and custom CSRF header checks and the existing administrator mutation limit. The server validates image signatures, dimensions up to 2048 pixels per side and full decoding, then stores a metadata-free PNG capped at 2 MiB. The image route takes no path, filename or query parameters. The response exposes a fixed administrator URL. Enabling before upload returns 409. Missing or unreadable configured files return 503. T24.2 reuses the fixed image lookup and enable state through the implemented owner-scoped order QR route with payable-order checks. The existing customer guidance projection is unchanged.

No supplier-cost or secret credential fields.

The original seven product/settings routes were implemented in Task 1.2.3. Those routes use existing ADMIN sessions, Origin/custom-header CSRF checks and admin mutation limits. Detail/create/edit/archive return `{product}`; settings return `{settings}`. Lists return `{items,total,page,pageSize}`. That milestone introduced no public product API; T22 subsequently added the public catalog routes documented above.

T13 adds `servicePeriodUnit: DAY | MONTH | YEAR | null` and `servicePeriodCount: integer | null` to every Product DTO. New SUBSCRIPTION POSTs require both non-NULL (count 1–2147483647); ONE_TIME uses NULL/NULL (omission on create defaults to NULL) and NULL renewalPriceFen. PATCH explicitly changing periods must include both keys. Validation uses the merged persisted record: only an existing NULL/NULL subscription with both keys omitted may retain its unknown period. Converting ONE_TIME to SUBSCRIPTION requires a full period and renewal price; converting back clears all three fields, rejecting explicitly conflicting non-NULL values. `termLabel` remains independent display text and never supplies an inferred period. Invalid requests return the existing sanitized HTTP 400; authorization/archiving/audit behavior is unchanged. See [T13 guide](17-order-creation-and-lifecycle-design.md#g-商品周期能力缺口创建订单前置任务).

Product list query: search (name, max 120), type SUBSCRIPTION/ONE_TIME, archived ALL/ACTIVE/ARCHIVED (default ALL), listed true/false, page (default 1, max 10000), pageSize (default 20, max 100). Sort is sortOrder, createdAt, id ascending. Unknown query/body properties are rejected.

Create accepts name (1–120), description (nullable, max 2000), type, priceFen, renewalPriceFen, termLabel (1–40), servicePeriodUnit/servicePeriodCount as specified above, optional listed (default false), sortOrder (default 0), formSchema (default v1 empty). Fen and sortOrder are integers 0–2147483647. SUBSCRIPTION requires a renewal price; ONE_TIME requires null renewal price. PATCH is nonempty and validates the complete merged record. Switching to SUBSCRIPTION requires compatible renewal/period values in the same request; switching to ONE_TIME clears obsolete subscription values. Only listed and archivedAt represent product state; archivedAt is server-managed. Removed purchase/renewal permission properties are rejected as unknown inputs. Unlisted/unarchived products remain in ADMIN lists and details. Public catalog selection must require listed=true AND archivedAt=null. Future offline orders may select any unarchived product; new subscription orders additionally require a complete structured period. Future manual subscription grants/imports must select an unarchived SUBSCRIPTION product. Neither ADMIN selection requires listed=true. Archived products cannot be used for new orders, renewals or new subscriptions; these write flows remain future tasks. Slug, targetField, IDs and timestamps cannot be supplied. Description/schema strings are plain text, never executable markup.

Archive POST accepts `{}`, sets listed=false and archivedAt together once, retains the row and historical references, and writes one audit record even on retry. Archived products remain readable in ADMIN lists/details but every valid PATCH, including listed=true, returns 409 PRODUCT_ARCHIVED. The archive timestamp is stable on retry, and archivedAt cannot be supplied or cleared by clients. Missing product returns 404. There is no DELETE/restore route for the product itself. All mutations and their sanitized audit records commit in one transaction; audit failures roll back changes. Audit records contain changed keys and operational flags/prices/counts, never form defaults or contact values.

Settings PATCH is nonempty and accepts only storeName (1–80), ownerEmail (normalized valid email, max 254) and timezone (valid IANA identifier, max 64; numeric offsets rejected). Existing singleton id=1 is updated, never an account/password. Missing initialization returns 503 SETTINGS_UNAVAILABLE. Validation returns sanitized 400 INVALID_INPUT; no request values are echoed. Full schema contract, limits and examples: [13-products-settings-forms.md](13-products-settings-forms.md).

### 商品主图（T24.5B）

ADMIN 商品响应、公开目录与详情、购买表单商品响应增加 coverImageUrl，未设置时为 null。公开 DTO 其余字段不变。URL 由服务器按商品 ID 或 slug 生成，不包含文件名或存储 Key，可附十六位十六进制 v 参数。GET 每次查当前引用，返回 image/webp 和 private, no-store。公开读取对下架、归档、不存在或无可用图片返回 404 NOT_FOUND。后台读取可查看未上架及已归档商品；图片存储异常返回 503 PRODUCT_COVER_STORAGE_UNAVAILABLE。

PUT 仅接受未压缩的 application/octet-stream。管理员会话、Origin、自定义 CSRF 头和管理员变更限流全部适用。无效图片返回 400 PRODUCT_COVER_INVALID，超限返回 413。DELETE 使用 JSON {}。两种写操作成功返回 200 和 {coverImageUrl, updatedAt}。归档商品返回 409 PRODUCT_ARCHIVED。更新与审计原子提交，图片变更使旧购买表单版本失效。文件目录与迁移说明见 [实现报告](29-product-cover-images.md)。


## 5. Admin offline orders and payment transactions

The order read/create/edit/cancel, T17 offline PAYMENT, T18 offline REFUND and T19 fulfillment routes below are implemented and merged. Renewal remains future work.

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/orders | Implemented: visible order search, pagination, kind/payment/fulfillment filters and creation-time sorting; T20 extension adds `productType=SUBSCRIPTION/ONE_TIME` against the frozen productTypeSnapshot |
| POST | /admin/orders | Implemented: create ADMIN ordinary order (INITIAL/ONE_TIME) |
| GET | /admin/orders/:id | Implemented: safe frozen order DTO; T20 extension adds a minimal linkedSubscription summary only (no transaction/event expansion) |
| PATCH | /admin/orders/:id | Implemented T15: eligible ordinary-order full form replacement and optional amount edit |
| GET | /admin/orders/:id/events | Implemented T20: ADMIN-only paginated safe OrderEvent timeline; no raw JSON, AdminAuditLog or OrderRevision |
| PATCH | /admin/orders/:id/internal-note | Implemented T20: D48/D92 ADMIN-only internalNote update with version, Revision/Event/Audit/idempotency |
| GET | /admin/orders/:id/payment-transactions | ADMIN-only paginated payment-attempt evidence (merged PR #20) |
| POST | /admin/orders/:id/payment-transactions | ADMIN-only offline PAYMENT attempt registration (merged PR #20) |
| POST | /admin/payment-transactions/:id/confirm | ADMIN-only full-payment confirmation (merged PR #20) |
| GET | /admin/orders/:id/refunds | Implemented T18: paginated ADMIN-only REFUND attempt history |
| POST | /admin/orders/:id/refunds | Implemented T18: register externally initiated full REFUND as PENDING |
| POST | /admin/payment-transactions/:id/confirm-refund | Implemented T18: confirm actual full refund completion |
| POST | /admin/payment-transactions/:id/fail | ADMIN-only payment-attempt failure (merged PR #20) |
| POST | /admin/payment-transactions/:id/fail-refund | Implemented T18: mark one PENDING REFUND FAILED with reason |
| POST | /admin/orders/:id/fulfill | Implemented T19 (PR #26): complete eligible INITIAL subscription or ONE_TIME order and atomically create initial ORDER subscription when applicable |

Supported offline channels: WECHAT, ALIPAY, CASH, BANK_TRANSFER, OTHER. Payment and fulfillment states are independent. Order.paymentStatus is recomputed from transaction records in the same DB transaction. The app does not move money.

No partial payments or partial refunds in Task 1.2. T18 supports only full refunds for CANCELLED + REFUND_PENDING orders; completed-fulfillment refunds are explicitly out of scope under D77 and require a separate future decision. A refund is successful only after external money has actually been returned and ADMIN confirms it.



**T20 administrator order center (implemented and merged in PR #29):** [Full contract](25-admin-order-center.md). The ADMIN order page consumes the existing T14-T19 APIs; only the event read endpoint, linkedSubscription minimal detail expansion, productType list filter and internal-note PATCH are new. Refunds remain restricted to CANCELLED + REFUND_PENDING; a paid pending order must first be cancelled. The `PROCESSING` fulfillment filter includes both PAID and NOT_REQUIRED zero-price orders. Internal-note writes use expectedVersion, actor-scoped Idempotency-Key, one version increment and complete Revision/Event/AdminAuditLog in one transaction. No schema or migration change is included.

## 6. Admin subscriptions — Phase 2

| Method | Path | Purpose |
|---|---|---|
| GET / POST | /admin/subscriptions | Search/list or create independent ADMIN subscription |
| GET / PATCH | /admin/subscriptions/:id | Read snapshot or maintain unexpired ACTIVE subscription |
| POST | /admin/subscriptions/:id/renew | Direct manual expiry update, no order/payment |
| POST | /admin/subscriptions/:id/terminate | Irreversible immediate termination |
| GET | /admin/subscriptions/:id/events | Paginated safe history |

All seven routes use existing ADMIN session, CSRF, JSON-body and mutation rate limits. List returns `{items,total,page,pageSize,serverNow}`; events return `{items,total,page,pageSize}`; detail/mutations return `{subscription}`. List/detail include ADMIN-safe customer info and only current product ID/archive eligibility, never use current product name/schema instead of snapshots.

List query: search (username/adminLabel/loginEmail/frozen product name, max254), userId/productId UUID, status ACTIVE/TERMINATED, sourceType ADMIN/SYSTEM, expiry ALL/UPCOMING/EXPIRED. UPCOMING means future expiry within 7 days; EXPIRED includes terminated rows whose expiry is past. Optional from/to bound expiresAt inclusively; timestamps are UTC ISO-8601 with milliseconds. Page defaults1 (max10000), pageSize20 (max100). Sort createdAt DESC then id ASC. Unknown query properties rejected.

Create `{userId,productId,startedAt,expiresAt,renewalPriceFen,formData?,note?}`. Customer must exist, role CUSTOMER, PENDING_ACTIVATION or ACTIVE. Product must be unarchived SUBSCRIPTION; listed is irrelevant. Start < expiry; Fen integer0–2147483647; note nullable max2000. Expired historical entries are allowed and are ineligible immediately; minute sweep terminates them. Source/status/creator/snapshots/version are server-managed, extra keys rejected. Copies name/description/type/initial price/term/schema atomically and sets version1/ADMIN/ACTIVE. HTTP201, CREATED event and audit. Independent records even for the same customer/product. No fake orders/payments.

PATCH is nonempty, allows only startedAt/expiresAt/renewalPriceFen/formData/note plus required version>=1 and reason1–500. Reject expired/terminated rows and stale version with409. Product archive does not prevent maintenance. Supplied formData validates against formSchemaSnapshot, never current Product. Dates and merged start<expiry checked server-side. Increment version once; record UPDATED and appropriate EXPIRY_ADJUSTED/PRICE_CHANGED/FORM_DATA_UPDATED events.

Renew `{version,newExpiresAt,renewalPriceFen?,reason}` requires unexpired ACTIVE and unarchived product. New expiry must exceed database time and startedAt. It need not add a fixed period; administrator enters confirmed time. Updates same row, version+1, RENEWED event/audit; never an order/payment. Terminate `{version,reason}` sets TERMINATED/terminatedAt/terminationReason and version+1, records TERMINATED, cannot restore. Repeating without the original idempotency key conflicts.

All four mutations accept optional `Idempotency-Key` (1–128 ASCII letters/digits/underscore/dot/colon/hyphen); frontend always sends it and retains it for a same-body retry. Same admin/key/canonical request replays original status/body. Different request/route/target conflicts409 IDEMPOTENCY_CONFLICT. Version conflict/expiry/termination returns409 SUBSCRIPTION_CONFLICT. Authentication/CSRF/rate checks still run on replay.

formData keys must be configured stable IDs; no unknown keys, coercion, expressions or HTML execution. Eight types follow schema validation/default bounds: text/textarea<=500, valid email<=254, finite number within safe range, real YYYY-MM-DD date, select/radio existing value, checkbox distinct existing values (max20). Required rejects missing/blank/empty selections; 0 is valid. Optional empty fields are omitted. Total formData<=8KiB and overall JSON request<=16KiB. Defaults are a UI convenience, never trusted as a substitute for submitted values.

Every minute (also startup) the worker conditionally terminates ACTIVE rows with expiresAt<=UTC_TIMESTAMP(3), sets reason `订阅到期`, version+1, AUTO_TERMINATED event and SYSTEM audit in one transaction. Multiple API processes/sweeps and admin renewal race safely on version/status/database-time conditions. Future entitlement reads must check ACTIVE AND expiresAt>now, independent of worker timing. No public worker trigger or SYSTEM creation endpoint.

The customer login/me projection includes username but never adminLabel; administrator customer APIs include both. No new username-setting, verification-code or activation workflow is added. Full snapshot/migration/privacy contract: [Phase 2 guide](14-user-subscription-core.md).

## 7. Storefront APIs

**T24.4B.1:** An ACTIVE CUSTOMER or ADMIN uses the existing /customer routes for storefront self-service. Orders, payment QR and claims, and subscriptions are scoped to the Session user and use the customer-safe projections. The /admin routes retain their separate ADMIN guard and management scope.

For ADMIN self-purchase, POST /customer/orders uses the current listed, unarchived product price and checks its version and form. It records source ADMIN, with userId and createdByAdminId equal to the Session user and createdByUserId null. The same version and idempotency rules apply. Self-service never accepts owner or price overrides and uses the customer cancellation rules. Administrator self-service writes record ADMIN revisions, events and audits. In particular, ADMIN_SELF_PAYMENT_CLAIMED records a request for verification without confirming payment.

| Method | Path | Purpose |
|---|---|---|
| GET | /customer/orders | Implemented: current customer's own visible ordinary orders |
| GET | /customer/orders/:id | Implemented: own ordinary order snapshot; no internal timeline |
| GET | /customer/order-guidance | Implemented T21: ACTIVE storefront session; safe `{storeName,businessTimezone,paymentInstructions}` allowlist |
| GET | /customer/orders/:id/wechat-qr | T24.2: current enabled QR PNG for the customer's own eligible order |
| POST | /customer/orders/:id/payment-claim | T24.2: submit a manual verification claim with `{expectedVersion}` and `Idempotency-Key` |
| GET | /customer/products/:slug | T22.2 ACTIVE storefront purchase projection with safe formSchema and updatedAt |
| PATCH | /customer/orders/:id | Implemented T15: own eligible ordinary-order full form replacement |
| GET | /customer/subscriptions | Implemented: own subscriptions with status filtering and pagination |
| GET | /customer/subscriptions/:id | Implemented: own frozen subscription details and visible source order |

### Customer subscription reads

Both endpoints require an ACTIVE storefront session and derive ownership from that session. Guest requests receive HTTP 401. Missing and foreign subscription IDs both receive HTTP 404 `NOT_FOUND`. Query validation rejects unknown parameters, including `userId`. The detail endpoint accepts no query parameters.

- `GET /api/v1/customer/subscriptions` accepts an optional `status` of `ACTIVE`, `EXPIRED` or `TERMINATED`. `page` defaults to 1 and accepts integers from 1 through 10,000. `pageSize` defaults to 20 and accepts integers from 1 through 100. It returns `{items,total,page,pageSize,businessTimezone}` sorted by start time descending and ID ascending.
- `GET /api/v1/customer/subscriptions/:id` returns `{subscription,businessTimezone}`. Each subscription in either response contains exactly `id`, `productNameSnapshot`, `termSnapshot`, `status`, `startedAt`, `expiresAt`, `renewalPriceFen` and `sourceOrder`. Times are ISO UTC strings. The price is in CNY fen. `sourceOrder` is `{id,orderNo}` for an order owned by the same customer with `hidden=false` and null otherwise.
- A stored `ACTIVE` subscription with `expiresAt` at or before the database clock appears as `EXPIRED`. A stored `TERMINATED` subscription retains that status. These reads leave the subscription unchanged. Product details come from frozen snapshots and responses exclude form data, internal notes and audit history.

Customer/order-based renewal endpoints remain out of scope. T22.1 provides public catalog reads. T22.2 provides the protected purchase-product read; T24.4B.1 permits ACTIVE CUSTOMER and ADMIN storefront sessions. T22.3B uses the existing customer order POST and opens /account/orders?orderId=:id on success. The order dialog independently loads the customer order detail GET, with the existing own-order and hidden-order 404 rules.

## 8. Dashboard

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/dashboard | Confirmed offline receipts minus confirmed refunds, order counts by payment/fulfillment state, pending fulfillment, and subscription counts |

Dashboard totals must be computed from confirmed PaymentTransaction records and reconciled with order summaries. Unconfirmed payment/refund records must not count as received/returned money.

## 9. State transitions and atomicity

- Payment transaction PENDING -> CONFIRMED only through an ADMIN action after external verification.
- Refund transaction PENDING -> CONFIRMED only after money has actually been returned outside the application.
- Order paymentStatus is a derived summary and cannot be set directly by the client.
- Order fulfillmentStatus changes require an ADMIN action and reason.
- Only a fully paid order may be completed.
- Initial subscription creation and renewal expiry update must be committed in the same database transaction as order completion and their event/audit records.
- Invalid transitions return 409 CONFLICT and make no partial changes.
- Repeated confirmation/completion/refund requests must be rejected or idempotent; do not create duplicate transaction/event rows.

## 10. Explicitly absent endpoints

Do not implement online checkout/payment intents, payment webhooks, automatic refund, supplier email/API/transfer, SMTP/email outbox, settlement, split payment, merchant wallet, or withdrawal routes. T22 approves public product browsing and creation of an ordinary offline-payment order only; it does not authorize online payment or money movement.

## Order revision infrastructure (2026-11-19)

Migration eleven adds Order.version, permanent append-only OrderRevision and actorUserId-scoped idempotency (D34–D36). There are no new HTTP routes. Existing four order GET endpoints return the additional role-specific fields documented in [order read API](16-order-read-api.md); no history, order creation/edit, payment, cancellation or fulfillment endpoint is added. Full snapshot history is internal and never reused as a customer DTO.


## Order creation API (implemented and merged in PR #11)

This implemented write stage is limited to POST `/customer/orders` and POST `/admin/orders`. Use [the complete order creation contract](19-order-creation-api.md) and ACTIVE decisions D1-D10, D33-D36, D40, D44, D51-D58. ADMIN must explicitly submit final `amountFen`; the future integrated UI must pre-fill Product.priceFen. The first successful request returns a complete role-safe order resource DTO with HTTP 201. Same-key retries replay the exact stored original response. No order editing, cancellation, payment, fulfillment, renewal, notifications or frontend order-center integration is included in that stage.

## Order creation implementation details

Both POST routes require a valid persisted Session, CSRF Origin/custom header, strict JSON body and Idempotency-Key (1–128 ASCII letters/digits or `_.:-`). T22.3A requires the exact customer body `{productId,expectedProductUpdatedAt,formData}`. The version is a valid UTC ISO-8601 timestamp with exactly three fractional digits. The ADMIN body requires `{productId,userId,amountFen,formData}` and permits priceAdjustmentReason (trimmed nonblank, max500) and internalNote (nullable, max2000, defaultNULL). No client source/identity override, statuses, version or snapshots. See [creation contract](19-order-creation-api.md).

The existing serializable transaction helper performs bounded retries for recognized MySQL write/deadlock conflicts. User and Product are locked in that order after persisted idempotency lookup. The same transaction commits Order, immutable V1 revision, ORDER_CREATED event, ADMIN-only sanitized audit and original `{order}` response. Customer contact snapshots use notificationEmail, falling back to loginEmail; new targetIdentifier remainsNULL. Both roles reject unknown periods and invalid/credential-collecting forms, without changing catalog rows. CUSTOMER order responses project safe frozen schemas without editor defaults. The persisted Order and Revision retain the full schema, as does the ADMIN DTO. Existing subscription idempotency semantics remain unchanged.

A pending customer's valid Session receives403 ACCOUNT_NOT_ELIGIBLE only on POST /customer/orders; all other existing routes keep ACTIVE-only authentication. Disabled/expired/revoked Sessions still return401. ADMIN target errors use404 CUSTOMER_NOT_FOUND or409 CUSTOMER_DISABLED. Zero-price DTOs have remainingSeconds=0; exact replay may retain an earlier countdown for positive-price orders, so GET detail provides a fresh clock.


## Order cancellation and timeout stage (implemented and merged in PR #17)

T16 implements [docs/21-order-cancellation-timeout.md](21-order-cancellation-timeout.md), under D65-D69. POST `/customer/orders/:id/cancel` accepts `{expectedVersion,reason?}` for the ACTIVE customer's own eligible unpaid/unconfirmed order; POST `/admin/orders/:id/cancel` accepts `{expectedVersion,reason}` for eligible unpaid/unconfirmed, paid-before-fulfillment or zero-price orders. Under unchanged D16, ADMIN unpaid eligibility includes both UNPAID and PENDING_VERIFICATION with NOT_STARTED, no confirmed PAYMENT and no paidAt/paymentConfirmedAt facts; pending attempts are retained as FAILED and the cancelled order summary becomes UNPAID. Strict bodies reject unknown fields. Customer reason is trimmed/optional (blank becomes NULL); administrator reason must be nonblank; both are limited to 500 characters. Both require positive expectedVersion and Idempotency-Key, persisted Session/role and CSRF guards. Missing/foreign customer IDs share NOT_FOUND (404). Ineligible state returns ORDER_NOT_CANCELLABLE (409), stale version VERSION_CONFLICT (409), invalid input 400, changed same-key intent IDEMPOTENCY_CONFLICT (409). Success is HTTP 200 `{order}` with the existing exact role-safe DTO; normalized retries replay the saved response.

Paid cancellation enters CANCELLED + REFUND_PENDING only with exactly one full confirmed PAYMENT matching amountFen/paidAt/paymentConfirmedAt; preserve that receipt and create no refund. Zero-price cancellation remains NOT_REQUIRED + CANCELLED with no payment/refund. Every success atomically updates version once, closes pending attempts, writes full Revision/Event, ADMIN-only sanitized Audit and manual idempotency response. A SYSTEM worker runs immediately on API startup and every minute, examines at most 100 deterministic candidates, rechecks the inclusive 24-hour deadline under database-time SKIP LOCKED row locks, and retries failed rows next minute without blocking healthy candidates. It retains pending unconfirmed PAYMENT attempts as FAILED with PAYMENT_TIMEOUT and returns PENDING_VERIFICATION summaries to UNPAID. SYSTEM history has NULL actor IDs and no AdminAuditLog/IdempotencyRecord. Payment confirmation, refund completion, fulfillment and UI remain out of T16; all twelve migrations remain unchanged.


## T17 offline payment attempt and confirmation API (implemented and merged in PR #20)

The merged T17 contract is [docs/22-offline-payment-api.md](22-offline-payment-api.md), governed by D19-D23, D39, D59, D65-D69 and D70-D75. It adds ADMIN-only GET `/admin/orders/:id/payment-transactions`, POST `/admin/orders/:id/payment-transactions`, POST `/admin/payment-transactions/:id/confirm`, and POST `/admin/payment-transactions/:id/fail`. Registration creates a PENDING PAYMENT attempt; a mismatched amount may be retained but cannot be confirmed. Confirmation requires exact full amount, no sibling PENDING attempts, no confirmed facts, and database time strictly before the original 24-hour deadline. Failure requires a reason and preserves original transaction evidence. Each successful mutation increments Order.version once and appends one Revision, Event, AdminAuditLog and idempotent response atomically. All payment routes use Order-first locking to serialize with T16 timeout/cancellation. This is offline manual recordkeeping only; no provider API or money movement. Registration returns HTTP 201; confirm/fail return HTTP 200, each with `{order,paymentTransaction}`. Listing returns `{items,total,page,pageSize}` using the exact ADMIN payment-evidence whitelist and has no version/history writes. Strict DTOs, original-response idempotency, post-lock and conditional-write DB-clock checks, immutable revisions and sanitized event/audit records are implemented. See docs/22 for error codes and actual isolated results. No development deployment is included.


## T18 offline refund API (implemented and merged in PR #23)

See [docs/23-offline-refund-api.md](23-offline-refund-api.md), governed by D18/D59/D67 and D76-D82. T18 adds ADMIN-only GET `/admin/orders/:id/refunds`, POST `/admin/orders/:id/refunds`, POST `/admin/payment-transactions/:id/confirm-refund`, and POST `/admin/payment-transactions/:id/fail-refund`. It only handles cancelled orders in `REFUND_PENDING`; only full refunds are allowed and the refund channel/amount must match the original unique confirmed PAYMENT. Registration creates one PENDING attempt only after the external refund transfer has been initiated; confirmation requires ADMIN verification that the money was actually returned and then sets Order.paymentStatus=REFUNDED while fulfillmentStatus remains CANCELLED. Failure requires a reason and leaves the order REFUND_PENDING. One PENDING at a time; FAILED attempts can be retried with a new record; only one CONFIRMED REFUND is allowed. Every successful mutation increments Order.version and writes Revision/Event/AdminAuditLog/idempotency atomically. No partial refund, refund after completed fulfillment, provider API or money movement. Registration returns HTTP 201 and confirm/fail HTTP 200, each `{order,paymentTransaction}` with the existing ADMIN allowlists; list returns `{items,total,page,pageSize}` and writes no history. Required expectedVersion and Idempotency-Key, strict bodies/queries, persisted ADMIN Session/CSRF, Order-first locks and database UTC validation are implemented. No 24-hour refund deadline applies. See docs/23 for error codes and actual isolated results; deployment remains separately authorized.


## T19 manual fulfillment and initial subscription API (implemented and merged in PR #26)

The approved contract is [docs/24-manual-fulfillment-api.md](24-manual-fulfillment-api.md), governed by D24-D32, D37, D40, D52, D59, D64 and D83-D88. It adds ADMIN-only POST `/admin/orders/:id/fulfill` for ordinary USER/ADMIN INITIAL subscription orders and ONE_TIME orders only; RENEWAL and SYSTEM_RENEWAL are excluded. Eligible orders must be `PAID + PROCESSING` with one exact confirmed full PAYMENT, or `NOT_REQUIRED + PROCESSING` with zero amount, NULL payment times and no transactions. ONE_TIME completes without a subscription. INITIAL creates one unique sourceType=ORDER subscription from frozen order snapshots, with fulfillment-time AppSettings timezone and structured DAY/MONTH/YEAR expiry calculation. Order completion, subscription, OrderRevision/Event, SubscriptionEvent, two separate AdminAuditLog rows and idempotency response commit atomically. Delivery failure reuses T16 cancellation and T18 refund; no FAILED fulfillment path. PR #26 merged the endpoint; development/production deployment requires separate operator authorization. Strict input is `{expectedVersion,fulfillmentNote?}` (bounded positive integer version; optional trimmed note, max500, blank becomesNULL), required Idempotency-Key and empty query. Success is HTTP200 `{order}` or `{order,subscription}` using explicit ADMIN whitelists. Order → all PaymentTransaction rows in ID order → AppSettings locks, one database UTC instant and serializable original-response idempotency protect atomicity. Errors include NOT_FOUND404 for hidden/missing orders, VERSION_CONFLICT409, ORDER_NOT_FULFILLABLE409, SETTINGS_UNAVAILABLE503 and IDEMPOTENCY_CONFLICT409. No client dates, migration or development deployment.


## T20 ADMIN order center implementation

ADMIN GET /orders adds strict productType=SUBSCRIPTION|ONE_TIME against productTypeSnapshot. GET /orders/:id adds nullable linkedSubscription (id/sourceType/status/version/productNameSnapshot/startedAt/expiresAt), only in detail. GET /orders/:id/events accepts page=1..10000 and pageSize=1..100 (defaults 1/20), returning safe paginated events. PATCH /orders/:id/internal-note requires Idempotency-Key and strict {expectedVersion,internalNote}; trimmed empty text becomes NULL, max2000. No-op is 400 NO_CHANGES; stale version is 409 VERSION_CONFLICT. All routes retain ADMIN Session/CSRF/no-store guards; CUSTOMER contracts are unchanged. See docs/25 for exact DTOs and atomicity.
