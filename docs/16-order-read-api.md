# Order API stage 1 — lists and details

Originally implemented four role-specific list/detail endpoints for owner acceptance after merged PR #6; T20 extends the ADMIN read surface with an event timeline and minimal linked-subscription summary. T20 contract: [admin order center](25-admin-order-center.md). CUSTOMER read ownership and DTO behavior remain unchanged.

## Access and responses

All paths start with `/api/v1`. Reuse persisted Sessions and current expiry/revocation/ACTIVE-account checks. Responses use no-store and existing safe errors; no token is returned in JSON.

| Method | Path | Access / response |
| --- | --- | --- |
| GET | `/admin/orders` | ADMIN; `{items,total,page,pageSize}` |
| GET | `/admin/orders/:id` | ADMIN; `{order}` |
| GET | `/customer/orders` | CUSTOMER, own rows; `{items,total,page,pageSize}` |
| GET | `/customer/orders/:id` | CUSTOMER, own row; `{order}` |

Every query, including ADMIN detail, fixes `hidden=false` in its database predicate. No include-hidden override exists. ADMIN reads ordinary USER/ADMIN orders, including orders for pending/disabled customers. CUSTOMER additionally filters by `response.locals.principal.user.id`; query/body identity is never trusted. Wrong roles return403, absent/expired/revoked sessions and disabled accounts return401.

Missing, foreign-owned and hidden UUIDs share404 `NOT_FOUND` / `订单不存在` (requestId is independently generated). Malformed UUIDs return400. Details reject all query properties. No `/me/orders` alias is implemented: `/customer/orders/:id` overrides the former reserved order-number route.

## List query

Single string values only. Unknown properties, repeated values, arrays and nested objects return400 `INVALID_INPUT`, without echoing input.

| Parameter | Rule |
| --- | --- |
| search | Trimmed text max254; partial order number OR frozen product name. ADMIN also searches customer loginEmail/username/adminLabel. CUSTOMER never searches identities/private labels. Default empty. |
| orderNo | Partial order number, max40, default empty |
| productName | Partial productNameSnapshot, max120, default empty; never today's Product.name |
| customer | ADMIN only; partial current loginEmail OR username OR private adminLabel, max254, default empty |
| kind | INITIAL / ONE_TIME / RENEWAL; the current model yields no ordinary RENEWAL rows |
| paymentStatus | UNPAID / PENDING_VERIFICATION / PAID / REFUND_PENDING / REFUNDED |
| fulfillmentStatus | NOT_STARTED / PROCESSING / COMPLETED / FAILED / CANCELLED |
| sort | asc / desc by createdAt; default desc, UUID ascending tie-breaker |
| page | Positive decimal integer string 1–10000; default1 |
| pageSize | Positive decimal integer string 1–100; default20 |

Filters combine with AND; fields within search/customer combine with OR. Rows/count share the same predicate in one read transaction. Beyond-last-page returns empty items and the actual total. userId, source, hidden and includeHidden are rejected, including on detail. Empty text applies no restriction. Substring matching follows MySQL collation/Prisma behavior.

```text
GET /api/v1/admin/orders?customer=example.com&productName=Membership&paymentStatus=PAID&fulfillmentStatus=PROCESSING&page=1&pageSize=20&sort=desc
```

## Explicit DTOs and history

List/detail share their per-role DTO. Prisma selects only allowlisted fields; return values are explicitly constructed. No current Product join/fallback exists.

Both roles receive:

- id, orderNo, productId, kind.
- productNameSnapshot, productDescriptionSnapshot, productTypeSnapshot, priceSnapshotFen, termSnapshot, renewalPriceSnapshotFen.
- servicePeriodUnitSnapshot, servicePeriodCountSnapshot. DAY is fixed days; MONTH/YEAR are calendar periods; this API performs no arithmetic.
- formSchemaSnapshot, formData, contactEmailSnapshot, targetIdentifier: this order's frozen non-sensitive submission/contact data.
- Integer CNY Fen amountFen, independent paymentStatus/fulfillmentStatus.
- UTC ISO-8601 createdAt, paidAt, paymentConfirmedAt, fulfilledAt, cancelledAt. Unknown values remain NULL. Deprecated paymentRecordedAt is never a paidAt fallback.

ADMIN additionally receives `internalNote`, `customer:{id,username,loginEmail,notificationEmail}`, `creator:{source,adminId,userId}`, and cancellationReason. These customer fields are public profile fields; no adminLabel or actor account details are returned.

Neither role receives audit/event JSON, request metadata in the DTO, payment transaction notes/references, password/token hashes, sessions/invitations or renewal request hashes. Existing request headers/error envelopes retain safe correlation. CUSTOMER receives no internalNote, customer relation, creator/source or cancellationReason. ADMIN can search private adminLabel without returning it.

Changed/archived/delisted products never hide an existing ordinary order. Unknown historic price/form/period/paidAt values stay NULL; never parse termSnapshot or invent forms/payments. Current customer identity is used only for ADMIN search/public projection, never in place of frozen contact/target data.

## Revision foundation DTO extension (2026-11-19)

Both list/detail DTOs now include `version` (positive integer), `expiresAt` (UTC ISO timestamp equal to original createdAt + exactly 24 hours), and `remainingSeconds` (nonnegative integer, floor of server-time difference). Only UNPAID + NOT_STARTED with no payment/confirmation/fulfillment/cancellation timestamp has a live countdown. All other states and expired orders return 0, while expiresAt still records the derived original deadline. List items share one server clock sample per response; updatedAt never resets the deadline. The countdown is informational: it does not confirm payment or cancel an order. All future writes must recheck eligibility/deadline in their transaction.

ADMIN alone additionally receives nullable `internalNote` in both list and detail. CUSTOMER query projection and DTO still exclude it. Existing complete DTO key allowlists were updated independently, and nested customer/creator allowlists remain exact. No routes or frontend were added. Schema now includes migration eleven; orders-only isolation applies all eleven migrations. Earlier results below describe the earlier read-only API delivery; current execution evidence is in [revision foundation](18-order-revision-foundation.md).

## Verification and isolation

In this worktree, without copying the development `.env`:

```powershell
npm ci --prefer-offline --no-audit
npm run db:validate
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:db -w backend -- --orders-only
npm run build
```

`--orders-only` creates a random membership-foundation MySQL8.4 project/volume with temporary credentials and a random loopback port. It applies the existing ten migrations, checks repeat deploy/schema agreement, then tests createApp HTTP on another random loopback port. It executes no Seed/seedAdministrator, expiry worker or browser suite and never loads development `.env`. integrationEnvironment checks the random runner marker/database/user before fictional identities/sessions/products/orders/payments/events/audits are inserted. Cleanup removes only its own random project/volume, without disabling order DELETE guards.

Coverage: all four role/Session guards, USER/ADMIN/pending-customer visibility, hidden list/detail denial, ownership in both directions, matching foreign/missing404, query tampering/validation, all status filters, pagination/sort, customer/snapshot search, changed/archived Product independence, nullable historical data, sensitive-field exclusion and complete unchanged-table snapshots after GET/absent mutations.

The review follow-up adds independent, complete DTO key allowlists for ADMIN/CUSTOMER list and detail responses, including the nested customer/creator objects and nullable historical rows. The allowlists are literal test contracts and are not derived from production selects/DTOs, so an unexpected response key fails the test. Existing sensitive-field/value assertions remain in place.

Search coverage includes partial order numbers/customer emails/frozen product names, whitespace-only filters, URL punctuation, Unicode, SQL-like text, and existing MySQL LIKE wildcard/escape semantics (`%`, `_`, and backslash escapes). Both customers have matching PAID/PROCESSING fixtures; combined search/payment/fulfillment queries check exact IDs and total on every page, including the empty page after the final result. All fixtures remain confined to the runner-owned database.

The final test follow-up gives each customer an additional PAID/PROCESSING order whose frozen name does not contain the combined search term. A control HTTP request without search must return these orders; the otherwise identical paginated search must exclude them and report the smaller exact total. Ignoring search therefore fails the test even when ownership and status filtering still work.

Literal LIKE coverage uses a target containing `100%_ready\path` and same-customer distractors named `100X_ready\path`, `100%Xready\path` and `100%_readypath`. For ADMIN and both CUSTOMER scopes, both search parameters must return only the target when percent, underscore and backslash are escaped. Separate HTTP positive controls remove one escape at a time and must return the corresponding distractor, proving it is present and searchable rather than excluded by unrelated conditions. Exact response lengths, totals and IDs are asserted; the other customer still sees none of these foreign orders.

The full database regression runner includes this suite as its own fresh isolated sub-run, so protected fixtures left by other suites cannot contaminate its list totals. Its existing Seed-dependent suites are unchanged; this task uses orders-only to honor no-Seed. No operator login/browser acceptance is automated.

Verified on 2026-11-18:

| Check | Result |
| --- | --- |
| npm ci --prefer-offline --no-audit | Passed; existing lockfile/dependency versions retained; postinstall generated Prisma Client |
| npm run db:validate | Passed |
| npm run format:check | Passed |
| npm run typecheck | Passed: frontend, backend and E2E TypeScript |
| npm run lint | Passed |
| npm run test -w backend | Previous follow-up passed:24, including2 query-schema tests; unit tests were not rerun in the final negative-control follow-up |
| npm run test:db -w backend -- --orders-only | Passed again:13 real HTTP/MySQL tests, now including same-customer search exclusions and three independent LIKE escape controls; all10 existing migrations, repeat deploy and schema agreement; only its disposable project/volume removed |
| npm run build | Passed: frontend/backend; non-failing upstream Zod/Rollup annotation warnings |

The final negative-control follow-up reran format/type/Lint/orders-only tests/frontend and backend builds. The13 tests passed through real HTTP against disposable MySQL8.4; no Mock Prisma was used. Its five additional ordinary-order fixtures and assertions cover both customers' status-matching non-search results plus percent/underscore/backslash lookalikes. Changes are confined to the order integration fixtures/assertions and this verification record; order business code is unchanged. Setup/Client generation and Schema validation above are retained from the initial implementation, and backend unit results are retained from the previous follow-up. Full Seed-dependent database/E2E suites were not run. No migration was added or changed, and no development database was connected for this task. Preserve the original shopping checkout, its three layout edits, `.env`, services and development volume; stop for acceptance before any order write/payment/fulfillment/renewal/frontend stage.


## T20 ADMIN read extension — implemented, pending PR review

T20 adds `GET /api/v1/admin/orders/:id/events?page=1&pageSize=20`, requiring the existing persisted ADMIN Session/role/CSRF/read middleware and `hidden=false` order predicate. It returns a paginated `OrderEvent` timeline ordered createdAt DESC/id ASC with explicit eventType/allowlisted operation/actor display/time/note and a reconstructed safe summary. Raw `fromStateJson`, `toStateJson`, AdminAuditLog and OrderRevision are never returned. The only internal-note before/after values surfaced are the explicit `internalNoteBefore`/`internalNoteAfter` fields for `ORDER_INTERNAL_NOTE_UPDATED`, ADMIN-only. No Revision browsing, comparison or restore API is added (D41).

The existing ADMIN detail response is extended with nullable `linkedSubscription` minimal summary (id/sourceType/status/version/productNameSnapshot/startedAt/expiresAt), resolved from `sourcedSubscription` for INITIAL or `subscription` for a renewal order. It does not include subscription formData or targetIdentifier. Existing payment and refund evidence remain separate T17/T18 endpoints. The ADMIN list adds optional `productType=SUBSCRIPTION|ONE_TIME` filtered against frozen productTypeSnapshot; customer list filters are unchanged. These changes add no schema or migration.
