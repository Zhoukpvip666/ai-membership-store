# T23.2 production infrastructure

**Review baseline** — Main at [8e568f5](https://github.com/lear111/ai-membership-store/commit/8e568f512eb44a01ae7b395b519094b8e7b572fc) includes [PR #50](https://github.com/lear111/ai-membership-store/pull/50). These templates and release tools are for the Ubuntu 24.04 x86_64 hybrid design. The Seoul host inventory is the 2026-11-21 audit in the [deployment design](28-production-deployment-design.md). Reconfirm its capacity, existing sites and listener inventory in a separately approved window.

## Topology and paths

Existing Caddy terminates HTTPS for the approved host and serves the Vue build. Its site forwards /api and /api/* with the prefix intact to one systemd-managed API. That process runs both minute workers and connects to a dedicated Docker MySQL instance. Use the existing automatic TLS and HTTP redirect behavior. Keep the public entry on Caddy's 80/443 and retain the existing SSH and firewall policies.

The **candidate** loopback endpoints are API 127.0.0.1:3101 and MySQL 127.0.0.1:3310. Recheck both on the shared host. If either is occupied, coordinate a new endpoint across the Caddy upstream, Compose publication, runtime/migration/bootstrap URLs, health check and preflight before deployment. Keep the existing listener on 3000. The MySQL container's internal port is 3306.

| Path | Ownership and mode |
| --- | --- |
| /opt/ai-membership-store, its releases directory and current / previous symlinks | root:root, directory mode 0755. Each release is identified by its full Git SHA. The installer removes all write bits from release files and directories and leaves them readable to the API and Caddy. |
| /opt/node-v24.13.0-linux-x64 | root:root, traverse/read/execute for the service accounts, writable only by the authorized installer. |
| /srv/membership-data | root:membership-store 0750. QR and cover subdirectories each membership-store:membership-store 0700, physically separate, outside the release tree and Caddy root. Include both in coordinated backups. |
| /etc/ai-membership-store | root:membership-store 0750. The runtime.env, migration.env, bootstrap.env, backup.env and mysql-root-password files are individually root:root 0600. Systemd reads runtime.env before dropping privileges. |
| /etc/ai-membership-store/mysql-auth-public.pem | root:root 0644, accessible to the API through the private parent. This is the verified public key. |
| MySQL data | Compose project ai-membership-store-production, named volume ai-membership-store-production_mysql-data at /var/lib/mysql inside the container. Docker manages the volume. Reserve host disk space for it and never reuse another instance's volume. |
| Operations bundle and its working directory | Keep in a separate root-owned 0700 location outside both the release and web roots. Extraction and execution require separate approval. |

Create a dedicated system user and group named membership-store with no login shell. The [unit](../deploy/systemd/ai-membership-store.service) directly launches the compiled API with --production. ProtectSystem=strict and the two ReadWritePaths keep the release read-only and allow only the two application data directories to be written by the service. The unit sends SIGTERM and allows 90 seconds for HTTP and both worker batches to drain before systemd escalates. Check the observed worst-case drain in T23.4. Standard output and errors go to journald. Retention, alerting, backup automation and monitoring belong to T23.3.

## MySQL configuration and accounts

The [production Compose template](../deploy/mysql/compose.yaml) uses the official MySQL 8.4.13 linux/amd64 manifest at sha256:72c368d898861f3b3a07af0e6d690400f44f048799ed46822783d9224cc2c86d. This is the architecture-specific manifest verified against the registry. Compose uses UTC and utf8mb4_0900_ai_ci and publishes only on loopback. The health check tests TCP server availability, while the API health endpoint tests an authenticated database query. The 768 MiB container limit, 256 MiB InnoDB buffer pool and 40 connections are starting values pending the capacity rehearsal. Change only the nonsecret knobs MYSQL_MEMORY_LIMIT, MYSQL_INNODB_BUFFER_POOL_SIZE and MYSQL_MAX_CONNECTIONS in an explicit Compose environment file. Use an empty file or --env-file /dev/null to use the reviewed defaults. [Official MySQL image](https://hub.docker.com/_/mysql)

Only during an approved change window, place the root credential from the approved secret store into the private mysql-root-password file before the first Compose start. Use a high-entropy hexadecimal bootstrap password since the image's entry point puts that value in a SQL string literal. The image reads the file and initializes the dedicated schema on an empty volume. It keeps root local to the container. Never place a password in the Compose file, command arguments or shell history. Treat access to the Docker daemon as administrative access. Use a socket DBA login inside the container with interactive -p and MYSQL_HISTFILE=/dev/null. Disable terminal capture for the credential-installation steps. Save generated passwords directly in the approved store.

Confirm the actual MySQL client peer for local Node connections during the rehearsal. Container port forwarding can make the peer the production bridge gateway. Substitute that exact peer for HOST_FROM_REHEARSAL in each account name and verify USER(), CURRENT_USER() and SHOW GRANTS in each connection context. Keep the bridge peer stable or review the change and update the scoped account. Avoid wildcard host grants. Example account creation in the private DBA session:

~~~sql
CREATE USER 'membership_api'@'HOST_FROM_REHEARSAL'
  IDENTIFIED WITH caching_sha2_password BY RANDOM PASSWORD;
CREATE USER 'membership_migrator'@'HOST_FROM_REHEARSAL'
  IDENTIFIED WITH caching_sha2_password BY RANDOM PASSWORD;
CREATE USER 'membership_bootstrap'@'HOST_FROM_REHEARSAL'
  IDENTIFIED WITH caching_sha2_password BY RANDOM PASSWORD;
CREATE USER 'membership_backup'@'HOST_FROM_REHEARSAL'
  IDENTIFIED WITH caching_sha2_password BY RANDOM PASSWORD;
~~~

- **Before migration** grant the migrator SELECT, INSERT, UPDATE, DELETE, CREATE, CREATE TEMPORARY TABLES, ALTER, DROP, INDEX, REFERENCES and TRIGGER on the single production schema. The database-level schema pattern in GRANT must escape the underscore as membership\_production with partial_revokes=OFF. Check the server setting first. With partial_revokes=ON, use the literal schema name. Confirm exact scope with SHOW GRANTS. Keep the migration trigger definer account and required privileges available after migration.
- **After migration** grant the API SELECT, INSERT, UPDATE on User, Session, InvitationToken, Product, Order, PaymentTransaction and Subscription. Grant SELECT and INSERT on OrderEvent, OrderRevision, SubscriptionEvent, AdminAuditLog and IdempotencyRecord. Grant SELECT and UPDATE on AppSettings. Use individual table grants on the literal schema name. The API has no schema modification, DELETE, TRIGGER or administrative grants.
- **First ADMIN** grant SELECT on _prisma_migrations, and SELECT and INSERT on User, AppSettings and AdminAuditLog. Follow the [Clean Install guide](31-production-clean-install.md) and retire access to the bootstrap credential after verification.
- **Backup** reserve a separate account with SELECT scoped to this schema. T23.3 must confirm any additional dump permissions. For example, exporting triggers requires TRIGGER on the relevant tables, which is a management privilege. Approve and constrain that grant and execution context explicitly. Keep credentials and backup destinations separate from the API.

The DBA handles the binary logging/trigger prerequisite in the approved migration window. If temporary log_bin_trust_function_creators is required, record and restore the original value once all reviewed migrations and trigger checks finish. Do not put the setting in permanent startup flags or give the API DBA privileges. A migration failure pauses the rollout for object and history inspection. [MySQL binary logging and triggers](https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html)

In the approved DBA window, inspect caching_sha2_password_public_key_path on the dedicated instance. For the default instance key at /var/lib/mysql/public_key.pem, obtain its SHA-256 inside the container, export only that public PEM to a private temporary file and compare the file hash with the DBA's independently verified source fingerprint. Install the matched file as /etc/ai-membership-store/mysql-auth-public.pem and set MYSQL_AUTH_PUBLIC_KEY_FILE to it in API, migration and bootstrap contexts. Verify cold connections after approved key rotation. Leave the private key in the container.

Use separate private environment files for each operation and clear the ambient environment before loading one. In the operations bundle, run the named scripts using absolute Node paths. For example, from the bundle's backend directory the authorized operator can use the following commands after grants and target verification. These are future operations, separate from template validation.

~~~sh
env -i PATH=/opt/node-v24.13.0-linux-x64/bin:/usr/bin:/bin \
  node --env-file=/etc/ai-membership-store/migration.env \
  scripts/prisma.ts --production migrate deploy
env -i PATH=/opt/node-v24.13.0-linux-x64/bin:/usr/bin:/bin \
  node --env-file=/etc/ai-membership-store/migration.env \
  scripts/prisma.ts --production migrate status
env -i PATH=/opt/node-v24.13.0-linux-x64/bin:/usr/bin:/bin \
  node --env-file=/etc/ai-membership-store/bootstrap.env prisma/bootstrap-admin.ts
~~~

## Build, install and recover a release

Run [the build script](../scripts/build-production-release.sh) on an independent Ubuntu 24.04 x86_64 build host with Node 24.13.0. The optional [build image](../deploy/release/build.Dockerfile) verifies the Linux Node archive against the published checksum. Use a clean committed checkout and an output directory outside it with an existing parent.

~~~sh
bash scripts/build-production-release.sh /path/to/artifacts/new-directory
cd /path/to/artifacts/new-directory
sha256sum --check --strict SHA256SUMS
~~~

The script starts from git archive HEAD and a fresh process environment. npm ci uses the committed lockfile and generates Prisma Client before building both workspaces. The runtime bundle contains Vue and Express build output, package metadata and the API's required dependencies, including installed platform-specific optional packages. The Prisma CLI and its optional peer dependency chain stay in the separate operations bundle with generated client, schema, all 14 migrations, config, source and the migration/bootstrap entry points. Both manifests identify one Git SHA, Node/npm/Prisma versions, the MySQL image, build time and SHA256SUMS. Verify the archive SHA independently before extraction. The archive hash also covers paths, modes and npm workspace symlinks. Transfer the approved checksums through a trusted channel. The bundles contain no workstation environment, images, credentials, or database data. [Node.js 24.13.0 checksums](https://nodejs.org/download/release/v24.13.0/SHASUMS256.txt)

1. Gate traffic. Approve the release, target, maintenance and recovery points under the [controlled launch plan](28-production-deployment-design.md#7-t235-controlled-production-launch). Reconfirm the host version, listeners, resource and disk budgets, existing-site health, grants, trigger requirements, backup integrity, Caddy import and TLS. The [first-start preflight](../deploy/release/preflight.sh) checks the expected binaries, free candidate ports, directory/file modes and template syntax. For later upgrades, check that occupied endpoints belong to this app instead of using the first-start free-port check on a running instance.
2. Use [release.sh](../deploy/release/release.sh) as the authorized operator with the full Git SHA, runtime archive and independently verified archive SHA-256. install verifies the bundle before extracting in a private staging directory, checks the manifest and per-file checksums, and installs a new immutable release directory. An existing ID is rejected. Extract the separately verified operations bundle in its private area. Keep the prior runtime and ops artifacts for recovery.
3. Stop the previous API before switching so only one worker instance exists. Perform any separately approved migrations and bootstrap using the matching operations bundle. Confirm database compatibility before proceeding. Invoke switch with the new Git SHA to atomically replace current and remember the previous release. The link operation starts or stops no services.
4. Start the unit in the approved window and run [health.sh](../deploy/release/health.sh). Set the exact approved host in a copy of [the site template](../deploy/caddy/ai-membership-store.caddy) and the same HTTPS origin in runtime.env. Place the site under a dedicated file and add a single import to the approved existing Caddyfile only if there is no existing matching include. For example, import /etc/caddy/sites/ai-membership-store.caddy. Validate the complete candidate configuration with the installed binary before an authorized reload. Existing virtual hosts and global settings stay in their own files. Verify HTTPS redirect, certificate, API and Vue routes, authenticated flows and each existing site's health before opening traffic.
5. Upon failure, gate traffic and stop the new API. If the previous application can safely use the current database, use rollback to atomically select the previous runtime and verify health before reopening. If migration status or schema compatibility is uncertain, retain the source data and escalate to the DBA. Release switching changes neither schema nor data. Both link replacements are atomic individually; interruption between previous and current updates can leave both pointing at the old release. Confirm the links and repeat the reviewed switch if necessary. On the first release there is no previous target.

Example release operations after approval:

~~~sh
bash deploy/release/release.sh install "$release_sha" "$runtime_archive" "$verified_sha256"
bash deploy/release/release.sh switch "$release_sha"
# With traffic gated, the API stopped, and database compatibility confirmed:
bash deploy/release/release.sh rollback
~~~

Caddy matches /api and /api/* before SPA fallback, preserves the API path and the browser Origin, and sets X-Forwarded-For to the socket peer using http.request.remote.host. The API trusts only the configured loopback proxy. Serve the Vue build from current/frontend/dist. Missing assets and file-like paths return 404. Vue history paths fall back to index.html. HTML revalidates, and existing fingerprinted /assets files may be cached for one year. The template assumes direct clients to Caddy. Adding an upstream CDN or proxy changes the IP trust boundary and needs review. [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## Isolated verification

Review the rendered Compose configuration with `docker compose --env-file /dev/null -f deploy/mysql/compose.yaml config`. Compare the exact image reference with the registry's linux/amd64 manifest and check the port, volume, secret source, health probe and initial limits.

For Linux artifact validation, build `deploy/release/build.Dockerfile` with the tag `ai-membership-store-t232-builder:local` and build `deploy/release/verify.Dockerfile` with the same local builder as its base. Both Dockerfiles use the context `deploy/release` and platform `linux/amd64`. Build the release in the builder from a clean checkout. Run `bash deploy/release/verify.sh ARTIFACT_DIR GIT_SHA` inside a new verifier container with no published ports, `--network none` and read-only mounts for the templates and artifacts. The verifier needs its own temporary filesystem for the synthetic installation. It uses Caddy 2.6.2, systemd-analyze, the Linux release binaries and two temporary release IDs. It checks native imports and processing, manifest agreement, file hashes, credential and local-data exclusions, copied Prisma tooling and entry-point guards, non-root startup without SQL, SIGTERM drain, Caddy route/cache/forwarding behavior and atomic release link switching/rollback. It does not need a running MySQL server, a systemd PID 1, public DNS or a certificate.

Actual MySQL startup/grant verification, a systemd-managed start through the hardened unit, shared Caddy import, public TLS and live-site health require the separately authorized T23.4 rehearsal and T23.5 launch checks.

## Capacity and next gates

These are planning estimates, not benchmark results. Allow roughly 450–750 MiB for MySQL under a small working set, 180–400 MiB for the Node API across online operation and image/Argon2 bursts, and 25–75 MiB incremental for the existing Caddy. The combined estimate is roughly 655–1,225 MiB before disk cache, concurrent backup work and changes in the existing services' resource use. MySQL per-connection buffers, native image decoding and password hashing can drive transient peaks. The historical 1,138 MiB available and 605 MiB used swap after three services stopped provide a point-in-time comparison. A 2 GB startup fits the low end on paper. Minimum startup on that host and steady coexistence remain unmeasured. Capacity approval remains pending.

Plan the T23.4 rehearsal on a separate 4 GiB/2 vCPU Ubuntu 24.04 environment with the intended MySQL disk and comparable existing-site load. Record idle and active host, process and cgroup memory, swap, CPU, IO, disk/inode and listener baselines. Run clean installation and restart with isolated synthetic data. Exercise concurrent registration/login, catalog reads, cover/QR uploads, order writes, both workers and backup/restore contention. Include a sustained run and repeated health, TLS and latency probes of the colocated sites. Compare OOM/restarts, swap growth, DB pool use, API p95 and worker lag with the agreed thresholds. Verify drain timing and spare host/volume space for recovery before accepting limits. T23.3 must deliver backup/restore, logging and monitoring; T23.4 must deliver deployment and capacity rehearsal; T23.5 is the separately approved launch.
