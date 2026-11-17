# Local Operations Data Model (Task 1.2)

This is the approved data model for the first persistent, local-only operating version. It supersedes the earlier conceptual model where it conflicts with this document. Full workflow and scope rules are in [10-local-operations-mvp.md](10-local-operations-mvp.md).

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
| displayName | VarChar(80) | Customer/admin display name |
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
| id | String PK | Internal ID |
| userId | String FK User, indexed | Owner; may be PENDING_ACTIVATION |
| productId | String FK Product | Product |
| sourceType | ORDER / MANUAL_GRANT / HISTORICAL_IMPORT | Why the entitlement exists |
| sourceOrderId | String?, unique FK Order | Required for ORDER source; null for manual grant/import unless a real historical order is recorded |
| targetIdentifier | VarChar(254) | Actual service target, separate from login email |
| startedAt | DateTime(3) | Confirmed service start |
| expiresAt | DateTime(3), indexed | Confirmed expiry |
| renewalPriceFen | Int | Current renewal price snapshot |
| status | ACTIVE / SUSPENDED / TERMINATED | Stored state |
| createdByAdminId | String FK User | Admin who created it |
| createdAt / updatedAt | DateTime(3) | Timestamps |

Display EXPIRED when status is ACTIVE and expiresAt is in the past; do not require a scheduled job to calculate the display state. A subscription can exist without an order for MANUAL_GRANT or HISTORICAL_IMPORT. No uniqueness constraint on userId + productId: a customer may have multiple entitlements for the same product/target.

### SubscriptionEvent

| Field | Type / rule | Meaning |
|---|---|---|
| id | String PK | Internal ID |
| subscriptionId | String FK Subscription, indexed with createdAt | Related entitlement |
| orderId | String?, FK Order | Related initial/renewal order when applicable |
| eventType | CREATED / ACTIVATED / RENEWED / EXPIRY_ADJUSTED / MANUAL_GRANT / HISTORICAL_IMPORT / SUSPENDED / RESUMED / TERMINATED / NOTE | Change type |
| oldStartedAt / newStartedAt | DateTime?, nullable | Start-date change |
| oldExpiresAt / newExpiresAt | DateTime?, nullable | Expiry-date change |
| actorAdminId | String FK User | Admin actor |
| reason | VarChar(500)?, nullable | Required for manual correction/termination |
| createdAt | DateTime(3) | Event time |

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
| actorAdminId | String FK User, indexed with createdAt | Admin actor |
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
- Manual grant and historical import create subscription/event records, not fake order/payment rows.
- All money uses integer fen. All timestamps are stored in UTC and displayed in configured business timezone.

## 5. Indexes and deletion rules

- Unique: User.loginEmail, Session.tokenHash, InvitationToken.tokenHash, Product.slug, Order.orderNo, Subscription.sourceOrderId.
- Index: Order(userId, createdAt), Order(paymentStatus, createdAt), Order(fulfillmentStatus, createdAt), Order(subscriptionId, createdAt), PaymentTransaction(orderId, kind, status), Subscription(userId, status), Subscription(expiresAt, status), SubscriptionEvent(subscriptionId, createdAt), OrderEvent(orderId, createdAt), AdminAuditLog(actorAdminId, createdAt).
- Use restrictive foreign keys for orders, payments, subscriptions, and events. Disable users and archive products; do not cascade-delete business history.
- Prisma migrations are the only schema-change mechanism. Never use destructive schema push against the local data volume.
