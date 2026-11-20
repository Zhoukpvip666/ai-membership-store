# Admin Order Center Implementation Plan

**Goal:** Implement the approved T20 ADMIN order workspace in docs/25, preserving CUSTOMER behavior and the original checkout.

**Architecture:** Extend the existing modular order API with safe events, a minimal subscription summary, snapshot product filtering, and an atomic note mutation. Integrate the existing lifecycle endpoints through typed Vue components and memory-only idempotent request contexts.

**Tech Stack:** Existing Vue/Element Plus, Express, Prisma and isolated MySQL 8.4. No dependency or migration changes.

**Spec:** docs/25-admin-order-center.md.

## Global constraints

- Never read development .env, connect to the development database, or touch its volume.
- Preserve the original checkout and its three layout edits.
- No CUSTOMER order integration, renewal, payment provider, or revision browser.

## Review focus

Privacy allowlists, persisted ADMIN authorization, ordinary-order note updates in terminal states, exact retries, frozen forms, separate payment/fulfillment states, transaction rollback and responsive controls.

## Steps

- [x] Add backend filter, minimal detail relation, safe event DTO and independent note mutation.
- [x] Verify backend authorization, exact DTOs, history, concurrency, idempotency and rollback with real isolated HTTP tests.
- [x] Build typed ADMIN order list/detail/forms/actions using existing APIs.
- [x] Add desktop/mobile real API E2E and regression tests.
- [x] Update contracts and implementation report; run quality gates serially.
- [x] Review the scoped diff and prepare the commit/PR handoff. Publication status is tracked by the resulting GitHub PR; do not merge it.
