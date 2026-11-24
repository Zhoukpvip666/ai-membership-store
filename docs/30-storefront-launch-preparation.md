# T23.5-8 商城前台首发准备

**状态** 实现待审查。开发基线为已合并 PR #52 的 main（`84b02ad7cc2a1daeb0a7929dbb5de9a174d6aafa`）。本文记录应用变更和隔离验收。

## 首发页面

- 游客可浏览已上架、未归档的商品列表、详情与主图。商品卡片继续采用桌面三列和手机两列，详情页保留「立即购买」。
- 品牌、商城页脚、浏览器标题与登录页面共用公开店名。控制台标题在同一店名前加「管理控制台」。首次请求失败时显示默认「AI 会员商店」，后续读取失败时保留已加载名称。
- 商城页面使用面向顾客的文案，页脚移除固定预览标识，页面标题移除旧版环境后缀。客户登录页说明购买和本人记录入口，个人中心链接到「我的订单」与「我的订阅」。
- 登录或注册后继续所选商品的购买流程。订单与订阅继续按照 Session 所属用户读取，沿用现有付款和履约合同。
- 管理员经营概览保留演示内容，在指标前显示醒目的「演示数据」。真实订单、商品、客户、订阅和设置仍使用各自现有的受保护接口。

## 公开配置接口

`GET /api/v1/storefront/config` 从现有 `AppSettings` 单例读取 `storeName`。无需登录，返回 HTTP 200 与 `{"storeName":"店铺名称"}`，并使用 `Cache-Control: no-store`。单例未初始化时返回 HTTP 503 与 `SETTINGS_UNAVAILABLE`。

该接口只查询并返回 `storeName`。管理员仍通过 `GET/PATCH /api/v1/admin/settings` 查看和更新设置，成功保存后前端重新读取公开店名。订单付款说明和收款码仍由各自接口的授权规则保护。

## 验证范围

验证在本地临时 MySQL、合成数据及 Vite 生产构建预览中执行。桌面和移动测试使用 Edge，移动测试采用 iPhone 13 视口。T23.1 的 HTTPS、代理、Cookie 和 API 生命周期配置已在 PR #50 交付，仍沿用 [Clean Install](31-production-clean-install.md) 约定。

## 本轮实测结果

| 验证 | 命令及结果 |
| --- | --- |
| 前端单测 | `npm test -w frontend` 对应的工作区测试通过 51/51。 |
| 后端单测 | 隔离 Linux 容器、Node.js 24.13.0 和批准基线的依赖下执行 `node --test --test-concurrency=1 test/*.test.ts`，90/90 通过。测试树包含本 PR 的后端源码变更。 |
| HTTP 集成测试 | `npm run test:db -w backend -- --products-only --fresh`，17/17 通过。涵盖公开店名精确响应、只读、管理员访问约束、原有商品设置和微信收款设置回归。 |
| 浏览器 | `npm run test:e2e -- --config=<本地预构建配置> --grep <首发相关用例>`。桌面 Edge 14/14、移动 Edge 14/14，各自使用随机隔离 MySQL。 |
| 静态与构建 | `npm run typecheck`、`npm run lint`、`npm run build`、`npm run db:validate` 和 `git diff --check` 通过。修改文件默认 Prettier 检查通过，Windows 全量格式检查使用 `npm run format:check -- --end-of-line auto` 通过。 |

浏览器范围包括匿名商品目录、详情和主图，自定义店名和故障回退，桌面三列与手机两列，登录或注册后续接购买，订单与订阅归属隔离，管理员导航权限与演示标识。导出的目录和详情截图均使用合成商品。

Windows 首次浏览器运行在构建并启动 Vite 的 120 秒窗口内超时。独立前端构建耗时约 3 分 04 秒。第一次尝试复用产物时，临时配置未正确继承浏览器项目列表。修正本地配置后继续使用仓库的两个 Edge 项目、120 秒超时及原断言，启动 Vite 预览同一构建产物完成两端验收。Windows 后端单测首次运行及串行复验遇到既有 15 秒子进程超时，隔离 Linux 正常通过相同用例。两项恢复都使用本地测试配置，未改动仓库的测试超时。Windows 检出的 CRLF 导致默认全量格式检查提示，保留原有文件并按上述方式校验。

## 发布交接

本 PR 无需数据库迁移。上线前由另行批准的发布任务从通过审查的提交构建新发布包，核对真实店名、主图和商品上架状态，并跑正式域名下的浏览、购买续接、权限和回退验收。维护页、生产数据和服务保留在本轮范围之外。

[API 契约](05-api-contract.md) · [界面规范](08-interface-specification.md) · [项目状态](00-project-status.md) · [路线图](07-development-roadmap.md) · [生产部署计划](28-production-deployment-design.md)
