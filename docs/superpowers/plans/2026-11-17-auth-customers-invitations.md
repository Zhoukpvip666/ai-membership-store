# Task 1.2.2 implementation plan

**Goal:** Implement the approved authentication, customer and invitation slice of docs/10-local-operations-mvp.md and the owner's Task 1.2.2 request.

**Architecture:** Keep the modular monolith, existing Prisma models and initial migration. Use cookie sessions and transactional services; connect only customer management to the API. Keep unrelated prototype screens explicitly labelled as Mock. Do not expose those fixtures as a real customer's history.

**Tech stack:** Node.js 24, Express 5, Prisma 7.10.1, MySQL 8.4, Argon2id, Zod, Vue 3, TypeScript and Element Plus.

## Constraints and decisions

- No development database writes during implementation/testing; use the existing isolated MySQL test runner. Preserve root configuration and current processes.
- No new migration, email, payment, supplier integration or product/order/subscription CRUD.
- Session lifetime: 12 hours, opaque 32-byte tokens, SHA-256 at rest, HttpOnly/host-only/SameSite=Strict cookies; Secure when APP_BASE_URL uses HTTPS.
- Invitations: 7 days, opaque 32-byte tokens, SHA-256 at rest, one-time raw URL in the issuance response. Put the token in the URL fragment and remove it from browser history on page entry.
- Login email is immutable after creation, matching the documented PATCH contract. Restore disabled accounts to ACTIVE only if previously activated; otherwise PENDING_ACTIVATION.
- Require the configured Origin plus a custom header on JSON mutations; no permissive CORS. Bound authentication and administrator mutation rate limits.

## Work and acceptance

- [x] Add token/password/session services, input schemas, error/CSRF/rate-limit middleware and authenticated routes. Test invalid credentials, expired/revoked sessions, authorization, cookies, validation and sanitized failures.
- [x] Add transactional customer and invitation services. Test duplicate/normalized email, rejected password/role injection, audit atomicity, disabled restoration, expiry/revocation/reuse and simultaneous activation/reissue.
- [x] Add API client/session store, guarded admin layout/login, real customer list/forms/details/invitation copying and activation/customer login. Verify local-only warning, errors, pending customers and desktop/mobile layout.
- [x] Run unit/HTTP tests and isolated real-MySQL integration/browser tests. Keep foundation and remaining Mock regression coverage; never target the developer database.
- [x] Update API payloads, local run instructions, roadmap and implementation report; run format, typecheck, lint, unit, integration, build and E2E checks.
- [x] Commit reviewed files, push the feature branch and create a PR to main. Stop for human review; do not start Task 1.2.3.

## Review focus

- Concurrent activation/reissue/disable must not resurrect a revoked token or disabled account.
- Session revocation and account status must be checked server-side on every protected request.
- Read responses, audit snapshots and error bodies must omit all token/password hashes and raw credentials.
- A database-backed customer must never see another customer's records or the prototype's fictitious personal history.
- Browser and database tests must clean only their own randomly named resources.
