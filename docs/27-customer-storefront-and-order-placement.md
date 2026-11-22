# T22 — Customer storefront and offline order placement

- Document: CUSTOMER-STOREFRONT-AND-ORDER-PLACEMENT
- Version: 1.0
- Status: Design approved in PR #32. T22.1 merged in PR #33. T22.2 merged in PR #34. T22.3A merged in PR #35. T22.3B implemented and awaiting review. T22 is complete after the final PR is merged and verified.
- Date: 2026-11-20
- Related: [Product requirements](01-product-requirements.md), [User and operations flows](02-user-and-operations-flows.md), [API contract](05-api-contract.md), [Interface specification](08-interface-specification.md), [Order lifecycle decisions](17-order-creation-and-lifecycle-design.md), [Order creation API](19-order-creation-api.md), [Customer order center](26-customer-order-center.md)

> Sections 1–11 record the approved T22 design. Sections 12–14 record the public catalog, protected purchase form, and customer order API upgrade with their verification.

## 1. Goal and boundary

Turn the existing ADMIN-only product preview into a customer-facing storefront where any visitor can browse available products, while only an ACTIVE CUSTOMER can enter the purchase flow and create an ordinary order.

T22 is a storefront and offline-order-placement task. It reuses the existing product model, dynamic form contract, customer authentication, customer order creation API, order lifecycle, and T21 order detail/payment-guidance experience.

### In scope

- Public, read-only product catalog and product detail pages.
- Public list filtering, search, and server pagination.
- Product detail without exposing or loading the dynamic form schema.
- A customer-only purchase route that loads the current product form after the customer clicks 立即购买.
- Login continuation: a visitor who clicks 立即购买 is returned automatically to the same purchase route after a successful customer login.
- Dynamic form rendering and validation using the existing eight-field-type contract and ProductFormInputs component.
- Customer order creation through the existing POST /api/v1/customer/orders.
- A stale-product guard so a changed price or form cannot silently produce an order different from the purchase page the customer reviewed.
- Navigation to the existing T21 order detail after successful creation.
- Desktop/mobile browser and API regression coverage.

### Explicit non-goals

- Online payment, payment intents, provider SDKs, payment callbacks/webhooks, settlement, or money movement.
- Payment proof upload or a customer "I have paid" mutation.
- Cart, multi-product orders, quantity editing, coupon codes, stored value, or discounts.
- Customer self-registration. Existing invitation activation and customer login remain unchanged.
- Customer subscription center, customer renewal, or subscription mutations.
- Customer refund requests or payment/refund evidence reads.
- Supplier API, supplier email, SMTP, notifications, or automated fulfillment.
- Administrator order center, dashboard, or product-management redesign.
- Database migration, new runtime dependency, development database migration, or deployment.

## 2. Approved customer journey

1. A visitor opens / and browses the public catalog without signing in.
2. The visitor opens /products/:slug and reviews the product description, type, price, service period, and renewal price where applicable.
3. The product detail page does not request, render, or disclose formSchema.
4. The visitor clicks 立即购买.
   - If not authenticated, navigate to /login?redirect=/purchase/:slug.
   - If an ACTIVE CUSTOMER is already authenticated, navigate directly to /purchase/:slug.
5. After successful CUSTOMER login, the existing login flow validates the same-origin purchase redirect and automatically returns to /purchase/:slug. The purchase page then loads the authenticated purchase projection and dynamic form.
6. The customer completes the required non-sensitive fields, reviews the product/price summary, and submits once.
7. The server validates the current product, submitted form, customer status, and idempotency key, then creates the ordinary order using the existing atomic order-creation service.
8. On success, navigate to /account/orders?orderId=:id. T21 loads the customer's own order detail and opens it automatically. Positive-price orders show the existing T21 offline payment instructions when eligible; zero-price orders show NOT_REQUIRED and proceed to the existing fulfillment workflow.

No order draft is created before the final POST. Incomplete form values remain in browser memory only and are not persisted by T22.

## 3. Public catalog API

All public catalog endpoints are GET-only and require no Session. They return only products satisfying both:

- listed = true
- archivedAt IS NULL

Unlisted, archived, and missing products are indistinguishable to public detail requests and return the same 404 product-not-found response. Public query parameters cannot override these eligibility predicates.

### 3.1 GET /api/v1/catalog/products

Strict query allowlist:

| Parameter | Rule |
|---|---|
| search | Optional trimmed text, maximum 120 characters; matches product name |
| type | Optional SUBSCRIPTION or ONE_TIME |
| page | Integer 1–10000, default 1 |
| pageSize | Integer 1–100, default 20 |

Unknown query parameters are rejected. Filters are AND-combined. Ordering is deterministic: sortOrder ASC, createdAt ASC, id ASC. The response is server-paginated and has the shape {items,total,page,pageSize}.

### 3.2 GET /api/v1/catalog/products/:slug

Returns one public product projection only when the product is listed and unarchived. An archived, unlisted, or missing slug returns the same 404 response.

### 3.3 Public product projection

Both public list and detail use an explicit allowlist:

| Field | Purpose |
|---|---|
| slug | Stable customer-facing route identifier |
| name | Product title |
| description | Customer-facing description |
| type | SUBSCRIPTION or ONE_TIME |
| priceFen | Initial selling price in integer CNY fen |
| renewalPriceFen | Renewal price for subscription products; null for ONE_TIME |
| termLabel | Human-readable service term |
| coverImageUrl | Same-origin public cover URL when configured, or null (T24.5B) |
| servicePeriodUnit | DAY, MONTH, YEAR, or null for ONE_TIME |
| servicePeriodCount | Positive integer or null for ONE_TIME |

Never return formSchema, form defaults, targetField, listed, archivedAt, sortOrder, createdAt, updatedAt, supplier/internal data, or audit information from public catalog endpoints. The public API does not return an admin Product DTO and does not expose product form fields or options.

## 4. Authenticated purchase-product API

### GET /api/v1/customer/products/:slug

Requires a persisted, valid, ACTIVE CUSTOMER Session. The existing /customer role middleware is authoritative. ADMIN, unauthenticated, expired, revoked, disabled, and pending-activation accounts cannot use this endpoint as a customer purchase route.

The product must still be listed and unarchived. Missing, unlisted, and archived products return 404. The server re-reads the current database product; the frontend never treats a previously cached public product as authoritative purchase data.

The response contains the public product fields plus:

- id: Product ID used by the existing order creation POST.
- updatedAt: exact UTC ISO-8601 timestamp with millisecond precision, used by the stale-product guard.
- formSchema: a customer-safe form projection.

### 4.1 Customer-safe form projection

The customer purchase projection contains schema version and ordered fields. Each field may expose only:

- id
- type
- label
- required
- hint
- options, only for select, radio, and checkbox fields

Do not return defaultValue. Product defaults are an administrator form-editor/preview convenience, not customer-submission data and not an instruction to prefill customer answers.

All eight existing field types remain supported: text, email, textarea, number, date, select, radio, and checkbox. Preserve field order and stable IDs. The frontend renders labels/hints/options as text; it must not use v-html, eval, dynamic code execution, or HTML supplied by product configuration.

Before returning the schema, the service validates it against the shared product-form contract and applies the shared credential-field policy. If a legacy/malformed schema is invalid or contains a prohibited credential field, do not return the unsafe schema or silently remove a required field; return 409 PRODUCT_FORM_UNAVAILABLE and leave the product unavailable for customer self-purchase until an administrator fixes its configuration. The existing order-creation service remains the final server-side validation authority and rejects prohibited credential values as well as prohibited field definitions.

## 5. Frontend routes and login continuation

| Route | Access | Behavior |
|---|---|---|
| / | Public | Catalog list |
| /products/:slug | Public | Product detail, no dynamic form |
| /purchase/:slug | ACTIVE CUSTOMER | Fetch purchase projection and render the form |
| /login?redirect=/purchase/:slug | Public | Customer login, then return to the purchase route |

The route guard protects /purchase/:slug. A direct unauthenticated visit redirects to customer login with the original fullPath. An authenticated non-CUSTOMER (including ADMIN) is redirected away from the customer purchase route; the administrator continues to create orders through /admin/orders.

After login, the client may honor only a validated same-origin internal redirect. Add the purchase route to the CUSTOMER redirect allowlist using a strict path/slug match. Do not accept arbitrary absolute URLs, protocol-relative URLs, backslash variants, or unrecognized paths. Existing safe redirects for /profile, /orders, /account/orders, and /subscriptions remain unchanged.

A visitor who clicks 立即购买 must not be asked to click it a second time after login. The purchase page loads the form only after the successful login redirect reaches the protected purchase route.

## 6. Purchase page behavior

### 6.1 Product summary

Show the current product name, description, type, price, term, and renewal price where applicable. Price is display-only; the customer cannot submit or override amountFen. The summary and form come from the same authenticated purchase-product response.

### 6.2 Dynamic form

Reuse ProductFormInputs.vue and the existing shared form contract. Do not build a second field renderer.

- Render only after the customer has entered the purchase route and the authenticated purchase-product GET has succeeded.
- Initialize customer input state as empty; do not apply administrator defaultValue values.
- Validate required values and field-specific constraints in the browser for usability.
- The server repeats all validation against the current Product.formSchema inside the order-creation transaction.
- Reject prohibited credential field definitions and recognizable credential values. Do not collect passwords, OTPs, 2FA codes, recovery codes, session cookies, API keys, private keys, payment credentials, or other authentication secrets.
- Do not persist incomplete drafts or form values to localStorage, sessionStorage, URL query strings, analytics, logs, or audit records.
- On navigation away before successful order creation, discard the in-memory form state.

### 6.3 Review and submit

The page shows a final product/price summary and a clear confirmation action. There is one product per order; no cart or quantity selector is introduced.

The frontend submits only productId, expectedProductUpdatedAt, and formData, plus the required Idempotency-Key header and existing CSRF headers. It must not submit userId, source, amountFen, payment/fulfillment status, order snapshots, or creator identity.

Disable duplicate clicks while a request is in flight. Reuse the existing OrderRequest idempotency/retry behavior or an equivalent exact-body/key mechanism: an uncertain network/response result must replay the same request body with the same key. A changed form or refreshed product version is a new intent and must use a new key.

## 7. Customer order creation integration

### 7.1 POST /api/v1/customer/orders

T22 reuses the existing customer order creation route and atomic service. The forward customer request contract becomes:

- productId: ID from the authenticated purchase-product response.
- expectedProductUpdatedAt: the exact updatedAt value returned by that same response.
- formData: complete normalized form data.

Idempotency-Key remains required. ADMIN POST /api/v1/admin/orders is unchanged.

The service continues to derive the customer ID and source from Session, lock User then Product, verify ACTIVE account status, validate the current listed/unarchived product, validate structured service periods, validate complete formData, derive amountFen from the locked Product.priceFen, freeze all order/product/form snapshots, and commit Order + V1 Revision + Event + idempotency response atomically. USER actions do not create AdminAuditLog rows.

Positive-price products create UNPAID + NOT_STARTED orders. A product whose actual selling price is zero uses the already-implemented NOT_REQUIRED + PROCESSING behavior; no PaymentTransaction, paidAt, or paymentConfirmedAt is fabricated. T19 fulfillment rules remain unchanged.

### 7.2 Stale-product guard

The purchase-product GET returns Product.updatedAt. The POST must include that exact value as expectedProductUpdatedAt.

After the existing idempotency lookup and after acquiring the Product row lock, compare expectedProductUpdatedAt with the locked Product.updatedAt at database precision. Also recheck listed and archivedAt eligibility. If the timestamp differs, or the product is no longer available, reject with 409 PRODUCT_CHANGED or the existing safe product-unavailable error, with no Order, Revision, Event, or idempotency success response written.

Include expectedProductUpdatedAt in the canonical request intent/hash. An exact same-key retry of a previously committed request must replay the original successful response before revalidating a later Product edit, preserving the existing D33-D35 semantics.

When PRODUCT_CHANGED is returned, the frontend must not automatically resubmit. Reload the purchase-product response, discard the old form draft, show that the product information changed, and require the customer to review the latest price and form before submitting a new intent with a new key.

The comparison is protected by the existing Product row lock: a concurrent ADMIN edit/archive waits for the order transaction, or the customer observes the committed newer Product and receives the conflict. No new database column or migration is required; Product.updatedAt already exists and is updated by the current product service.

### 7.3 Response and navigation

The existing creation response remains HTTP 201 {order}, with the complete CUSTOMER-safe order DTO. Same-key retries return the exact original response. Do not change the response into an order ID-only envelope.

On success, navigate to /account/orders?orderId=<created order id>. T22 extends the T21 customer order page to read this optional query parameter and open the existing detail dialog for that ID. The detail must be loaded through GET /api/v1/customer/orders/:id, which remains the authority for ownership and hidden-order 404 behavior. Closing the dialog removes the orderId query parameter. A forged or foreign ID reveals no data and follows the existing 404 behavior.

The T21 detail then displays the existing order status, countdown, and eligible plain-text payment instructions. T22 does not duplicate payment guidance or introduce a new order-detail API.

## 8. Security, privacy, and operational rules

- Public routes are GET-only and expose the public product allowlist.
- Customer purchase-product GET and order POST require an ACTIVE CUSTOMER Session and existing CSRF/session protections where applicable.
- Never trust productId alone as proof of current availability; lock and re-read Product in the order transaction.
- Never trust priceFen or amountFen from the browser. The server derives the customer price.
- Never accept customer-supplied userId, source, actor, statuses, timestamps, or snapshot fields.
- Unlisted/archived product state must not be exposed through public DTOs.
- Customer order data is never included in public catalog responses.
- Form schemas and submitted values are not logged. Existing audit/event behavior remains minimized and unchanged.
- No public self-registration or account activation behavior is added.
- All test databases must be random isolated MySQL 8.4 projects with no Seed unless a task-specific test explicitly requires a synthetic fixture. Never read the development .env, connect to or mutate the development database, or touch the original MySQL volume.
- No deployment, service restart, or development migration is part of T22.

## 9. Responsive UI

Desktop:
- Three-column product grid at typical desktop widths, consistent with docs/08.
- Product detail uses a concise information column and a clear primary purchase action.
- Purchase form stays in a readable single-column form region with a visible product/price summary.

Mobile:
- Single-column compact catalog cards.
- Product detail and purchase form use full-width layout.
- Primary purchase/submit action remains visible without covering fields or content.
- Preserve existing mobile navigation and safe-area behavior.
- Avoid horizontal overflow and retain keyboard-friendly labels/focus behavior.

Use the existing Vue 3, TypeScript, Element Plus, icons, shared form component, and visual tokens. Do not introduce another UI framework or a new form library.

## 10. Testing and acceptance

### Public catalog/API

- Unauthenticated list/detail returns only listed, unarchived products.
- Unlisted, archived, and missing slugs do not disclose product existence through different public responses.
- Strict search/type/page/pageSize behavior and deterministic pagination.
- Public DTOs never include formSchema/defaultValue, targetField, archive/listing flags, admin data, or internal fields.
- CUSTOMER purchase GET requires ACTIVE CUSTOMER Session and returns the safe schema projection without defaults.
- ADMIN, unauthenticated, disabled, expired/revoked, and pending sessions cannot read the customer purchase projection.

### Purchase and login flow

- Guest can browse catalog and detail without loading formSchema.
- Guest clicking 立即购买 is redirected to login with the exact purchase destination.
- Successful CUSTOMER login returns to the same purchase page and loads the form automatically.
- Direct purchase-route access is guarded; ADMIN cannot use customer checkout.
- Product form displays only after the authenticated purchase GET; all eight field types and validation work.
- Credential field schemas are not returned and cannot be submitted.

### Order creation

- Customer POST uses the authenticated Session, current Product price, complete formData, frozen snapshots, and existing actor-scoped Idempotency-Key.
- Client-supplied price/user/status/source/snapshot fields are rejected.
- Stale Product.updatedAt returns 409 with no business writes; concurrent product edit/archive follows the row-lock contract.
- Exact same-key/same-body retry replays the original order; same key with changed body conflicts; different key may create a new order.
- Zero-price order uses NOT_REQUIRED + PROCESSING and has no fake payment facts.
- Success returns the complete CUSTOMER DTO and navigates to the T21 detail through orderId.
- T21 detail enforces own-order visibility and displays payment guidance only under D105 eligibility.

### Browser and regression

- Desktop Edge and mobile Edge E2E for public catalog, product detail, guest login continuation, purchase form, submit, and order-detail navigation.
- T20 administrator order center and T21 customer order center regressions remain green.
- Authentication, product/settings, order creation, order read, edit, cancellation, payment, refund, and fulfillment regression suites pass.
- Unit tests, typecheck, lint, format check, build, Prisma schema validation, and git diff --check pass.
- No test may use or mutate the development database or original MySQL volume. Mobile viewport emulation must be described as emulation, not a physical-device test.

## 11. PR #32 design delivery boundary

This PR is documentation-only. It creates the T22 design baseline and synchronizes existing contracts/roadmap. It must not modify application source, Prisma Schema, migrations, dependencies, environment files, test fixtures, or deployment configuration.

After this design PR is reviewed and merged, stop and wait for separate owner authorization before assigning the T22 implementation to Codex. The implementation should be split into reviewable tasks only after the approved document baseline is on main.

## 12. T22.1 implementation report

- Guests can call the two public catalog GET endpoints. Both queries apply listed=true and archivedAt=null and select only the nine fields in section 3.3. The detail endpoint returns the single product object and uses one NOT_FOUND response for unavailable slugs.
- List requests validate the strict query allowlist, trim search, and treat percent, underscore, and backslash as literal search characters. Search, type, and visibility predicates are AND-combined. Count and page items use the same filter and the approved stable ordering.
- The storefront uses the public endpoints for browsing, search, type filters, pagination, and detail. The detail displays prices and the structured period when present, with termLabel as the display fallback for unknown legacy periods. In T22.1 the purchase action was disabled.
- T22.1 covered public browsing and detail. Prisma Schema, migrations, and dependencies are unchanged.

### Local verification

MySQL tests use the existing runner with unique projects, test credentials, and loopback ports. The focused modes use disposable fixtures. They do not run Seed or read the development environment. Browser results cover desktop Edge and the iPhone 13 viewport emulated in Edge.

| Command | Result |
|---|---|
| `npm test` | Frontend 24/24, backend 71/71 |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run db:validate`, `git diff --check` | Passed |
| `npm run test:db -w backend -- --catalog-only --fresh` | 6/6 real HTTP cases on MySQL 8.4 |
| `npm run test:db -w backend -- --products-only --fresh` | 11/11 product and settings cases |
| `npm run test:db -w backend -- --admin-orders-only --fresh` | 14/14 administrator order center cases |
| `npm run test:db -w backend -- --customer-orders-only --fresh` | Customer order center 3/3, authentication 14/14 |
| `npm run test:db -w backend -- --fulfillment-only --fresh` | On the aggregate rerun, read 14/14, edit 19/19, creation 15/15, revision 9/9, subscription 10/10, cancellation 25/25, payment 25/25, refund 18/18, fulfillment 20/21 |
| `npm run test:db -w backend -- --fulfillment-only --focused --fresh` | Fulfillment 21/21 in the subsequent standalone rerun, including the concurrency regression |
| `npm run test:e2e -w backend -- --catalog-only` | Desktop Edge 3/3, mobile Edge emulation 3/3 |
| `npm run test:e2e -w backend -- --admin-orders-only` | Serial rerun, desktop Edge 10/10 and mobile Edge emulation 10/10 |
| `npm run test:e2e -w backend -- --customer-orders-only` | Desktop Edge 8/8, mobile Edge emulation 8/8 |
| `npm run test:e2e -w backend -- --creation-only products.spec.ts auth.spec.ts prototype.spec.ts` | Product management, settings, authentication and navigation, desktop Edge 15/15 and mobile Edge emulation 15/15 |

The first public HTTP run was 5/6 because the new test used the wrong validation error code. The test now checks the existing 400 INVALID_INPUT contract. The rerun passed all six cases.

The first T20 browser run reached the existing 120-second Vite preview startup limit before running any scenario. The serial rerun passed both viewports with the same browser config, assertions, and timeouts.

The first order lifecycle aggregate reached the existing 600-second nested runner budget after the read, edit, creation, revision, and subscription suites passed. On rerun those suites and cancellation, offline payment, and offline refund passed 135/135 combined. Fulfillment was 20/21 because one parallel request in the existing pool regression returned HTTP 409 CONFLICT. A subsequent standalone fulfillment run passed 21/21. Its production code, assertions, and timeouts are unchanged from main.

### PR #33 review verification

- `npm run test:db -w backend -- --catalog-only --fresh` passed 6/6. The unlisted fixture has no archive timestamp, and the archived fixture is listed. The test verifies each fixture is absent from the list and its detail returns 404 NOT_FOUND.
- `npm run test:e2e -w backend -- --catalog-only` passed 4/4 on desktop Edge and 4/4 on mobile Edge emulation. The new test holds the catalog GET until it sees the loading message and releases the request in `finally`. It then verifies product cards render and the loading message clears.
- `npm run format:check`, `npm run typecheck`, and `npm run lint` passed.

## 13. T22.2 implementation report

- `GET /api/v1/customer/products/:slug` uses the existing Session and CUSTOMER role middleware. It reads a current listed, unarchived product and adds id, updatedAt, and the customer-safe form projection to the public display fields.
- The service validates the full database schema and checks for prohibited credential fields before projecting the response. The allowlist preserves the ordered field IDs, labels, hints, required flags, and applicable options. It excludes all editor defaults. Invalid forms return a sanitized 409 PRODUCT_FORM_UNAVAILABLE.
- The 立即购买 button opens the protected purchase route. Guests and expired Sessions are redirected to login with the current purchase destination. Login accepts strict internal purchase paths and the existing customer destinations. An authenticated administrator is sent to order management.
- The responsive purchase page reuses the product summary and ProductFormInputs. The shared form contract and credential detection validate answers in the browser. Answers stay in component memory and are cleared on product changes and navigation. 检查填写信息 makes no business request.
- At T22.2 delivery, order submission and order-center continuation were still planned. This slice needs no new Migration, database column, or dependency.

### T22.2 verification

The MySQL runner used disposable MySQL 8.4 projects with synthetic fixtures and random loopback database ports. The browser projects used desktop Edge and an iPhone 13 viewport emulated in Edge.

| Command | Result |
|---|---|
| `npm test` | Frontend 30/30, backend 71/71 |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run db:validate` | Passed |
| `npm run test:db -w backend -- --customer-purchase-only --fresh` | 5/5 including permissions, visibility, fresh reads, exact projections and sanitized failures |
| `npm run test:e2e -w backend -- --customer-purchase-only` | Rerun passed desktop Edge 7/7 and mobile Edge emulation 7/7 |
| `npm run test:db -w backend -- --catalog-only --fresh` | 6/6 public catalog |
| `npm run test:db -w backend -- --products-only --fresh` | 11/11 products and settings |
| `npm run test:db -w backend -- --admin-orders-only --fresh` | 14/14 T20 |
| `npm run test:db -w backend -- --customer-orders-only --fresh` | 3/3 T21 and 14/14 authentication |
| `npm run test:db -w backend -- --fulfillment-only --fresh` | 156/156 across read (14), edit (19), create (15), revision (9), subscription (10), cancellation (25), payment (25), refund (18), and fulfillment (21) |
| `npm run test:e2e -w backend -- --admin-orders-only` | T20 desktop Edge 10/10, mobile Edge emulation 10/10 |
| `npm run test:e2e -w backend -- --customer-orders-only` | T21 desktop Edge 8/8, mobile Edge emulation 8/8 |
| `npm run test:e2e -w backend -- --creation-only auth.spec.ts products.spec.ts prototype.spec.ts public-catalog.spec.ts` | Catalog, products, settings, authentication and navigation. Desktop Edge 19/19, mobile Edge emulation 19/19 |
| `git diff --check` | Passed |

On the first desktop run, the Element Plus placeholder intercepted clicks on the readonly select input. Six scenarios passed and the form scenario hit the existing 30-second test limit. The rerun opens the select with ArrowDown, following the existing browser test pattern. It verifies the selected options and the same validation outcomes with the original timeout.

## 14. T22.3A implementation report

- CUSTOMER creation requires a strict `{productId,expectedProductUpdatedAt,formData}` body. The expected timestamp is the canonical UTC timestamp with three fractional digits from the purchase GET. The ADMIN request retains its existing shape.
- The existing transaction checks the persisted idempotency record first. A first request acquires User then Product locks and reads the current product. The customer version must equal the locked row's millisecond timestamp before validation and order writes. The request hash includes the version. A stale version returns 409 PRODUCT_CHANGED and leaves Product, Order and history intact.
- A successful same-key replay returns the original response before checking whether the product is still current or orderable. A changed version with the same key conflicts. New success, Revision, Event and idempotency response commit together. Only ADMIN creates an administrator audit record.
- CUSTOMER creation, list and detail apply the T22.2 field allowlist to safe frozen forms. Unsafe-schema and credential checks still inspect the original snapshot and values. Editor defaults are removed from the customer projection. Stored Order and Revision snapshots and the ADMIN DTO retain the full schema.
- T22.3A was limited to the backend contract and did not connect the purchase confirmation. T22.3B verification is recorded below.

### T22.3A verification

The database suites use random isolated MySQL 8.4 projects and synthetic fixtures. The browser tests use desktop Edge and mobile Edge viewport emulation.

| Command | Result |
|---|---|
| `npm test` | Frontend 30/30 and backend 72/72 |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run db:validate` | Passed |
| `npm run test:db -w backend -- --creation-only --fresh` | Creation 19/19, Revision 9/9 and subscription 10/10 |
| `npm run test:db -w backend -- --fulfillment-only --fresh` | 160/160 across read (14), edit (19), create (19), revision (9), subscription (10), cancellation (25), payment (25), refund (18), and fulfillment (21) |
| `npm run test:db -w backend -- --admin-orders-only --fresh` | T20 14/14 |
| `npm run test:db -w backend -- --customer-orders-only --fresh` | T21 3/3 and authentication 14/14 |
| `npm run test:db -w backend -- --products-only --fresh` | Product and settings 11/11 |
| `npm run test:db -w backend -- --catalog-only --fresh` | T22.1 catalog 6/6 |
| `npm run test:db -w backend -- --customer-purchase-only --fresh` | T22.2 purchase projection 5/5 |
| `npm run test:e2e -w backend -- --creation-only order-creation.spec.ts order-edit.spec.ts order-cancellation.spec.ts public-catalog.spec.ts customer-purchase.spec.ts` | Desktop Edge 18/18 and mobile Edge emulation 18/18 |
| `npm run test:e2e -w backend -- --admin-orders-only` | T20 desktop Edge 10/10 and mobile Edge emulation 10/10 |
| `npm run test:e2e -w backend -- --customer-orders-only` | T21 desktop Edge 8/8 and mobile Edge emulation 8/8 |
| `git diff --check` | Passed |

Creation regression covers exact millisecond matching, the live purchase GET version, a real ADMIN price update, a competing database writer that holds the Product row lock, and rejection before business writes. It also covers version-only idempotency conflicts, replay after unlisting and archiving, simultaneous duplicates, and rollback at each applicable write stage. The CUSTOMER creation, list and detail DTOs exclude defaults while the ADMIN DTO and stored history preserve them.

All listed T22.3A commands passed on their first run. The browser creation, edit and cancellation fixtures send the required product version only for CUSTOMER creation. Their original business assertions and timeouts were retained.

## 15. T22.3B implementation report

- The purchase page uses the T22.2 protected product read, shared form controls and credential rules. It validates before review and again before confirmation. Review displays the current product quotes and configured option labels. Only confirmation sends the exact three-field POST with the product timestamp from the GET.
- A single in-memory OrderRequest owns the serialized body and UUID key. Submitting disables duplicate confirmations and form edits. A timeout, network failure, 5xx or unusable success response displays 订单结果尚未确认 and offers 重试原请求. Leaving requires confirmation and can discard the request context. My Orders can be used to verify the outcome after leaving. Session expiry returns to login for the same purchase path without automatic submission.
- PRODUCT_CHANGED clears the request and draft, reloads current terms and fields, and requires a fresh customer confirmation. A product that is no longer purchasable has no confirm action. A committed order may still be replayed with its original request and key after the product changes.
- Success replaces the purchase route with /account/orders?orderId=:id. The list and the /orders alias share URL-backed dialog selection, preserve other query parameters, and track browser history. Only one valid UUID is accepted. The detail uses the existing authenticated GET for all IDs, including ones absent from the current filtered page. Foreign, hidden and missing orders show the same 404.
- Positive orders show 待付款 and the T21 countdown and offline guidance while actionable. Zero-amount orders show 处理中 without that countdown or transfer guidance. Customer order creation generates no payment, subscription or administrator audit.
- This work is isolated on codex/t22-3b-storefront-order-placement from the PR #35 merge commit. Test fixtures use disposable MySQL 8.4 instances, synthetic accounts, and temporary credentials. The development environment and its data volume were left untouched. No backend business API, database schema, migration, dependency or deployment is included.

### T22.3B verification

All commands below ran on Node 24.13.0 in the independent worktree. The database and browser suites use the checked-in isolated MySQL 8.4 runner. Each browser project uses a separate database.

| Command | Result |
| --- | --- |
| npm test | Frontend 42/42 and backend 72/72. The 12 new checkout tests cover review, validation, the exact POST body, duplicate clicks, uncertain responses, replay, product changes and order IDs. |
| npm run test:e2e -w backend -- --customer-purchase-only | Desktop Edge 14/14 and mobile Edge 14/14. The seven existing purchase scenarios retain their coverage. The seven new scenarios cover checkout, persistence and detail authorization through real HTTP and isolated MySQL. |
| npm run typecheck | Passed for frontend, backend and E2E. |
| npm run lint | Passed. |
| npm run format:check | Passed. |
| npm run build | Frontend and backend passed. |
| npm run db:generate | Prisma Client generated. |
| npm run db:validate | Prisma Schema validated. |
| git diff --check | Passed. |

The first type checks identified missing required fields in the new test fixtures. The first desktop browser run passed 11/14. The failed cases expected trimmed text even though the shared parser preserves it, matched two simultaneous live-status messages, and omitted the subscription price snapshot from the hidden-order fixture. The next run passed 13/14 and showed that the list renders the order number alongside its kind. The final exact locator uses both parts. Both viewports then passed 14/14 with the existing timeouts.

The initial combined unit test run hit the existing 15-second child-process timeout in the backend invalid-environment test. A fresh run of npm test passed all 114 tests, with no changes to that test or its timeout.

#### Isolated MySQL HTTP/API regression

The modes in this table use `npm run test:db -w backend -- <mode> --fresh`. Results count each distinct suite once even when the runner repeated it in a parent mode.

| Mode or suite | Passed |
| --- | ---: |
| --creation-only (creation, revisions, subscriptions) | 19/19, 9/9, 10/10 |
| --orders-only (order reads) | 14/14 |
| --edit-only (order edits) | 19/19 |
| --cancellation-only | 25/25 |
| --payments-only | 25/25 |
| --refunds-only (focused rerun) | 18/18 |
| --fulfillment-only --fresh --focused | 21/21 |
| --admin-orders-only | 14/14 |
| --customer-orders-only (customer orders, authentication) | 3/3, 14/14 |
| --products-only (products and settings) | 11/11 |
| --catalog-only | 6/6 |
| --customer-purchase-only | 5/5 |

The initial refund and fulfillment aggregate commands stopped during repeated nested regression runs at the existing 600-second subprocess budget. For the refund rerun, a temporary copy of the checked-in runner enabled the same focused selector already supported for fulfillment. The selector omitted recursive suite launches and retained the original disposable MySQL setup, schema verification, refund test file and per-suite timeout. The temporary copy was removed. The already-passing prerequisite suites are reported separately. The two abandoned disposable projects were identified by their Compose project and mount labels and cleaned up individually.

The first focused fulfillment run passed 20/21. The independent-fulfillment concurrency case received three HTTP 503 responses. After the other test jobs finished, `npm run test:db -w backend -- --fulfillment-only --fresh --focused` passed all 21 cases with the original timeouts and assertions. Across the distinct API suites above, 213 cases passed.

#### Desktop and mobile browser regression

| Command | Desktop Edge | Mobile Edge |
| --- | ---: | ---: |
| npm run test:e2e -w backend -- --admin-orders-only | 10/10 | 10/10 |
| npm run test:e2e -w backend -- --customer-orders-only | 8/8 | 8/8 |
| npm run test:e2e -w backend -- --creation-only public-catalog.spec.ts auth.spec.ts products.spec.ts prototype.spec.ts | 19/19 | 18/19 initially, plus 1/1 on the focused rerun |
| npm run test:e2e -w backend -- --creation-only order-creation.spec.ts order-edit.spec.ts order-cancellation.spec.ts offline-payments.spec.ts offline-refunds.spec.ts manual-fulfillment.spec.ts | 15/15 | 15/15 |

The first T21 run showed a stale browser action. Reload now restores the dialog from the URL, so the payment guidance test verifies that the same order is open after reload before checking the cleared instructions. The assertions for plain-text rendering, countdown, visibility, timezone and cleared settings remain in place.

The existing mobile product-type change test hit its 30-second timeout in the grouped run. The same case passed in 16.4 seconds with its original assertions and timeout via `npm run test:e2e -w backend -- --creation-only --project=mobile-edge products.spec.ts --grep "changing product types clears one-time periods and requires new subscription configuration"`.
