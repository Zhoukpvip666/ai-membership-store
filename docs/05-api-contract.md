# Local Operations API Contract (Task 1.2 and Phase 2)

Base path: /api/v1. All payloads are JSON. Timestamps are UTC ISO-8601. Money is integer CNY fen. Validate all input with Zod or an equivalent schema validator. This contract covers the local-only offline operations milestone; online payment and supplier/email APIs are deliberately absent.

**Stage 1 model-only update:** [Order/subscription foundation](15-order-subscription-foundation.md) reserves USER/ADMIN/SYSTEM_RENEWAL order sources, ORDER subscription linkage, structured periods/snapshots, lifecycle timestamps and plain-text payment instructions. It implements no order/payment/customer-history endpoint and does not add writable fields to existing product/settings/subscription payloads. Existing Phase 2 direct creation/renewal remains legacy compatibility behavior, not the future order-first workflow. Settings' existing ADMIN response can include the new paymentInstructions column, but PATCH cannot edit it in this stage. Next-stage APIs must enforce confirmed full payment → fulfillment → exactly-once linked subscription, ownership, hidden-order filtering and snapshot/period validation.

## Implemented surface

**Current order-read override:** [Order API stage 1](16-order-read-api.md) implements only GET `/admin/orders`, `/admin/orders/:id`, `/customer/orders`, `/customer/orders/:id`. Both roles exclude hidden rows in list/detail; CUSTOMER ownership comes only from Session. Explicit snapshot DTOs exclude authentication data and audits. ADMIN additionally receives internalNote; CUSTOMER never does. Both receive version, derived expiresAt and server-calculated remainingSeconds; see [revision foundation](18-order-revision-foundation.md). This supersedes the earlier reserved `/me/orders` paths below. The two creation POST routes below are implemented and merged; payment/fulfillment/renewal remain absent.

**Order creation stage — implemented (PR #11):** [Order creation API contract](19-order-creation-api.md) defines POST `/customer/orders` for ACTIVE CUSTOMER self-order and POST `/admin/orders` for ADMIN-created orders. Both use server-derived source/actor, strict role-specific DTOs, full form validation, frozen Product snapshots, required Idempotency-Key, atomic Order + V1 Revision + Event + applicable Audit + idempotency response. ADMIN may select ACTIVE or PENDING_ACTIVATION customers and unlisted/unarchived Products; CUSTOMER must be ACTIVE and may select listed/unarchived Products. Creation returns the complete role-safe order DTO with HTTP 201 (D58). Merged in PR #11; migration is included in main but development deployment requires separate authorization. Zero amount uses NOT_REQUIRED/PROCESSING without PaymentTransaction or payment times; positive amount uses UNPAID/NOT_STARTED. Responses are `{order}` and exact persisted role-specific DTOs are replayed for the same actor/key/input. See the contract for strict request/error definitions and isolated verification.

`GET /api/v1/health` and its `/health` alias retain their database-readiness behavior. Each request probes MySQL through Prisma. Successful connectivity returns HTTP 200 with `{"status":"ok","database":"ready"}`. Connection/query failure returns HTTP 503 with `{"status":"degraded","database":"unavailable"}`; driver errors and credentials are never returned. This does not verify migration currency: use the local `db:status` command. Authentication, customer/invitation, product/settings, Phase 2 subscription and the four order GETs above are implemented. The two creation POSTs, two core-edit PATCHes and two cancellation POSTs are implemented; other order mutations, payment, dashboard and customer subscription APIs remain unimplemented and return404. All /admin routes, including unimplemented paths, first require a valid ADMIN session.

## Order edit API (implemented and merged in PR #14)

PATCH `/customer/orders/:id` and PATCH `/admin/orders/:id` are implemented as specified in [docs/20-order-edit-api.md](20-order-edit-api.md). CUSTOMER may replace only the complete formData of their own eligible order; ADMIN may replace formData and optionally change amountFen in the same atomic edit. Both require expectedVersion and Idempotency-Key. Strict body shapes are `{expectedVersion,formData}` for CUSTOMER and `{expectedVersion,formData,amountFen?,priceAdjustmentReason?}` for ADMIN; unknown fields are rejected. Changed amount requires a nonblank reason (max500); a reason without an actual price change is rejected with 400 INVALID_INPUT. No effective change also returns 400. Validation uses the order's frozen formSchemaSnapshot, never current Product data or defaults. Missing/non-owned orders return the same 404. Ineligible/expired orders return 409 ORDER_NOT_EDITABLE; stale eligible versions return 409 VERSION_CONFLICT.

Success returns HTTP 200 `{order}` using the existing exact role-specific DTO. Locking, database-time expiry checks, one version increment, complete Revision, sanitized Event, ADMIN-only audit and the original idempotency response commit together. Exact retries replay the stored response even after later edits or zero conversion; another intent using the same actor/key returns 409 IDEMPOTENCY_CONFLICT. A positive-to-zero ADMIN change atomically enters NOT_REQUIRED/PROCESSING without payment timestamps, transactions or subscriptions; any existing PaymentTransaction prevents conversion. New events reuse NOTE with an ORDER_EDITED operation marker; no internal notes are changed. internalNote remains a separate D48 endpoint; its own update still increments Order.version and appends Revision/Event/AdminAuditLog atomically, but is outside T15. Cancellation, timeout, payment, refund and fulfillment are out of scope. No new migration is added.

## Model review follow-up (no new endpoints)

The sixth migration tightens USER/ADMIN ordinary orders and hidden SYSTEM_RENEWAL, requires complete ORDER subscription billing data, and freezes target/eligibility cycles plus anchor/timezone/billing revision on renewal orders. See [the authoritative transaction and compatibility contract](15-order-subscription-foundation.md#review-follow-up--integrity-and-renewal-cycle-snapshots).

Future administrator renewal verifies full external receipt first; future customer renewal accepts only a trusted successful payment result (no provider integration here). The system then creates and fulfills one renewal order, updates the existing subscription and writes events/audit in one transaction. The seventh migration requires SYSTEM_RENEWAL to be inserted as PAID/COMPLETED, with paidAt <= paymentConfirmedAt <= fulfilledAt (all explicitly non-NULL) and cancelledAt NULL. Order.paidAt is actual payment occurrence, frozen from the corresponding confirmed full PAYMENT's occurredAt; paymentConfirmedAt is the administrator's receipt confirmation time. PaymentTransaction.createdAt is the database entry time and can follow confirmation. Preserve deprecated paymentRecordedAt only for old data; never accept it as paidAt, fall back to it, or write it in the new flow. Row-local SQL cannot check equality across tables; future payment/fulfillment transactions must validate and persist matching occurrence/confirmation times and amounts atomically. Never create a pending renewal requiring a subsequent update: these rows are immutable from INSERT. Existing Phase 2 APIs are unchanged and must be integrated/restricted before ORDER subscriptions are enabled.

The final model supports only USER/ADMIN/SYSTEM_RENEWAL. Migration ten removes the retired source, all its CHECK exemptions and its special triggers. Every create service must explicitly select a source from trusted server context; nullable ENUM storage is only an omission sentinel, rejected by the INSERT Trigger and a non-NULL CHECK. All order sources are immutable; every order rejects DELETE/REPLACE. Same-source ordinary payment/fulfillment/note updates remain possible, while SYSTEM_RENEWAL is immutable immediately after its final INSERT. Future APIs must not expose source mutation or physical order deletion. This repair adds no endpoint and does not inspect or clean development test orders.

## 1. Conventions

- Single merchant and one owner ADMIN account.
- All /admin routes require server-side ADMIN authorization.
- Customer routes require an authenticated CUSTOMER and enforce ownership.
- Customers may be PENDING_ACTIVATION and still have admin-managed orders/subscriptions.
- No public registration, online checkout, payment-provider API, supplier API, SMTP, settlement, or withdrawal endpoints.
- Stable error shape with code, message, and requestId.
- Server generates IDs/order numbers and calculates/defaults prices. Never trust browser-supplied payment status, role, or transaction confirmation.
- Store money in integer fen. Store timestamps in UTC.
- Do not return password hashes, session token hashes, invitation token hashes, internal notes, or audit metadata to customers.

## 2. Authentication and invitation activation

| Method | Path | Purpose |
|---|---|---|
| POST | /auth/login | Admin/customer login |
| POST | /auth/logout | Revoke current session |
| GET | /auth/me | Current account and role |
| POST | /auth/activate | Consume one-time invitation token and set customer password |

No public /auth/register route. Admin is seeded from local environment configuration. Customer activation requires a valid, unused, unexpired invitation token. The raw invitation token is never returned by a read endpoint and is never emailed.

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

Customer order reads are implemented at `/customer/orders` as documented above; customer subscription reads remain future work. Customer UI remains a placeholder with no frontend integration in this stage. Administrator products/subscriptions, order GETs, the two order-creation POSTs and the two core-edit PATCHes are implemented; other order mutations remain unimplemented.

## 4. Admin products and settings

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/products | List products including archived |
| POST | /admin/products | Create product |
| GET | /admin/products/:id | Read product and versioned form configuration |
| PATCH | /admin/products/:id | Edit unarchived product and catalog listing |
| POST | /admin/products/:id/archive | Irreversibly archive and unlist product |
| GET | /admin/settings | Read store name, owner email, timezone |
| PATCH | /admin/settings | Update non-secret settings |

No supplier-cost or secret credential fields.

Implemented in Task 1.2.3. All seven routes use existing ADMIN sessions, Origin/custom-header CSRF checks and admin mutation limits. Detail/create/edit/archive return `{product}`; settings return `{settings}`. Lists return `{items,total,page,pageSize}`. No public product API is introduced.

T13 adds `servicePeriodUnit: DAY | MONTH | YEAR | null` and `servicePeriodCount: integer | null` to every Product DTO. New SUBSCRIPTION POSTs require both non-NULL (count 1–2147483647); ONE_TIME uses NULL/NULL (omission on create defaults to NULL) and NULL renewalPriceFen. PATCH explicitly changing periods must include both keys. Validation uses the merged persisted record: only an existing NULL/NULL subscription with both keys omitted may retain its unknown period. Converting ONE_TIME to SUBSCRIPTION requires a full period and renewal price; converting back clears all three fields, rejecting explicitly conflicting non-NULL values. `termLabel` remains independent display text and never supplies an inferred period. Invalid requests return the existing sanitized HTTP 400; authorization/archiving/audit behavior is unchanged. See [T13 guide](17-order-creation-and-lifecycle-design.md#g-商品周期能力缺口创建订单前置任务).

Product list query: search (name, max 120), type SUBSCRIPTION/ONE_TIME, archived ALL/ACTIVE/ARCHIVED (default ALL), listed true/false, page (default 1, max 10000), pageSize (default 20, max 100). Sort is sortOrder, createdAt, id ascending. Unknown query/body properties are rejected.

Create accepts name (1–120), description (nullable, max 2000), type, priceFen, renewalPriceFen, termLabel (1–40), servicePeriodUnit/servicePeriodCount as specified above, optional listed (default false), sortOrder (default 0), formSchema (default v1 empty). Fen and sortOrder are integers 0–2147483647. SUBSCRIPTION requires a renewal price; ONE_TIME requires null renewal price. PATCH is nonempty and validates the complete merged record. Switching to SUBSCRIPTION requires compatible renewal/period values in the same request; switching to ONE_TIME clears obsolete subscription values. Only listed and archivedAt represent product state; archivedAt is server-managed. Removed purchase/renewal permission properties are rejected as unknown inputs. Unlisted/unarchived products remain in ADMIN lists and details. Public catalog selection must require listed=true AND archivedAt=null. Future offline orders may select any unarchived product; new subscription orders additionally require a complete structured period. Future manual subscription grants/imports must select an unarchived SUBSCRIPTION product. Neither ADMIN selection requires listed=true. Archived products cannot be used for new orders, renewals or new subscriptions; these write flows remain future tasks. Slug, targetField, IDs and timestamps cannot be supplied. Description/schema strings are plain text, never executable markup.

Archive POST accepts `{}`, sets listed=false and archivedAt together once, retains the row and historical references, and writes one audit record even on retry. Archived products remain readable in ADMIN lists/details but every valid PATCH, including listed=true, returns 409 PRODUCT_ARCHIVED. The archive timestamp is stable on retry, and archivedAt cannot be supplied or cleared by clients. Missing product returns 404. No DELETE/restore route exists. All mutations and their sanitized audit records commit in one transaction; audit failures roll back changes. Audit records contain changed keys and operational flags/prices/counts, never form defaults or contact values.

Settings PATCH is nonempty and accepts only storeName (1–80), ownerEmail (normalized valid email, max 254) and timezone (valid IANA identifier, max 64; numeric offsets rejected). Existing singleton id=1 is updated, never an account/password. Missing initialization returns 503 SETTINGS_UNAVAILABLE. Validation returns sanitized 400 INVALID_INPUT; no request values are echoed. Full schema contract, limits and examples: [13-products-settings-forms.md](13-products-settings-forms.md).

## 5. Admin offline orders and payment transactions

The two GET routes, ordinary-order creation POST and core-edit PATCH below are implemented. Other mutation/payment/fulfillment routes and rules remain future contracts.

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/orders | Implemented: ordinary order search, pagination, kind/payment/fulfillment filters and creation-time sorting |
| POST | /admin/orders | Implemented: create ADMIN ordinary order (INITIAL/ONE_TIME) |
| GET | /admin/orders/:id | Implemented: safe frozen order DTO; transaction/event/linked-subscription expansion deferred |
| PATCH | /admin/orders/:id | Implemented T15: eligible ordinary-order full form replacement and optional amount edit |
| GET | /admin/orders/:id/payment-transactions | T17 planned: paginated ADMIN-only payment-attempt evidence |
| POST | /admin/orders/:id/payment-transactions | T17 planned: record offline PAYMENT attempt as PENDING |
| POST | /admin/payment-transactions/:id/confirm | T17 planned: confirm exact full payment after checking external account |
| POST | /admin/orders/:id/refunds | Record a pending full-refund action after private agreement |
| POST | /admin/payment-transactions/:id/confirm-refund | Confirm only after refund has actually been sent externally |
| POST | /admin/payment-transactions/:id/fail | T17 planned: mark one PENDING attempt FAILED with reason |
| PATCH | /admin/orders/:id/fulfillment | Change fulfillment status with required reason |
| POST | /admin/orders/:id/complete | Complete paid order; for subscription order include supplier-confirmed dates and create/update entitlement atomically |

Supported offline channels: WECHAT, ALIPAY, CASH, BANK_TRANSFER, OTHER. Payment and fulfillment states are independent. Order.paymentStatus is recomputed from transaction records in the same DB transaction. The app does not move money.

No partial payments or partial refunds in Task 1.2. Refund is confirmed only after external money return. A confirmed full refund before fulfillment completion cancels fulfillment; a refund after completion does not erase historical completion.

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

## 7. Customer read-only APIs

| Method | Path | Purpose |
|---|---|---|
| GET | /customer/orders | Implemented: current customer's own visible ordinary orders |
| GET | /customer/orders/:id | Implemented: own ordinary order snapshot; no internal timeline |
| PATCH | /customer/orders/:id | Implemented T15: own eligible ordinary-order full form replacement |
| GET | /me/subscriptions | Current customer's own subscriptions |
| GET | /me/subscriptions/:id | Own subscription detail and renewal history |

No customer purchase or online renewal endpoint in Task 1.2.

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

Do not implement public checkout, online payment intent, payment webhook, automatic refund API, supplier email, supplier API, supplier transfer, SMTP, email outbox, settlement, split payment, merchant wallet, or withdrawal routes.

## Order revision infrastructure (2026-11-19)

Migration eleven adds Order.version, permanent append-only OrderRevision and actorUserId-scoped idempotency (D34–D36). There are no new HTTP routes. Existing four order GET endpoints return the additional role-specific fields documented in [order read API](16-order-read-api.md); no history, order creation/edit, payment, cancellation or fulfillment endpoint is added. Full snapshot history is internal and never reused as a customer DTO.


## Order creation API (implemented and merged in PR #11)

This implemented write stage is limited to POST `/customer/orders` and POST `/admin/orders`. Use [the complete order creation contract](19-order-creation-api.md) and ACTIVE decisions D1-D10, D33-D36, D40, D44, D51-D58. ADMIN must explicitly submit final `amountFen`; the future integrated UI must pre-fill Product.priceFen. The first successful request returns a complete role-safe order resource DTO with HTTP 201. Same-key retries replay the exact stored original response. No order editing, cancellation, payment, fulfillment, renewal, notifications or frontend order-center integration is included in that stage.

## Order creation implementation details

Both POST routes require a valid persisted Session, CSRF Origin/custom header, strict JSON body and Idempotency-Key (1–128 ASCII letters/digits or `_.:-`). The customer schema is exactly `{productId,formData}`; ADMIN additionally requires `{userId,amountFen}` and permits priceAdjustmentReason (trimmed nonblank, max500) and internalNote (nullable, max2000, defaultNULL). No client source/identity override, statuses, version or snapshots. See [creation contract](19-order-creation-api.md).

The existing serializable transaction helper performs bounded retries for recognized MySQL write/deadlock conflicts. User and Product are locked in that order after persisted idempotency lookup. The same transaction commits Order, immutable V1 revision, ORDER_CREATED event, ADMIN-only sanitized audit and original `{order}` response. Customer contact snapshots use notificationEmail, falling back to loginEmail; new targetIdentifier remainsNULL. Both roles reject unknown periods and invalid/credential-collecting forms, without changing catalog rows. Existing subscription idempotency semantics remain unchanged.

A pending customer's valid Session receives403 ACCOUNT_NOT_ELIGIBLE only on POST /customer/orders; all other existing routes keep ACTIVE-only authentication. Disabled/expired/revoked Sessions still return401. ADMIN target errors use404 CUSTOMER_NOT_FOUND or409 CUSTOMER_DISABLED. Zero-price DTOs have remainingSeconds=0; exact replay may retain an earlier countdown for positive-price orders, so GET detail provides a fresh clock.


## Order cancellation and timeout stage (implemented and merged in PR #17)

T16 implements [docs/21-order-cancellation-timeout.md](21-order-cancellation-timeout.md), under D65-D69. POST `/customer/orders/:id/cancel` accepts `{expectedVersion,reason?}` for the ACTIVE customer's own eligible unpaid/unconfirmed order; POST `/admin/orders/:id/cancel` accepts `{expectedVersion,reason}` for eligible unpaid/unconfirmed, paid-before-fulfillment or zero-price orders. Under unchanged D16, ADMIN unpaid eligibility includes both UNPAID and PENDING_VERIFICATION with NOT_STARTED, no confirmed PAYMENT and no paidAt/paymentConfirmedAt facts; pending attempts are retained as FAILED and the cancelled order summary becomes UNPAID. Strict bodies reject unknown fields. Customer reason is trimmed/optional (blank becomes NULL); administrator reason must be nonblank; both are limited to 500 characters. Both require positive expectedVersion and Idempotency-Key, persisted Session/role and CSRF guards. Missing/foreign customer IDs share NOT_FOUND (404). Ineligible state returns ORDER_NOT_CANCELLABLE (409), stale version VERSION_CONFLICT (409), invalid input 400, changed same-key intent IDEMPOTENCY_CONFLICT (409). Success is HTTP 200 `{order}` with the existing exact role-safe DTO; normalized retries replay the saved response.

Paid cancellation enters CANCELLED + REFUND_PENDING only with exactly one full confirmed PAYMENT matching amountFen/paidAt/paymentConfirmedAt; preserve that receipt and create no refund. Zero-price cancellation remains NOT_REQUIRED + CANCELLED with no payment/refund. Every success atomically updates version once, closes pending attempts, writes full Revision/Event, ADMIN-only sanitized Audit and manual idempotency response. A SYSTEM worker runs immediately on API startup and every minute, examines at most 100 deterministic candidates, rechecks the inclusive 24-hour deadline under database-time SKIP LOCKED row locks, and retries failed rows next minute without blocking healthy candidates. It retains pending unconfirmed PAYMENT attempts as FAILED with PAYMENT_TIMEOUT and returns PENDING_VERIFICATION summaries to UNPAID. SYSTEM history has NULL actor IDs and no AdminAuditLog/IdempotencyRecord. Payment confirmation, refund completion, fulfillment and UI remain out of T16; all twelve migrations remain unchanged.


## T17 offline payment attempt and confirmation API (implemented for review)

The approved T17 contract is [docs/22-offline-payment-api.md](22-offline-payment-api.md), governed by D19-D23, D39, D59, D65-D69 and D70-D75. It adds ADMIN-only GET `/admin/orders/:id/payment-transactions`, POST `/admin/orders/:id/payment-transactions`, POST `/admin/payment-transactions/:id/confirm`, and POST `/admin/payment-transactions/:id/fail`. Registration creates a PENDING PAYMENT attempt; a mismatched amount may be retained but cannot be confirmed. Confirmation requires exact full amount, no sibling PENDING attempts, no confirmed facts, and database time strictly before the original 24-hour deadline. Failure requires a reason and preserves original transaction evidence. Each successful mutation increments Order.version once and appends one Revision, Event, AdminAuditLog and idempotent response atomically. All payment routes use Order-first locking to serialize with T16 timeout/cancellation. This is offline manual recordkeeping only; no provider API or money movement. Registration returns HTTP 201; confirm/fail return HTTP 200, each with `{order,paymentTransaction}`. Listing returns `{items,total,page,pageSize}` using the exact ADMIN payment-evidence whitelist and has no version/history writes. Strict DTOs, original-response idempotency, post-lock and conditional-write DB-clock checks, immutable revisions and sanitized event/audit records are implemented. See docs/22 for error codes and actual isolated results. No development deployment is included.
