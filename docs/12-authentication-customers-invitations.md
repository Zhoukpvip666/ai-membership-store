# Task 1.2.2 — Authentication, customers, and invitations

> **Later approved design:** [T25 customer records and invitation registration](34-customer-claim-registration.md) will replace the required administrator-assigned email and password-only activation with customer-chosen email/password registration on the existing invited User ID. Preserve this original milestone report and test results; T25 is not yet implemented.

> Historical milestone report. See [current project status](00-project-status.md) for merged capabilities. [Phase 2](14-user-subscription-core.md) records the later user/subscription compatibility contract; subsequent order centers, subscription reads and public registration are also merged. Prior table/test counts, invitation-only registration and displayName/source/status descriptions below belong to their original milestone.

## Scope and status

This historical delivery implemented only the approved local authentication/customer/invitation milestone. Task 1.2.3 had not started at that time and is now merged. The report's existing 11-table schema and initial migration were unchanged. Implementation and verification used a separate worktree; the original checkout, local `.env`, running API and development database were preserved.

## Implemented behavior

- Administrator and activated-customer login, logout and current-account reads. Password verification uses Argon2id; new customer passwords are set only by the customer during invitation activation.
- Server-side database sessions with independent cryptographically random 32-byte tokens, SHA-256 hashes at rest, fixed 12-hour expiry and revocation. Cookies are host-only, HttpOnly, SameSite=Strict, Path=/; Secure is enabled for HTTPS application origins. Tokens are never stored in localStorage or returned as JSON.
- Every `/api/v1/admin` path requires an active database session and ADMIN role, including paths reserved for future work. Session expiry, revocation and current user status are checked on each protected request.
- Customer listing with search/status filters and pagination, creation, profile editing, details with actual order/subscription counts, disable and restore. Login emails are normalized and unique across users. New customers have role CUSTOMER, status PENDING_ACTIVATION and no password. No administrator password-setting or role-changing payload is accepted.
- Login email is immutable after creation, matching the existing PATCH contract. Display name and optional notification email can be edited. A null notification email means the login email is the effective notification address.
- Disabling a customer revokes their sessions and unused invitations without deleting their orders or subscriptions. Restoring returns previously activated customers to ACTIVE and others to PENDING_ACTIVATION; old sessions and revoked invitations remain invalid.
- Invitations expire after seven days, store only a SHA-256 token hash, and are consumed transactionally once. Reissuing revokes all previous unused invitations. Administrators can explicitly revoke unused invitations. Only pending, unactivated customers can receive an invitation; this is not a password-reset flow.
- The raw invitation URL is returned only by its creation response, shown for copying in the current detail dialog, and discarded on close. List/detail/audit responses never recover the URL or return token/password hashes. The activation token uses a URL fragment, which is not sent to the HTTP server, and is removed from the current browser history entry on page entry.
- Customer activation validates the invitation, saves an Argon2id password and changes the account to ACTIVE in a serializable transaction. Expired, revoked, reused and concurrently consumed tokens fail. Activation does not automatically log the customer in.
- Vue login screens, authenticated navigation, real customer management dialogs, invitation copying/history/revocation and activation screens retain the existing desktop/mobile styling. Local-only invitation and no-email notices are visible. When automatic clipboard access fails, the readonly field supports manual copying.
- Real customer profiles display only the signed-in account. Real customers cannot enter administrator pages or see the prototype's fictitious order/subscription histories. Those account pages explain that real history reads belong to Task 1.2.6. Unrelated administrator prototypes remain clearly marked Mock; public/customer purchasing is disabled.

Pending-activation customers may continue to own existing orders and subscriptions. There is no activation requirement on those foreign keys and no order/subscription write endpoint in this change.

## API and security

Implemented endpoints:

| Method | Path below `/api/v1` | Access |
| --- | --- | --- |
| POST | `/auth/login` | Public, rate limited |
| POST | `/auth/logout` | Clears/revokes the current session; safe to repeat |
| GET | `/auth/me` | Active authenticated account |
| POST | `/auth/activate` | Public, valid single-use invitation, rate limited |
| GET / POST | `/admin/users` | ADMIN |
| GET / PATCH | `/admin/users/:id` | ADMIN, CUSTOMER targets only |
| PATCH | `/admin/users/:id/status` | ADMIN, reason required |
| POST | `/admin/users/:id/invitations` | ADMIN |
| POST | `/admin/invitations/:id/revoke` | ADMIN |

All mutations require JSON, the exact configured `APP_BASE_URL` origin and `X-Requested-With: MembershipStore`. No permissive CORS is enabled. Login and activation each allow 30 requests per IP per 15 minutes; administrator mutations allow 120. These bounded, process-local limits reset when the API restarts. Request bodies are limited to 16 KiB. Strict Zod schemas reject extra privileged fields. Invalid credentials share one response to reduce account enumeration.

Customer/invitation changes and their sanitized administrator audit entries commit together. Serializable transactions retry transient write conflicts; concurrent invitation issuance leaves one valid link, and concurrent activation permits one winner. Public errors include a request ID and safe error code/message without Prisma details, credentials or hashes. Responses use no-store and no-referrer headers. This remains a loopback-only local application, not a public deployment configuration.

## Local operation

Use Node.js 24, the existing MySQL 8.4 database and the already-seeded administrator. Do not copy or overwrite an existing `.env`. Existing Task 1.2.1 installations need no migration, seed or database reset for this change.

From the feature checkout, with its own existing local configuration available:

```powershell
npm ci
npm run dev:api
```

In a second terminal at the same checkout:

```powershell
npm run dev:web
```

Open the frontend at the exact origin configured in `APP_BASE_URL`, normally `http://localhost:5173`. The Vite `/api` proxy uses the configured loopback `API_PORT` (default 3000). If another checkout's API is already running on that port, stop it manually before starting the feature API, or use a separate local API port consistently. This task did not interrupt the original running service.

1. Visit `/admin/login` and use the administrator previously initialized in the local database. Changing `ADMIN_PASSWORD` does not reset that database password.
2. Open user management, create a pending customer, then open details and generate/copy the invitation.
3. Open the copied invitation on the same computer. Set a 12–128 character password and activate. Sign in at `/login` afterward.
4. Reopening details cannot retrieve the original link. Generate a replacement if needed; the previous unused link becomes invalid.

Localhost/127.0.0.1 invitations work only on the computer running the application. No invitation or other email is sent. Setup of a completely fresh database remains documented in [the foundation guide](11-database-foundation.md).

## Verification

All checks below passed on the final implementation. Tests use fictitious fixtures only.

| Check | Result |
| --- | --- |
| `npm run format:check` | Passed |
| `npm run typecheck` | Passed: frontend, backend and E2E TypeScript |
| `npm run lint` | Passed |
| `npm test` | 29/29 passed: 17 frontend and 12 backend unit/HTTP tests |
| `npm run db:validate` | Passed |
| `npm run test:db` | 24/24 passed: 8 foundation, 2 readiness/restart, 14 authentication/customer/invitation tests |
| `npm run build` | Passed: frontend Vite and backend TypeScript |
| `npm run test:e2e` | 24/24 passed: 12 desktop and 12 mobile Edge viewport tests |

Database tests create a uniquely named Docker Compose MySQL 8.4 project and volume, apply only the committed migration, and remove only their own resources. Coverage includes the existing 11-table foundation, idempotent seed, restart/readiness, authorization, login/logout, token/cookie properties, duplicate emails, pending accounts with orders/subscriptions, state restoration, expired/revoked/reused invitations, concurrent activation/reissue/disable and audit rollback.

E2E runs create a separate isolated database/API and serve the frontend on loopback port 4175. The real authentication/customer suite exercises actual HTTP/MySQL persistence; only the separate remaining-Mock regression suite stubs identity. Edge runs at desktop and mobile viewport sizes. Clipboard access is stubbed only at the browser/OS boundary and the copied value is asserted. A mobile viewport is not a physical-device acceptance test. Screenshots/traces are local ignored artifacts under `test-results/` and may contain disposable test credentials or links; do not publish them unredacted.

Browser checks wait for activation/login responses and completed logout navigation before checking account state. The two longer flows involving multiple browser contexts have a 60-second whole-test budget; assertions remain unchanged. The expired/revoked mobile scenario also passed in isolation. Customer detail screenshots were visually checked at desktop and mobile sizes, and the browser assertions verify that page width does not overflow.

## Changed files

Backend:

- `backend/package.json`
- `backend/scripts/test-database.ts`
- `backend/src/app.ts`
- `backend/src/server.ts`
- `backend/src/db/transaction.ts`
- `backend/src/http/errors.ts`
- `backend/src/http/routes.ts`
- `backend/src/http/security.ts`
- `backend/src/modules/auth/security.ts`
- `backend/src/modules/auth/service.ts`
- `backend/src/modules/users/schemas.ts`
- `backend/src/modules/users/service.ts`
- `backend/test/health.test.ts`
- `backend/test/security.test.ts`
- `backend/test/integration/auth.test.ts`

Frontend:

- `frontend/index.html`
- `frontend/vite.config.ts`
- `frontend/src/api/client.ts`
- `frontend/src/stores/auth.ts`
- `frontend/src/router/index.ts`
- `frontend/src/layouts/AdminLayout.vue`
- `frontend/src/layouts/StoreLayout.vue`
- `frontend/src/style.css`
- `frontend/src/views/auth/Login.vue`
- `frontend/src/views/auth/Activate.vue`
- `frontend/src/views/admin/Users.vue`
- `frontend/src/views/account/Profile.vue`
- `frontend/src/views/account/Orders.vue`
- `frontend/src/views/account/Subscriptions.vue`
- `frontend/src/views/storefront/Catalog.vue`

Tests, commands and documentation:

- `package.json`
- `tsconfig.e2e.json`
- `e2e/package.json`
- `e2e/auth.spec.ts`
- `e2e/prototype.spec.ts`
- `README.md`
- `docs/04-data-model.md`
- `docs/05-api-contract.md`
- `docs/07-development-roadmap.md`
- `docs/08-interface-specification.md`
- `docs/10-local-operations-mvp.md`
- `docs/11-database-foundation.md`
- `docs/12-authentication-customers-invitations.md`
- `docs/superpowers/plans/2026-11-17-auth-customers-invitations.md`

No schema, migration, dependency lockfile, developer configuration or existing database data is changed.

## Boundaries at the original milestone

This delivery added no product/order/subscription CRUD, online payment, SMTP/email, supplier API, self-registration, password reset, real customer order/subscription history API or public deployment. Customer login-email changes were outside the approved profile PATCH contract. Rate limits were per API process, and no administrator provisioning UI was added. Task 1.2.3 was the next separately authorized task at that time. Use the current status index and [API contract](05-api-contract.md) for later merged product, order, subscription and registration capabilities; this report is not a new statement about deployed accounts or server state.
