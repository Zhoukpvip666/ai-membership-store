# Product Requirements

## 1. Product summary

Build an independent storefront for reselling AI membership services and other digital services. Customers browse products, submit the information required for a service, pay the reseller, and track order progress. The operator manages supplier communication, supplier transfers, fulfillment, subscriptions, and customer notifications.

The first release deliberately supports manual operations. It must be useful before the supplier has an API and before an automated payment API is available.

## 1.1 Operating model: single merchant only

- The site owner is the only merchant and the only seller using the merchant console.
- Customers are buyers only. Customer registration must never create a merchant account or a payment-provider sub-merchant account.
- There is no public merchant registration, merchant onboarding, merchant store, merchant wallet, merchant balance, merchant withdrawal, marketplace split settlement, or multi-merchant commission feature.
- The owner configures one payment-provider merchant identity through provider credentials and onboarding outside the application.
- The application may display the owner's order-level payment, refund, and settlement records returned by the provider. It does not hold customer funds or independently custody/transfer money.
- If the selected provider offers a compliant order-level delayed-settlement, split, or refund-from-held-funds product, it may be integrated only after the owner confirms provider eligibility and contract terms. The application cannot freeze funds merely by keeping an order in a pending state.

## 2. Goals

- Present subscription services and one-time services with clear prices and terms.
- Let customers create accounts, place orders, and see their own orders.
- Collect only the non-sensitive information needed to submit an order to the supplier.
- Allow the operator to verify customer payments manually.
- Send a structured supplier request email after customer payment verification.
- Let the operator record the per-order supplier transfer.
- Let the operator confirm supplier fulfillment and notify the customer by email.
- Track subscription expiry and renewal price separately from individual orders.
- Provide an administrative view of sales, costs, pending work, and customer records.

## 3. Non-goals for the MVP

- Automatic recurring billing or automatic renewal charges.
- Automatic supplier payment or bank/WeChat transfer.
- Supplier API, webhook, or browser automation.
- Third-party account login, password handling, or membership activation automation.
- Customer wallet, stored-value balance, multi-level affiliate system, coupons, or multi-supplier routing.
- Complex tax, invoicing, or accounting automation.

## 4. User roles

### Customer
- Browse active products.
- Register and log in.
- Submit an order with the product's configured non-sensitive fields.
- Follow the payment instructions and submit a payment notice if enabled.
- View order status and order history.
- View active, expired, and pending subscriptions.
- View renewal price and expiry date.
- Place a renewal order.
- Manage basic profile and notification email.

### Owner / administrator (single back office)
The site owner uses one unified management console. Do not split it into a separate merchant portal and system-administrator portal.

- View dashboard metrics and operational queues.
- Create, edit, publish, archive, and sort products.
- Configure product type, initial price, renewal price, service duration, and form fields.
- View customer orders and submitted order information.
- Verify customer payment after checking the actual payment account or provider console.
- Send/resend supplier request email.
- Record supplier transfer amount, time, method, and transaction reference.
- Record supplier progress and exceptions.
- Confirm fulfillment only after checking the supplier's completion evidence.
- Record the resulting membership expiry date.
- Manage users and subscriptions.
- Review email delivery logs and administrator audit logs.

## 5. Product model

### Subscription service
A subscription product has a name, description, category, initial purchase price, renewal price, service period, required non-sensitive form fields, internal supplier cost reference, and publication status.

A subscription is an entitlement record, not a payment mandate. Renewal is a new order that the customer actively places and pays for. No automatic charge is performed.

### One-time service
A one-time service has a name, description, category, one-time selling price, required non-sensitive form fields, internal supplier cost reference, and publication status. It has no renewal price or expiry unless explicitly configured otherwise.

### Price snapshots
The order preserves the product name, product type, selling price, renewal price (when relevant), term, and supplier cost reference as they were when the order was placed. Later product edits must not rewrite historical orders.

The approved page layouts, responsive behavior, concise visual style, and prototype interactions are specified in [08-interface-specification.md](08-interface-specification.md). Treat that document as the UI source of truth.

## 6. Customer-facing pages

### Product catalog
- Show active products only.
- Distinguish subscription and one-time services.
- Show price, term, renewal price when relevant, and a clear purchase action.
- Support category filtering and basic sorting.
- Show accurate service descriptions and fulfillment expectations.

### Product detail and checkout
- Show product description, price, term, renewal price, and important conditions.
- Render the product's configured form fields.
- Validate required fields in browser and server.
- Show order summary before submission.
- Create an order with a server-calculated price.
- Never trust a price or discount supplied by the browser.

### My subscriptions
- List the customer's subscription records.
- Show product, masked service/account identifier where appropriate, status, start date, expiry date, and current renewal price.
- Provide a renewal action that creates a new order.
- Show previous renewal orders or link to order history.
- Do not promise automatic renewal.

### My orders
- List orders belonging to the authenticated customer.
- Show order number, product snapshot, amount, creation time, payment state, fulfillment progress, and final result.
- Provide a detail view with a human-readable timeline.
- Do not expose internal supplier cost, supplier payment evidence, internal notes, or another customer's data.

### Account/profile
- Show account email and basic profile.
- Allow safe profile and notification-email updates.
- Provide password change and logout.
- Do not expose authentication secrets or internal notes.

## 7. Unified owner/admin console

There is one management console for the site owner. Its navigation combines all merchant operations and administrative controls; no separate merchant-side application or admin-side application is required.

Recommended navigation:
1. Overview
2. Products
3. Orders
4. Subscriptions
5. Users
6. Settings

### Dashboard
- Customer sales total for a selected period.
- Number of orders by status.
- Subscription count and upcoming expirations.
- Pending payment verification.
- Orders waiting for supplier transfer or fulfillment.
- Keep the overview simple: today's verified receipts, this month's verified receipts, total order count, pending-delivery count, recent orders, and active/expired subscription counts. Do not show supplier procurement cost, gross profit, merchant wallet balance, or withdrawable balance in the first version.

### Product management
- Product CRUD and publication status.
- Product type: subscription or one-time.
- Initial price and renewal price.
- Term description and configured duration.
- Product-specific form field configuration.
- Product images and display ordering.

### Order management
- Search by order number, customer, product, and status.
- View customer-submitted non-sensitive fields.
- Verify customer payment.
- Send/resend supplier request email.
- Record supplier transfer.
- Update fulfillment progress.
- Mark success or failure.
- Record external refund outcome.
- View order and email timeline.

### Subscription management
- Search subscriptions by customer, product, status, or expiry.
- View initial and renewal orders.
- Record start and expiry dates confirmed by supplier.
- Record renewal price snapshot.
- Suspend or mark a subscription expired when appropriate.
- View reminder history.

### User management
- Search users.
- View account details and order/subscription history.
- Disable access when justified.
- Never display passwords or authentication tokens.

### Settings
- Supplier contact email and optional operator CC.
- Email sender configuration status.
- Customer payment instructions and manual-verification notice.
- Business timezone.
- Expiry reminder schedule.
- SMTP credentials are deployment secrets, not ordinary settings-table values.

## 8. Payment and fulfillment rules

### Customer payment
- MVP payment verification is manual.
- The first frontend prototype uses mock checkout only. Real payment integration is out of scope until an eligible provider is selected and approved.
- The checkout page may display administrator-configured, compliant payment instructions.
- A customer clicking "I have paid" only changes the order to pending verification; it does not mark the order paid.
- An administrator verifies the actual transaction in the relevant payment account.
- A screenshot alone is not sufficient proof.
- Only verified payment may trigger the supplier request email.

### Supplier request and transfer
- After customer payment is verified, create a supplier fulfillment record and queue a supplier request email.
- Email includes internal order number, product snapshot, customer contact/target identifier, and approved non-sensitive form values.
- The operator manually transfers the supplier's fixed per-order amount.
- The operator records amount, transfer time, channel, and transaction reference/note.
- The platform does not initiate or simulate a money transfer.

### Supplier fulfillment
- Supplier performs the service outside the platform.
- Supplier may send an invitation or activation link directly to the customer's designated email.
- Operator checks supplier completion confirmation and updates the order.
- Only then does the system send the customer completion email.
- The completion email must not claim invitation delivery unless the operator verified it.

### Failure and refund
- Supplier rejection, delay, or failure is recorded as an exception.
- Operator contacts customer and decides whether to retry, offer an alternative, or refund under the published policy.
- Refunds are performed through the actual payment provider/account, not simulated by changing a database status. The first frontend prototype may show a simulated refund interaction only and must label it clearly.
- Record the external refund reference and operator.

## 9. Subscription and renewal rules

- A subscription record is created or activated only after supplier completes the initial service and the operator confirms it.
- Each renewal is a new order linked to the existing subscription.
- Renewal price is snapshotted when renewal order is created.
- Operator records the new expiry date based on supplier confirmation.
- Do not automatically add a fixed number of days until supplier renewal behavior is confirmed for that product.
- Expiry reminders are configurable; initial proposed schedule: 7, 3, and 1 day before expiry.
- Reminder jobs must be idempotent.
- A reminder does not create or charge a renewal.

## 10. MVP acceptance criteria

- Visitor can browse active subscription and one-time products.
- Authenticated customer can place an order using product-specific fields.
- Server calculates and snapshots price.
- Administrator can verify customer payment manually.
- Verified payment queues supplier request email.
- Administrator can record supplier transfer and fulfillment progress.
- Administrator can complete an order and trigger customer email.
- Customers can view only their own orders and subscriptions.
- Subscription shows renewal price and expiry date.
- Renewal creates a separate order and preserves history.
- Important state changes are audited.
- No password, OTP, 2FA code, recovery code, or session cookie is collected or emailed.
