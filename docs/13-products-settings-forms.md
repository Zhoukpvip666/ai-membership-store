# Task 1.2.3 — Products, settings and dynamic form configuration

> Historical milestone report. The current user/subscription contract and fourth incremental migration are documented in [Phase 2](14-user-subscription-core.md). Prior table/test counts and displayName/source/status descriptions below describe their original milestone, not the current schema.

Implemented for owner review. Stop after the PR; Task 1.2.4 is not started.

## Delivered behavior

- ADMIN product list/search/type/archive filters, pagination, details, create/edit, deterministic sorting and permanent soft archive. No hard-delete or unarchive API. Archived records cannot be edited; repeat archive is idempotent.
- Initial/renewal prices are integer CNY fen (0–2147483647). SUBSCRIPTION requires a renewal price; ONE_TIME has null renewal price. termLabel remains descriptive, with no expiry arithmetic.
- Product state is only listed and archivedAt. type remains classification. Public catalog selection requires listed=true AND archivedAt=null; the current UI exposes this only as an ADMIN preview. Unlisted/unarchived products remain ADMIN-readable/editable and available for future offline orders; future manual grants/imports require an unarchived SUBSCRIPTION product regardless of listing. Archived products cannot be used for new orders, renewals or new subscriptions. Those write flows are outside this task.
- Archive atomically sets listed=false and archivedAt, with a sanitized audit record. It is irreversible; archived products cannot be edited or relisted. Repeated archive retains its timestamp and writes no duplicate audit. Lists/details retain archived rows and historical references.
- Product form configuration supports text, email, textarea, select, radio, checkbox, number and date. Editor adds/deletes/reorders fields, edits required/hint/default/choices and preserves generated field/option IDs. New products start with an empty form, listed=false and archivedAt=null. Different products keep separate JSON values.
- All eight controls render in a live preview. Preview input stays in component memory and is never sent with the save request. Labels, hints, option labels and defaults are rendered as text; no v-html, eval, dynamic components, HTML types, JavaScript callbacks or expression evaluation.
- AppSettings singleton id=1 persists storeName, ownerEmail and IANA timezone. ADMIN branding and actual data dates use these settings; notification email is separate from administrator login identity. No SMTP or payment credentials exist in these APIs.
- All seven endpoints are mounted behind the existing session/ADMIN/CSRF/admin-rate-limit middleware. Mutations and minimal audit records are atomic. No changes to authentication, invitation or account business rules.
- Removed the obsolete Mock product switches and the unused prototype checkout dialog/helpers, which had no active UI entry point after persistence work. Existing Mock order/subscription history, completion and refund behavior remain unchanged; no live order/subscription business logic is added or changed.

## Form contract v1

```json
{
  "version": 1,
  "fields": [
    {"id":"contact_email","type":"email","label":"联系邮箱","required":true,"hint":"只填写非敏感信息"},
    {"id":"plan","type":"select","label":"方案","required":false,"hint":"请选择","options":[{"value":"standard","label":"标准"}],"defaultValue":"standard"}
  ]
}
```

The shared browser-safe Zod contract is `backend/src/contracts/product-form.ts`. It imports no database, environment or authentication implementation. Server validation is authoritative; client preview validation is only a convenience.

| Item | Rule |
|---|---|
| Version | Literal 1; strict objects reject unknown keys at every level |
| Fields | 0–20, ordered; serialized UTF-8 schema maximum 8192 bytes |
| ID | Unique, stable, 1–64 ASCII letters/digits/underscore/hyphen, begins with a letter; prototype-related keys rejected |
| Label / hint | Trimmed nonempty label max 80; hint max 200, defaults to empty string |
| Required | Boolean; preview marker only, no customer submission in this task |
| Options | Required only for select/radio/checkbox; 1–20 strict `{value,label}` records, nonempty max 80 each, unique values |
| Text / textarea default | Optional string, max 500 |
| Email default | Optional valid email (max 254) or empty string |
| Select / radio default | Optional string matching one option value |
| Checkbox default | Optional array of distinct existing option values, max 20 |
| Number default | Optional finite number within ±Number.MAX_SAFE_INTEGER; decimals allowed |
| Date default | Optional real calendar date in YYYY-MM-DD format |

The total request still has the existing 16 KiB limit. A schema satisfying individual field limits may still exceed the total 8 KiB schema limit and be rejected. Removing an option clears/filter its default; changing field type retains the field ID and common properties but resets type-specific values. Option IDs generated in the UI are stable across label edits and reorder. No arbitrary markup is executed; literal angle-bracket text is escaped by Vue.

## Versioned incremental migrations and historical data

`20261117010000_product_form_schema` adds Product.sortOrder NOT NULL DEFAULT 0, Product.formSchema JSON NOT NULL DEFAULT (`{"version":1,"fields":[]}`), and an archive/sort/creation index. MySQL 8.4 supports this JSON expression default. There are still exactly eleven business tables plus Prisma's migration metadata table.

`20261117020000_product_listing_archive` first sets listed=false for already archived products, then drops only the obsolete purchase/renewal permission columns. Both earlier migration SQL files remain unchanged. This incremental follow-up preserves all rows, all eleven business tables, references, saved form JSON, sort values and other columns. No db push, reset or development migration is performed.

Legacy targetField is retained and not rewritten. Existing products receive the empty form; no target field is automatically synthesized because this task does not accept customer submissions. There is no order/subscription/account mutation from product edits. Existing order price/name/type/term/contact snapshots remain unchanged. Future order work must snapshot relevant field definitions and values when authorized; this task does not add order schema/value storage or migration.

The development database is not migrated during implementation/testing. Apply the committed migrations only after review and an operator backup; no db push or reset is needed. No seed is necessary for an already initialized Task 1.2.2 database.

## Local operation

From the checkout containing this branch, use existing local configuration (never commit `.env`). For an existing initialized database:

The isolated implementation worktree deliberately has no copied `.env`. These development commands assume the reviewed branch is checked out in the directory with the operator's existing local configuration, or that the operator supplies that configuration locally. Automated tests need neither the development configuration nor a manual seed/migration of the development database.

```powershell
npm ci
npm run db:validate
npm run db:status
# After reviewing/backing up the intended local database:
npm run db:migrate
npm run dev:api
# Another terminal:
npm run dev:web
```

Use `http://localhost:5173/admin/login`, `/admin/products` and `/admin/settings`; API defaults to `http://127.0.0.1:3000/api/v1`. APP_BASE_URL must match the frontend origin. Do not run a second API/frontend on occupied ports. Keep the root `.env` and existing Compose volume. For a completely new installation follow docs/11 and docs/12 to initialize MySQL and the single administrator; existing installations must not reset or reseed accounts.

## Verification

```powershell
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:db
npm run test:e2e
npm run build
```

Both integration and browser runners create random `membership-foundation-*` Compose projects, loopback ports, temporary credentials and their own MySQL 8.4 volumes. They never load the development `.env`; integration fixtures reject execution without the isolated-runner marker and foundation_test user/database. Cleanup targets only that exact random project. No development volume is cleared/reset.

Database coverage starts with the original committed migration and populates all eleven tables, including an archived-but-listed legacy product. It applies the unchanged form migration, compares all pre-existing data and checks empty schema/sort defaults, then persists a custom form and sort value before applying the new listing/archive migration. It verifies only the two obsolete columns are removed, archived products become unlisted, and all remaining data, saved JSON and history survive. It removes only the isolated fixtures before running the foundation suite. Additional cases cover ADMIN/CSRF protection, strict inputs (including rejection of removed fields), unlisted ADMIN availability versus catalog visibility, irreversible archive from either listing state, audit rollback, concurrent duplicate archive, immutable accounts/order/subscription snapshots, settings, API/MySQL restart and idempotent deploy. No order/subscription API is implemented.

E2E runs the built frontend against a real isolated API/MySQL on desktop Edge and an iPhone-sized Edge viewport. It covers the eight-type editor, preview defaults/escaping, stable IDs/reorder/delete, refresh persistence, unlisted ADMIN management, catalog visibility and irreversible archive, settings reload and invalid schema/timezone/unauthorized errors. Existing authentication/customer/invitation flows and isolated Mock history regressions remain covered. Mobile viewport emulation is not physical-device verification. Screenshots/traces remain ignored under test-results.

## Boundaries and remaining work

Final PR #4 review verification (2026-11-17):

| Command | Result |
| --- | --- |
| npm run format:check | Passed |
| npm run typecheck | Passed (frontend, backend and E2E) |
| npm run lint | Passed |
| npm test | 25/25 passed: frontend 7, backend 18 |
| npm run db:validate | Passed |
| npm run test:db | 33/33 passed, plus the populated eleven-table staged migration comparison |
| npm run test:e2e | 26/26 passed, desktop/mobile Edge (4.9 minutes) |
| npm run build | Passed (frontend and backend) |

The first new upgrade assertion used a JavaScript boolean where the raw MySQL query returns 0/1; a second new assertion assumed a search name was unique across fictional fixtures. Both test assumptions were corrected, then the complete database suite passed. The final E2E run passed all cases. Build emits two non-blocking annotation warnings from the installed Zod dependency. No acceptance check remains failing.

Both isolated projects/volumes were removed by their own runners. The original main checkout, local configuration, development MySQL volume and existing services were preserved. The new migration has not been applied to the development database; an operator must review/back up and apply it after approval before running this feature against that database.

No changes to real administrator/customer records or current development data. No orders, subscriptions, payments, emails, upstream services or customer form submissions. Overview/order/subscription history stays explicitly Mock for ADMIN; customer histories remain placeholders. Catalog is an ADMIN preview, with purchase disabled and public/customer placeholders. Task 1.2.4 needs separate owner authorization after review.

## Changed files

The complete Task 1.2.3 source/documentation change list, including PR #4 review corrections (generated artifacts and local configuration excluded):

- README.md
- backend/prisma/migrations/20261117010000_product_form_schema/migration.sql
- backend/prisma/migrations/20261117020000_product_listing_archive/migration.sql
- backend/prisma/schema.prisma
- backend/scripts/test-database.ts
- backend/src/contracts/product-form.ts
- backend/src/http/routes.ts
- backend/src/modules/products/routes.ts
- backend/src/modules/products/schemas.ts
- backend/src/modules/products/service.ts
- backend/src/modules/settings/service.ts
- backend/test/integration/auth.test.ts
- backend/test/integration/database.test.ts
- backend/test/integration/products-restart.test.ts
- backend/test/integration/products.test.ts
- backend/test/integration/upgrade.ts
- backend/test/products.test.ts
- docs/01-product-requirements.md
- docs/04-data-model.md
- docs/05-api-contract.md
- docs/07-development-roadmap.md
- docs/08-interface-specification.md
- docs/09-task-1.1-report.md
- docs/10-local-operations-mvp.md
- docs/11-database-foundation.md
- docs/13-products-settings-forms.md
- docs/superpowers/plans/2026-11-17-products-settings-forms.md
- e2e/auth.spec.ts
- e2e/products.spec.ts
- e2e/prototype.spec.ts
- frontend/src/api/products.ts
- frontend/src/components/Brand.vue
- frontend/src/components/CheckoutDialog.vue (removed unused prototype component)
- frontend/src/components/ProductFormEditor.vue
- frontend/src/components/ProductFormPreview.vue
- frontend/src/layouts/AdminLayout.vue
- frontend/src/layouts/StoreLayout.vue
- frontend/src/main.ts
- frontend/src/stores/fixtures.ts
- frontend/src/stores/format.ts
- frontend/src/stores/mock.test.ts
- frontend/src/stores/mock.ts
- frontend/src/stores/settings.ts
- frontend/src/style.css
- frontend/src/types/index.ts
- frontend/src/views/account/Subscriptions.vue
- frontend/src/views/admin/Products.vue
- frontend/src/views/admin/Settings.vue
- frontend/src/views/admin/Users.vue
- frontend/src/views/storefront/Catalog.vue
