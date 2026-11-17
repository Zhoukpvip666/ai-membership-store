# Local Operations API Contract (Task 1.2)

Base path: /api/v1. All payloads are JSON. Timestamps are UTC ISO-8601. Money is integer CNY fen. Validate all input with Zod or an equivalent schema validator. This contract covers the local-only offline operations milestone; online payment and supplier/email APIs are deliberately absent.

## Task 1.2.1 implemented surface

Only `GET /api/v1/health` and its `/health` alias are implemented. Each request probes MySQL through Prisma. Successful connectivity returns HTTP 200 with `{"status":"ok","database":"ready"}`. Connection/query failure returns HTTP 503 with `{"status":"degraded","database":"unavailable"}`; driver errors and credentials are never returned. This does not verify migration currency: use the local `db:status` command. All business/authentication endpoints below remain unimplemented in Task 1.2.1.

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
