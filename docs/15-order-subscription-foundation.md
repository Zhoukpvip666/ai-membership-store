# Order and subscription model refactoring — Stage 1

This model-only stage prepares order → confirmed full offline payment → fulfillment → order-linked subscription. It adds no order/payment API, page, payment provider, calendar calculator, fulfillment handler or renewal worker. Existing Phase 2 subscription services remain compatibility runtime until separately integrated.

## Final source decision (2026-11-18)

The owner confirmed there are no real orders and retired OFFLINE_MANUAL. The final Prisma enum and deployed Order column contain exactly USER, ADMIN, SYSTEM_RENEWAL. Migration ten removes every retired-source CHECK exemption and both legacy-specific triggers. Earlier migration files remain immutable deployment history, not the final business contract.

- USER: visible INITIAL/SUBSCRIPTION or ONE_TIME/ONE_TIME, creator is the owning customer, no admin creator or subscription link.
- ADMIN: the same ordinary types/visibility, admin creator only, no subscription link.
- SYSTEM_RENEWAL: hidden RENEWAL/SUBSCRIPTION with the original subscription, no fake human creator. Insert only as PAID/COMPLETED with non-NULL paidAt <= paymentConfirmedAt <= fulfilledAt and cancelledAt NULL.
- Every source is permanent after INSERT. Ordinary same-source updates, including notes and valid payment/fulfillment transitions, remain possible. System renewals are immutable immediately after their final INSERT.
- Every order rejects DELETE and REPLACE conflicts, whether referenced or unreferenced, unpaid or completed. The two original renewal guards remain intact.

### Required source and MySQL non-strict mode

A NOT NULL ENUM without an explicit default silently chooses its first value when omitted under non-strict SQL. Removing the retired first enum member would therefore create a USER fallback vulnerability.

Order.source deliberately uses nullable ENUM storage and DEFAULT NULL. Prisma reflects that storage as OrderSource?. This does **not** permit missing sources in persisted business data: Order_new_source_insert rejects NULL/omitted/invalid sources with SIGNAL, including INSERT IGNORE; Order_source_check independently requires source IS NOT NULL and exactly one of the three values. No valid default source exists. Future services must explicitly require source from trusted server context despite the generated optional storage input. Do not change it back to NOT NULL without replacing and re-testing the omission protection.

See [MySQL implicit defaults](https://dev.mysql.com/doc/refman/8.4/en/data-type-defaults.html). CHECK alone is insufficient for IGNORE because rows may be skipped; the INSERT Trigger ensures invalid source writes fail instead.

### Final trigger order

| Event | BEFORE triggers, in order |
| --- | --- |
| INSERT | Order_new_source_insert (migration eight) |
| UPDATE | Order_renewal_immutable_update (six), Order_source_immutable_update (nine) |
| DELETE | Order_paid_renewal_delete (six), Order_delete_guard (ten) |

Order_no_legacy_reclassification_update and Order_legacy_delete_guard are dropped only after their general replacements exist. Binary NULL-safe OLD/NEW comparison protects source identity. All-order deletion raises ORDER_DELETE_FORBIDDEN; the older renewal guard retains PAID_RENEWAL_IMMUTABLE. REPLACE invokes DELETE guards on either primary-key or orderNo conflicts; upsert UPDATE invokes identity/renewal guards. These are ordinary DML protections, not protection against a DBA dropping tables/triggers. The runtime account must not have DDL/TRIGGER privileges.

## Remaining database foundation

| Model | Contract |
| --- | --- |
| Product | Optional structured servicePeriodUnit DAY/MONTH/YEAR plus positive servicePeriodCount. Unknown historical periods remain NULL; termLabel is descriptive, never parsed. |
| Order | Frozen product name/type/description/configured price, agreed amountFen, service period, formSchemaSnapshot and formData. Existing contact/target/renewal-price snapshots remain. Lifecycle includes actual paidAt, paymentConfirmedAt, fulfilledAt, cancelledAt and cancellationReason. |
| OrderEvent | USER/ADMIN/SYSTEM actors with unambiguous creator references; historical event types preserved. |
| Subscription | ADMIN/SYSTEM history stays compatible without invented orders. New ORDER subscriptions require unique sourceOrderId, SUBSCRIPTION type, complete frozen period, canonical billingTimezone, billingAnchorAt, positive billingRevision, currentPeriodStartAt/endAt and consistent earlyRenewalUsed/markers. |
| Renewal order | Required immutable target start/end, eligibility-period start, original subscription, billing anchor/timezone/revision snapshots and request identity/intent hashes. Durable unique cycle/target/request claims prevent duplicate successful purchases. |
| AppSettings | Plain-text paymentInstructions (4000 characters, default empty); existing PATCH API is not extended in this stage. |
| PaymentTransaction | Existing model unchanged. occurredAt is actual payment; createdAt is database entry time. Confirmed full PAYMENT.occurredAt must equal Order.paidAt in the future transaction. |

All money is integer Fen; timestamps are UTC DateTime(3), rendered/calculated in the recorded business timezone. DAY is a fixed-day duration; MONTH/YEAR are calendar periods. Retain original calendar anchors: Jan 31 → Feb 28/29 → Mar 31 → Apr 30 → May 31, with leap-year/DST rules implemented next stage. Do not infer billing cycles from expiresAt alone.

Current-period boundaries remain independent of paid-through expiresAt. earlyRenewalUsed plus earlyRenewedPeriodStartAt/earlyRenewalOrderId explicitly identify consumption of the current cycle. Manual expiry adjustment resets anchor, billingRevision and eligibility atomically; Subscription.version remains ordinary optimistic versioning. Historical renewal orders and their durable cycle claims remain unchanged. Rollover/concurrency arithmetic is not implemented here.

Order.paidAt is actual payment occurrence; paymentConfirmedAt is administrator confirmation; fulfilledAt is actual completion. Deprecated paymentRecordedAt remains only for old data and is never used as paidAt or backfilled. PaymentTransaction.createdAt is entry time. Do not impose createdAt <= paidAt: system orders are created after successful payment. Known payment/confirmation/fulfillment pairs must be chronological for all sources, with no legacy exemption. Cross-table payment equality, amount verification, ownership and exactly-once fulfillment remain transactional service requirements.

The twelve business tables, restrictive references, legacy non-order subscriptions/events, Session, InvitationToken, accounts, products and settings remain. There is no new business table in this stage and no physical order-delete endpoint.

## Versioned migration chain

| Number | Migration | Role |
| --- | --- | --- |
| 1 | 20261117000000_init_local_operations | Published original eleven-table schema |
| 2 | 20261117010000_product_form_schema | Published product forms |
| 3 | 20261117020000_product_listing_archive | Published product listing/archive |
| 4 | 20261117030000_user_subscription_core | Published Phase 2 subscriptions/users/idempotency |
| 5 | 20261118000000_order_subscription_foundation | Structured periods, order snapshots/actors/lifecycle and subscription billing storage |
| 6 | 20261118010000_order_subscription_integrity | Strict source/kind/completeness, renewal snapshots/unique claims and original renewal guards |
| 7 | 20261118020000_order_paid_at | Actual payment time, no backfill; final renewal INSERT rule |
| 8 | 20261118030000_order_source_guard | Explicit-source INSERT guard and former legacy reclassification guard |
| 9 | 20261118040000_order_source_identity | Permanent source identity and former historical deletion guard |
| 10 | 20261118050000_order_source_final | Final three-source enum, no legacy exemptions/special triggers, all-order DELETE/REPLACE protection |

The inspected PR #6 head remains 77950f9ca5b6a431e074ad40bf040e6768d8c375. Migration nine was untracked locally and absent from that PR, and earlier runner-owned containers were removed. This cannot establish that SQL was never manually deployed elsewhere. The task prohibits persistent database inspection, so migration ten is appended conservatively; all nine earlier SQL files, especially the four published on main, remain byte-identical.

### Deployment prerequisite and partial DDL

The very first statement of migration ten adds Order_source_check, atomically refusing any remaining retired-source row before creating triggers or altering the enum. It never converts old orders to new sources or clears their associated records. If development still contains old test orders, deployment must stop. Development order counts and relationships have **not been inspected**; no cleanup is authorized by this implementation task. Separately inspect, back up and decide cleanup before any development deployment. Databases already protected by migration nine need a separately reviewed cleanup plan; this task provides no general-purpose guard-disabling cleanup tool.

After that preflight, the migration installs the unconditional DELETE guard, atomically replaces the enum and all exempt checks in one ALTER, then drops obsolete legacy triggers. Retained guards stay active. Each DDL statement commits separately: a later error may leave the new check/delete guard or final enum already installed while obsolete triggers remain. Do not assume whole-migration rollback, blindly retry raw SQL, auto-resolve failed migration records, reset or disable guards. Stop writers and request DBA inspection of actual definitions/migration metadata on failure. Successful Prisma deploy repetition is a tested no-op.

Migration DDL needs ALTER and TRIGGER on Order. The retained trigger DEFINER needs TRIGGER and SELECT for OLD/NEW reads. With binary logging enabled and log_bin_trust_function_creators=OFF, creation can additionally require DBA-approved SUPER privileges (MySQL 1419). Use a separate migration account; do not elevate the application DML account or globally relax trust settings to pass tests. See [trigger privileges](https://dev.mysql.com/doc/refman/8.4/en/create-trigger.html) and [binlog restrictions](https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html).

## Isolated verification and test-data inventory

All writes use random membership-foundation projects, loopback ports, foundation_test credentials/database and runner-owned volumes. The development .env/container/volume are never loaded or targeted. No Seed, API or browser suite runs with --models-only.

The only positive retired-source creation is the three synthetic orders in upgrade.ts under migration one (omitted old default). Their dependent fixture records are one PaymentTransaction, one OrderEvent and one historical subscription sourceOrderId link. order-upgrade.ts retains raw old-schema assertions for migration-seven preservation. No current-schema positive fixture or application path creates the retired source; references in order-source.test.ts are negative SQL tests only.

The populated path first verifies old migration preservation through seven, including all old columns in twelve populated business tables, sessions, invitations and no fabricated paidAt. It executes the exact first migration-ten DDL against the three old orders and verifies rejection without row/check changes. Then, **before migration eight/nine**, it explicitly unlinks that synthetic subscription sourceOrderId and removes only those three test orders and their payment/event fixtures. No protected trigger is disabled. All unrelated values are compared. After applying eight/nine, the test creates three explicit valid-source orders (one per source), their actor events and a confirmed synthetic renewal payment. The complete twelve-table snapshot under migration nine is compared after migration ten and reconnection, proving that enum reordering preserves existing valid orders and their references. The migration itself contains no data cleanup.

The fresh path independently installs all ten migrations. Both paths re-run deploy and Prisma schema diff. Source tests verify exact final enum/check/trigger metadata, valid USER/ADMIN lifecycle updates and final SYSTEM_RENEWAL creation, strict/non-strict omission/DEFAULT/NULL/invalid values, IGNORE/UPSERT, immutable source, every-order DELETE/REPLACE on both unique keys with/without children, unchanged complete rows/associations after failures and transaction rollback. Non-strict omission also uses otherwise-valid USER creator fields to detect first-enum fallback independently of creator checks.

```powershell
npm run db:validate
npm run db:generate
npm run test:db -w backend -- --models-only
npm run test:db -w backend -- --fresh --models-only
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
```

Final verification results for this source redesign:

| Check | Result |
| --- | --- |
| `npm run test:db -w backend -- --models-only` | Passed: 41 tests (10 model, 11 renewal-integrity, 20 source). Additional upgrade scripts verify old data through seven, fail-fast rejection of retired-source data, explicit disposable cleanup, and complete preservation of all three valid-source orders plus twelve-table data across nine → ten and reconnection. |
| `npm run test:db -w backend -- --fresh --models-only` | Passed: 41 tests against a clean ten-migration installation. |
| Repeated deploy / Prisma schema diff | Passed on both paths: no pending migrations, no schema differences, ten successful migrations and thirteen tables including Prisma metadata. |
| `npm run db:validate` / `npm run db:generate` | Passed. |
| `npm run format:check` / `npm run typecheck` / `npm run lint` | Passed; later test-only edits also passed backend typecheck and final full lint/format checks. |
| `npm test` | Passed: 31 unit tests (9 frontend, 22 backend). |
| `npm run build` | Passed for frontend/backend; existing Zod/Rollup annotation warnings are non-fatal. |
| Preservation | All first nine SQL files and dependency manifests/lockfile are byte-identical to task start; first four SQL files match origin/main. Original checkout's three layout files retain their task-start hashes. |

An initial populated run exceeded Prisma's default five-second interactive transaction budget while comparing twelve tables repeatedly in the non-strict test matrix. Only the two test-local SQL-mode transaction budgets were increased to thirty seconds; application defaults, assertions, SQL constraints and permissions were not weakened. Both database paths passed after this correction. The final additional populated ninth-to-tenth upgrade also passed.

No database Seed initialization or full Seed/API/E2E regression suites ran. Only the owning random test containers/volumes were removed after verification. Development order counts and relationships remain uninspected; development data/configuration/volumes, commits, pushes and PR state were not changed.

## Files changed by this source redesign

These sixteen paths are relative to this task's starting working tree; unrelated pre-existing model/layout changes remain preserved:

- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20261118050000_order_source_final/migration.sql` (new)
- `backend/scripts/test-database.ts`
- `backend/test/integration/database.test.ts`
- `backend/test/integration/order-source.test.ts`
- `backend/test/integration/order-source-upgrade.ts`
- `backend/test/integration/order-source-support.ts`
- `backend/test/integration/order-history-protection.ts` (removed obsolete compatibility tests)
- `AGENTS.md`
- `README.md`
- `docs/04-data-model.md`
- `docs/05-api-contract.md`
- `docs/07-development-roadmap.md`
- `docs/10-local-operations-mvp.md`
- `docs/11-database-foundation.md`
- `docs/15-order-subscription-foundation.md`

## Deferred service requirements

- Authenticated administrator/customer order APIs, ownership, server-selected source and hidden-order projections.
- Structured period/form validation and permanent paid ordinary-order snapshot protection.
- Full confirmed payment amount/time equality, independent payment/fulfillment, pending expiry/cancellation rules and audited state transitions.
- Atomic exactly-once initial subscription creation after fulfillment; one-time products never create subscriptions.
- Atomic final renewal order INSERT, subscription extension, events/audit/idempotency; stable period claims, clock rollover, old-request rejection after billing reset and calendar calculations.
- Integration/restriction of existing direct Phase 2 subscription APIs before enabling ORDER subscriptions.

No order API, UI, provider, Seed, development migration/cleanup, commit, push or merge is performed by this task. Preserve the original shopping checkout's accepted layout edits. Stop for human review.
