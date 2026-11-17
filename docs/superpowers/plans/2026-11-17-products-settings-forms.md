# Task 1.2.3 Products, Settings and Form Configuration Implementation Plan

**Goal:** Implement the owner's explicit Task 1.2.3 specification using the approved local-operations baseline. Stop after a PR to main; do not begin Task 1.2.4.

**Architecture:** Existing modular monolith, MySQL 8.4/Prisma 7, Express 5, Zod and Vue/Element Plus. Reuse the existing admin guard, CSRF/rate limits, transactions and safe error envelope. Authentication, sessions, invitations and account records remain unchanged. The pure browser-safe contract in backend/src/contracts/product-form.ts is shared with the editor/preview; it imports no environment, ORM or authentication code.

**Spec:** Owner's Task 1.2.3 request; docs/04, 05, 07, 08, 10 and 12.

## Decisions and scope

- Work in an isolated worktree from latest origin/main. Never load the developer .env into tests or migrate/reset/seed the developer database.
- Add only Product.formSchema JSON and Product.sortOrder Int (default 0), plus an ordering index. Keep all 11 business tables and the original migration intact. Form default: {version:1,fields:[]}. Keep legacy targetField data unchanged; new products use NONE. Service period remains termLabel, not an inferred expiry rule.
- Prices are nonnegative integer fen within MySQL signed INT. SUBSCRIPTION requires renewalPriceFen; ONE_TIME requires null renewalPriceFen and false renewalEnabled. Switching listed/purchaseEnabled/renewalEnabled never changes another switch or existing snapshots.
- Product slugs are generated stable identifiers; no hard-delete or unarchive endpoint. Archive preserves stored flags/history, excludes the product from previews, rejects later edits and is safe to repeat without duplicate audit records.
- Form schema v1: max 20 ordered fields; stable IDs (not array positions); 8 explicit discriminated types; max 20 unique nonempty choice values per select/radio/checkbox. Defaults must match their type and option set. Strict unknown-key rejection, bounded text and an 8 KiB serialized UTF-8 schema limit fit the existing 16 KiB request limit. No HTML renderer, script/expression evaluation or password field. Preview values are transient and never included in save payloads.
- Admin product/settings pages use real APIs. Administrator catalog preview uses only persisted listed/unarchived products; other visitors see an explicit unavailable catalog placeholder. No public API or checkout is added. Unrelated historical Mock orders/subscriptions remain labelled; their fixtures never become database products.
- Settings expose only storeName, ownerEmail and a valid IANA timezone. Update the existing singleton; never overwrite administrator identity or authentication. ADMIN layouts/branding use persisted settings with a static initial fallback.

## Implementation and acceptance

- [x] Add product form contract and unit tests for all types, duplicate IDs/options, invalid defaults/dates, excess size/fields, unknown/script properties and stable IDs after reordering.
- [x] Extend Prisma and add an additive migration. Test upgrade of populated original schema, preserved accounts/orders/subscriptions, safe old-product defaults, exactly 11 tables and idempotent migration deploy.
- [x] Add product/settings schemas, transactional services and guarded routes. Test create/detail/list/edit/archive, partial updates, independent flags, types/prices, authorization, audit rollback, preserved snapshots and persistent settings.
- [x] Replace Products/Settings Mock screens, add form editor and preview, update admin branding/notices and persisted catalog preview. Test responsive layouts, errors, schema editing/reordering/defaults, archive and reload behavior without submitting preview data.
- [x] Extend isolated runner and real HTTP/E2E coverage; verify data survives API/MySQL restart. Keep existing auth tests and scoped Mock regressions. Never use development credentials or volumes.
- [x] Update docs/README/roadmap and implementation report. Run format:check, typecheck, lint, unit tests, db:validate, database integration tests, E2E and build.
Delivery procedure: review/stage only intended files, commit, push the feature branch and create a PR to main. Leave it unmerged and stop for human review.

## Review focus

- PATCH must validate the merged product, including incompatible type/renewal combinations and concurrent archive/edit operations.
- Product edits must never update linked Order/Subscription rows or their snapshots.
- Reordering fields must preserve IDs and defaults; removing an option must make a stale default invalid.
- Preview must render untrusted strings as text and never save trial values or execute code.
- Migration tests must start from the actual original migration with populated data; restart/cleanup may target only the exact random test project.
