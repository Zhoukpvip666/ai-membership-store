# Initial Data Model

Logical model for MVP. Codex may refine column names and Prisma relations but must preserve domain rules and historical snapshots.

## 1. Core entities

### users
Customer and administrator accounts.

| Field | Meaning |
|---|---|
| id | Primary key |
| email | Unique login email |
| password_hash | Password hash only |
| display_name | Optional display name |
| role | CUSTOMER or ADMIN |
| status | ACTIVE or DISABLED |
| email_verified_at | Optional verification timestamp |
| created_at / updated_at | Audit timestamps |

Never store plaintext password or session token.

### products
Sellable subscription or one-time services.

| Field | Meaning |
|---|---|
| id | Primary key |
| slug | Unique public identifier |
| name | Display name |
| description | Customer-facing description |
| product_type | SUBSCRIPTION or ONE_TIME |
| initial_price_fen | Initial selling price |
| renewal_price_fen | Renewal price; nullable for one-time products |
| term_label | Human-readable term, e.g. 1 month |
| term_days | Optional duration; avoid assuming calendar-month arithmetic |
| supplier_cost_fen | Internal cost reference |
| status | DRAFT, ACTIVE, or ARCHIVED |
| sort_order | Catalog ordering |
| created_at / updated_at | Timestamps |

Prices are integer fen. Supplier cost is never returned by public product APIs.

### product_form_fields
Configurable non-sensitive fields for a product.

| Field | Meaning |
|---|---|
| id | Primary key |
| product_id | Parent product |
| field_key | Stable key within product |
| label | Customer-facing label |
| field_type | TEXT, EMAIL, TEXTAREA, SELECT, CHECKBOX |
| required | Whether required |
| options_json | SELECT options |
| validation_json | Length/pattern constraints |
| help_text | Customer guidance |
| sort_order | Display order |
| active | Whether field is used |

Do not support PASSWORD, OTP, 2FA, RECOVERY_CODE, SESSION_COOKIE, or payment credential field types in MVP.

### orders
One row per customer purchase or renewal.

| Field | Meaning |
|---|---|
| id | Primary key |
| order_no | Unique public order number |
| user_id | Customer |
| product_id | Product reference |
| subscription_id | Existing subscription for renewal; nullable otherwise |
| order_kind | INITIAL, RENEWAL, or ONE_TIME |
| product_snapshot_json | Immutable name, type, term, description |
| form_snapshot_json | Submitted approved non-sensitive values |
| selling_price_fen | Immutable customer price |
| supplier_cost_snapshot_fen | Internal cost snapshot |
| renewal_price_snapshot_fen | Renewal price snapshot when relevant |
| customer_payment_status | UNPAID, PENDING_VERIFICATION, PAID, REFUND_PENDING, REFUNDED, FAILED |
| supplier_payment_status | NOT_REQUIRED, PENDING, RECORDED, EXCEPTION |
| fulfillment_status | NOT_STARTED, REQUEST_QUEUED, PROCESSING, COMPLETED, FAILED, CANCELLED |
| created_at / updated_at | Timestamps |

Server calculates amounts and statuses; never trust browser values.

### payment_records
Records external customer payments and supplier transfers.

| Field | Meaning |
|---|---|
| id | Primary key |
| order_id | Related order |
| direction | CUSTOMER_INBOUND or SUPPLIER_OUTBOUND |
| amount_fen | Amount |
| method | Manual method/provider label |
| external_reference | Transaction reference if available |
| status | PENDING, VERIFIED, FAILED, REFUNDED |
| verified_by | Administrator |
| verified_at | Verification timestamp |
| note | Non-sensitive operator note |
| created_at | Timestamp |

This is a record of external transaction, not a transfer API.

### supplier_fulfillments
Supplier request and fulfillment details.

| Field | Meaning |
|---|---|
| id | Primary key |
| order_id | Unique order relation in MVP |
| supplier_name | Supplier snapshot |
| supplier_email | Recipient snapshot |
| request_email_status | NOT_QUEUED, QUEUED, SENT, FAILED |
| request_email_id | Related outbox record |
| supplier_order_reference | Optional supplier reference |
| supplier_accepted_at | Optional timestamp |
| completed_at | Supplier completion confirmation |
| result_note | Non-sensitive internal note |
| created_at / updated_at | Timestamps |

### subscriptions
Customer membership/entitlement records.

| Field | Meaning |
|---|---|
| id | Primary key |
| user_id | Customer |
| product_id | Product |
| account_identifier | Masked target identifier |
| status | PENDING, ACTIVE, EXPIRED, SUSPENDED, CANCELLED |
| started_at | Confirmed service start |
| expires_at | Confirmed service expiry |
| renewal_price_fen | Current renewal price snapshot |
| last_order_id | Most recent successful order |
| created_at / updated_at | Timestamps |

Expiry is recorded from supplier confirmation. Do not infer renewal stacking rules.

### subscription_events
History of activation, renewal, expiry changes, suspension, and corrections.

| Field | Meaning |
|---|---|
| id | Primary key |
| subscription_id | Related subscription |
| order_id | Related order, nullable for admin event |
| event_type | ACTIVATED, RENEWED, EXPIRY_UPDATED, EXPIRED, SUSPENDED, NOTE |
| old_expires_at | Previous expiry |
| new_expires_at | New expiry |
| actor_user_id | Admin or system actor |
| note | Non-sensitive explanation |
| created_at | Timestamp |

### email_outbox
Durable queue and delivery history.

| Field | Meaning |
|---|---|
| id | Primary key |
| idempotency_key | Unique logical email event |
| related_order_id | Optional order |
| recipient | Email recipient |
| cc | Optional CC |
| template_key | Template identifier |
| payload_json | Sanitized template data |
| status | PENDING, SENDING, SENT, FAILED |
| attempt_count | Attempts |
| next_attempt_at | Retry time |
| last_error | Sanitized error |
| sent_at | Successful send time |
| created_at / updated_at | Timestamps |

No SMTP credentials or authentication secrets in payload.

### admin_audit_logs
Important administrator action history.

| Field | Meaning |
|---|---|
| id | Primary key |
| actor_user_id | Administrator |
| action | Action identifier |
| entity_type | Order, product, subscription, user, setting |
| entity_id | Affected entity |
| before_json / after_json | Sanitized state changes |
| request_id | Optional correlation ID |
| created_at | Timestamp |

Never copy passwords, OTPs, tokens, or secrets into audit logs.

## 2. Relationships

- One user has many orders.
- One product has many orders and form-field definitions.
- One order has zero or one supplier fulfillment record in MVP.
- One order has multiple payment records because customer payment and supplier transfer are distinct.
- One user can have many subscriptions.
- One subscription has many renewal orders and subscription events.
- One order can create multiple email outbox events.
- Admin actions create audit entries.

## 3. Historical consistency

- Snapshot product name, type, term, selling price, renewal price, supplier cost on order creation.
- Product edits do not alter existing orders.
- Submitted form values are order snapshots and are not overwritten by later form changes.
- Renewal creates a new order and subscription event; it does not overwrite old orders.
- Subscription expiry changes have event records.

## 4. Indexes and constraints

- Unique: users.email, products.slug, orders.order_no, product_form_fields(product_id, field_key), email_outbox.idempotency_key.
- Index: orders(user_id, created_at), orders(customer_payment_status, created_at), orders(fulfillment_status, created_at), subscriptions(user_id, status), subscriptions(expires_at, status), payment_records(order_id, direction).
- Use foreign keys and appropriate delete restrictions. Do not cascade-delete financial/order history when user or product is disabled.
