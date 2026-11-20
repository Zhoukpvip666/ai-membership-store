# Admin order center — implementation contract

- Document: ADMIN-ORDER-CENTER
- Version: 1.0
- Status: Implemented and validated in codex/admin-order-center; pending PR review
- Date: 2026-11-20
- Related: [Order lifecycle decisions](17-order-creation-and-lifecycle-design.md), [UI specification](08-interface-specification.md), [Order read API](16-order-read-api.md), [Order creation](19-order-creation-api.md), [Order edit](20-order-edit-api.md), [Cancellation/timeout](21-order-cancellation-timeout.md), [Offline payment](22-offline-payment-api.md), [Offline refund](23-offline-refund-api.md), [Manual fulfillment](24-manual-fulfillment-api.md)

T20 replaces the ADMIN `/admin/orders` Mock screen with one real API-driven order workspace. It reuses the already merged T15-T19 backend operations and adds only the missing ADMIN OrderEvent read endpoint, linked-subscription detail summary, ADMIN product-type list filter, and D48 internal-note mutation endpoint. It does not rebuild order business services.

## 1. Decision reconciliation

D89-D97 are additive UI/API integration decisions. No existing ACTIVE decision is superseded or revoked. D38 remains superseded by D39.

| Existing decision | T20 relationship | Resolution |
|---|---|---|
| D41 | OrderRevision browsing/comparison/restore is prohibited | The UI reads OrderEvent only; never exposes OrderRevision snapshots or AdminAuditLog |
| D46-D47 | Customer/admin detail fields and explicit privacy boundary | ADMIN detail uses existing allowlisted order DTO, including admin-only internalNote and creator/customer metadata |
| D48-D49 | Internal note is independent from customer formData; optional at ADMIN creation | D92 adds the separate versioned internal-note PATCH; create UI uses existing optional field |
| D54 | CUSTOMER activity must not be written as ADMIN audit | Timeline labels actual ADMIN/USER/SYSTEM actor; no actor spoofing or customer AdminAuditLog |
| D57-D58 | ADMIN explicitly submits final amount and receives complete order DTO | Creation UI defaults to product price but submits final amount and required adjustment reason |
| D60-D64 | Full form replacement, price change, zero-price conversion | Edit UI reuses T15 strict frozen-schema API and its eligibility; zero-price becomes NOT_REQUIRED/PROCESSING |
| D65-D69 | Manual cancel and SYSTEM timeout | UI invokes T16 cancellation; no direct state editing or restoration |
| D70-D75 | Two-stage offline payment evidence and confirmation | UI invokes T17; mismatched amount can be recorded but not confirmed; other PENDING attempts must be closed first |
| D76-D82 | Two-stage offline full refund | UI invokes T18 only after cancellation; PENDING is not success; original channel/amount are fixed |
| D83-D88 | ADMIN manual fulfillment and initial ORDER subscription | UI invokes T19; both PAID and zero-price eligible orders can be fulfilled; no supplier API |

## 2. Scope and route inventory

All endpoints use base `/api/v1`, existing persisted ADMIN Session, ADMIN role guard, CSRF protection, mutation rate limits and `Cache-Control: no-store`. No CUSTOMER route is added.

| Method | Path | T20 behavior |
|---|---|---|
| GET | `/api/v1/admin/orders` | Existing list; add optional `productType` filter |
| GET | `/api/v1/admin/orders/:id` | Existing detail; add minimal `linkedSubscription` summary |
| GET | `/api/v1/admin/orders/:id/events` | New paginated safe OrderEvent timeline |
| GET | `/api/v1/admin/orders/:id/payment-transactions` | Reuse T17 payment evidence list |
| GET | `/api/v1/admin/orders/:id/refunds` | Reuse T18 refund evidence list |
| POST | `/api/v1/admin/orders` | Reuse T14 ADMIN order creation |
| PATCH | `/api/v1/admin/orders/:id` | Reuse T15 ADMIN edit |
| PATCH | `/api/v1/admin/orders/:id/internal-note` | New D92 internal-note mutation |
| POST | `/api/v1/admin/orders/:id/cancel` | Reuse T16 cancellation |
| POST | `/api/v1/admin/orders/:id/payment-transactions` | Reuse T17 payment registration |
| POST | `/api/v1/admin/payment-transactions/:id/confirm` | Reuse T17 payment confirmation |
| POST | `/api/v1/admin/payment-transactions/:id/fail` | Reuse T17 payment failure |
| POST | `/api/v1/admin/orders/:id/refunds` | Reuse T18 refund registration |
| POST | `/api/v1/admin/payment-transactions/:id/confirm-refund` | Reuse T18 refund confirmation |
| POST | `/api/v1/admin/payment-transactions/:id/fail-refund` | Reuse T18 refund failure |
| POST | `/api/v1/admin/orders/:id/fulfill` | Reuse T19 fulfillment |

Do not create duplicate endpoints for the existing T14-T19 business operations. All new route handlers must mount behind the existing ADMIN router middleware.

## 3. Order list

### 3.1 Query contract

Keep existing strict query fields: `search`, `orderNo`, `productName`, `customer`, `kind`, `paymentStatus`, `fulfillmentStatus`, `sort`, `page`, `pageSize`. Add ADMIN-only optional `productType=SUBSCRIPTION|ONE_TIME`, filtered against immutable `Order.productTypeSnapshot`; do not filter by today's Product.type.

- `search`: trimmed max 254; order number OR frozen product name OR customer username/loginEmail/adminLabel.
- `orderNo`: partial order number, max 40.
- `productName`: partial productNameSnapshot, max 120.
- `customer`: ADMIN-only partial username/loginEmail/adminLabel, max 254.
- `kind`: INITIAL / ONE_TIME / RENEWAL.
- `productType`: SUBSCRIPTION / ONE_TIME, based on productTypeSnapshot.
- `paymentStatus`: existing enum UNPAID / PENDING_VERIFICATION / PAID / REFUND_PENDING / REFUNDED / NOT_REQUIRED.
- `fulfillmentStatus`: existing enum NOT_STARTED / PROCESSING / COMPLETED / FAILED / CANCELLED.
- `sort`: asc / desc by createdAt; default desc; UUID ascending tie-breaker.
- `page`: default 1, max 10000; `pageSize`: default 20, max 100.
- All supplied filters combine with AND; repeated/unknown/nested query fields are rejected by the existing strict schema.

Keep `hidden=false` in every list/detail/events database predicate. List all visible orders, including legacy or currently unsupported order kinds; do not silently remove them. Hidden SYSTEM_RENEWAL rows remain excluded by the existing predicate.

### 3.2 Status tabs and mapping

The primary status tabs are server-side query presets. Product type/kind and text search remain independent filters that combine with the selected tab.

| UI tab | Query mapping |
|---|---|
| 全部 | no status predicate |
| 待付款 | `paymentStatus=UNPAID` |
| 待核实付款 | `paymentStatus=PENDING_VERIFICATION` |
| 待履约 | `fulfillmentStatus=PROCESSING` |
| 已完成 | `fulfillmentStatus=COMPLETED` |
| 已取消 | `fulfillmentStatus=CANCELLED` |
| 已退款 | `paymentStatus=REFUNDED` |

IMPORTANT: 待履约 is based on `fulfillmentStatus=PROCESSING`, not `paymentStatus=PAID`; this must include zero-price `NOT_REQUIRED + PROCESSING` orders. Payment and fulfillment remain separate columns and separate filters.

List columns: product snapshot name + order number/kind; customer display name + masked login email; createdAt in AppSettings.timezone; amountFen; payment status; fulfillment status; detail action. Show the total and server pagination. Do not derive status from a single combined mock enum.

## 4. Order detail and safe event timeline

### 4.1 Detail resource

Reuse `GET /api/v1/admin/orders/:id` and the explicit ADMIN order DTO. Extend it with `linkedSubscription` (nullable minimal summary) resolved from the order's `sourcedSubscription` for an INITIAL order or its `subscription` relation for a renewal order:

```json
{
  "linkedSubscription": {
    "id": "uuid",
    "sourceType": "ORDER",
    "status": "ACTIVE",
    "version": 1,
    "productNameSnapshot": "Example subscription",
    "startedAt": "2026-11-20T10:00:00.000Z",
    "expiresAt": "2026-12-20T10:00:00.000Z"
  }
}
```

Only return the fields above. Do not include subscription formData, formSchemaSnapshot, targetIdentifier, account credentials, event JSON or audit data in this expansion. ONE_TIME and not-yet-fulfilled INITIAL orders return NULL.

Keep payment and refund evidence as separate existing paginated endpoints. Do not turn order detail into an unbounded transaction/event expansion.

### 4.2 OrderEvent endpoint

New endpoint:

`GET /api/v1/admin/orders/:id/events?page=1&pageSize=20`

- Require ADMIN and visible order (`hidden=false`); missing, hidden or malformed IDs use existing safe errors.
- Strict query: page positive integer default 1 max 10000; pageSize default 20 max 100.
- Query only OrderEvent rows for the order; order by createdAt DESC then id ASC.
- Join actorAdmin and actorUser only to construct a display label. ADMIN label: adminLabel → username → loginEmail prefix. USER label: username → loginEmail prefix. SYSTEM label: 系统.
- Return `{items,total,page,pageSize}`.

Each item is a purpose-built DTO:

```json
{
  "id": "uuid",
  "eventType": "NOTE",
  "operation": "ORDER_EDITED",
  "actorType": "ADMIN",
  "actorDisplayName": "Operator",
  "createdAt": "2026-11-20T10:00:00.000Z",
  "note": "price adjustment reason",
  "summary": {
    "versionBefore": 2,
    "versionAfter": 3,
    "paymentStatusBefore": "UNPAID",
    "paymentStatusAfter": "UNPAID",
    "fulfillmentStatusBefore": "NOT_STARTED",
    "fulfillmentStatusAfter": "NOT_STARTED"
  }
}
```

`operation` is extracted only from a strict allowlist of known operation markers (for example ORDER_EDITED, PAYMENT_FAILED, REFUND_FAILED, ORDER_INTERNAL_NOTE_UPDATED); do not reflect arbitrary JSON values. `summary` is reconstructed from a per-event-type allowlist: version/status/amount deltas, transaction ID/kind/amount/channel/status, fulfilledAt/subscriptionId, cancelledAt, and for ORDER_INTERNAL_NOTE_UPDATED only, `internalNoteBefore` and `internalNoteAfter`. Unknown or malformed JSON fields are omitted. Never return raw `fromStateJson`, `toStateJson`, Prisma rows, AdminAuditLog or OrderRevision. The timeline may show the event's existing `note` field; render it as plain text, never HTML.

Do not add any OrderRevision GET/list/compare/restore endpoint or UI. D41 remains active.

## 5. Internal-note mutation (D92)

New endpoint:

`PATCH /api/v1/admin/orders/:id/internal-note`

Strict request:

```json
{
  "expectedVersion": 3,
  "internalNote": "Customer requested priority handling"
}
```

- `expectedVersion`: required positive 32-bit integer.
- `internalNote`: required key; accepts string or NULL. Trim leading/trailing whitespace; empty string becomes NULL; maximum 2000 characters.
- Reject unknown keys. Require Idempotency-Key and use the existing actorUserId-scoped mutation helper.
- ADMIN only. Derive actor from persisted Session.
- Order must be visible (`hidden=false`) and source USER or ADMIN. SYSTEM_RENEWAL remains immutable and is not editable through this route.
- Note updates are allowed regardless of ordinary order payment/fulfillment terminal status, including PAID, COMPLETED, CANCELLED, REFUND_PENDING and REFUNDED. They never reopen or otherwise change the order lifecycle.
- If normalized value equals current `internalNote`, return 400 NO_CHANGES with no writes.

One transaction:

1. Idempotency replay check before current-state validation.
2. Lock Order `FOR UPDATE`; load explicit revision/admin DTO select; verify visible ordinary source and expectedVersion.
3. Update only `internalNote`, `version=version+1`, and `updatedAt=UTC_TIMESTAMP(3)` using conditional `WHERE id/version/hidden/source`.
4. Re-read persisted Order; create exactly one complete immutable OrderRevision V1 snapshot with actorType=ADMIN, actorUserId=current admin and reason=NULL.
5. Create exactly one existing `NOTE` OrderEvent with actorType/actorAdminId=ADMIN, `fromStateJson={operation:'ORDER_INTERNAL_NOTE_UPDATED',version:oldVersion,internalNote:oldValue}` and `toStateJson={operation:'ORDER_INTERNAL_NOTE_UPDATED',version:newVersion,internalNote:newValue}`. Do not put the full 2000-character note in OrderEvent.note; use note=NULL.
6. Create exactly one AdminAuditLog with action=ORDER_INTERNAL_NOTE_UPDATED, entityType=Order, entityId=order.id, requestId, and exact safe beforeJson/afterJson matching the old/new note state. Audit reason may be NULL.
7. Save exact `{order}` ADMIN DTO response in IdempotencyRecord and commit.

Any failure rolls back the Order update, version, Revision, Event, Audit and idempotency row. Same actor/key/intent replays exact response; same key/different intent returns IDEMPOTENCY_CONFLICT. Stale version returns VERSION_CONFLICT. The CUSTOMER order DTO must continue to exclude internalNote, and no CUSTOMER note route exists.

## 6. Create and edit workflows

### 6.1 Create order

Add a 新建订单 action to `/admin/orders`; reuse existing APIs and UI components:

1. Remote-search/select a CUSTOMER through existing ADMIN customer APIs. Accept ACTIVE and PENDING_ACTIVATION only; reject DISABLED/non-CUSTOMER as server already does.
2. Remote-search/select a Product through existing ADMIN product APIs. Accept unarchived products regardless of listed state; never allow archived products.
3. Render `Product.formSchema` with existing `ProductFormInputs.vue`; require a complete valid formData object. Follow D31: do not solicit passwords, OTPs, 2FA/recovery codes, session cookies or payment credentials.
4. Show frozen-at-create product information and `priceFen`; prefill final amountFen with priceFen but explicitly submit amountFen. Any difference requires priceAdjustmentReason. Allow zero price per D64.
5. Optional internalNote follows D49, max 2000, separate from formData.
6. Submit POST `/api/v1/admin/orders` with a fresh Idempotency-Key. On HTTP 201, insert/refresh list and open the created order detail.

### 6.2 Edit order

Reuse PATCH `/api/v1/admin/orders/:id` and D60-D64. Show edit only when the server-side T15 eligibility applies (ordinary visible order, unpaid/unstarted, no payment facts, before original 24-hour deadline, and non-NULL frozen form schema). Render the frozen `formSchemaSnapshot`, not today's Product schema. CUSTOMER-only edit is not part of T20. internalNote is never part of the core edit payload; use section 5.

## 7. Cancellation and payment workflows

Reuse T16/T17 exactly; do not duplicate or weaken their validation.

- Cancellation: ADMIN reason required, max 500. Expose only when the current order state is cancellable. Paid cancellation transitions to CANCELLED + REFUND_PENDING and preserves the confirmed PAYMENT. Zero-price cancellation preserves NOT_REQUIRED and creates no refund. Pending verification cancellation closes PENDING PAYMENT attempts according to T16.
- Payment evidence panel: show all PAYMENT attempts from T17 GET, including PENDING/CONFIRMED/FAILED, amount, channel, occurredAt, externalReference and note in the ADMIN-only surface.
- Register payment: allow multiple attempts as D74 permits; collect actual amount, channel, occurredAt, optional externalReference/note. A mismatch can be recorded but must be visibly marked unverified and cannot be confirmed.
- Confirm payment: only after external full receipt is checked. If any other PAYMENT remains PENDING, disable confirmation with a clear explanation and keep the server's 409 as final guard. On confirmation show PAID + PROCESSING.
- Fail payment: require a nonblank reason max 500; preserve original transaction evidence.
- Payment registration/confirmation remains constrained by the original 24-hour deadline. Do not extend it or accept late confirmation.

Never expose direct state-edit controls for paymentStatus or fulfillmentStatus.

## 8. Refund and fulfillment workflows

### 8.1 Refund

Reuse T18:

- Refund section appears only for CANCELLED + REFUND_PENDING ordinary orders.
- Before registration, UI text must state that the ADMIN must already have initiated the external full refund; registration only records a PENDING attempt and is not success.
- Amount is fixed to the original confirmed PAYMENT amount; channel is fixed to the original PAYMENT channel. The UI must not allow alternate amount/channel selection.
- Collect actual refund occurredAt, optional externalReference and note.
- PENDING refund can be confirmed only after the customer actually receives the full refund; or marked FAILED with mandatory reason max 500.
- FAILED attempts remain visible and immutable; allow a new registration only after the previous PENDING is closed and no CONFIRMED refund exists.
- REFUNDED appears only after T18 confirmation. No direct refund from PAID + PROCESSING; first use T16 cancellation.

### 8.2 Fulfillment

Reuse T19:

- Show fulfillment action only for eligible ordinary INITIAL/ONE_TIME orders in PAID + PROCESSING or NOT_REQUIRED + PROCESSING.
- Both paid and zero-price orders are eligible; do not exclude NOT_REQUIRED from the queue.
- Optional fulfillmentNote max 500.
- INITIAL success completes order and creates one sourceType=ORDER Subscription; show the minimal linkedSubscription summary returned by detail.
- ONE_TIME success completes order without Subscription.
- No fulfillment FAILED action/state; unable to deliver means T16 cancellation and, for paid orders, T18 refund.
- RENEWAL/SYSTEM_RENEWAL and unsupported legacy states are read-only in T20.

## 9. State-driven action matrix

| Order state | Available business actions (subject to original server checks) |
|---|---|
| UNPAID + NOT_STARTED | Edit while T15 deadline/eligibility remains; register payment; cancel; edit internal note |
| PENDING_VERIFICATION + NOT_STARTED | Register another payment attempt; fail a PENDING attempt; cancel; edit internal note |
| PAID + PROCESSING | Fulfill; cancel (moves to REFUND_PENDING); payment evidence read; edit internal note |
| NOT_REQUIRED + PROCESSING | Fulfill; cancel without refund; edit internal note |
| CANCELLED + REFUND_PENDING | Register refund when no PENDING/CONFIRMED attempt exists; confirm/fail the PENDING refund; edit internal note |
| CANCELLED + REFUNDED | Read-only lifecycle; edit internal note |
| COMPLETED | Read-only lifecycle; edit internal note |
| CANCELLED + UNPAID/NOT_REQUIRED | Read-only lifecycle; edit internal note |
| Hidden, SYSTEM_RENEWAL, unsupported RENEWAL or inconsistent legacy state | No lifecycle mutation actions; only details where visible, and internal note only for visible USER/ADMIN source |

The UI is advisory only. The backend's existing strict DTO, role checks, row locks, expectedVersion, idempotency and transaction predicates remain authoritative.

## 10. Frontend architecture and request handling

- Keep the existing Vue 3 + TypeScript + Element Plus + `@lucide/vue` stack and current AdminLayout/navigation. Update `AdminLayout.vue`'s persistent-page detection so `/admin/orders` is marked LOCAL/API-backed; keep `/admin` overview marked MOCK and change the demo notice copy so it no longer claims the order page is Mock.
- Replace the Mock data path in `frontend/src/views/account/Orders.vue` only for the ADMIN route; do not change CUSTOMER orders in this task.
- Add a dedicated typed `frontend/src/api/orders.ts` module for list/detail/events/payment/refund and mutation request/response types. Reuse the existing `api()` client and its same-origin credentials, CSRF and Idempotency-Key behavior.
- Create focused ADMIN components as needed (list/filter, detail, create/edit, payment/refund/fulfillment actions); reuse `ProductFormInputs.vue`, existing date/time helpers and format utilities.
- Do not import or read `mock`/`CURRENT_USER` from the ADMIN order route. Keep Mock overview and customer-order placeholder unchanged.
- Maintain one request context per mutation: canonical request body + Idempotency-Key. Network timeout/unknown response retries must reuse the same body and key; never generate a new key for a retry. A changed payload gets a new key. Do not persist raw formData/payment evidence in localStorage/sessionStorage merely to preserve a key.
- On a 409 VERSION_CONFLICT, reload detail and related lists and ask the ADMIN to review; never auto-reapply the old payload against the new version.
- After success, refresh list/counts, detail, payment/refund attempts, events and linkedSubscription as applicable.
- Display dates in current AppSettings.timezone; API timestamps remain UTC ISO-8601. Money is integer fen and formatted by existing helpers.

## 11. Responsive UI

Desktop: retain the existing sidebar console; use a data-focused table with product/order, customer, createdAt, amount, payment, fulfillment and detail action. Keep filters and search above the table; pagination below.

Mobile/tablet: keep the existing responsive AdminLayout navigation; allow the order table to scroll horizontally. Order detail opens as a full-screen sheet/dialog; forms become one-column; action buttons wrap without obscuring status/evidence. Preserve safe-area and existing design tokens.

## 12. Security and privacy

- ADMIN Session/role/CSRF/no-store/rate-limit middleware remains mandatory for all routes.
- Hidden orders remain excluded in list, detail and events. Never expose hidden override query parameters.
- CUSTOMER never receives internalNote, event timeline, payment/refund evidence, admin creator fields or AdminAuditLog.
- Do not return raw OrderEvent JSON, OrderRevision snapshots, AdminAuditLog rows, password/token/session/invitation hashes or supplier/payment credentials.
- Customer formData is shown only through the order's frozen non-sensitive form schema. Do not render arbitrary HTML or executable content.
- Free-text reasons/notes are rendered as plain text. UI copy warns ADMIN not to enter passwords, OTPs, recovery codes or other credentials.

## 13. Testing and acceptance

Use random isolated MySQL and real HTTP requests with persisted ADMIN Sessions; no Seed. Do not read development `.env`, connect to the development DB, migrate it, or touch the original data volume.

### Backend

- ADMIN productType filter: SUBSCRIPTION/ONE_TIME, combined with search/kind/payment/fulfillment filters, pagination/count consistency, strict unknown/repeated query rejection, hidden rows excluded.
- Order detail linkedSubscription: initial ORDER subscription present after T19; null before fulfillment/ONE_TIME; minimal allowlist only; no formData/targetIdentifier.
- Event endpoint: ADMIN only, pagination/order, USER/ADMIN/SYSTEM actor labels, all known event types, safe operation/summary mapping, NOTE operation allowlist, internal note before/after summary, no raw JSON/audit/revision leakage, hidden order 404.
- Internal-note PATCH: 2000-character boundary, trim/empty/null normalization, strict body, ADMIN only, ordinary visible order only, allowed after payment/completion/cancellation/refund, rejects SYSTEM_RENEWAL, no-op no writes, stale version, same-key replay/different-intent conflict, concurrent admin update, exact before/after Event/Audit, complete Revision and fault-injection rollback at each write stage.
- Verify CUSTOMER list/detail DTOs remain unchanged and never include internalNote/linkedSubscription admin-only data/events/payment/refund evidence.

### Browser E2E — desktop and mobile

- ADMIN login → order list, search, each status tab, product type/kind filters, pagination, empty/error states.
- Create positive-price and zero-price orders for ACTIVE and PENDING_ACTIVATION customers; verify final amount/reason and frozen form.
- Open detail; verify frozen order/customer data, linked subscription summary, payment/refund evidence and event timeline.
- Edit eligible unpaid order using frozen form schema; verify stale version conflict and zero-price conversion behavior.
- Internal-note create/change/clear on unpaid, paid, completed and cancelled orders; verify event timeline shows before/after only to ADMIN.
- Payment registration → confirm; mismatched attempt → cannot confirm; multiple PENDING attempts → close others first; fail requires reason.
- Paid order cancellation → REFUND_PENDING → refund registration → confirm; separate FAILED refund → new attempt retry. Never allow refund directly from PAID + PROCESSING.
- Zero-price NOT_REQUIRED order appears in 待履约 and can be fulfilled; zero-price cancel creates no refund.
- INITIAL fulfillment creates linked ORDER subscription; ONE_TIME fulfillment does not.
- System renewal/unsupported renewal and inconsistent legacy state show read-only actions.
- CUSTOMER login cannot access ADMIN page or any ADMIN-only event/payment/refund/internal-note endpoint.

### Regression and quality

- Re-run relevant T14-T19 isolated DB suites and existing admin product/customer/subscription regression.
- Desktop/mobile E2E for T20 flows.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run db:validate`, `git diff --check`.
- No Prisma Schema or migration change is expected. If a trigger/constraint prevents D92's versioned note update, stop and report the exact blocker; do not add a migration or bypass immutable protections.

## 14. Explicit non-goals

- CUSTOMER order UI/API integration.
- Replacing Mock overview/dashboard data.
- Public storefront catalog/checkout or online payment provider integration.
- Supplier APIs, automated fulfillment, SMTP/email or notifications.
- Renewal order creation/renewal fulfillment/SYSTEM_RENEWAL visibility changes.
- OrderRevision browse/compare/restore or AdminAuditLog browsing.
- Refund after COMPLETED fulfillment or partial refunds.
- Production/development database deployment, Seed or data cleanup.
- New UI framework, new runtime dependency or Prisma migration.

## 15. Delivery

One T20 implementation PR targeting `main`, using an independent worktree/branch. Preserve all existing uncommitted user changes and running services. Update this document with implementation report, `docs/17`, `docs/08`, `docs/05`, `docs/04`, `docs/07` and README. Stop after pushing the PR; do not merge, deploy or start T21 without separate authorization.

## 16. Implementation report (2026-11-20)

### Delivered behavior

- ADMIN list adds frozen productType filtering; detail alone adds the minimal seven-field linkedSubscription expansion. CUSTOMER DTOs and shared mutation/list DTOs keep their existing keys.
- New ADMIN-only event pagination reconstructs per-operation scalar summaries. Unknown/mismatched markers and malformed fields are omitted; plain-text notes and role-specific actor labels are retained. No raw JSON, Revision or audit endpoint exists.
- New internal-note mutation reuses actor-scoped idempotency and Order-first row locking. The conditional SQL touches only note/version/updatedAt, then writes one full immutable Revision, exact old/new NOTE Event and Audit, and the original response atomically. Terminal-state lifecycle fields remain unchanged; no-op returns NO_CHANGES.
- ADMIN orders are split from the unchanged customer view. Focused Vue components provide list/filter/pagination, snapshot details, create/edit, notes, payment/refund evidence and existing lifecycle actions. Existing Element Plus/form/date/money helpers are reused.
- A memory-only request context freezes the canonical body/key until a confirmed response. Uncertain responses retain the dialog for original-request retry; stale versions refresh without automatic reapplication. No order form/evidence is saved to browser storage.
- Evidence remains paginated. When one page does not contain all attempts, lifecycle controls stay disabled until explicit full-evidence review. This prevents confirming a payment based on an incomplete pending-attempt list; the backend remains the final guard.
- Date entry retains seconds/milliseconds while converting the chosen business-zone wall time to UTC through the existing business-time helper. UI warnings separate external money movement from local registration/confirmation.
- AdminLayout changes only LOCAL-page detection and Mock notice text. No header/sidebar positioning or original user layout changes are included.
- The existing credential-field policy is extracted unchanged into a browser-safe shared contract. Create/edit and snapshot rendering reject credential-collecting forms before displaying inputs; server validation remains authoritative.

### Structure and environment

No Prisma Schema, migration, dependency version or lockfile changes. All twelve committed migrations remain intact. The original shopping checkout, three layout edits, development .env, services and original MySQL volume are outside this implementation. All test writes use the existing randomly named disposable MySQL 8.4 runner and fictional fixtures; no Seed or development database connection.

### Verification record

- Node 24.13.0, existing dependencies installed with npm ci (no dependency changes); Prisma Client generated.
- Final `npm test`: backend 71/71 and frontend 15/15 (serial execution). An earlier concurrent run hit the unchanged 15-second invalid-environment subprocess budget; serial reruns passed without weakening that test. The final counts include shared credential-field policy and unusable-success-response retry coverage.
- `npm run test:db -w backend -- --admin-orders-only`: 14/14. Historical migration-twelve upgrade preserved all thirteen business tables and immutable revisions exactly, without reclassifying zero orders or fabricating payment facts. Repeat deploy had no pending migrations and schema diff passed.
- `npm run test:db -w backend -- --admin-orders-only --fresh`: 14/14. Both paths include five actual MySQL fault-injection rollback stages, real same-key/different-key concurrency, terminal notes, privacy/strict DTO assertions, and actual T19 fulfillment creating the linked ORDER subscription.
- `npm run test:e2e -w backend -- --admin-orders-only --project desktop-edge`: 9/9; the corresponding `mobile-edge` command: 9/9. Real login and HTTP/MySQL lifecycle workflows, version conflict, exact uncertain-response retry, pagination, credential-form blocking and customer isolation pass in both viewports. Screenshots were inspected for the order table and mobile layout.
- `npm run test:db -w backend -- --fulfillment-only`: 156/156 across the existing isolated T14-T19 chain: read 14, edit 19, create 15, Revision 9, subscriptions 10, cancellation 25, offline payments 25, refunds 18 and fulfillment 21. No Seed was executed. The last suite also passed the populated migration-twelve upgrade/repeat-deploy/schema-diff checks.
- `npm run test:db -w backend -- --products-only`: 11/11, including persistent dynamic forms/settings, frozen history, structured service periods, archive and authorization regression.
- `npm run test:e2e -w backend -- --creation-only auth.spec.ts products.spec.ts subscriptions.spec.ts prototype.spec.ts --project desktop-edge`: 16/16. The same mobile regression run passed 15/16; the unchanged product-type transition case exceeded its existing 30-second budget without a failed functional assertion. `npm run test:e2e -w backend -- --creation-only products.spec.ts --project mobile-edge --grep 'changing product types clears'` passed 1/1 in a separate random MySQL environment (17.0-second case). Production code, assertions and timeout were unchanged; the initial whole-suite result remains recorded as 15/16 rather than reported as a fully green run.
- Initial browser run identified hidden Element Plus checkbox inputs being targeted directly and full-workflow tests exceeding the default 30-second case budget. Tests now click visible checkbox labels and assert the actual checked state; complete workflow cases use 120 seconds. No business timeout, guard or assertion was relaxed.
- A subsequent browser run exposed two locator mismatches (failure-dialog title versus button label, and the placeholder overlay on non-filterable selects). Tests now use the actual visible title/placeholder controls. Desktop and mobile reruns passed. Initial SQL fault-injection tests also corrected an expected HTTP 500 to the existing sanitized HTTP 503 mapping, retaining complete rollback assertions; a SYSTEM fixture was corrected to have no administrator creator.

- Final serial quality gates passed: `npm run typecheck` (frontend/backend/E2E), `npm run lint`, `npm run format:check`, `npm run db:validate`, `npm run db:generate`, `npm run build` (frontend/backend), and `git diff --check`. Existing upstream Zod/Rollup annotation warnings are non-fatal; dependencies were not changed.

### Remaining review and operational limits

- PR code review and operator acceptance remain pending. No development deployment, service restart or T21 work is included.
- Mobile acceptance uses Edge with an iPhone-sized viewport, not a physical phone. The existing product-type mobile case had one whole-suite timeout, then passed unchanged in isolation; no root cause beyond that observed intermittent timeout is claimed.
- The original checkout still contains exactly its three uncommitted layout edits. All three SHA-256 values match the preflight baseline. The CUSTOMER view is byte-equivalent after line-ending normalization to the prior order view; no CUSTOMER feature was added.
- The original MySQL container remains running/healthy on its existing volume. Development database content was not queried or changed. All random test containers/volumes were removed by their runner; local logs/screenshots are ignored.

### Changed files

- Backend: `backend/scripts/test-database.ts`; `backend/src/contracts/credential-fields.ts`; `backend/src/modules/orders/{center-schemas,create-form,events,internal-note,routes,schemas,service}.ts`; `backend/test/order-center.test.ts`; `backend/test/integration/{admin-order-center,orders}.test.ts`.
- Frontend: `frontend/src/api/orders.ts`, `orders.test.ts`; `frontend/src/layouts/AdminLayout.vue`; `frontend/src/views/account/{Orders,CustomerOrders}.vue`; `frontend/src/views/admin/orders/{OrderAction,OrderCenter,OrderDetail,OrderForm}.vue`, `state.ts`, `state.test.ts`; `frontend/tsconfig.json` (no-emit TypeScript imports for the shared contract).
- Browser tests: `e2e/admin-order-center.spec.ts`, `e2e/prototype.spec.ts` (the obsolete ADMIN Mock-order workflows are replaced by real API tests; CUSTOMER prototype behavior is retained).
- Documentation: `README.md`; `docs/{04-data-model,05-api-contract,07-development-roadmap,08-interface-specification,16-order-read-api,17-order-creation-and-lifecycle-design,25-admin-order-center}.md`; `docs/superpowers/plans/2026-11-20-admin-order-center.md`.

The scoped implementation contains 35 files. Generated output, test logs, screenshots, dependencies and local configuration are not committed.
