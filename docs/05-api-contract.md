# Initial REST API Contract

Base path: /api/v1

Initial contract for MVP. Formalize schemas in TypeScript and validate with Zod during implementation.

## 1. Conventions

- JSON request/response.
- Authentication through secure server-side session cookie.
- Every protected route enforces backend authorization.
- Consistent errors with stable code and human-readable message.
- Server-generated order numbers.
- Integer fen for money.
- UTC timestamps in API payloads.
- Never return supplier costs, secrets, password hashes, session IDs, or internal notes to customers.
- Use request IDs for tracing.
- Validate and normalize all input.

Suggested error:

~~~json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please check the submitted fields.",
    "requestId": "..."
  }
}
~~~

## 2. Authentication

| Method | Path | Purpose |
|---|---|---|
| POST | /auth/register | Register customer |
| POST | /auth/login | Login |
| POST | /auth/logout | Logout |
| GET | /auth/me | Current account |
| POST | /auth/change-password | Change password |

Password reset/email verification may be added after email configuration.

## 3. Public catalog

| Method | Path | Purpose |
|---|---|---|
| GET | /products | List active products |
| GET | /products/:slug | Product detail and public form fields |

Public responses include selling price, product type, term, renewal price when relevant, and public form metadata. Omit supplier cost and internal supplier details.

## 4. Customer orders

| Method | Path | Purpose |
|---|---|---|
| POST | /orders | Create order |
| GET | /me/orders | List current customer's orders |
| GET | /me/orders/:orderNo | Order detail and customer-visible timeline |
| POST | /orders/:orderNo/payment-submitted | Optional notice of attempted payment |

Order input contains product identifier, optional subscription identifier for renewal, and approved non-sensitive form values. Server determines price and order kind.

Payment-submitted only marks pending verification; it never marks order paid.

## 5. Customer subscriptions

| Method | Path | Purpose |
|---|---|---|
| GET | /me/subscriptions | List current customer's subscriptions |
| GET | /me/subscriptions/:id | Subscription detail and renewal history |
| POST | /me/subscriptions/:id/renew | Create renewal order |

Renewal endpoint checks ownership, eligibility, and current renewal price server-side. It creates a new order; it does not charge customer or extend expiry.

## 6. Admin dashboard and products

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/dashboard | Metrics and work queues |
| GET | /admin/products | List all products |
| POST | /admin/products | Create product |
| GET | /admin/products/:id | Product detail |
| PATCH | /admin/products/:id | Update product |
| POST | /admin/products/:id/archive | Archive product |
| PUT | /admin/products/:id/form-fields | Replace product form-field configuration |

Product writes require admin authorization and server validation.

## 7. Admin orders and fulfillment

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/orders | Search/filter orders |
| GET | /admin/orders/:orderNo | Full internal order detail |
| POST | /admin/orders/:orderNo/verify-customer-payment | Verify customer payment |
| POST | /admin/orders/:orderNo/send-supplier-email | Queue/retry supplier email |
| POST | /admin/orders/:orderNo/record-supplier-transfer | Record manual supplier transfer |
| POST | /admin/orders/:orderNo/mark-processing | Mark supplier processing |
| POST | /admin/orders/:orderNo/complete | Confirm fulfillment and queue customer email |
| POST | /admin/orders/:orderNo/fail | Record fulfillment failure |
| POST | /admin/orders/:orderNo/record-refund | Record externally completed refund |

Payment verification requires admin and records actor/time. In one transaction it updates payment state, creates supplier fulfillment record, and queues supplier email with unique idempotency key.

Supplier email retry must not create another procurement record.

Recording supplier transfer does not call a bank/payment API.

Completion requires valid state. For subscription order, operator must provide actual start/expiry details confirmed by supplier before activation.

## 8. Admin subscriptions and users

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/subscriptions | Search subscriptions |
| GET | /admin/subscriptions/:id | Subscription detail/events |
| PATCH | /admin/subscriptions/:id | Correct status or confirmed dates with audit |
| GET | /admin/users | Search users |
| GET | /admin/users/:id | User detail/history |
| PATCH | /admin/users/:id/status | Enable/disable account |

All admin routes require server-side ADMIN authorization.

## 9. Email and settings

| Method | Path | Purpose |
|---|---|---|
| GET | /admin/email-outbox | View email queue/delivery |
| POST | /admin/email-outbox/:id/retry | Retry failed email |
| GET | /admin/settings/public | Public checkout/payment instructions |
| PATCH | /admin/settings | Update non-secret business settings |

SMTP credentials are not managed by normal settings API. They are deployment secrets.

## 10. State transitions

- Customer payment: UNPAID -> PENDING_VERIFICATION -> PAID only through admin verification.
- Supplier email queued only after payment PAID.
- Supplier transfer recorded only for a paid order with supplier fulfillment.
- Fulfillment cannot be COMPLETED before supplier confirms success and operator verifies it.
- Subscription activation/renewal is committed in same transaction as order completion.
- Duplicate state-changing requests must be safe using transactions, unique constraints, and idempotency keys.
- Invalid transitions return conflict and do not partially update DB.

## 11. Future integrations (not MVP)

Future payment-provider webhooks and supplier APIs require official docs, merchant eligibility, signing requirements, callback behavior, refund flow, and idempotency requirements. Do not invent provider payloads in MVP.
