# Local Operations Data Model (Task 1.2 and Phase 2)

This is the approved data model for the first persistent, local-only operating version. It supersedes the earlier conceptual model where it conflicts with this document. Full workflow and scope rules are in [10-local-operations-mvp.md](10-local-operations-mvp.md).

Phase 2 user/subscription fields and migration rules below follow [14-user-subscription-core.md](14-user-subscription-core.md), which supersedes the earlier order-first subscription and suspension design. Other order/payment models remain reserved and their business APIs are not implemented in this phase.

## 1. Design boundaries

- Single merchant: the site owner is the only ADMIN and seller. There is no Merchant, CustomerWallet, merchant balance, withdrawal, or sub-merchant model.
- A customer is a User with role CUSTOMER. There is no separate customers table.
- Customers may have orders and subscriptions while their account status is PENDING_ACTIVATION.
- Task 1.2 records offline transactions only. Order source is OFFLINE_MANUAL. Online payment is not implemented.
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
| userId | String FK User, indexed with createdAt | Customer, including pending-activation users |
| productId | String FK Product | Product reference; deletion restricted |
| subscriptionId | String?, FK Subscription | Required for RENEWAL; null for initial/one-time |
| kind | INITIAL / RENEWAL / ONE_TIME | Order purpose |
| source | OFFLINE_MANUAL | Only supported source in Task 1.2 |
| productNameSnapshot | VarChar(120) | Immutable product name |
| productTypeSnapshot | SUBSCRIPTION / ONE_TIME | Immutable product type |
| termSnapshot | VarChar(40) | Immutable term |
| amountFen | Int | Agreed order amount in CNY fen |
| renewalPriceSnapshotFen | Int?, nullable | Renewal price snapshot where applicable |
| contactEmailSnapshot | VarChar(254) | Contact email at order creation |
| targetIdentifier | VarChar(254), nullable | Service target identifier; never a password/token |
| paymentStatus | UNPAID / PENDING_VERIFICATION / PAID / REFUND_PENDING / REFUNDED | Summary derived from transaction records and updated transactionally |
| fulfillmentStatus | NOT_STARTED / PROCESSING / COMPLETED / FAILED / CANCELLED | Service progress |
| internalNote | Text?, nullable | Admin-only note |
| createdByAdminId | String FK User | Creating admin |
| createdAt / updatedAt | DateTime(3) | Timestamps |

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
| occurredAt | DateTime(3) | Actual payment/refund time |
| confirmedAt | DateTime(3)?, nullable | Admin confirmation time |
| createdByAdminId | String FK User | Admin who recorded it |
| confirmedByAdminId | String?, FK User | Admin who verified it |
| note | VarChar(500)?, nullable | Admin-only explanation |
| createdAt / updatedAt | DateTime(3) | Timestamps |

This table records customer money only, not supplier transfers. In Task 1.2, payment is manually verified and refund is manually recorded after external action. Support full-order refunds only; no partial payments or partial refunds. The order paymentStatus summary must be recomputed in the same database transaction whenever a transaction changes.

### Subscription

| Field | Type / rule | Meaning |
|---|---|---|
| id / userId / productId | UUID / restrictive FKs | Independent entitlement; no customer/product uniqueness |
| sourceOrderId | Nullable unique Order FK | Preserved historical link; admin API cannot set it |
| sourceType | ADMIN / SYSTEM | API creates ADMIN only; SYSTEM is reserved |
| createdByAdminId | Nullable User FK | ADMIN creator; future SYSTEM creation leaves null |
| productNameSnapshot / productDescriptionSnapshot | VarChar(120) / nullable Text | Frozen product copy |
| productTypeSnapshot / priceSnapshotFen / termSnapshot | ProductType / Int Fen / VarChar(40) | Product price at subscription creation, never proof of payment |
| formSchemaSnapshot / formData | JSON | Frozen schema and strictly validated non-sensitive values |
| targetIdentifier | Nullable legacy VarChar(254) | Preserved read-only, not repurposed or collected by new API |
| startedAt / expiresAt | UTC DateTime(3) | Explicit administrator-entered service dates |
| renewalPriceFen | Nonnegative integer Fen | Current subscription renewal amount |
| note | Nullable VarChar(2000) | Administrator-only service note, not copied verbatim into audit/history |
| status | ACTIVE / TERMINATED | Entitlement additionally requires expiresAt > database now |
| terminatedAt / terminationReason | Nullable DateTime(3) / VarChar(500) | Irreversible manual/system termination |
| version | Int, initial 1 | Optimistic concurrency, increment every successful change |
| createdAt / updatedAt | UTC DateTime(3) | Existing timestamps preserved by migration |

New subscriptions snapshot current product fields. Legacy rows can only snapshot the referenced product at migration time: prior product history cannot be reconstructed. Legacy targetIdentifier remains intact, formData starts empty, and later edits validate supplied formData against the frozen schema. Never invent historic submitted values or payments.

### SubscriptionEvent

Extends the original history table, never replaces it. Existing order/date/actor/reason/timestamp columns and all old event types/rows remain. New actorType is ADMIN/SYSTEM (legacy defaults ADMIN); actorAdminId is nullable for SYSTEM. New beforeJson/afterJson cover mutable state, versions, dates and prices; formData values and note are redacted. New operations emit CREATED, UPDATED, RENEWED, EXPIRY_ADJUSTED, PRICE_CHANGED, FORM_DATA_UPDATED, TERMINATED or AUTO_TERMINATED. One edit can append UPDATED plus specific changed-field events in the same transaction. History is ADMIN-only and paginated.

### IdempotencyRecord

UUID id, restrictive actorAdminId FK, SHA-256 keyHash, SHA-256 canonical requestHash (including operation/target), operation, responseJson and createdAt. Unique (actorAdminId,keyHash). The stored ADMIN-only response may contain service data and must never be logged or exposed to customers. Same key/body replays the committed original response even after later changes; changed body/target/operation returns 409. No raw key/request is stored. Rows are retained for this local milestone; no automatic expiry silently removes replay protection.

### OrderEvent

| Field | Type / rule | Meaning |
|---|---|---|
| id | String PK | Internal ID |
| orderId | String FK Order, indexed with createdAt | Related order |
| eventType | ORDER_CREATED / PAYMENT_RECORDED / PAYMENT_CONFIRMED / REFUND_RECORDED / REFUND_CONFIRMED / FULFILLMENT_CHANGED / COMPLETED / NOTE | Timeline event |
| actorAdminId | String FK User | Admin actor |
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
| updatedAt | DateTime(3) | Last update |

No SMTP or payment credentials belong in AppSettings.

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
  - no recorded payment: UNPAID;
  - payment awaiting admin verification: PENDING_VERIFICATION;
  - confirmed payment: PAID;
  - refund awaiting external completion: REFUND_PENDING;
  - confirmed full refund: REFUNDED;
  - failed refund returns the summary to PAID if the original payment remains confirmed.
- Order.fulfillmentStatus is independent. Only PAID orders can become COMPLETED. A confirmed full refund before completion sets fulfillment to CANCELLED; a refund after completion does not erase the historical completion.
- Confirming payment, confirming refund, completing an order, and applying a renewal date update must use database transactions and append the corresponding OrderEvent/SubscriptionEvent/AdminAuditLog atomically.
- Renewal expiry is entered from supplier-confirmed information; never infer by adding a fixed number of days.
- Phase 2 direct subscription creation/renewal creates no order/payment rows. Changes/events/audits/idempotency commit together; database-clock expiry and version predicates arbitrate concurrent admin/worker actions.
- Legacy sources all migrate to ADMIN with existing creators/references/dates/prices/states intact. SUSPENDED blocks before persistent schema/data changes.
- All money uses integer fen. All timestamps are stored in UTC and displayed in configured business timezone.

## 5. Indexes and deletion rules

- Unique: User.loginEmail, Session.tokenHash, InvitationToken.tokenHash, Product.slug, Order.orderNo, Subscription.sourceOrderId.
- Index: Order(userId, createdAt), Order(paymentStatus, createdAt), Order(fulfillmentStatus, createdAt), Order(subscriptionId, createdAt), PaymentTransaction(orderId, kind, status), Subscription(userId, status), Subscription(expiresAt, status), SubscriptionEvent(subscriptionId, createdAt), OrderEvent(orderId, createdAt), AdminAuditLog(actorAdminId, createdAt).
- Use restrictive foreign keys for orders, payments, subscriptions, and events. Disable users and archive products; do not cascade-delete business history.
- Prisma migrations are the only schema-change mechanism. Never use destructive schema push against the local data volume.
