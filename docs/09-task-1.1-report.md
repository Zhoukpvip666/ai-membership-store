# Task 1.1 实施报告

本次只实现脚手架及 `docs/08-interface-specification.md` 的本地 Mock 原型。Task 1.2 未开始，后续阶段未自动推进。

## 实际完成

- npm workspaces：Vue 3 + TypeScript + Vite + Element Plus 前端，Node.js 24 + TypeScript + Express 后端。
- MySQL 8.4 Docker Compose：独立数据库用户、仅回环地址开放 3307、命名卷、SQL 健康检查；没有创建业务表。
- 用户端：商品、我的订阅、我的订单、个人中心；统一后台：经营概览、商品管理、订单管理、订阅管理、用户管理、系统设置。
- 桌面商品三列、移动单列；用户移动底部导航留出安全区和内容空间；后台桌面侧栏、平板/移动横向导航；表格横向滚动、移动弹窗。
- 商品分类筛选、添加/编辑、独立上下架/新购/续费开关。
- 本地模拟下单、订单价格与商品信息快照、通知邮箱及商品配置所需的非敏感信息校验。新订单不声称已付款。
- 订单搜索/状态筛选、详情/时间线；已付款待发货样例支持确认后模拟完成，以及退款申请 → 处理中 → 显式模拟成功/失败。重复和非法操作被拒绝。
- 订阅筛选/详情、脱敏标识、初购/续费历史；续费新建独立模拟订单，不自动延长到期时间。下架不终止订阅，续费停用有说明。
- 用户搜索/详情及对应订单/订阅链接；通知邮箱保存、演示账户退出/进入、安全入口提示；店铺名称/邮箱/时区/通知偏好本地设置。
- 概览按业务时区计算模拟确认收款减去成功退款，显示订单及订阅汇总。
- Mock 全部保存在同一浏览器标签页内存中，刷新恢复样例。没有真实认证，也没有业务 API、支付、退款、结算、SMTP 或上游调用。

## 本地启动

首次克隆请参考 [README](../README.md#local-development--task-11) 安装 Node.js 24 和依赖、复制 `.env.example` 并设置本地密码。已有 `.env` 时请保留，避免与数据库卷内凭据不一致。

```powershell
npm ci
docker compose up -d --wait mysql
npm run dev
```

- 商店：<http://localhost:5173/>
- 后台：<http://localhost:5173/admin>
- 健康接口：<http://127.0.0.1:3000/api/v1/health>，稳定响应 `{"status":"ok"}`。
- MySQL：`127.0.0.1:3307`。可通过 `.env` 修改端口。
- 前端可单独 `npm run dev:web`；后台可单独 `npm run dev:api`。
- 停止应用按 Ctrl+C；停止数据库用 `docker compose stop mysql`，保留卷。
- 本机验收生成的 `.env` 已被忽略，不在修改清单中，不包含真实服务凭据。

## 验证

验收命令：

```text
npm ci
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm audit
docker compose config --quiet
docker compose up -d --wait mysql
```

- 前端 7 项测试：购买校验与快照、商品开关独立性、续费归属/到期日保留、完成/退款状态转换、重复/失败操作、整数金额和业务时区净收款。
- 后端 2 项 HTTP 测试：健康 JSON 稳定且无需数据库；业务路由未暴露。
- 浏览器 12 项：6 个用例分别运行于 Edge 桌面和移动尺寸，覆盖全部页面与响应式布局、购买、商品编辑/上下架、完成/退款、订阅续费、用户历史及设置。测试在没有后端的环境运行，业务 API 调用会使测试失败。
- 已实际启动前后端开发命令并取得页面 HTTP 200 和健康 JSON。
- MySQL 8.4 容器通过健康检查；已执行版本查询及 `SHOW TABLES`，确认没有业务表。
- 桌面/移动截图人工检查通过，输出在被 Git 忽略的 `test-results/`。
- `@typescript-eslint/typescript-estree` 的开发依赖 `minimatch` 通过局部 npm override 升至 `^11.0.1`，规避审计报告中的旧版依赖；锁文件与 lint 共同验证兼容性。

最终结果：干净安装、格式检查、类型检查、lint、前后端构建全部通过；基础测试 9/9、桌面/移动浏览器测试 12/12；依赖审计 0 项漏洞。测试结束后停止本次启动的应用及 MySQL 容器，保留数据库卷和本地 `.env`。

移动测试为浏览器视口仿真，未在真实 iOS/Android 设备验收。健康接口只报告 API 进程健康，不表示数据库连接已就绪。

## 尚未实现

Task 1.1 的原型范围已实现。以下内容按范围留待后续任务：

- Prisma、数据库模型/迁移、环境配置校验及请求日志（Task 1.2）。
- 真实登录、密码修改、会话及服务端权限控制。
- 商品/订单/订阅持久化、完整业务状态机和业务审计。
- 订阅实际激活、依据供应商确认的日期修正及终止工作流。
- 真实收款核验、退款、结算、SMTP、提醒任务和供应商服务。
- 生产部署和实体移动设备验收。

没有增加多商家、钱包、采购成本或利润统计功能。

## 文件清单

修改已有文件：

```text
README.md
docs/07-development-roadmap.md
```

新增文件：

```text
.env.example
.gitignore
.prettierignore
.prettierrc.json
package.json
package-lock.json
compose.yaml
eslint.config.mjs
playwright.config.ts
tsconfig.e2e.json
docs/09-task-1.1-report.md
backend/package.json
backend/tsconfig.json
backend/tsconfig.build.json
backend/src/app.ts
backend/src/server.ts
backend/test/health.test.ts
frontend/package.json
frontend/index.html
frontend/tsconfig.json
frontend/vite.config.ts
frontend/src/main.ts
frontend/src/App.vue
frontend/src/style.css
frontend/src/types/index.ts
frontend/src/router/index.ts
frontend/src/layouts/StoreLayout.vue
frontend/src/layouts/AdminLayout.vue
frontend/src/components/Brand.vue
frontend/src/components/CheckoutDialog.vue
frontend/src/components/OrderDialog.vue
frontend/src/stores/fixtures.ts
frontend/src/stores/mock.ts
frontend/src/stores/format.ts
frontend/src/stores/mock.test.ts
frontend/src/views/storefront/Catalog.vue
frontend/src/views/account/Orders.vue
frontend/src/views/account/Subscriptions.vue
frontend/src/views/account/Profile.vue
frontend/src/views/admin/Overview.vue
frontend/src/views/admin/Products.vue
frontend/src/views/admin/Users.vue
frontend/src/views/admin/Settings.vue
e2e/prototype.spec.ts
```
