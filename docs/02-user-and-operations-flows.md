# User and Operations Flows

> **T25 approved flow (pending implementation):** ADMIN creates a customer record using only the private label, can associate orders/subscriptions before activation, and shares the existing one-time invitation. The customer registers with their own email and password; the system atomically claims the same User ID, consumes the invitation and signs the customer in. Existing email conflicts follow ordinary registration rules; no account merge. See [T25 contract](34-customer-claim-registration.md).

> **Document scope:** These are the original end-to-end target flows with historical phase notes. The [current project status](00-project-status.md) identifies implemented flows. Supplier emails/outbox, supplier transfer recording, notification/reminder delivery and order-based renewal below remain planned; they are not side effects of the current manual payment or fulfillment APIs.

> **Historical Phase 2 override (2026-11-17):** The owner separately authorized user-name refactoring and administrator-only subscription management before offline orders. `displayName` becomes nullable `username` (customer-owned, no new editing/activation flow yet) and `adminLabel` (admin-only). Admin naming is adminLabel → username → login-email prefix; customer responses exclude adminLabel. Subscription sources are ADMIN/SYSTEM, stored states ACTIVE/TERMINATED. Admin creates independent subscription records and directly edits/renews/terminates them without orders, payments, email or automatic duration arithmetic. Product/form snapshots are frozen; archived products block new subscriptions/renewals but allow maintenance of existing unexpired subscriptions. Expired ACTIVE rows grant no entitlement and cannot be edited/renewed, even before the minute worker terminates them. [Phase 2 details](14-user-subscription-core.md) supersede conflicting legacy subscription rules below. No development database migration is performed by implementation/tests.


## 1. Customer purchase flow

1. Customer opens the product catalog.
2. Customer selects a subscription service or one-time service.
3. Customer reviews description, price, term, renewal price (if applicable), and fulfillment conditions.
4. Customer signs in or registers.
5. Customer fills product-specific, non-sensitive fields.
6. Server validates fields and calculates price from current product configuration.
7. Server creates an order and stores product/price/form snapshots.
8. Customer sees configured payment instructions.
9. Customer may click "I have paid" to request verification. This does not confirm payment.
10. Order appears as awaiting payment verification.

## 2. Operator payment-verification flow

1. Operator opens the pending payment queue.
2. Operator checks the actual transaction in the merchant/payment account.
3. Operator compares transaction amount and order reference.
4. Operator confirms payment in the admin console.
5. System records who verified payment and when.
6. System creates supplier fulfillment record.
7. System queues supplier request email. It must not send before payment verification.
8. If email delivery fails, outbox retains failure and supports retry without creating a second supplier fulfillment record.

## 3. Supplier request email

Suggested subject:

~~~text
[New Service Order] {order_number} - {product_name}
~~~

Suggested body fields:
- Internal order number.
- Product/service name and term.
- Customer's designated contact email.
- Target account identifier required for service.
- Product-specific approved non-sensitive values.
- Requested service/quantity.
- Operator-approved note.

Do not include passwords, OTPs, 2FA codes, recovery codes, session cookies, payment card data, or unrelated personal information. Do not include customer's payment credentials or operator's private payment credentials.

Supplier recipient is configured by an administrator. Operator may be CC'd.

## 4. Supplier payment and processing

1. Operator reviews supplier cost on order snapshot.
2. Operator manually transfers agreed fixed per-order amount.
3. Operator records amount, timestamp, channel, and transaction reference/note.
4. Operator marks supplier payment recorded/confirmed based on actual transaction evidence.
5. Operator updates fulfillment to processing when supplier accepts request.
6. System records transitions in order timeline and audit log.

The application only records the operator's external action; it never claims to transfer money.

## 5. Supplier completion

1. Supplier completes service outside platform.
2. Supplier sends invitation/activation link or confirmation through agreed channel, usually directly to customer's designated mailbox.
3. Operator verifies completion using supplier confirmation and expected recipient information.
4. For subscription products, operator enters confirmed service start and expiry dates.
5. Operator marks fulfillment complete.
6. System queues customer completion email.
7. Customer sees completed order and general instructions.

The platform does not verify a third-party mailbox unless an explicitly approved integration is built later.

## 6. Subscription initial activation

1. Customer buys subscription product.
2. Order follows normal payment and supplier workflow.
3. After supplier completion, operator creates/activates subscription or links order to existing subscription.
4. Operator records actual start and expiry dates confirmed by supplier.
5. Customer subscription page shows status, expiry date, and renewal price.

## 7. Subscription renewal

1. Customer opens My Subscriptions.
2. Customer selects an eligible subscription.
3. Site displays current renewal price and creates renewal order.
4. Customer pays.
5. Operator verifies payment.
6. Supplier request email is queued.
7. Operator manually transfers supplier renewal cost.
8. Supplier completes renewal.
9. Operator records new expiry date confirmed by supplier.
10. Renewal order is completed and linked to subscription.
11. Subscription page reflects new expiry and retains all historical renewal orders.

Do not assume renewals stack automatically. Confirm supplier behavior per product.

## 8. One-time service

A one-time service follows the same order, payment verification, supplier email, manual transfer, and fulfillment flow. It does not create a subscription record unless explicitly configured.

## 9. Customer-visible order timeline

- Order created.
- Awaiting payment verification.
- Payment confirmed.
- Service request submitted.
- Service processing.
- Service completed.
- Order exception or refund update, if applicable.

Do not expose supplier cost, supplier transfer reference, internal notes, or internal email content to customers.

## 10. Exception handling

### Customer payment cannot be found
Keep order unconfirmed. Do not send supplier request. Ask customer to verify payment details and record operator note.

### Supplier email fails
Keep order paid but supplier-notification pending. Retry same outbox message. Do not create duplicate supplier fulfillment.

### Supplier transfer delayed or fails
Keep supplier payment pending. Do not mark paid or processing until supplier accepts request.

### Supplier rejects or cannot fulfill
Mark fulfillment failed/exception. Operator contacts customer and handles retry, alternative, or refund under published policy.

### Supplier completes but customer does not see invitation
Keep completion evidence and timestamps. Ask customer to check correct mailbox, spam, and recipient. Do not automatically create a second purchase. Handle resend/reissue through supplier's approved process.

### Customer requests cancellation
Check payment and fulfillment states. If supplier work/payment has begun, require operator review. Record any refund through actual payment channel and store external reference.
