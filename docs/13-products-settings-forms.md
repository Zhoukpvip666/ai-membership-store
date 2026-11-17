# Task 1.2.3 — Products, settings and dynamic form configuration

Implemented for owner review. Stop after the PR; Task 1.2.4 is not started.

## Delivered behavior

- ADMIN product list/search/type/archive filters, pagination, details, create/edit, deterministic sorting and permanent soft archive. No hard-delete or unarchive API. Archived records cannot be edited; repeat archive is idempotent.
- Initial/renewal prices are integer CNY fen (0–2147483647). SUBSCRIPTION requires a renewal price; ONE_TIME has null renewal price and false renewalEnabled. termLabel remains descriptive, with no expiry arithmetic.
- listed only governs catalog visibility, purchaseEnabled only records new-purchase permission, renewalEnabled only records existing-subscription renewal permission. Changing any one leaves the other two unchanged. Archive preserves flags but excludes the product from the catalog preview.
- Product form configuration supports text, email, textarea, select, radio, checkbox, number and date. Editor adds/deletes/reorders fields, edits required/hint/default/choices and preserves generated field/option IDs. New products start with an empty form and all flags false. Different products keep separate JSON values.
- All eight controls render in a live preview. Preview input stays in component memory and is never sent with the save request. Labels, hints, option labels and defaults are rendered as text; no v-html, eval, dynamic components, HTML types, JavaScript callbacks or expression evaluation.
- AppSettings singleton id=1 persists storeName, ownerEmail and IANA timezone. ADMIN branding and actual data dates use these settings; notification email is separate from administrator login identity. No SMTP or payment credentials exist in these APIs.
- All seven endpoints are mounted behind the existing session/ADMIN/CSRF/admin-rate-limit middleware. Mutations and minimal audit records are atomic. No changes to authentication, invitation or account business rules.

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

## Additive migration and historical data

`20261117010000_product_form_schema` adds Product.sortOrder NOT NULL DEFAULT 0, Product.formSchema JSON NOT NULL DEFAULT (`{"version":1,"fields":[]}`), and an archive/sort/creation index. MySQL 8.4 supports this JSON expression default. There are still exactly eleven business tables plus Prisma's migration metadata table.

Legacy targetField is retained and not rewritten. Existing products receive the empty form; no target field is automatically synthesized because this task does not accept customer submissions. There is no order/subscription/account mutation from product edits. Existing order price/name/type/term/contact snapshots remain unchanged. Future order work must snapshot relevant field definitions and values when authorized; this task does not add order schema/value storage or migration.

The development database is not migrated during implementation/testing. Apply the committed migration only after review and an operator backup; no db push or reset is needed. No seed is necessary for an already initialized Task 1.2.2 database.

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

Database coverage includes applying the original committed migration SQL, populating all eleven tables, baselining the original migration, deploying the new migration, comparing every existing column and testing empty defaults. It removes only these disposable fixtures before running the original foundation suite. It also covers ADMIN/CSRF protection, create/edit/archive, all eight flag combinations, strict Fen/type/schema/option validation, unknown fields, snapshot/account preservation, sanitized transactional audit rollback, settings identity separation, API instance reconnection, and a real isolated MySQL stop/start proving persistence. Repeated migrate deploy must report no pending migrations.

E2E runs the built frontend against a real isolated API/MySQL on desktop Edge and an iPhone-sized Edge viewport. It covers the eight-type editor, preview defaults/escaping, stable IDs/reorder/delete, refresh persistence, independent flags/catalog/archive, settings reload and invalid schema/timezone/unauthorized errors. Existing authentication/customer/invitation flows and isolated Mock history regressions remain covered. Mobile viewport emulation is not physical-device verification. Screenshots/traces remain ignored under test-results.

## Boundaries and remaining work

Final local verification (2026-11-17): format:check, typecheck, lint, db:validate and build passed; unit tests 35/35; database tests 32/32 plus the populated eleven-table upgrade comparison; E2E 26/26 across desktop and mobile Edge. Targeted replay of the three initial browser failures also passed after the settings-payload/selector corrections. A pre-existing environment child-process test timed out during a concurrent verification run; the final serial unit run passed unchanged. Build emits non-blocking annotation warnings from the installed Zod dependency. No acceptance check remains failing.

No changes to real administrator/customer records or current development data. No orders, subscriptions, payments, emails, upstream services or customer form submissions. Overview/order/subscription history stays explicitly Mock for ADMIN; customer histories remain placeholders. Catalog is an ADMIN preview, with purchase disabled and public/customer placeholders. Task 1.2.4 needs separate owner authorization after review.

## Changed files

The complete Task 1.2.3 source/documentation change list (generated artifacts and local configuration excluded):

- backend/prisma/migrations/20261117010000_product_form_schema/migration.sql
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
- docs/04-data-model.md
- docs/05-api-contract.md
- docs/07-development-roadmap.md
- docs/08-interface-specification.md
- docs/10-local-operations-mvp.md
- docs/13-products-settings-forms.md
- docs/superpowers/plans/2026-11-17-products-settings-forms.md
- e2e/auth.spec.ts
- e2e/products.spec.ts
- e2e/prototype.spec.ts
- frontend/src/api/products.ts
- frontend/src/components/Brand.vue
- frontend/src/components/ProductFormEditor.vue
- frontend/src/components/ProductFormPreview.vue
- frontend/src/layouts/AdminLayout.vue
- frontend/src/layouts/StoreLayout.vue
- frontend/src/main.ts
- frontend/src/stores/format.ts
- frontend/src/stores/mock.test.ts
- frontend/src/stores/settings.ts
- frontend/src/style.css
- frontend/src/views/account/Subscriptions.vue
- frontend/src/views/admin/Products.vue
- frontend/src/views/admin/Settings.vue
- frontend/src/views/admin/Users.vue
- frontend/src/views/storefront/Catalog.vue
- README.md
