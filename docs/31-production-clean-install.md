# T23.1 production clean installation

This procedure prepares a new MySQL 8.4 schema for the reviewed application release. Use a fresh database and private storage directories. Package the compiled API, Vue build, Linux-compatible runtime dependencies, and the exact release Prisma schema and fourteen migration directories. Keep a migration and bootstrap artifact with the release scripts, their source imports, the Prisma CLI and the generated client. Importing local accounts, products, orders, subscriptions, payment records, image files, QR files or development credentials is outside this procedure.

Keep the new site behind the maintenance gate through migration and first login verification. The commands below apply only to a separately approved installation target.

## Database identities and contexts

Use a fresh schema on the dedicated MySQL 8.4 instance. Pin the database name in each process with PRODUCTION_DATABASE_NAME and use the same name in its connection URL. All database connections originate on the server via loopback. Start independent shells or services with private, owner-readable-only environment files for the following contexts. Keep actual values out of command lines, shell history, releases, build inputs and access logs.

| Context | Environment | Database privileges |
| --- | --- | --- |
| API runtime | NODE_ENV=production, PRODUCTION_DATABASE_NAME, DATABASE_URL, APP_BASE_URL, TRUSTED_PROXY_IP=127.0.0.1, API_PORT and the private image storage paths. See the production runtime example. | SELECT on business tables. INSERT and UPDATE on User, Session, InvitationToken, Product, Order, PaymentTransaction and Subscription. INSERT on OrderEvent, OrderRevision, SubscriptionEvent, AdminAuditLog and IdempotencyRecord. UPDATE on AppSettings. |
| Migration | NODE_ENV=production, PRODUCTION_DATABASE_NAME, MIGRATION_DATABASE_URL | Schema-scoped SELECT, INSERT, UPDATE, DELETE, CREATE, CREATE TEMPORARY TABLES, ALTER, DROP, INDEX, REFERENCES and TRIGGER for the committed chain and migration history. The MySQL operator must handle binary-log trigger creation prerequisites in the approved migration window. Retain the trigger definer and its required privileges after migration. |
| First ADMIN | NODE_ENV=production, PRODUCTION_DATABASE_NAME, BOOTSTRAP_DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD | SELECT on _prisma_migrations. SELECT and INSERT on User, AppSettings and AdminAuditLog. |
| Backups | A separate protected credential such as BACKUP_DATABASE_URL for the reviewed backup tooling | Read-only backup identity. Determine any additional object/metadata privileges from the approved dump flags and verify restoration in T23.3. |

The API rejects a runtime context containing ADMIN_EMAIL, ADMIN_PASSWORD, MIGRATION_DATABASE_URL, BOOTSTRAP_DATABASE_URL, BACKUP_DATABASE_URL or MYSQL_ROOT_PASSWORD. The application uses a non-root SQL username in each production context. Use separate accounts with distinct credentials and do not copy the .env used for local development. Passwords in connection URLs need percent-encoding.

Each production database context also needs MYSQL_AUTH_PUBLIC_KEY_FILE. Have the DBA provide the public PEM for the dedicated MySQL instance's caching_sha2_password authentication. Install a read-only copy at that absolute path and verify its fingerprint through the approved channel. The client pins this key for cold connections. Keep the private key inside MySQL. Repeat fingerprint verification after an authorized key rotation. This secures the password exchange on the loopback database connection. [MySQL caching SHA-2 authentication](https://dev.mysql.com/doc/refman/8.4/en/caching-sha2-pluggable-authentication.html)

## 1. Migrate the empty target

Verify that the expected schema is empty and belongs to the separate production MySQL instance. Confirm the approved release SHA, MySQL identity, grants and recovery path with the operator before writes. In the migration context, use the release repository root.

~~~sh
npm run db:migrate:production -w backend
npm run db:status:production -w backend
~~~

Confirm all 14 release migrations succeeded. Verify the schema, CHECKs, foreign keys, indexes and trigger definers. Keep production launch gated on any failure or partial DDL. Preserve the database and review the migration record and grants before taking separately approved corrective action.

## 2. Initialize the first administrator once

With the migration process stopped, load the distinct first-ADMIN context. Use the actual administrator email and a 12–128 character password from the approved secret store.

~~~sh
npm run db:bootstrap:production -w backend
~~~

The command verifies the connected schema and compares the applied status, names and checksums with the release migration SQL. It requires an empty User table. It then creates the stable ADMIN identity in ACTIVE state with an Argon2id password hash, the AppSettings singleton and an initialization audit entry in one transaction. A second invocation exits with a conflict, even when the supplied email matches. Existing users and settings are preserved on any conflict or failed transaction.

On failure, keep registration and other writers gated. Check the selected database, successful migration history, bootstrap privileges and existing state through the approved operator channel. A registered CUSTOMER or prior administrator requires review by the authorized operator. Follow the account and recovery decision before taking further action.

Remove the bootstrap configuration and ADMIN password from the invocation environment after success. Retain the administrator password only in the approved password store. Remove bootstrap database access after verification under the approved account lifecycle. Keep the migration, bootstrap and backup credentials out of the API unit.

## 3. Start and verify

Load the runtime context and run from the release root. The compiled entry validates the production profile and listens only on 127.0.0.1.

~~~sh
npm run start:production -w backend
~~~

For the later systemd unit, use the equivalent direct Node entry from the backend working directory so the supervisor signals the API process. Production startup performs neither migration nor bootstrap. On SIGINT/SIGTERM, the API stops accepting connections, stops both schedulers, waits for in-flight HTTP requests and task batches, then disconnects Prisma. The unit stop timeout must allow this drain.

APP_BASE_URL must be the canonical HTTPS origin with a real hostname, without user info, a non-root path, a query or a fragment. Development remains on loopback. The production app trusts only the direct configured 127.0.0.1 Caddy peer at hop zero. In the later dedicated Caddy site, set upstream X-Forwarded-For to the immediate browser peer address using Caddy's remote host value and discard any incoming forwarded chain. Use no upstream trusted proxies unless reviewed separately. External clients cannot connect directly to the Node listener. Other local processes share this trust boundary. Keep incoming browser Origin intact for CSRF checks.

Check loopback API health. Through the separately approved HTTPS gateway, sign in via /admin/login, verify the account is ACTIVE ADMIN, and confirm the administrator can read the initial settings. Check cookie Secure, HttpOnly and SameSite=Strict flags. Log out and confirm that the session is revoked. After the go/no-go, public registration at /register creates ACTIVE CUSTOMER accounts. Verify customer/admin separation and own-record access in the next authorized rehearsal using synthetic inputs. Any actual service, DNS, Caddy, database or account operation belongs to a later approved deployment window.

## Local validation

Run the isolated T23.1 suite from the repository root.

~~~sh
npm run test:production -w backend
~~~

The test creates a random loopback-only MySQL 8.4 container with tmpfs data storage and synthetic, separate accounts. It migrates two fresh test schemas. One exercises first-ADMIN success and secure production HTTP behavior. The other proves an initial public registration is still CUSTOMER and blocks bootstrap. A third empty schema exercises the missing-migration guard. Test credentials and data remain confined to this container. The test stops its disposable container without using a Docker Volume.

T23.1 verification on Node 24.13.0 passed 51 frontend tests, 86 backend unit tests and 5 real MySQL integration tests. Both migrated schemas received all 14 unchanged migrations. The suite verified schema parity and the presence of indexes, foreign keys, CHECKs and 10 triggers. It also tested audit failure rollback, concurrent initialization, secure cookie attributes, CSRF, origin and proxy rate limiting, role and record isolation, and a CUSTOMER-first target. Caddy and systemd acceptance belongs to the subsequent deployment stages.
