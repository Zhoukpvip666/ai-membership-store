# Customer order center — implementation contract

- Document: CUSTOMER-ORDER-CENTER
- Version: 1.0
- Status: Approved design baseline; implementation not started
- Date: 2026-11-20
- Related: [Order lifecycle decisions](17-order-creation-and-lifecycle-design.md), [UI specification](08-interface-specification.md), [Order read API](16-order-read-api.md), [Order edit](20-order-edit-api.md), [Cancellation/timeout](21-order-cancellation-timeout.md), [Admin order center](25-admin-order-center.md), [Data model](04-data-model.md)

T21 turns the existing CUSTOMER `/account/orders` page from Mock into a real API-backed view of the signed-in customer's own orders. It reuses the already implemented customer order read/edit/cancel APIs. It does not create orders or implement checkout. The only new backend read endpoint is the safe customer order-guidance endpoint; the existing ADMIN settings PATCH gains the already-persisted `paymentInstructions` field.

## 1. Decision reconciliation

D98-D105 are additive CUSTOMER UI and public-facing guidance decisions. No existing ACTIVE lifecycle decision is superseded or revoked.

| Existing decision | T21 relationship | Resolution |
|---|---|---|
| D13-D16 | Customer edit/cancel eligibility | Reuse T15/T16 predicates; full form replacement, original deadline, no confirmed payment facts |
| D18-D23 | Payment facts and confirmation | Customer sees only order-level status; cannot create/confirm or inspect payment attempts |
| D31-D32 | Product-specific account information | Render only the frozen, non-sensitive form snapshot; no new account credential fields |
| D39 | 24-hour timeout | Use server expiresAt/remainingSeconds; never restore or accept late payment on cancelled orders |
| D41 | Revision history UI prohibition | No OrderRevision browse/compare/restore and no OrderEvent API |
| D45 | Notification strategy deferred | No email, SMS, push or outbox behavior |
| D46 | Customer order detail requirements | Show frozen product/form snapshot, amount, payment status and remaining deadline |
| D47-D49 | ADMIN-only fields | Never return/display internalNote, creator, adminLabel, cancellation reason or private audit data |
| D51-D53 | Zero-price order behavior | NOT_REQUIRED + PROCESSING appears as in progress; customer cannot cancel it |
| D54 | Correct actor attribution | Customer edits/cancels continue to use USER actor and never create AdminAuditLog |
| D55-D56 | Account and form eligibility | Require ACTIVE customer session; server validates complete frozen form schema on edit |
| D58 | Creation response | No customer create flow in T21; existing create response remains unchanged |
| D59, D70-D75 | Manual payment | No payment gateway, payment evidence upload, transaction list or confirmation action |
| D76-D82 | Manual refund | Show only order-level REFUND_PENDING/REFUNDED; never expose attempts or customer refund mutation |
| D89-D97 | ADMIN order center | ADMIN workspace remains unchanged; T21 is CUSTOMER-only |

Important clarification: `REFUND_PENDING` is set at cancellation time, before an external refund is necessarily initiated. The customer label is therefore **待退款**, not “退款处理中”. Only after ADMIN confirms actual external refund completion does the order become **已退款**.

## 2. Scope and route inventory

All CUSTOMER paths use `/api/v1`, a persisted Session, role CUSTOMER, ACTIVE-account validation, no-store responses and existing CSRF rules for mutations. Ownership is always derived from `response.locals.principal.user.id`; never accept `userId` from query/body.

| Method | Path | T21 behavior |
|---|---|---|
| GET | `/api/v1/customer/orders` | Existing own-order list; reuse |
| GET | `/api/v1/customer/orders/:id` | Existing own-order detail; reuse |
| PATCH | `/api/v1/customer/orders/:id` | Existing T15 formData edit; reuse |
| POST | `/api/v1/customer/orders/:id/cancel` | Existing T16 cancellation; reuse |
| GET | `/api/v1/customer/order-guidance` | New safe store name/business timezone/plain-text payment guidance |
| GET | `/api/v1/admin/settings` | Existing ADMIN settings read; already includes AppSettings fields |
| PATCH | `/api/v1/admin/settings` | Extend existing strict schema to accept optional `paymentInstructions` |

No CUSTOMER order creation endpoint is called from this page. No new CUSTOMER payment/refund/OrderEvent/OrderRevision endpoint is added. No online checkout, payment provider, refund request, payment proof upload, supplier, subscription center or notification integration.

## 3. Customer order list

### 3.1 Existing query contract

Reuse `GET /api/v1/customer/orders`. Existing strict query supports:

- `search`: trimmed max 254; matches partial `orderNo` or frozen `productNameSnapshot` only.
- `kind`: INITIAL / ONE_TIME / RENEWAL when provided.
- `paymentStatus`: UNPAID / PENDING_VERIFICATION / PAID / REFUND_PENDING / REFUNDED / NOT_REQUIRED.
- `fulfillmentStatus`: NOT_STARTED / PROCESSING / COMPLETED / FAILED / CANCELLED.
- `sort`: asc / desc by createdAt; default desc; id ascending tie-breaker.
- `page`: default 1; `pageSize`: default 20, maximum 100.

Every database query includes `hidden=false` and `userId=current Session user`. Search must not include other customer identities/private labels. Unknown, repeated, nested or extra query fields remain rejected by the existing strict schema. List and count use the same predicate.

### 3.2 Status filter presets

Presets map to existing query fields; they do not create a new status column:

| UI preset | Query |
|---|---|
| 全部 | no status predicate |
| 待付款 | `paymentStatus=UNPAID` |
| 付款待核实 | `paymentStatus=PENDING_VERIFICATION` |
| 处理中 | `fulfillmentStatus=PROCESSING` |
| 已完成 | `fulfillmentStatus=COMPLETED` |
| 已取消 | `fulfillmentStatus=CANCELLED` |
| 待退款 | `paymentStatus=REFUND_PENDING&fulfillmentStatus=CANCELLED` |
| 已退款 | `paymentStatus=REFUNDED&fulfillmentStatus=CANCELLED` |

The 已取消 preset intentionally includes its 待退款 and 已退款 subsets; row-level status labels remain more specific. Presets combine with search/kind through server-side AND. The 处理中 preset MUST include both `PAID + PROCESSING` and `NOT_REQUIRED + PROCESSING` zero-price orders.

### 3.3 List presentation

Each row/card shows frozen productNameSnapshot, orderNo, createdAt, amountFen, payment status and fulfillment/business status. Show the 24-hour remaining countdown only when the server DTO reports a positive `remainingSeconds` for an eligible UNPAID + NOT_STARTED order. Use server pagination and total count; do not locally filter only the current page.

Desktop: concise table/list with status filters, search and pagination. Mobile: vertically stacked order cards, one-column controls and full-width detail action. Provide loading, empty, retryable error and stale-response handling. Do not show Mock labels/data or read `mock`/`CURRENT_USER` in this route.

## 4. Customer order detail

Reuse `GET /api/v1/customer/orders/:id`; do not add a separate DTO or event endpoint. Missing, hidden and foreign-owned IDs continue to share 404. The detail UI may be a desktop dialog/drawer and a mobile full-screen sheet.

### 4.1 Frozen product and price

Display only the order's frozen fields:

- orderNo, productNameSnapshot, productDescriptionSnapshot, productTypeSnapshot, kind.
- priceSnapshotFen (if historically NULL, show unavailable; do not infer from current Product), amountFen, termSnapshot and structured servicePeriod snapshots where present.
- createdAt and the derived expiresAt/remainingSeconds.
- contactEmailSnapshot and the frozen non-sensitive form fields.

Never query today's Product to replace an order snapshot. Never parse termSnapshot to invent a structured period. Format money as integer fen using the existing formatter.

### 4.2 Frozen form display

Render labels/options from `formSchemaSnapshot` and values from `formData`, not from current Product.formSchema. Use explicit known field types and safe plain-text rendering; never use `v-html` or execute schema content. Hide/refuse credential-like field IDs/labels/hints using the shared credential-field contract. Do not show passwords, OTPs, 2FA/recovery codes, session cookies, access tokens or payment credentials, including legacy values. Do not expose admin-only `internalNote`, `creator`, `source`, `cancellationReason`, `adminLabel`, OrderRevision, AdminAuditLog or raw event JSON. The CUSTOMER DTO must remain its current exact allowlist.

`targetIdentifier` is not a new display authority: render the corresponding frozen form field once using its schema label, and do not duplicate it if already represented in formData. Display `contactEmailSnapshot` as the order's frozen contact address.

### 4.3 Payment and fulfillment

Show payment and fulfillment as independent fields. Use the status mapping in section 5. Display `paidAt` as actual payment occurrence only when the server has confirmed the PAYMENT fact; display `paymentConfirmedAt` as the merchant verification time. Display `fulfilledAt` and `cancelledAt` only when present. Do not show payment attempt IDs, external references, channels, notes or confirmation actors.

## 5. Customer-facing status mapping

| Server facts | Customer label |
|---|---|
| UNPAID + NOT_STARTED | 待付款 |
| PENDING_VERIFICATION + NOT_STARTED | 付款待核实 |
| PAID + PROCESSING | 处理中 |
| NOT_REQUIRED + PROCESSING | 处理中 |
| fulfillmentStatus=COMPLETED | 已完成 |
| CANCELLED + REFUND_PENDING | 待退款 |
| CANCELLED + REFUNDED | 已退款 |
| CANCELLED + UNPAID or NOT_REQUIRED | 已取消 |

Legacy/inconsistent combinations not listed above display `状态待确认`; do not infer or mutate a state. The page may advise the customer to contact the merchant but must not expose internal reasons or evidence.

## 6. Customer edit and cancellation

### 6.1 Edit

Show 修改订单 only if the latest DTO says `paymentStatus=UNPAID`, `fulfillmentStatus=NOT_STARTED`, `remainingSeconds>0`, `formSchemaSnapshot` is non-NULL, and there is no confirmed payment fact. The client predicate is for UI visibility only; T15 server row lock, expectedVersion, frozen schema validation and database-time deadline are authoritative.

Reuse `PATCH /api/v1/customer/orders/:id` with strict `{expectedVersion,formData}` and Idempotency-Key:

- Replace the complete formData object; never field-merge.
- Render the frozen formSchemaSnapshot; all required fields must remain valid.
- Customer cannot submit amountFen, priceAdjustmentReason, productId, userId, source, creator, status, timestamps or internalNote.
- No order amount/price changes; no product/customer change.
- On 409 VERSION_CONFLICT or ORDER_NOT_EDITABLE, reload detail and explain; do not silently resubmit against a newer version.
- A network-unknown retry reuses the exact original body and Idempotency-Key. Changed formData is a new intent and gets a new key.

### 6.2 Cancel

Show 取消订单 only when the latest order is an ordinary own order in `UNPAID + NOT_STARTED` or `PENDING_VERIFICATION + NOT_STARTED` and has no confirmed PAYMENT/payment timestamps. Reuse `POST /api/v1/customer/orders/:id/cancel` with `{expectedVersion,reason?}` and Idempotency-Key.

- reason is optional; when supplied, trim and enforce max 500 characters. Blank normalizes to NULL under T16.
- Require a confirmation dialog; cancellation is irreversible.
- If `PENDING_VERIFICATION`, the dialog must explicitly warn: cancelling closes the pending/unconfirmed PAYMENT attempts; if the customer already transferred money but it has not been confirmed, the customer must contact the merchant and the claim is handled outside this order workflow.
- Do not offer cancel for PAID, NOT_REQUIRED zero-price, PROCESSING, COMPLETED or already CANCELLED orders.
- Do not add a client-side deadline restriction to cancellation beyond the T16 state/fact rules; the backend remains authoritative.
- On 409 VERSION_CONFLICT, reload the order; do not retry a changed version automatically.

## 7. Refund visibility (D103)

Customer UI displays only the order-level `paymentStatus` and the label from section 5. It never reads or displays T17/T18 payment/refund evidence endpoints. There is no customer refund attempt list, refund transaction ID, external reference, channel, administrator note/reason, audit record or customer refund mutation.

`REFUND_PENDING` means the order is cancelled and awaits the merchant's refund handling; it does not prove the external transfer has started. Display `待退款`. Only T18 ADMIN confirmation of actual external full refund changes the order to `REFUNDED`, then display `已退款`. No refund completion time is invented because Order has no such field.

## 8. Order lifecycle timeline (D104)

No CUSTOMER OrderEvent endpoint is added. Build a concise timeline from the existing role-safe order DTO only:

| Timestamp field | Timeline entry |
|---|---|
| `createdAt` | 订单创建 |
| `paidAt` | 实际付款发生 (only after confirmed payment fact exists) |
| `paymentConfirmedAt` | 商家确认收款 |
| `fulfilledAt` | 服务完成 |
| `cancelledAt` | 订单取消 |

Only non-NULL timestamps are shown, in chronological order. The values are UTC instants; render using the `businessTimezone` returned by order-guidance. A PENDING_VERIFICATION attempt is not a confirmed payment event and has no customer-visible attempt timestamp. Refund state is shown in the current status area only; do not fabricate a refund timeline node or timestamp.

## 9. Offline payment guidance (D105)

### 9.1 ADMIN settings write

Existing `GET /api/v1/admin/settings` already returns AppSettings. Extend the existing strict `PATCH /api/v1/admin/settings` schema with optional `paymentInstructions`:

- string, maximum 4000 characters after newline normalization (`CRLF`/`CR` → `LF`).
- Preserve line breaks and plain text; empty string explicitly clears the field.
- Accept plain text only; do not parse/render HTML or Markdown and reject extra unknown fields.
- ADMIN settings page adds a textarea with a 4000-character counter and save/error state.
- Extend the frontend `AppSettings` type and settings store save payload.
- `AppSettings.paymentInstructions` already exists; no Prisma schema or migration is expected.

The existing `SETTINGS_UPDATED` AdminAuditLog records that `paymentInstructions` changed by field name only. Do not duplicate the full instruction text or receiving-account details into audit JSON. Never place passwords, OTPs, API keys, private keys or payment-account login credentials in this field.

### 9.2 CUSTOMER read endpoint

New endpoint:

`GET /api/v1/customer/order-guidance`

Require the existing persisted Session, role CUSTOMER and ACTIVE-account guard. Return exactly:

```json
{
  "storeName": "AI 会员商店",
  "businessTimezone": "Asia/Shanghai",
  "paymentInstructions": "请向以下收款账户转账……"
}
```

`businessTimezone` is the validated AppSettings.timezone and is public display configuration; it is needed to render the UTC order timestamps in the same business timezone used by D86. Do not return `ownerEmail`, admin user data, settings IDs, updatedAt or any other internal settings. Response is no-store and plain JSON.

### 9.3 Display eligibility

Show the payment-instructions panel only when the order is positive-amount `UNPAID + NOT_STARTED` and `remainingSeconds>0`:

- UNPAID + NOT_STARTED: show the guidance (if non-empty) and remind the customer to pay before expiry.
- PENDING_VERIFICATION + NOT_STARTED: hide the guidance and show `付款待核实，请勿重复转账`.
- PAID: hide the guidance.
- NOT_REQUIRED zero-price: hide the guidance.
- cancelled, REFUND_PENDING, REFUNDED, COMPLETED or expired (`remainingSeconds=0`): hide the guidance.
- Empty instructions: show `商家暂未配置付款说明，请联系商家确认` without exposing ownerEmail.

The endpoint only returns instructions; it does not create a payment, reserve funds, verify receipt, extend the 24-hour deadline, send a notification or initiate refund.

## 10. Frontend integration

- Replace the Mock CUSTOMER branch in `frontend/src/views/account/CustomerOrders.vue` with the real list/detail/edit/cancel flow. Keep the T20 ADMIN branch unchanged.
- Add typed CUSTOMER order/guidance API functions in `frontend/src/api/orders.ts` or a dedicated `customer-orders.ts`; reuse the existing same-origin `api()` client and CSRF/session behavior.
- Remove `mock`, `CURRENT_USER`, `OrderDialog` and Mock state dependencies from the CUSTOMER order route. Do not change Mock operating overview, customer storefront checkout or unrelated prototype flows.
- Use existing `ProductFormInputs.vue` with the order's frozen schema for editing; read-only detail may use the same component disabled or a dedicated safe text renderer.
- Extend `frontend/src/views/admin/Settings.vue`, `frontend/src/api/products.ts` AppSettings type and `frontend/src/stores/settings.ts` to edit/save paymentInstructions. Do not alter unrelated settings semantics.
- Keep idempotency request body/key in memory for unknown-result retry; never persist full formData/payment instructions in localStorage/sessionStorage.
- On successful edit/cancel, refresh detail and the server-paginated list/count. Preserve the exact request body/key for replay.
- On stale version, reload and ask the customer to review; do not automatically overwrite.
- Use `businessTimezone` for all customer order dates and countdown labels; use server `remainingSeconds` as the countdown authority. Client clock is display-only and never authorizes writes.

## 11. Responsive behavior

Desktop: use the existing customer storefront shell and navigation. The order list is a compact table/list; filters and search remain above it; detail opens in a dialog/drawer.

Mobile: preserve the four-item bottom navigation; use stacked order cards, vertically arranged filters/forms and a full-screen order detail sheet. Ensure action buttons remain reachable and confirmation dialogs do not overflow the viewport.

Do not add a new UI framework or alter the ADMIN navigation/layout.

## 12. Security and privacy

- Every order GET/edit/cancel enforces CUSTOMER role, ACTIVE account, persisted Session and ownership in the database predicate.
- Hidden, foreign and missing order IDs remain indistinguishable 404s.
- Customer DTO remains the exact allowlist in `backend/src/modules/orders/dto.ts`; never add internalNote, creator/source, cancellationReason, adminLabel, linkedSubscription admin projection, events, payment/refund attempts or audit data.
- Customer guidance is a separate strict allowlist: storeName, businessTimezone, paymentInstructions only.
- No secrets, authentication credentials, payment login credentials, access tokens, OTPs or raw audit/history data in UI/API/logs.
- Render all free text as text; no `v-html`, arbitrary HTML or Markdown execution.

## 13. Testing and acceptance

Use random isolated MySQL and real HTTP with persisted CUSTOMER/ADMIN sessions. No Seed unless the existing task-specific runner explicitly requires and documents it; prefer no-Seed modes. Do not read development `.env`, connect to development DB, migrate it, inspect its orders or touch its original data volume.

### Backend/API

- Customer list filters/search/pagination/count and stable ordering; no hidden/foreign rows, no userId query override, strict unknown/repeated query rejection.
- Customer detail owner/hidden/missing all safe 404; exact DTO allowlist; no internalNote/creator/cancellationReason/PaymentTransaction/Event/Revision/Audit leakage.
- Guidance route requires CUSTOMER ACTIVE session; ADMIN/anonymous/pending/disabled rejected according to existing auth behavior; returns only storeName/businessTimezone/paymentInstructions; never ownerEmail or other settings.
- ADMIN settings PATCH accepts 4000-character text, preserves line breaks, normalizes CRLF, empty clears, rejects 4001/unknown/non-string; GET returns saved value; audit records field name but not full instruction content.
- Customer edit: frozen schema validation, complete replacement, required fields, expectedVersion, 409 stale version, original deadline, idempotent replay, changed-intent conflict, no amount/status changes, Revision/Event USER actor, no AdminAuditLog.
- Customer cancel: UNPAID and PENDING_VERIFICATION no-confirmed-fact branches, optional reason/500 boundary, pending attempts retained/closed as T16 requires, version/history/idempotency, replay, foreign/hidden 404, paid/zero/completed rejection.
- No API is added to read payment/refund attempts or OrderEvent for CUSTOMER; tests assert 403/404 on admin routes and absence of sensitive response keys.

### Browser E2E — desktop and mobile

- CUSTOMER login → own order list, server search/status filters/pagination, empty/error/retry states.
- Customer A cannot see Customer B order in list/detail; tampered IDs share 404.
- Detail renders frozen product/schema/form data and all available lifecycle timestamps in businessTimezone; does not render Mock data, internalNote or secrets.
- Positive UNPAID order shows countdown and payment guidance; blank guidance shows safe fallback; expired/other statuses hide instructions.
- PENDING_VERIFICATION displays wait/no-repeat-transfer warning and does not show payment instructions.
- PAID/NOT_REQUIRED/REFUND_PENDING/REFUNDED/COMPLETED/CANCELLED status mapping exact, including zero-price order in 处理中.
- Edit full form with frozen schema; stale version reload; idempotent unknown-result retry preserves original body/key.
- Cancel UNPAID; cancel PENDING_VERIFICATION requires explicit warning; paid, zero-price and completed orders have no cancel action.
- CUSTOMER cannot access ADMIN order center, ADMIN settings or payment/refund evidence routes.
- ADMIN settings can configure/clear guidance; CUSTOMER sees updated plain text after reload; no HTML execution.
- Existing T20 ADMIN order center and unrelated prototype regression remain unchanged.

### Regression and quality

- Re-run T15 edit/T16 cancellation/order-read/auth/settings regression and T20 ADMIN order center regression.
- Desktop/mobile E2E, `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run db:validate`, `git diff --check`.
- No Prisma schema/migration or dependency change is expected. If an existing auth/settings contract cannot support this safely, stop and report; do not add a migration without separate approval.

## 14. Explicit non-goals

- Customer checkout, product catalog, customer order creation or cart.
- Customer subscription center/read API or renewal.
- Online payment provider, webhook, payment proof upload or customer payment attempt read.
- Customer refund request, refund transaction read or provider refund.
- Customer OrderEvent/OrderRevision/AdminAuditLog browsing.
- Email, SMS, push, outbox or notifications.
- Supplier API/automation, account login or authentication-secret collection.
- Dashboard/overview changes or ADMIN order center changes.
- New Prisma schema/migration, new runtime dependency or production/development deployment.

## 15. Delivery

One T21 implementation PR targeting `main`, using an independent worktree/branch `codex/customer-order-center`. Preserve all existing user changes, original worktree, running services and database volume. Update this document, D98-D105 decision register, docs/08, docs/05, docs/04, docs/07, docs/16, AGENTS and README. Stop after pushing the PR; do not merge, deploy or start T22 without separate authorization.