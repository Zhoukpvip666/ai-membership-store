# T26 — 商品动态表单多行文本容量扩展

**状态：用户已批准，待实现与审查。** 设计基线为当前 `main`；本任务仅扩展动态表单中 `textarea` 类型，不改变其他字段语义，不执行生产发布。

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

## 6. 交付边界

在独立工作树开发，更新相关测试，提交面向 `main` 的 PR。报告测试命令、实际结果和准确 SHA。项目设计、状态、路线图及本契约由项目文档维护者更新；Codex 不自行改写这些文档。无数据库 Migration；不连接生产 VPS、不修改线上商城、不构建或发布生产包。合并后继续积累更新，等待用户明确提出批量升级时再发布。

本任务不包括商品业务字段重构、附件上传、富文本编辑器、文件存储或其他字段长度调整。