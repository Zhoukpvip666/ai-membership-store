# Local Operations Data Model (Task 1.2 and Phase 2)

> **T25 approved model override (pending implementation):** [T25](34-customer-claim-registration.md) changes User.loginEmail to nullable while retaining the unique index. New ADMIN-created customer records have NULL loginEmail, notificationEmail, passwordHash and activatedAt. Invitation registration sets the login identity on the same User ID. Only never-activated ADMIN-created CUSTOMER records' preset emails are cleared during the new migration; activated/previously activated users and all business relations are preserved. The original non-null email field and activation rules below describe the current implementation until T25 is delivered.

> **Document scope:** This is a staged data-model history with later overrides. The [current project status](00-project-status.md) identifies merged capabilities. Original table/migration counts and stage-specific statements that an API is absent apply only to the named stage. T24.1 WeChat settings and [T24.5B product covers](29-product-cover-images.md) are later additive schema changes; consult the committed schema/migrations and [current API contract](05-api-contract.md) rather than treating these earlier table lists as an exhaustive current inventory.

This is the approved data model for the first persistent, local-only operating version. It supersedes the earlier conceptual model where it conflicts with this document. Full workflow and scope rules are in [10-local-operations-mvp.md](10-local-operations-mvp.md).

Phase 2 user/subscription fields and migration rules below follow [14-user-subscription-core.md](14-user-subscription-core.md), which supersedes the earlier order-first subscription and suspension design. Other order/payment models remain reserved and their business APIs are not implemented in this phase.

**Historical model-only stage (2026-11-18):** [Stage 1 order/subscription foundation](15-order-subscription-foundation.md) added the order-first model while preserving Phase 2 services and history. That migration stage itself did not implement order APIs; later merged API stages are documented below and in the current project status.

**Order revision foundation (2026-11-19):** [Revision/idempotency guide](18-order-revision-foundation.md) adds migration eleven, append-only OrderRevision, Order.version and generic actorUserId idempotency. That foundation stage itself adds no order write API.

**Order write implementation override (2026-11-19):** The merged [creation API](19-order-creation-api.md) writes V1 and adds migration twelve. [T15 order editing](20-order-edit-api.md) now implements the two role-specific PATCH routes for review, without Schema or Migration changes. A row lock plus expectedVersion and a database-clock conditional UPDATE protect eligible visible USER/ADMIN orders (UNPAID/NOT_STARTED, no payment/completion/cancellation facts, before the original 24-hour deadline). One transaction replaces formData against the order's frozen schema, optionally changes ADMIN amountFen, increments version exactly once, appends a complete immutable Revision and sanitized Event, records ADMIN-only audit, and saves the exact idempotent response. Prior revisions and all frozen snapshots remain unchanged. NULL legacy form schemas are rejected without consulting current Product data.

Changing a positive amount to zero atomically uses NOT_REQUIRED/PROCESSING, keeping payment times NULL and creating no PaymentTransaction or Subscription. Any existing payment transaction prevents this conversion; confirmed transaction facts also prevent other core edits. priceSnapshotFen remains unchanged. The existing NOTE event type carries an `operation: ORDER_EDITED` marker in its sanitized state JSON; this does not modify internalNote. Internal-note editing, cancellation, payment and fulfillment APIs remain outside this task.

## 1. Design boundaries

**T16 cancellation implementation:** [Cancellation/timeout report](21-order-cancellation-timeout.md) reuses this Schema and all twelve migrations unchanged. Manual cancellation and database-clock SYSTEM expiry atomically update Order/version, pending PAYMENT attempts (FAILED, retained), complete OrderRevision and CANCELLED OrderEvent; only ADMIN actions append AdminAuditLog, only manual requests persist idempotency responses. PAID cancellation validates the matching confirmed full receipt and moves to REFUND_PENDING without refund records; zero-price cancellation retains NOT_REQUIRED. SYSTEM actor references are NULL, and protected snapshots/payment facts remain intact. T16 itself adds no payment/refund confirmation or fulfillment; payment and refund confirmation are covered by T17/T18 below.

- Single merchant: the site owner is the only ADMIN and seller. There is no Merchant, CustomerWallet, merchant balance, withdrawal, or sub-merchant model.
- A customer is a User with role CUSTOMER. There is no separate customers table.
- Customers may have orders and subscriptions while their account status is PENDING_ACTIVATION.
- Transactions remain offline/manual. Only USER, ADMIN and SYSTEM_RENEWAL identify order creators, not payment providers; retired-source order compatibility ends at migration ten. Online payment is not implemented.
- Payment transactions record customer money received/refunded outside the app. The app never moves money.
- No supplier costs, supplier transfers, supplier fulfillment, email outbox, SMTP, or payment-provider credentials in this schema.

## 2. Prisma models

### User

| Field | Type / rule | Meaning |
|---|---|---|
| id | String PK, CUID/UUID | Internal ID |
| username | VarChar(80), nullable | Customer-owned name; initialized NULL; new editing flow deferred |
| adminLabel | VarChar(80), nullable | Private administrator label; migrated from displayName; never returned to customers |
| loginEmail | VarChar(254), unique, normalized lowercase | Login identity |
| notificationEmail | VarChar(254), nullable | Notification/contact email; defaults to loginEmail when omitted |
| passwordHash | VarChar(255), nullable | Null until invitation activation |
| role | ADMIN / CUSTOMER | One owner admin; ordinary customers |
| status | PENDING_ACTIVATION / ACTIVE / DISABLED | Account access state |
| activatedAt | DateTime?, nullable | Activation timestamp |
| createdByAdminId | String?, FK User | Admin who created the customer |
| createdAt / updatedAt | DateTime(3) UTC | Audit timestamps |

A pending customer can have orders and subscriptions. Never require ACTIVE status to create them.

Task 1.2.2 uses the existing schema without a migration. Login email is immutable after customer creation. Disabling preserves business history while revoking sessions and unused invitations; restoring derives ACTIVE versus PENDING_ACTIVATION from the existing activation timestamp and password hash. Account activation and one-time invitation consumption commit together.

### Session

| Field | Type / rule | Meaning |
|---|---|---|
| id | String PK | Internal ID |
| userId | String FK User, indexed | Session owner |
| tokenHash | VarChar(64), unique | Hash of opaque random session token; never store raw token |
| expiresAt | DateTime(3), indexed | Expiry |
| lastSeenAt | DateTime(3)? | Last activity |
| revokedAt | DateTime(3)? | Logout/revocation |
| createdAt | DateTime(3) | Creation time |

### InvitationToken

| Field | Type / rule | Meaning |
|---|---|---|
| id | String PK | Internal ID |
| userId | String FK User, indexed | Invited customer |
| tokenHash | VarChar(64), unique | SHA-256 hash of random token; raw token is returned once only |
| expiresAt | DateTime(3), indexed | Default 7-day expiry |
| usedAt | DateTime(3)? | One-time activation timestamp |
| revokedAt | DateTime(3)? | Reissue/admin revocation |
| createdByAdminId | String FK User | Issuing admin |
| createdAt | DateTime(3) | Creation time |

Only one unexpired, unused invitation should remain active per user. Enforce by transactionally revoking prior invitations before issuing a new one. No email is sent.

### Product

| Field | Type / rule | Meaning |
|---|---|---|
| id | String PK | Internal ID |
| slug | VarChar(100), unique | Stable product key |
| name | VarChar(120) | Product name |
| description | Text?, nullable | Optional description |
| type | SUBSCRIPTION / ONE_TIME | Product type |
| priceFen | Int | Initial/one-time selling price in CNY fen |
| renewalPriceFen | Int?, nullable | Required for SUBSCRIPTION; null for ONE_TIME |
| termLabel | VarChar(40) | Human-readable service term |
| servicePeriodUnit / servicePeriodCount | Nullable DAY / MONTH / YEAR and Int | Fixed days / calendar months / calendar years plus positive quantity; NULL pair is unknown legacy data |
| targetField | EMAIL / TEXT / NONE | Non-sensitive target information needed |
| listed | Boolean | Public catalog visibility only; default false |
| sortOrder | Int, default 0 | Nonnegative display order; ties use createdAt then id |
| formSchema | JSON, default `{"version":1,"fields":[]}` | Versioned non-sensitive product form configuration; see docs/13-products-settings-forms.md |
| archivedAt | DateTime?, nullable | Irreversible soft archive; default null |
| createdAt / updatedAt | DateTime(3) | Timestamps |

Do not add supplierCost. Product API never hard-deletes any product. Product has only listed and archivedAt as state fields; type remains the product classification. Archive atomically sets listed=false and archivedAt once, retains history, and prevents editing or relisting. There is no restore path. Public catalog eligibility is listed=true AND archivedAt=null. Future ADMIN offline orders may use any unarchived product even if unlisted; future manual grants/imports require an unarchived SUBSCRIPTION product regardless of listed. Archived products cannot be selected for new orders, renewals or new subscriptions; existing entitlements and history are preserved. These future writes are not implemented in Task 1.2.3. New slugs are server-generated and stable. The legacy targetField column remains unchanged for old records; new products use NONE and formSchema. Form configuration edits never rewrite orders or subscriptions. Future order work must snapshot any relevant schema and field labels rather than read mutable product configuration for historical display; no order field or submission storage is added in Task 1.2.3.

### Order

| Field | Type / rule | Meaning |
|---|---|---|
| id | String PK | Internal ID |
| orderNo | VarChar(40), unique | Server-generated order number |
| version | Int, non-null default 1 | Every successful row update requires exactly +1; append matching OrderRevision atomically |
| userId | String FK User, indexed with createdAt | Customer, including pending-activation users |
| productId | String FK Product | Product reference; deletion restricted |
| subscriptionId | String?, FK Subscription | Required for RENEWAL; null for initial/one-time |
| kind | INITIAL / RENEWAL / ONE_TIME | Order purpose |
| source | USER / ADMIN / SYSTEM_RENEWAL; nullable storage DEFAULT NULL, logically required | INSERT Trigger and non-NULL CHECK reject omission/NULL in every SQL mode; source is immutable and all orders reject DELETE/REPLACE |
| hidden | Boolean, default false | System renewal orders are persisted but hidden from ordinary customer listings; ADMIN visibility/ownership rules are deferred |
| productNameSnapshot | VarChar(120) | Immutable product name |
| productDescriptionSnapshot / priceSnapshotFen | Nullable Text / Int Fen | Frozen description and configured price; NULL on old orders |
| productTypeSnapshot | SUBSCRIPTION / ONE_TIME | Immutable product type |
| termSnapshot | VarChar(40) | Immutable term |
| servicePeriodUnitSnapshot / servicePeriodCountSnapshot | Nullable ServicePeriodUnit / Int | Frozen structured period, never inferred from termSnapshot |
| formSchemaSnapshot / formData | Nullable JSON | Frozen form structure and entered non-sensitive data; NULL means unknown, not an empty historic submission |
| renewalPeriodStartAt / renewalPeriodEndAt | Nullable UTC DateTime(3) | Required increasing purchased target-cycle bounds for SYSTEM_RENEWAL |
| renewalForPeriodStartAt | Nullable UTC DateTime(3) | Current cycle consuming its one advance-renewal entitlement; required for SYSTEM_RENEWAL |
| billingAnchorSnapshotAt / billingTimezoneSnapshot / billingRevisionSnapshot | Nullable UTC instant / canonical IANA zone / positive Int | Frozen renewal calendar context, independent of mutable Subscription.version |
| renewalRequestKeyHash / renewalRequestHash | Nullable VarChar(64), first unique | Stable server-scoped request identity and canonical intent hashes; required and immutable for system renewals |
| amountFen | Int | Agreed order amount in CNY fen |
| renewalPriceSnapshotFen | Int?, nullable | Renewal price snapshot where applicable |
| contactEmailSnapshot | VarChar(254) | Contact email at order creation |
| targetIdentifier | VarChar(254), nullable | Service target identifier; never a password/token |
| paymentStatus | UNPAID / PENDING_VERIFICATION / PAID / REFUND_PENDING / REFUNDED / NOT_REQUIRED | Transaction-derived payment facts; NOT_REQUIRED is the explicit zero-price exception |
| fulfillmentStatus | NOT_STARTED / PROCESSING / COMPLETED / FAILED / CANCELLED | Service progress |
| paidAt | Nullable UTC DateTime(3) | Actual full-payment occurrence; frozen copy of the corresponding confirmed PAYMENT transaction's occurredAt. Unknown history stays NULL. |
| paymentConfirmedAt / fulfilledAt / cancelledAt | Nullable UTC DateTime(3) | Administrator receipt confirmation / actual fulfillment completion / cancellation time |
| paymentRecordedAt | Nullable UTC DateTime(3), deprecated | Legacy entry timestamp retained unchanged. New flows neither write it nor treat it as paidAt; no fallback or backfill. |
| cancellationReason | Nullable VarChar(500) | Cancellation explanation |
| internalNote | Text?, nullable | Admin-only note |
| createdByAdminId / createdByUserId | Nullable restrictive User FKs | ADMIN or USER creator; system needs no fake account; legacy admin references preserved |
| createdAt / updatedAt | DateTime(3) | Timestamps |

The tenth migration removes the retired enum member, all retired-source CHECK exemptions and the two legacy-specific triggers. It preserves the source-identity Trigger and original renewal guards, and installs an unconditional all-order DELETE guard. Nullable ENUM storage prevents non-strict omission from silently choosing USER; the INSERT Trigger and source IS NOT NULL CHECK enforce required source. Prisma reflects storage optionality; future create services must still explicitly require a source. Old migration SQL remains intact. Migration ten first rejects any remaining retired-source order without conversion or cleanup. Development orders and references remain uninspected and require separate authorization before migration.

The sixth migration requires visible USER/ADMIN orders with INITIAL/SUBSCRIPTION or ONE_TIME/ONE_TIME, no subscription link and no renewal-only snapshots. SYSTEM_RENEWAL requires RENEWAL/SUBSCRIPTION, hidden=true, the original subscription and complete cycle/anchor/revision snapshots. Migration ten removes every historical source exemption. New subscription-product orders must have a positive structured period. Cross-table ownership/roles/payment verification remain service checks.

The seventh migration adds nullable Order.paidAt without backfill and replaces the sixth migration's provisional paymentRecordedAt-based final-state check. SYSTEM_RENEWAL must be inserted as PAID/COMPLETED with non-NULL paidAt, paymentConfirmedAt and fulfilledAt, NULL cancelledAt, and paidAt <= paymentConfirmedAt <= fulfilledAt. Every required timestamp has an explicit non-NULL guard to prevent MySQL CHECK's UNKNOWN result from accepting incomplete rows. paymentRecordedAt is not consulted. Unpaid, processing, not-started, failed, cancelled or refund-state system renewals cannot be inserted. New USER/ADMIN orders also reject reversed known payment/confirmation/fulfillment pairs while permitting unknown timestamps. No source is exempt after migration ten.

For a new confirmed full PAYMENT, Order.paidAt must equal PaymentTransaction.occurredAt and Order.paymentConfirmedAt must match its confirmedAt, written in the same future business transaction. The deliberate frozen order copy is not a second independent payment clock. The row-local SQL CHECK does not enforce cross-table equality; the future service must validate the trusted payment, amount and relationship before committing. No order API or payment service is added here.

Renewal snapshots are protected against UPDATE by a database trigger, including byte-level text changes. Valid SYSTEM_RENEWAL rows reject every UPDATE and DELETE from their initial INSERT. A future renewal transaction therefore inserts the final PAID/COMPLETED order after verifying payment, then updates Subscription and writes payment/events/audit without another Order UPDATE. Do not disable triggers to rewrite purchase history. Refunds remain future work and cannot mutate these frozen renewal rows.

Payment and fulfillment are independent. A newly created unpaid order is not “待发货”. Only paid pending orders enter the fulfillment queue. Admin may change fulfillment with a required reason and audit record. Only paid orders may be completed.

### PaymentTransaction

| Field | Type / rule | Meaning |
|---|---|---|
| id | String PK | Internal ID |
| orderId | String FK Order, indexed | Related order |
| kind | PAYMENT / REFUND | Customer inbound or refund |
| channel | WECHAT / ALIPAY / CASH / BANK_TRANSFER / OTHER | Actual offline channel |
| amountFen | Int | Transaction amount in CNY fen |
| status | PENDING / CONFIRMED / FAILED | Manual verification/result |
| externalReference | VarChar(120)?, nullable | Transaction reference if available |
| occurredAt | DateTime(3) | Actual payment/refund time; the corresponding confirmed full PAYMENT's occurrence equals Order.paidAt |
| confirmedAt | DateTime(3)?, nullable | Admin confirmation time |
| createdByAdminId | String FK User | Admin who recorded it |
| confirmedByAdminId | String?, FK User | Admin who verified it |
| note | VarChar(500)?, nullable | Admin-only explanation |
| createdAt / updatedAt | DateTime(3) | Payment record database entry/update times; createdAt is not actual payment time and may follow confirmation for a system renewal |

This table records customer money only, not supplier transfers. In Task 1.2, payment is manually verified and refund is manually recorded after external action. Support full-order refunds only; no partial payments or partial refunds. The order paymentStatus summary must be recomputed in the same database transaction whenever a transaction changes.

### Subscription

| Field | Type / rule | Meaning |
|---|---|---|
| id / userId / productId | UUID / restrictive FKs | Independent entitlement; no customer/product uniqueness |
| sourceOrderId | Nullable unique Order FK | Required by DB CHECK for new ORDER source; historical unlinked rows remain unchanged |
| sourceType | ADMIN / SYSTEM / ORDER | Legacy/direct compatibility and future order-driven creation; existing API still creates ADMIN |
| createdByAdminId | Nullable User FK | ADMIN creator; future SYSTEM creation leaves null |
| productNameSnapshot / productDescriptionSnapshot | VarChar(120) / nullable Text | Frozen product copy |
| productTypeSnapshot / priceSnapshotFen / termSnapshot | ProductType / Int Fen / VarChar(40) | Product price at subscription creation, never proof of payment |
| servicePeriodUnitSnapshot / servicePeriodCountSnapshot | Nullable ServicePeriodUnit / positive Int | Frozen period; unknown historical period remains NULL |
| billingAnchorAt / billingTimezone | Nullable UTC DateTime(3) / VarChar(64) | Original calendar anchor instant and IANA timezone snapshot; both unknown for legacy rows |
| billingRevision | Nullable positive Int | Explicit 1 for new ORDER subscriptions; increments only on manual anchor reset, independently of general version |
| earlyRenewalUsed | Nullable Boolean | Explicit false for a new ORDER cycle; NULL preserves unknown legacy eligibility |
| currentPeriodStartAt / currentPeriodEndAt | Nullable UTC DateTime(3) | Current cycle bounds, independent of paid-through expiresAt |
| earlyRenewedPeriodStartAt / earlyRenewalOrderId | Nullable DateTime(3) / unique restrictive Order FK | Successful advance-renewal marker; new ORDER records require false + NULL/NULL when unused, true + current-period start/order when used; reset on rollover/anchor correction |
| formSchemaSnapshot / formData | JSON | Frozen schema and strictly validated non-sensitive values |
| targetIdentifier | Nullable legacy VarChar(254) | Preserved read-only, not repurposed or collected by new API |
| startedAt / expiresAt | UTC DateTime(3) | Existing manual service dates; future order-driven service dates require separately reviewed period arithmetic |
| renewalPriceFen | Nonnegative integer Fen | Current subscription renewal amount |
| note | Nullable VarChar(2000) | Administrator-only service note, not copied verbatim into audit/history |
| status | ACTIVE / TERMINATED | Entitlement additionally requires expiresAt > database now |
| terminatedAt / terminationReason | Nullable DateTime(3) / VarChar(500) | Irreversible manual/system termination |
| version | Int, initial 1 | Optimistic concurrency, increment every successful change |
| createdAt / updatedAt | UTC DateTime(3) | Existing timestamps preserved by migration |

ORDER subscriptions require SUBSCRIPTION, an existing unique sourceOrderId, complete positive period, anchor, supported canonical IANA timezone, positive billingRevision, increasing current-cycle bounds and explicitly initialized earlyRenewalUsed. ADMIN/SYSTEM history remains exempt. The migration carries a versioned canonical timezone allowlist (Node 24 ICU, plus UTC aliases); the future service must normalize valid aliases before saving. It does not depend on MySQL timezone tables.

Phase 2 direct subscriptions snapshot current product fields. Future ORDER subscriptions must copy the source order's frozen product/period/form/data snapshots, never today's Product. The initial sourceOrderId remains stable; later renewal orders use Order.subscriptionId without replacing the initial source link. Legacy rows could only snapshot the referenced product at the Phase 2 migration time: prior product history cannot be reconstructed. Legacy targetIdentifier remains intact, formData started empty, and later edits validate supplied formData against the frozen schema. Stage 1 does not rewrite these snapshots. Never invent historic submitted values or payments.

### SubscriptionEvent

Extends the original history table, never replaces it. Existing order/date/actor/reason/timestamp columns and all old event types/rows remain. New actorType is ADMIN/SYSTEM (legacy defaults ADMIN); actorAdminId is nullable for SYSTEM. New beforeJson/afterJson cover mutable state, versions, dates and prices; formData values and note are redacted. New operations emit CREATED, UPDATED, RENEWED, EXPIRY_ADJUSTED, PRICE_CHANGED, FORM_DATA_UPDATED, TERMINATED or AUTO_TERMINATED. One edit can append UPDATED plus specific changed-field events in the same transaction. History is ADMIN-only and paginated.

### OrderRevision

Append-only internal full-state history: UUID id; restrictive orderId and nullable actorUserId FKs; positive version; snapshotSchemaVersion=1; snapshotJson; OrderActorType USER/ADMIN/SYSTEM; optional reason (500 characters); UTC createdAt. Unique (orderId,version), indexes (orderId,createdAt) and (actorUserId,createdAt). Human actors require an existing User; SYSTEM may use NULL. Actor role/ownership authorization remains the future trusted service's responsibility.

Order.version is non-null, initially 1 for old/new orders. An INSERT trigger requires 1; an UPDATE trigger requires exactly old version + 1. A revision INSERT locks/reads the parent and requires its current version. Snapshot JSON has a strict, versioned business whitelist in TypeScript and MySQL JSON Schema; IDs/versions must match its columns. UPDATE/DELETE triggers reject all history mutation, including conflicting UPSERT/REPLACE. These guards do not implement deferred cross-table completeness: future writes must atomically update Order, append revision/events/audits and store any idempotency response. Historical orders get version 1 without invented revision/actor history. See the guide for the full V1 field list and deployment limitations.

### IdempotencyRecord

UUID id, restrictive actorUserId FK, SHA-256 keyHash, SHA-256 canonical requestHash (including operation/target), operation, responseJson and createdAt. Unique (actorUserId,keyHash), shared by ADMIN and CUSTOMER but scoped independently to each identity. Migration eleven renames the old actorAdminId column/index/FK in place without deleting/reinserting rows. Original administrator IDs, hashes, responses and dates remain unchanged. Stored sanitized responses may contain business data: never log them or expose across identities. Same identity/key/body replays the exact committed original response even after later changes; changed body/target/operation returns 409. No raw key is stored. Records are permanent, with no TTL or automatic cleanup. Existing subscription canonicalization, atomic writes, conflict handling and replay are unchanged.

### OrderEvent

| Field | Type / rule | Meaning |
|---|---|---|
| id | String PK | Internal ID |
| orderId | String FK Order, indexed with createdAt | Related order |
| eventType | ORDER_CREATED / PAYMENT_RECORDED / PAYMENT_CONFIRMED / REFUND_RECORDED / REFUND_CONFIRMED / FULFILLMENT_CHANGED / COMPLETED / NOTE / CANCELLED | All old event types retained; cancellation appended |
| actorType | USER / ADMIN / SYSTEM, default ADMIN | Explicit actor; old records were ADMIN |
| actorAdminId / actorUserId | Nullable restrictive User FKs | Exactly the actor appropriate to actorType; SYSTEM has neither |
| fromStateJson / toStateJson | Json?, nullable | Safe status snapshots |
| note | VarChar(500)?, nullable | Operator explanation |
| createdAt | DateTime(3) | Event time |

Do not place raw invitation tokens, passwords, authentication cookies, or secrets in event metadata.

### AdminAuditLog

| Field | Type / rule | Meaning |
|---|---|---|
| id | String PK | Internal ID |
| actorAdminId | Nullable String FK User, indexed with createdAt | Admin actor; NULL for SYSTEM |
| actorType | ADMIN / SYSTEM, default ADMIN | Explicit actor without a fake system account |
| action | VarChar(80) | Action key |
| entityType | VarChar(40) | User/Product/Order/PaymentTransaction/Subscription/Settings |
| entityId | VarChar(40) | Target ID |
| beforeJson / afterJson | Json?, nullable | Sanitized change snapshots |
| reason | VarChar(500)?, nullable | Required for sensitive manual correction |
| requestId | VarChar(64)?, nullable | Correlation |
| createdAt | DateTime(3) | Audit timestamp |

### AppSettings

Singleton row, initialized with id = 1.

| Field | Type / rule | Meaning |
|---|---|---|
| id | Int PK, fixed value 1 | Singleton key |
| storeName | VarChar(80) | Store display name |
| ownerEmail | VarChar(254) | Owner/notification address |
| timezone | VarChar(64) | Default Asia/Shanghai |
| paymentInstructions | VarChar(4000), default empty string | Site-wide plain text only; no secrets, HTML rendering or payment execution |
| wechatPayEnabled | Boolean, default false | Administrator-controlled WeChat collection setting |
| wechatQrImageKey | Nullable VarChar(40) | Current server-generated PNG filename in private storage |
| updatedAt | DateTime(3) | Last update |

No SMTP or payment credentials belong in AppSettings.

T24.1 adds the two WeChat fields with an incremental migration. Existing settings keep their merchant remarks and start with collection disabled. A database check requires an image reference when enabled. The service also verifies the image file before enabling collection. The database stores only the current reference and state. Audit records include only the status and whether an image is configured.

**T21 payment guidance (implemented for review):** `paymentInstructions` remains the existing singleton plain-text field, maximum 4000 characters, with no new column or migration. The ADMIN settings PATCH may update/clear it; AdminAuditLog records only the changed field name, not the text itself. The CUSTOMER `GET /customer/order-guidance` projection exposes only storeName, businessTimezone (AppSettings.timezone) and paymentInstructions to an ACTIVE CUSTOMER Session. It never exposes ownerEmail or other settings. The customer UI shows the text only for positive UNPAID + NOT_STARTED orders with remainingSeconds > 0. Markup-like characters are preserved and rendered as literal plain text. Authentication secrets (passwords, OTPs, API keys, private keys) do not belong in this field.


## 3. Relationships

- User has many orders, subscriptions, sessions, invitation tokens, and admin audit actions.
- Product has many orders and subscriptions.
- Order has many payment transactions and order events.
- A renewal Order references one existing Subscription.
- An initial subscription Order may be referenced by Subscription.sourceOrderId after fulfillment.
- Subscription has many renewal orders and subscription events.
- Pending-activation users may own orders/subscriptions exactly like active users.
- ADMIN and CUSTOMER are User roles; there is one owner/admin account.

## 4. State and transaction invariants

- Order.paymentStatus is a summary of PaymentTransaction records, not a free-form editable field:
  - zero-price order requiring no payment: NOT_REQUIRED, amountFen=0, no paidAt/paymentConfirmedAt or PaymentTransaction;
  - no recorded payment on a positive-price order: UNPAID;
  - payment awaiting admin verification: PENDING_VERIFICATION;
  - confirmed payment: PAID;
  - refund awaiting external completion: REFUND_PENDING;
  - confirmed full refund: REFUNDED;
  - failed refund returns the summary to PAID if the original payment remains confirmed.
- Order.fulfillmentStatus is independent. Future fulfillment permits PAID/PROCESSING or zero-price NOT_REQUIRED/PROCESSING; creation does not fulfill either. A confirmed full refund before completion sets fulfillment to CANCELLED; a refund after completion does not erase the historical completion.
- Confirming payment, confirming refund, completing an order, and applying a renewal date update must use database transactions and append the corresponding OrderEvent/SubscriptionEvent/AdminAuditLog atomically.
- Existing Phase 2 direct renewal still accepts a manually confirmed expiry. Future structured-period arithmetic must use frozen unit/count/anchor/timezone, with explicitly reviewed calendar-boundary rules. Unknown legacy periods must not participate in automatic calculations.
- Phase 2 compatibility APIs still create/renew directly without order/payment rows. Future new business must use ORDER subscriptions after full payment and fulfillment; service integration, ownership, ordinary-order snapshot immutability, concurrency and atomic renewal markers are deferred to the next stage. Database-clock expiry/version behavior is unchanged.
- Legacy sources all migrate to ADMIN with existing creators/references/dates/prices/states intact. SUSPENDED blocks before persistent schema/data changes.
- All money uses integer fen. All timestamps are stored in UTC and displayed in configured business timezone.

## 5. Indexes and deletion rules

- Renewal unique claims: Order(subscriptionId,billingRevisionSnapshot,renewalForPeriodStartAt) and Order(subscriptionId,billingRevisionSnapshot,renewalPeriodStartAt). Both survive marker reset and use NULL compatibility for old orders. New system orders represent successful purchases only; payment attempts are not committed as system renewal orders.
- Unique: User.loginEmail, Session.tokenHash, InvitationToken.tokenHash, Product.slug, Order.orderNo, Subscription.sourceOrderId, Subscription.earlyRenewalOrderId.
- Index: Order(userId, createdAt), Order(paymentStatus, createdAt), Order(fulfillmentStatus, createdAt), Order(subscriptionId, createdAt), PaymentTransaction(orderId, kind, status), Subscription(userId, status), Subscription(expiresAt, status), SubscriptionEvent(subscriptionId, createdAt), OrderEvent(orderId, createdAt), AdminAuditLog(actorAdminId, createdAt).
- Use restrictive foreign keys for orders, payments, subscriptions, and events. Disable users and archive products; do not cascade-delete business history.
- Prisma migrations are the only schema-change mechanism. Never use destructive schema push against the local data volume.

## Order creation zero-price migration

Twelfth incremental migration `20261119010000_order_creation` appends NOT_REQUIRED to Order.paymentStatus and extends the strict OrderRevision V1 payment enum CHECK. The same-row zero-price CHECK requires amountFen=0, NULL paidAt/paymentConfirmedAt and PROCESSING/COMPLETED/CANCELLED fulfillment for NOT_REQUIRED. Existing status values/ordinals, rows, revisions, triggers and historical zero-price UNPAID records are preserved exactly; no retrospective payment facts or state conversions. Cross-table absence of payment/subscription creation is enforced by the creation transaction and tested. Source/version/renewal/history protections remain in effect.

DDL is not an all-or-nothing migration: Order ALTER may commit before the OrderRevision ALTER. Stop on failure and inspect migration history/column enum/CHECK definitions before DBA-approved recovery. No automatic reset/resolve. Migration permissions include ALTER and the MySQL ALTER-required CREATE/INSERT privileges; no new TRIGGER or foreign DEFINER is introduced by migration twelve, while fresh installations still require all prior trigger prerequisites. No development deployment is performed by this task.


**T17 offline payment implementation (merged PR #20):** [docs/22-offline-payment-api.md](22-offline-payment-api.md) implements ADMIN-only payment-attempt listing, registration, confirmation and failure. It reuses the existing PaymentTransaction model/status/channel and twelve migrations without schema changes. Each successful payment mutation updates the Order payment summary and increments Order.version once, appending a complete Revision, Event, AdminAuditLog and actor-scoped idempotency response in one transaction. `PAYMENT_FAILED` reuses OrderEventType.NOTE with a safe operation marker; no enum migration is added. Confirmation requires exactly one selected full-value pending attempt, all sibling attempts closed, exact amount and a database-time check before the original 24-hour deadline. No provider integration, refunds, fulfillment or subscription entitlement is included.


**T18 offline refund implementation (merged PR #23):** [docs/23-offline-refund-api.md](23-offline-refund-api.md) reuses the existing `PaymentTransaction` model with `kind=REFUND` and the existing PENDING/CONFIRMED/FAILED statuses. It is ADMIN-only and only applies to CANCELLED + REFUND_PENDING orders with one confirmed full PAYMENT. The refund channel and amount must match the original payment. A PENDING REFUND represents an externally initiated attempt, not completed return; only CONFIRMED changes Order.paymentStatus to REFUNDED. FAILED attempts remain immutable and may be retried with a new row. Every successful refund mutation increments Order.version once and appends Revision/Event/AdminAuditLog/idempotency in the same transaction. No Schema or Migration changes. Serializable Order-first transactions lock all related PaymentTransaction rows in ID order and revalidate the unique full receipt, refund facts and expectedVersion. The protected conditional Order update increments once; only confirmation changes paymentStatus to REFUNDED. Source, cancellation facts, actual payment times and original PAYMENT evidence are retained. Existing version/source/history/renewal guards are not changed; no 24-hour restriction applies to refunds.


**T19 manual fulfillment (merged PR #26):** [docs/24-manual-fulfillment-api.md](24-manual-fulfillment-api.md) adds one ADMIN fulfillment action for INITIAL subscription and ONE_TIME orders. It uses exact PAID or NOT_REQUIRED eligibility; ONE_TIME becomes COMPLETED without a Subscription. INITIAL creates one unique ORDER-linked Subscription copied from frozen Order snapshots, with `startedAt=billingAnchorAt=currentPeriodStartAt=fulfilledAt`, a canonical `AppSettings.timezone` frozen at fulfillment, structured period-derived `expiresAt`, billingRevision=1 and earlyRenewalUsed=false. The same transaction completes Order/version/Revision/Event, creates Subscription/CREATED event, writes separate Order and Subscription AdminAuditLog rows and stores idempotency response. RENEWAL/SYSTEM_RENEWAL, fulfillment FAILED, refunds and automatic renewal are excluded. No Schema or Migration is added: all twelve committed SQL files and source/version/renewal/revision guards remain unchanged. The service deep-copies Order JSON, initializes every ORDER billing/renewal marker and guards sourceOrderId under the parent lock; both audits commit atomically. The approved Temporal 0.5.1 helper computes expiry. Unknown periods or invalid settings are rejected, never inferred or repaired. Phase 2 ADMIN/SYSTEM services and existing rows remain unchanged.


## T20 administrator order center data access and internal-note history (implemented and merged in PR #29)

[T20 contract](25-admin-order-center.md) adds no Prisma model or migration. The ADMIN order detail may project only a minimal linkedSubscription summary from the existing `sourcedSubscription` or renewal `subscription` relation; it must not expose subscription formData/targetIdentifier in that expansion. The new ADMIN OrderEvent list is a safe read projection of existing OrderEvent rows and never returns raw from/to JSON, AdminAuditLog or OrderRevision. The D92 internal-note PATCH updates only `Order.internalNote` plus the required version/updatedAt fields, then atomically appends the existing immutable OrderRevision, existing NOTE OrderEvent, AdminAuditLog and IdempotencyRecord. Before/after internalNote values live in the existing Event/Audit JSON allowlists; the Event note column is not used for the 2000-character note. CUSTOMER projections continue to exclude internalNote and ADMIN-only event/payment/refund data. SYSTEM_RENEWAL remains immutable. The ADMIN list adds a query filter on the existing frozen `Order.productTypeSnapshot`; no new persisted field is required.


## T20 ADMIN order center implementation

No Schema, CHECK, trigger or migration change. The independent internal-note mutation locks the visible USER/ADMIN Order, increments version once and appends a complete immutable snapshotSchemaVersion=1 Revision, NOTE event, exact before/after audit and actor-scoped idempotency response in the existing transaction. Lifecycle and payment facts are unchanged even in terminal states. ADMIN detail projects only seven linked-subscription fields; event reads reconstruct operation-specific scalar summaries, never raw JSON.


## T21 customer order center — no schema change

T21 reuses the existing Order customer projection, OrderRevision, OrderEvent and AppSettings models. It adds no customer-specific order status, payment/refund attempt visibility, event table, or migration. Customer order DTOs continue excluding internalNote, creator/source, cancellationReason and all audit/history data. Order guidance reads the existing AppSettings singleton. Customer order projections use the existing exact keys and suppress unsafe legacy form snapshots and values. The persisted snapshots and administrator projections remain intact.
