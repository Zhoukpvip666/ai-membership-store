# Task 1.2.1 — Prisma 与本地数据库基础

> Historical milestone report. The current user/subscription contract and fourth incremental migration are documented in [Phase 2](14-user-subscription-core.md). Prior table/test counts and displayName/source/status descriptions below describe their original milestone, not the current schema.

> 本文是 Task 1.2.1 的历史实施报告。认证与客户管理的当前实现见 [Task 1.2.2 报告](12-authentication-customers-invitations.md)；下文未实现项描述当时的交付边界。

本次仅交付数据库基础，待人工审查。Task 1.2.2 未开始。前端保留 Task 1.1 的独立 Mock 交互，不读取数据库，不提供真实登录、客户/商品/订单 CRUD、邀请激活、付款、退款、邮件或上游操作。

## 实现与数据库结构

- Node.js 24、Prisma/Client/MariaDB adapter 固定为 7.10.1，数据库仍为 MySQL 8.4。使用 Prisma 7 ESM TypeScript 客户端；生成目录不提交，`npm ci` 后自动生成，也可运行 `npm run db:generate`。
- 11 张领域表与 `docs/04-data-model.md` 一致，不新增客户表、供应商、邮件、钱包或多商家表。另有 Prisma 管理的 `_prisma_migrations`，不属于领域表。

| 表 | 内容与关键约束 |
| --- | --- |
| User | ADMIN/CUSTOMER、唯一登录邮箱、可空密码哈希、账号状态、创建管理员 |
| Session | 用户关联、唯一 tokenHash、到期/撤销时间；没有原始 token 字段 |
| InvitationToken | 用户/签发管理员、唯一 tokenHash、到期/使用/撤销时间；仅表结构 |
| Product | 唯一 slug、类型、整数分价格、商城展示 listed、不可逆归档 archivedAt |
| Order | 唯一 orderNo、客户/商品/可选续费订阅、快照、独立付款/履约状态；初始来源枚举已由第十条迁移替换为 USER/ADMIN/SYSTEM_RENEWAL |
| PaymentTransaction | 订单关联、PAYMENT/REFUND、线下渠道、整数分金额、记录/确认管理员 |
| OrderEvent | 订单时间线、管理员、脱敏状态快照 |
| Subscription | 客户/商品、可空唯一 sourceOrderId、来源、确认起止日期、续费价格快照 |
| SubscriptionEvent | 订阅、可选关联订单、变更日期、管理员与原因 |
| AdminAuditLog | 管理员、操作、实体、脱敏前后快照、原因与 requestId |
| AppSettings | 固定 id=1、店名、店主邮箱、Asia/Shanghai 时区；无密钥 |

统一使用 UUID 字符串主键（设置表除外），关联字段为 `VARCHAR(36)`，金额为 `INT` 分，时间为 UTC `DATETIME(3)`。MySQL 默认时区设为 `+00:00`，连接驱动使用 UTC。全部 21 个外键限制删除和主键变更，不级联清除历史。文档要求的唯一键与查询/时间线索引均已加入；同客户同商品可有多个订阅。`EXPIRED` 不作为持久化订阅枚举值。

初始迁移：`backend/prisma/migrations/20261117000000_init_local_operations/migration.sql`。SQL 由空 Schema 差异生成，另外加入 `AppSettings.id = 1` CHECK；Prisma Schema 不表达 CHECK，因此该约束保留在版本化迁移中。默认客户角色/待激活、订单未付款/履约未开始、交易待核验；商品开关默认关闭，由后续 CRUD 显式配置。

本阶段只建立存储基础。ADMIN 角色授权、邀请一次性使用、付款汇总、跨行归属、订单状态转换及审计原子性等业务规则，待相应子任务实现服务端事务与验证。Seed 负责唯一管理员初始化并拒绝已有多 ADMIN 的异常数据；本阶段未添加可创建管理员的 API。

## 本地启动

在仓库根目录使用 Node.js 24.x、npm 和 Docker Compose：

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

手动编辑本地 `.env`，不要覆盖已有文件或数据库卷凭据：

- `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`：将占位值改为各自的本地密码；数据库用户与 root 分离。
- `DATABASE_URL`：与 Compose 的数据库/用户/密码/端口一致，例如 `.env.example` 中的结构。用户名和密码的特殊字符必须百分号编码。支持 `mysql://`、loopback 主机及单个数据库名；不支持连接串查询参数。
- `APP_BASE_URL`：本机源地址，默认 `http://localhost:5173`；不接受公网/LAN 地址、用户凭据、路径、查询或片段。
- `ADMIN_EMAIL`：Seed 使用的登录邮箱，会去除首尾空白并转为小写。
- `ADMIN_PASSWORD`：12–128 字符，不能是示例占位值；不自动删除密码首尾字符。
- `API_PORT`：1–65535，省略时为 3000。修改 `MYSQL_PORT` 时同步修改 `DATABASE_URL`。

API 与 Seed 启动时验证完整应用配置；迁移/状态命令只需要有效的 `DATABASE_URL`。生成、格式化、Schema 校验不需要凭据。配置失败只列出字段名，不输出输入值、密码、完整连接串或驱动错误。现有 `.env` 和本地秘密文件继续被 Git 忽略。

```powershell
docker compose config --quiet
docker compose up -d --wait mysql
npm run db:migrate
npm run db:status
npm run db:seed
npm run dev
```

- 前端：`http://127.0.0.1:5173/`；Mock 后台：`http://127.0.0.1:5173/admin`。
- 后端：`http://127.0.0.1:3000/api/v1/health`；`/health` 是别名。
- MySQL：默认 `127.0.0.1:3307`。前后端及数据库均仅绑定回环地址，没有部署或公网开放。
- 仅前端演示可运行 `npm run dev:web`，无需数据库或管理员凭据。
- 编译后可分别运行 `npm run preview -w frontend`、`npm start -w backend`。
- 停止应用按 Ctrl+C；`docker compose stop mysql` 保留数据。正常工作无需删除卷、`db push` 或 reset。

`db:migrate` 使用 `prisma migrate deploy` 只应用尚未执行的版本化迁移，不使用 root，也不要求 shadow database。重复运行不重建表。`db:status` 检查迁移记录；健康接口只验证数据库连接，不能代替迁移状态检查。后续迁移应新建文件，不修改已应用 SQL。

## 管理员初始化与冲突

Seed 仅创建一个 ADMIN、一个 `AppSettings(id=1)` 和一条脱敏 `ADMIN_BOOTSTRAPPED` 审计记录，不创建示例客户、商品、订单或支付记录。使用固定的保留 UUID 作为初始管理员主键，串行化事务及有界唯一键/并发冲突重试保证并发初始化不会创建第二个管理员。

密码使用 Argon2id（m=19456 KiB，t=2，p=1），随机盐由哈希库生成，数据库只写入哈希；参数遵循 [OWASP 的 Argon2id 最低配置](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#argon2id)。不会把密码或哈希写入审计、日志或 API 响应。

重复 Seed 保留已有管理员密码、状态、资料和设置，也不重复审计。改变环境密码不会重置现有密码；改变邮箱、邮箱已被 CUSTOMER 使用、保留主键冲突、已有多个 ADMIN 或管理员缺失哈希时，明确失败并保留数据。需要人工检查实际记录与本地配置，不通过 Seed 暗中重置账号。管理员登录、密码变更和恢复均不属于本次交付。

## 健康响应

每次请求通过 Prisma 执行 `SELECT 1`：

| 数据库连接 | HTTP | JSON |
| --- | --- | --- |
| 可用 | 200 | `{"status":"ok","database":"ready"}` |
| 不可用/查询失败 | 503 | `{"status":"degraded","database":"unavailable"}` |

连接、获取连接和 socket 均有超时。数据库未启动时，配置有效的 API 可启动并明确返回 503。业务和认证路由仍为 404，没有把管理操作暴露为无鉴权 API。

## 验证与迁移结果

验收命令：

```powershell
npm ci
npm run db:validate
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:db
npm run build
npm run test:e2e
npm audit
```

数据库集成测试不加载开发 `.env`。它创建唯一名称 `membership-foundation-<随机值>` 的 Compose 项目、全新命名卷、随机回环端口和随机临时凭据；测试只针对 `foundation_test` 数据库运行。先执行两次迁移，再验证模型、索引、限制删除、UTC/分单位、待激活用户关联、管理员冲突/并发/幂等/密码校验、脱敏审计。测试 fixture 的插入仅用于验证数据库结构，没有业务 CRUD API。

随后执行两次 Prisma Seed CLI；仅停止自身数据库验证 HTTP 503，再重启验证 HTTP 200 和管理员/设置/审计持久化。每次启动后重新发现 Docker 的随机端口映射，避免重启后探测旧端口。最后删除自身容器/卷及临时凭据文件，不修改开发卷。若被外部强制终止，先用 `docker compose ls -a` 核对输出中具体的随机测试项目，再仅清理该项目；不要删除 `ai-membership-store` 项目的卷。

本轮最终验收结果：

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 干净安装及自动生成 Prisma 客户端通过 |
| `npm run db:validate` | Schema 校验通过，Schema 已用 Prisma 格式化 |
| `npm run format:check` | 通过 |
| `npm run typecheck` | 前端、后端、Seed/脚本/测试及 E2E 全部通过 |
| `npm run lint` | 通过 |
| `npm test` | 前端 17 + 后端 8，共 25/25 通过 |
| `npm run build` | 前后端构建通过 |
| `npm run test:db` | 8 项结构/Seed + 2 项停启健康测试，共 10/10 通过 |
| `npm run test:e2e` | 原有 Mock UI 的 Edge 桌面/移动尺寸 14/14 通过 |
| 编译后后端/Prisma 冒烟 | 数据库不可用时 HTTP 503，响应已脱敏 |
| `npm audit` | 0 漏洞 |
| `docker compose --env-file .env.example config --quiet` | 示例配置通过 |

全新 MySQL 8.4 测试卷已成功应用初始迁移；第二次 deploy 无待执行迁移，状态检查正常，数据库内有 11 张领域表和 1 条成功迁移记录。Seed 并发及重复执行只保留一个 ADMIN、一条设置及一条初始化审计，不覆盖已有密码或资料。停库返回 503，重启恢复 200 且初始化记录保留，测试资源已清理。

现有开发 `.env` 未修改，开发数据卷未迁移或重置；首次使用者仍需按上文手动填写本地凭据并执行迁移/Seed。本地结果不代表远端 CI；移动 E2E 为视口仿真，没有新增真实业务流程的浏览器验收。

## 本次修改文件

共 33 个文件（含新增文件）：

```text
.env.example
.gitignore
.prettierignore
README.md
backend/package.json
backend/prisma.config.ts
backend/prisma/schema.prisma
backend/prisma/seed.ts
backend/prisma/migrations/migration_lock.toml
backend/prisma/migrations/20261117000000_init_local_operations/migration.sql
backend/scripts/prisma.ts
backend/scripts/test-database.ts
backend/src/app.ts
backend/src/config/env.ts
backend/src/db/client.ts
backend/src/db/seed.ts
backend/src/server.ts
backend/test/compose.yaml
backend/test/env.test.ts
backend/test/health.test.ts
backend/test/integration/database.test.ts
backend/test/integration/readiness.test.ts
backend/test/integration/support.ts
backend/tsconfig.json
compose.yaml
docs/05-api-contract.md
docs/07-development-roadmap.md
docs/10-local-operations-mvp.md
docs/11-database-foundation.md
eslint.config.mjs
frontend/vite.config.ts
package.json
package-lock.json
```

## 范围与审查

本任务完成后停止，等待人工审查。下一项仅为建议：获批后再执行 Task 1.2.2。没有实现客户/商品/订单 CRUD、邀请链接或激活、会话认证流程、线上支付、邮件或上游 API，也没有部署。

实现参考：[Prisma 7 MySQL 与 driver adapter](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/mysql)、[Prisma 7 迁移流程](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production)、[显式 Seed 配置](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/seeding)。

## Task 1.2.3 商品状态迁移说明

初始迁移作为历史版本保持不变。最新商品状态仅有 listed 与 archivedAt；后续版本化迁移移除旧购买/续费权限列，并把历史归档商品设为未上架。动态表单增量迁移保留，已有表、账户、订单、订阅、表单及排序数据不重建。迁移验证只操作隔离测试数据库；本轮修订未对开发数据库执行迁移或 Seed。当前运行说明和检查结果见 [13-products-settings-forms.md](13-products-settings-forms.md)。
