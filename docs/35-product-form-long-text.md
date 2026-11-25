# T26 — 商品动态表单多行文本容量扩展

**状态：已实现并合并，生产部署按批次策略暂缓。** 实现 PR：[ #55](https://github.com/lear111/ai-membership-store/pull/55)，实现提交 `14105e12534b895518d4f47edc191dc6ed5de2dc`，Squash Merge：`408b3b276a26abe97be2b519f5d8d9f19fc68682`。本任务仅扩展动态表单中 `textarea` 类型，不改变其他字段语义；无 Prisma Schema、Migration 或依赖变更。合并不代表生产商城已更新。

## 1. 已确认的限制

| 范围 | 目标上限 |
|---|---:|
| 单行文本 `text` | 500 字符，保持不变 |
| 邮箱 `email` | 254 字符，保持不变 |
| 每个多行文本 `textarea` 输入值 | **10,000 字符** |
| 每个多行文本 `textarea` 默认值 | **10,000 字符** |
| 序列化商品表单配置 | 64 KiB（65,536 UTF-8 字节） |
| 序列化订单表单数据 | 64 KiB（65,536 UTF-8 字节） |
| Express JSON 请求体 | 128 KiB（131,072 字节） |

字符上限沿用浏览器 `maxlength` 与 JavaScript/Zod 字符串长度语义（UTF-16 code units），保证前后端一致；常见中文字符计 1，补充平面 Emoji 计 2。字节上限统一按 `TextEncoder().encode(JSON.stringify(value)).length` 计算，不用字符数代替 UTF-8 大小。

## 2. 前端范围

- `ProductFormEditor.vue`：textarea 默认值输入上限改为 10,000；单行文本默认值仍为 500。字段标签、提示、选项及其他类型限制不变。
- `ProductFormPreview.vue`：textarea 预览输入上限 10,000；其他类型维持原限制。
- `ProductFormInputs.vue`：客户购买表单中 textarea 输入上限 10,000；text 仍为 500、email 仍为 254。
- 保留现有动态表单字段数、选项数、必填校验、credential-field 拦截、提示和响应式布局。不要把所有输入类型统一放宽。

## 3. 后端与传输范围

- `backend/src/contracts/product-form.ts`：为 textarea 默认值定义独立的 10,000 字符校验；text 默认值仍为 500。商品表单配置 JSON UTF-8 总量上限从 8 KiB 提升到 64 KiB，错误提示同步。
- `backend/src/contracts/form-data.ts`：分开校验 text（500）与 textarea（10,000）；订单表单数据 JSON UTF-8 总量上限从 8 KiB 提升到 64 KiB，并提供明确的超限错误。
- `backend/src/app.ts`：JSON parser 请求体上限从 16 KiB 提升到 128 KiB。保留 strict JSON、Content-Type、CSRF/Origin 校验、限流、错误脱敏和 no-store 行为。
- 检查所有复用 `productFormSchema`、`formDataSchema` 的商品创建/编辑、管理员下单、客户下单和订单编辑路径，确保没有第二处 500/8 KiB 限制遗漏。
- 不改变 `MAX_FIELDS=20`、`MAX_OPTIONS=20`、标签/提示长度、邮箱长度及其他字段类型规则。

## 4. 存储与兼容性

- 不修改 Prisma Schema，不新增 Migration，不执行数据库迁移。
- Product.formSchema、Order.formSchemaSnapshot、Order.formData 和 OrderRevision 中相关 JSON 快照继续使用现有 JSON 列。
- 历史商品表单、历史订单和 revision 快照不重写；既有 500 字符数据继续有效。
- 10,000 字符只表示单个 textarea 字段上限；商品配置与订单表单数据仍分别受 64 KiB 聚合 UTF-8 限制。多个长文本字段同时填写时，聚合限制仍可能先触发，前端应给出明确提示。

## 5. 验收要求

- textarea 输入/默认值恰好 10,000 字符可保存、预览、提交；10,001 字符拒绝。
- text 仍拒绝 501 字符；email 仍拒绝 255 字符。
- 覆盖中文、多行换行、混合 ASCII/中文以及 Emoji，验证字符计数与 UTF-8 字节计数各自正确。
- schema 与 formData 分别覆盖 64 KiB 边界内成功、超限失败；API 请求体覆盖 128 KiB 边界及超限 413。
- 覆盖商品配置保存/读取、管理员和客户订单创建、订单编辑、历史订单详情及 revision 回归。
- 验证 credential-field 检测、禁止敏感凭证内容、未知字段拒绝、幂等、CSRF 与既有 16 KiB 以下请求行为不回归。
- 桌面与移动浏览器验证 textarea 实际输入、粘贴、字符上限和错误提示。

## 6. 实现结果与验证证据

PR #55 修改 23 个文件，主要交付：

- 新增共享 `form-limits.ts`，统一前后端长度与聚合大小常量，并按 UTF-16 code units 与浏览器 `maxlength` 保持一致。
- `textarea` 的管理员默认值、管理员预览和客户实际填写均支持 10,000 字符；`text` 仍为 500，`email` 仍为 254。
- 商品 Schema 和订单 `formData` 分别以序列化 JSON UTF-8 字节数限制为 64 KiB；Express 严格 JSON 请求体限制为 128 KiB，超限返回 HTTP 413。
- 商品保存、管理员/客户下单、订单编辑和 Revision 快照均覆盖；历史快照结构不变。无数据库 Migration、依赖变更或项目设计文档变更。

**PR #55 报告的验证结果（本次文档更新未重新运行）：**

| 验证 | 结果 |
|---|---:|
| 前端 / 后端单测 | 52/52、94/94 |
| 隔离 MySQL HTTP 回归 | 132/132（商品 18、订单编辑/读取 74、客户购买 5、注册/认证 35） |
| 桌面 Edge E2E | 商品与设置 9/9；客户购买 16/16 |
| 移动 Edge E2E | 商品与设置 9/9；客户购买 16/16 |
| 类型检查、Lint、Prettier、Prisma 校验、前后端构建、`git diff --check` | 全部通过 |

GitHub 未提供该提交的 Actions/status checks；上述结果来自 PR 报告中的本地与隔离环境运行，不代表 GitHub CI 结果。隔离 MySQL 测试只在本轮临时容器中应用既有迁移，容器和数据卷已清理。开发数据库、生产 VPS 与线上商城均未操作。

## 7. 交付边界

实现已合并 PR #55。项目设计、状态、路线图及本契约由项目文档维护者更新；Codex 不自行改写这些文档。无数据库 Migration；本次没有连接生产 VPS、修改线上商城、构建或发布生产包。按用户要求继续积累多个更新，等待明确提出批量升级时再发布。

本任务不包括商品业务字段重构、附件上传、富文本编辑器、文件存储或其他字段长度调整。