# Local Operations API Contract (Task 1.2)

Base path: /api/v1. All payloads are JSON. Timestamps are UTC ISO-8601. Money is integer CNY fen. Validate all input with Zod or an equivalent schema validator. This contract covers the local-only offline operations milestone; online payment and supplier/email APIs are deliberately absent.

## Task 1.2.2 implemented surface

`GET /api/v1/health` and its `/health` alias retain their database-readiness behavior. Each request probes MySQL through Prisma. Successful connectivity returns HTTP 200 with `{"status":"ok","database":"ready"}`. Connection/query failure returns HTTP 503 with `{"status":"degraded","database":"unavailable"}`; driver errors and credentials are never returned. This does not verify migration currency: use the local `db:status` command. Authentication and the section 3 customer/invitation APIs below are implemented in Task 1.2.2. Sections 4–8 remain unimplemented; unknown authorized routes return 404. All /admin routes, including unimplemented paths, first require a valid ADMIN session.

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
| PATCH | /admin/users/:id | Update display name/notification email |
| PATCH | /admin/users/:id/status | Disable/enable customer account |
| POST | /admin/users/:id/invitations | Generate/reissue invitation and return copyable URL once |
| POST | /admin/invitations/:id/revoke | Revoke an unused invitation |

Creating a user and creating a subscription are independent. A pending customer may have orders and subscriptions. Reissuing an invitation revokes previous unused tokens. The UI must warn that localhost invitation URLs are not externally reachable.

### Implemented customer payloads

- List query: optional search, status (PENDING_ACTIVATION/ACTIVE/DISABLED), page (1–10000, default 1), pageSize (1–100, default 20). Response: `{items,total,page,pageSize}`; each item contains public account fields and `_count:{orders,subscriptions}`. Only CUSTOMER rows are listed.
- Create: `{displayName,loginEmail,notificationEmail?}`. Display name is 1–80 trimmed characters; emails are validated, normalized and at most 254 characters. Null/omitted notification email falls back to login email in the UI. Response HTTP 201 `{user}`; account is CUSTOMER/PENDING_ACTIVATION with null passwordHash and activatedAt. Duplicate email returns 409 EMAIL_EXISTS.
- Detail: `{user}`, including real order/subscription counts and the latest 10 invitation metadata rows (id/createdAt/expiresAt/usedAt/revokedAt). No password/token hash or original URL is exposed.
- Edit: nonempty `{displayName?,notificationEmail?}`. Login email is immutable after creation, matching the profile-only PATCH contract. Supplied role, status, password, passwordHash or unknown fields are rejected with 400; administrators cannot set customer passwords.
- Status: `{disabled:boolean,reason:string}` (1–500 trimmed characters). Disabling revokes all sessions and unused invitations atomically, preserving orders/subscriptions. Restoring returns to ACTIVE only for an already activated/password-bearing account, otherwise PENDING_ACTIVATION. Repeating the current status returns 409.
- Issue/reissue: JSON `{}`, allowed only for unactivated PENDING_ACTIVATION customers. Response HTTP 201 `{invitation,url}`; invitation contains safe metadata only, and url is returned once. It has the form APP_BASE_URL/activate#TOKEN so the browser never sends the token in a URL to the web server; the activation page removes the fragment from browser history and submits the token only in the activation body. Regeneration transactionally revokes earlier unused invitations.
- Revoke: JSON `{}`; HTTP 204. Already used/revoked invitations return 409. The UI retains no recoverable URL after closing the detail.
- Customer creation/edit/disable/restore, invitation issue/revoke and administrator login/logout append sanitized audit records transactionally. Audit snapshots omit names/emails, raw tokens and password/token hashes; edit logs name changed fields only.

Task 1.2.2 adds no customer order/subscription read APIs. They remain section 7 future work; customer UI shows an explicit placeholder rather than another account's Mock history. No product/order/subscription CRUD is implemented.

## 4. Admin products and settings

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/products | List products including archived |
| POST | /admin/products | Create product |
| PATCH | /admin/products/:id | Edit product and independent listing/new-purchase/renewal flags |
| POST | /admin/products/:id/archive | Soft archive product |
| GET | /admin/settings | Read store name, owner email, timezone |
| PATCH | /admin/settings | Update non-secret settings |

No supplier-cost or secret credential fields.

## 5. Admin offline orders and payment transactions

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/orders | Search/filter by customer, order number, payment status, fulfillment status, date |
| POST | /admin/orders | Create OFFLINE_MANUAL order |
| GET | /admin/orders/:id | Order snapshot, transactions, events, linked subscription |
| POST | /admin/orders/:id/payment-transactions | Record offline payment transaction as pending verification |
| POST | /admin/payment-transactions/:id/confirm | Confirm payment after checking the actual external account |
| POST | /admin/orders/:id/refunds | Record a pending full-refund action after private agreement |
| POST | /admin/payment-transactions/:id/confirm-refund | Confirm only after refund has actually been sent externally |
| POST | /admin/payment-transactions/:id/fail | Record a failed/uncompleted transaction attempt |
| PATCH | /admin/orders/:id/fulfillment | Change fulfillment status with required reason |
| POST | /admin/orders/:id/complete | Complete paid order; for subscription order include supplier-confirmed dates and create/update entitlement atomically |

Supported offline channels: WECHAT, ALIPAY, CASH, BANK_TRANSFER, OTHER. Payment and fulfillment states are independent. Order.paymentStatus is recomputed from transaction records in the same DB transaction. The app does not move money.

No partial payments or partial refunds in Task 1.2. Refund is confirmed only after external money return. A confirmed full refund before fulfillment completion cancels fulfillment; a refund after completion does not erase historical completion.

## 6. Admin subscriptions

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/subscriptions | Search/filter subscriptions |
| POST | /admin/subscriptions | Create subscription from ORDER, MANUAL_GRANT, or HISTORICAL_IMPORT source |
| GET | /admin/subscriptions/:id | Subscription and event history |
| PATCH | /admin/subscriptions/:id | Correct dates/renewal price/status with reason and audit |
| POST | /admin/subscriptions/:id/renewal-orders | Create separate OFFLINE_MANUAL renewal order |
| POST | /admin/subscriptions/:id/terminate | Terminate with required reason |

Pending-activation customers are valid subscription owners. MANUAL_GRANT and HISTORICAL_IMPORT do not create fake orders or payments. Renewal creates a new order but does not extend expiry until service completion is confirmed and the administrator enters the supplier-confirmed new expiry date.

## 7. Customer read-only APIs

| Method | Path | Purpose |
|---|---|---|
| GET | /me/orders | Current customer's own orders |
| GET | /me/orders/:orderNo | Own order detail and safe timeline |
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
