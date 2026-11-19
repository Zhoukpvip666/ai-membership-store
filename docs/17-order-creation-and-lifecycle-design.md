# 订单创建与生命周期设计

- 文档编号：ORDER-DESIGN
- 版本：1.0
- 状态：业务决策已记录；技术实现待分阶段设计
- 最后整理：2026-11-18
- 适用仓库：`lear111/ai-membership-store`
- 关联文档：[订单与订阅数据库模型](15-order-subscription-foundation.md)、[订单查询 API](16-order-read-api.md)

> 本文记录已经由项目负责人明确确认的业务决策。它不是已实现功能清单。除明确标记为“已实现”的既有基础外，本文规则仍需在后续 API、事务、前端和测试中落实。

## 1. 决策编号与变更治理

### 1.1 编号规则

- 每项已确认的业务决策分配永久唯一编号：`D1`、`D2`、`D3`……
- 编号只增不减、不复用、不因章节重排而改变。
- 后续讨论引用决策时使用编号，例如“修改 D10”“D14 与 D18 冲突”。
- 新决策即使取代旧决策，也必须分配新的编号，不覆盖旧条目。

### 1.2 状态

| 状态 | 含义 |
| --- | --- |
| ACTIVE | 当前有效，后续设计和实现必须遵守 |
| SUPERSEDED | 已被后续决策取代；保留历史，不再作为当前规则 |
| REVOKED | 项目负责人明确放弃；不再执行，但保留决策记录 |
| PROPOSED | 仅为建议，尚未获得明确确认，不得当成已确定规则 |
| IMPLEMENTED | 对应规则已实现并通过约定验收；仍保留决策来源 |

### 1.3 决策修订流程

当新决定与旧决定冲突，或项目负责人决定修改/放弃旧决定时：

1. 新增一个决策编号，不修改旧编号的原始决定内容。
2. 在新决策中填写 `Supersedes: Dn` 或 `Revokes: Dn`。
3. 将旧决策状态改为 `SUPERSEDED` 或 `REVOKED`，并填写 `Superseded by: Dm`。
4. 更新本文“当前有效规则摘要”和相关实现任务。
5. 在 PR 中说明受影响的决策编号、Schema/API/测试/文档变更。
6. 不允许仅在聊天中口头覆盖旧规则；应同步更新本文。

若两项规则表面冲突但适用场景不同，应新增澄清决策，明确各自适用范围，而不是擅自判定哪一项失效。

### 1.4 本轮决策登记

下列 D 编号按本轮讨论的确认顺序分配。全部为 ACTIVE；后续若修改，按 1.3 节处理。

| 编号 | 主题 | 当前决定 | 状态 |
| --- | --- | --- | --- |
| D1 | 管理员创建订单的客户 | 必须绑定系统中已存在的 CUSTOMER；允许 ACTIVE 和 PENDING_ACTIVATION，不允许 DISABLED；不得隐式创建客户 | ACTIVE |
| D2 | 用户自主购买资格 | 用户必须完成激活且账户状态为 ACTIVE | ACTIVE |
| D3 | 商品购买资格 | USER 只能购买已上架且未归档商品；ADMIN 可购买未上架但未归档商品；任何人不能购买已归档商品 | ACTIVE |
| D4 | 单笔订单商品数 | 一个订单只能包含一个商品；同一客户可多次购买同一商品 | ACTIVE |
| D5 | 管理员定价 | ADMIN 创建订单可设置任意非负最终应付金额，包括优惠、加价和 0 元；价格偏离原价时记录调整原因 | ACTIVE |
| D6 | 用户定价 | USER 创建订单时最终应付金额自动等于商品当前售价，用户不能自行改价 | ACTIVE |
| D7 | 商品周期 | 创建订单时使用商品当前周期单位和数量；创建订单时 USER/ADMIN 均不能临时改周期；周期写入订单快照 | ACTIVE |
| D8 | 动态表单填写 | USER 与 ADMIN 遵守同一商品表单必填规则；ADMIN 可以代客户填写；服务端按商品 Schema 校验 | ACTIVE |
| D9 | 订单初始状态 | 所有新订单均为 UNPAID + NOT_STARTED；paidAt、paymentConfirmedAt、fulfilledAt、cancelledAt 初始为 NULL | ACTIVE |
| D10 | 待付款有效期 | 自最初 createdAt 起 24 小时；任何编辑不重置期限；超过期限系统自动取消订单 | ACTIVE |
| D11 | 订单商品不可变 | 订单创建后 productId 永久锁定；商品选错只能取消原订单并重新创建 | ACTIVE |
| D12 | 订单客户归属不可变 | 订单创建后 userId 永久锁定；客户选错只能取消原订单并为正确客户新建订单 | ACTIVE |
| D13 | 待付款编辑权限 | 有效期内 USER 可编辑自己的 formData；ADMIN 可编辑待付款订单 formData 和 amountFen；用户不能改价；双方都不能换商品或客户 | ACTIVE |
| D14 | 待付款编辑限制 | 只有未付款、未取消、未开始履约且未超过 24 小时的订单可编辑；订单创建时间、来源、商品、周期和表单 Schema 不可修改 | ACTIVE |
| D15 | 编辑审计与并发 | 每次编辑记录操作人、时间、前后内容和原因；使用订单 version 乐观锁，冲突返回 HTTP 409，不静默覆盖；具体比较并发流程由 D43 明确 | ACTIVE |
| D16 | 未付款取消 | 用户可取消自己的未付款订单；管理员可取消未付款订单；系统可超时取消；取消后不可恢复、不可删除 | ACTIVE |
| D17 | 已付款取消 | 用户不能取消已付款订单；ADMIN 可取消已付款且尚未完成履约的订单，必须填写原因并记录操作者/时间；已完成订单不能取消。零元订单取消另按 D53 处理 | ACTIVE |
| D18 | 退款边界 | 取消已付款订单不等于退款；保留原付款交易，进入待退款业务处理；独立退款流程暂不实现 | ACTIVE |
| D19 | 付款确认权限 | 第一版仅 ADMIN 人工确认收款；不接入支付平台自动回调；必须核实全额到账，不支持部分付款 | ACTIVE |
| D20 | 付款金额 | 实际到账金额必须等于订单 amountFen；用户不能自行修改付款状态 | ACTIVE |
| D21 | 付款时间 | paidAt 表示实际付款发生时间，由管理员填写，默认当前时间；paymentConfirmedAt 由服务器生成；PaymentTransaction.occurredAt 必须等于 paidAt；createdAt 是付款记录入库时间 | ACTIVE |
| D22 | 付款渠道与凭证 | 付款渠道必填，支持 WECHAT、ALIPAY、BANK_TRANSFER、CASH、OTHER；交易流水号和付款备注选填；流水号不能单独作为到账证明 | ACTIVE |
| D23 | 付款后状态 | 人工确认收款成功后 paymentStatus=PAID，fulfillmentStatus=PROCESSING；付款交易、订单状态、订单事件和管理员审计在同一事务提交 | ACTIVE |
| D24 | 履约权限与状态 | 第一版由 ADMIN 手动确认履约；普通付款订单须 PAID + PROCESSING，零元订单须 NOT_REQUIRED + PROCESSING（D52）；两种情况均要求未取消、未完成；已完成或已取消订单不能重复履约 | ACTIVE |
| D25 | 履约原子性 | 订单完成、订阅创建/更新、订单事件、订阅事件和审计记录必须在同一事务；任何一步失败整体回滚；重复请求不能重复兑现 | ACTIVE |
| D26 | 首次订阅起点 | 首次订阅 startedAt 等于实际 fulfilledAt；expiresAt 按订单冻结的服务周期快照计算 | ACTIVE |
| D27 | 一次性商品履约 | ONE_TIME 履约完成后订单变为 COMPLETED，不创建订阅 | ACTIVE |
| D28 | 订阅商品履约 | SUBSCRIPTION 首次购买履约完成后创建一条新独立订阅，sourceType=ORDER，sourceOrderId 关联来源订单 | ACTIVE |
| D29 | 多订阅 | 一个客户可以拥有多个订阅，也可以拥有同一商品的多条订阅；每笔首次购买独立创建，不自动合并或延长其他订阅 | ACTIVE |
| D30 | 续费目标 | 续费订单必须明确关联原订阅；只更新指定订阅，不得按 userId + productId 自动猜测目标 | ACTIVE |
| D31 | 会员账号信息 | 不新增会员账号专用字段或独立会员账号管理模块；第三方账号标识等作为商品动态表单填写数据，按订单/订阅快照保存 | ACTIVE |
| D32 | 订阅表单修改 | 订阅继承订单表单数据；管理员可以后续修改订阅当前 formData，必须写 SubscriptionEvent 和 AdminAuditLog；不得反向修改原订单快照 | ACTIVE |
| D33 | 创建订单幂等 | USER 和 ADMIN 创建订单必须携带 Idempotency-Key；缺失返回 HTTP 400；相同身份+Key+相同请求返回原订单；相同身份+Key+不同请求返回 HTTP 409；不同 Key 可创建新订单 | ACTIVE |
| D34 | 幂等键作用域 | 幂等唯一范围为 actorUserId + keyHash；管理员和客户共用表但各自拥有独立键空间 | ACTIVE |
| D35 | 幂等记录保留 | 订单创建幂等记录永久保留，不设置 TTL，不自动清理 | ACTIVE |
| D36 | 幂等模型调整 | 现有 IdempotencyRecord.actorAdminId 需要迁移为通用 actorUserId，保留既有管理员记录及其关联；使用新增 Migration，不改写已应用迁移 | ACTIVE |

| D37 | 零元订单 | 当管理员将订单最终应付金额设为 0 时，该订单无需实际付款；付款状态采用无需付款语义，不创建虚假 PaymentTransaction，不填写 paidAt/paymentConfirmedAt，并直接进入待履约状态；管理员仍须正常确认履约 | ACTIVE |
| D38 | 订单到期后的付款核实（历史方案） | 到期后转入待核实，允许管理员依据 paidAt 判断是否能迟延确认；该方案已被 D39 完全取代，不再执行 | SUPERSEDED（由 D39 取代） |
| D39 | 24 小时超时自动取消及迟到付款处理（Supersedes D38；确认 D10 的自动取消规则） | 待付款订单自 createdAt 起 24 小时有效，编辑不重置期限；到期仍未完成付款确认时由系统自动取消，记录取消时间和系统原因，取消后不可恢复。系统不设置待核实状态，不提供用户上传付款凭证功能。即使客户声称或提供线下材料证明其在截止前转账，只要订单已超时取消，管理员不得恢复订单或在该订单上迟延确认付款；相关款项/争议在订单系统外线下人工处理。需要继续购买时创建新订单 | ACTIVE |
| D40 | 订单版本历史 | 使用独立 `OrderRevision` 表保存订单完整版本快照；订单创建时保存 V1 初始快照，每次成功编辑后新增一个完整快照，版本号按订单严格递增；历史版本永久保留、只读且不可编辑/删除。快照记录订单当时的完整业务字段，并记录操作人、主体类型、修改原因和时间。订单更新、版本号递增、OrderRevision、OrderEvent 及相应 AdminAuditLog 必须在同一事务中完成；任何一步失败整体回滚。付款后订单核心信息冻结，不再产生普通编辑版本 | ACTIVE |
| D41 | 订单修改历史的界面展示 | 当前版本暂不提供管理员或用户查看、浏览、比较、恢复订单历史版本的界面/API；订单历史仍按 D40 在后台完整保存并永久保留，作为审计与追溯数据。未来如需开放查看能力，另行新增决策并明确权限范围 | ACTIVE |
| D42 | 订单修改原因要求 | ADMIN 修改待付款订单的最终应付金额时必须填写原因；ADMIN 修改表单数据不强制填写原因；USER 修改自己的表单数据不需要填写原因。无论是否要求原因，所有成功修改均须记录操作人、主体类型、时间及修改前后完整快照 | ACTIVE |
| D43 | 订单编辑乐观锁 | 订单使用单调递增的 version。读取订单时返回当前 version；编辑请求必须提交其读取到的 expectedVersion。服务端在数据库中以订单 ID、可编辑状态和 expectedVersion 作为条件原子更新，并将 version 加一。若版本已变化或状态已不允许编辑，返回 HTTP 409，不覆盖新数据、不写入 OrderRevision/OrderEvent/AdminAuditLog；客户端应重新读取订单后再决定是否重试。并发请求只有一个基于同一版本的更新可以成功 | ACTIVE |
| D44 | 创建时保存 V1 初始快照 | 每笔订单创建成功时，必须在同一数据库事务中创建对应的 OrderRevision V1 完整快照；订单创建与初始版本快照任一写入失败时，整个订单创建事务回滚。即使订单从未编辑，也永久保留创建时的商品、价格、周期、表单 Schema、表单数据及其他约定的订单业务快照 | ACTIVE |
| D45 | 通知策略暂缓 | 通知事件、接收对象、渠道、模板、频率、重试和免打扰规则暂不在本阶段决定；订单 API 不自行接入邮件或其他通知。后续单独制定通知策略，优先只发送具有明确业务价值、需要用户采取行动或涉及重要权益/安全的信息，避免无意义的高频通知 | ACTIVE |
| D46 | 客户订单详情展示 | 客户查看订单详情时，应清晰展示商品名称及订单商品快照、商品原价、最终应付金额、该订单动态表单填写内容、付款状态，以及距离 24 小时有效期截止的剩余时间/倒计时；展示不得使用当前商品数据覆盖历史快照 | ACTIVE |
| D47 | 管理员订单详情展示 | 管理员订单详情展示与客户相同的订单快照、商品原价、最终应付金额、表单填写内容和付款状态；管理员额外可查看订单创建者、客户资料、订单来源、管理员内部备注及当前订单 version。敏感认证数据和无关审计数据仍不得返回；管理员 DTO 字段应明确白名单 | ACTIVE |
| D48 | 管理员内部备注 | 管理员可为订单填写内部备注；该字段独立于商品动态表单数据，任何客户接口/DTO 永远不得返回。管理员在待付款及付款后均可修改内部备注，因为它不改变购买商品、价格、周期或付款事实；每次修改记录操作者、时间及修改前后值。内部备注修改不改变订单 version 的业务编辑语义，但是否递增 version 需与技术并发方案统一实现，不能导致订单历史快照缺失 | ACTIVE |
| D49 | 创建订单时填写内部备注 | 管理员创建订单时可以同时填写可选的内部备注；不填写也可创建。备注独立于商品表单，客户不可见，之后仍按 D48 规则修改和审计 | ACTIVE |
| D50 | 常规细节决策授权 | 项目负责人授权助手自行决定不改变已确认业务规则、资金安全、用户权限/隐私、数据不可逆性或长期维护成本的常规实现细节；助手应选择简单、一致、可测试的方案并记录在技术设计/实现文档中。涉及上述重大边界、与 ACTIVE 决策冲突、需要新增收费/通知/数据收集、或可能造成数据丢失的事项，仍须先向项目负责人确认。任何变更既有 D 决策仍须新增 D 编号并明确 Supersedes/Revokes 关系 | ACTIVE |
| D51 | 用户自主创建零元订单 | CUSTOMER 可以自主创建售价本身为 0 的已上架、未归档商品订单；ADMIN 也可按 D5 将订单最终应付金额调整为 0。两种零元订单均无需实际付款、不创建 PaymentTransaction、paidAt/paymentConfirmedAt 保持 NULL，创建事务中直接进入无需付款/PROCESSING 待履约状态；仍须由 ADMIN 手动确认履约 | ACTIVE |
| D52 | 零元订单履约资格（澄清 D24） | D24 的普通履约前置条件适用于实际付款订单；零元订单按 D37/D51 进入无需付款 + PROCESSING 后，也具备管理员手动确认履约的资格。履约服务必须分别验证 PAID + PROCESSING 或 NOT_REQUIRED + PROCESSING，且订单未取消、未完成；两条路径均执行 D25 的同一原子履约事务 | ACTIVE |
| D53 | 零元订单取消 | 对于 `NOT_REQUIRED + PROCESSING` 且尚未完成履约的零元订单，ADMIN 可以取消；必须填写取消原因，并记录管理员身份、取消时间和事件/审计。该取消不创建退款记录、不创建订阅，订单取消后不可恢复。已完成履约的零元订单不能取消 | ACTIVE |
| D54 | 用户操作的审计归属 | 所有订单编辑都写入 OrderRevision 和 OrderEvent；只有 ADMIN 操作写入 AdminAuditLog。CUSTOMER 操作由 OrderRevision.actorUserId/actorType 和 OrderEvent.actorUserId/actorType 追溯，不向仅用于管理员操作的 AdminAuditLog 填入客户身份或伪造管理员主体 | ACTIVE |
| D55 | 客户账户激活与自主下单资格 | 管理员预先添加的客户初始为 PENDING_ACTIVATION，不得自主下单；客户通过有效邀请链接完成注册/激活后变为 ACTIVE；客户通过公开自助注册成功后直接成为 ACTIVE，无需管理员另行邀请或手动激活。CUSTOMER 创建订单时必须由服务端校验当前账户状态为 ACTIVE；PENDING_ACTIVATION 和 DISABLED 均拒绝。管理员代客创建订单仍按 D1 处理：可选择已存在的 ACTIVE 或 PENDING_ACTIVATION 客户，不得选择 DISABLED 客户。邮箱验证等注册安全细节由后续认证设计明确，不改变上述账户状态和下单资格规则 | ACTIVE |
| D56 | 管理员代客创建订单的表单完整性与后续客户编辑 | ADMIN 创建订单时必须提交满足该商品冻结表单 Schema 全部必填规则的完整有效 formData；缺少必填项或字段校验失败时拒绝创建，不创建草稿/待补充订单，也不引入不完整订单状态。创建成功时保存完整 formSchemaSnapshot 与 formData。订单创建后，在 D13 允许的待付款、未取消且未超时窗口内，客户仍可自行编辑/修正该订单 formData；每次修改必须按冻结的 formSchemaSnapshot 重新校验并遵守 D15/D40/D43/D54 的版本、历史、事件及审计规则。客户后续编辑是对已创建订单的修改，不是补齐创建时缺失的必填字段；ADMIN 代客创建与 USER 自主创建遵守相同的必填校验规则（澄清 D8），不新增草稿状态或付款前补填豁免 | ACTIVE |
| D57 | 管理员创建订单的价格输入方式 | 管理员创建订单时必须显式提交最终应付金额 amountFen；管理界面默认预填商品原价 priceFen，但该默认值只是前端初始值，服务端不因字段缺失而代填。管理员直接填写最终金额，不填写“优惠金额”或折扣率让系统反推。最终金额必须为非负整数分；与商品当前售价 priceSnapshotFen 不同的任何调整（优惠、加价或设为 0）均须填写调整原因，并按 D5 保存原价快照、最终应付金额及原因。该输入方式仅定义管理员创建订单的价格录入语义，不改变 USER 按商品当前售价下单的规则 | ACTIVE |
| D58 | 订单创建成功响应 | USER/ADMIN 首次创建订单成功时均返回完整的订单资源 DTO（与对应角色的订单详情字段白名单保持一致），HTTP 201；不得只返回订单 ID。响应中的 version=1、订单快照、初始状态及 expiresAt 均来自已提交的订单记录/服务端计算。幂等重放遵守 D33/D34：返回首次成功请求保存的原始响应，不重复创建；需要最新 remainingSeconds 的客户端应随后读取订单详情 GET，不得为刷新倒计时而改变原始响应回放语义 | ACTIVE |
| D59 | 第一阶段人工收款、人工退款与无法履约处理 | 第一阶段不接入支付网关或供应商 API；客户向经营者线下付款，ADMIN 人工核实实际全额到账后按 D20-D23 登记付款事实。订单无法交付时，由 ADMIN 取消订单并填写原因；若订单已实际付款，默认应向客户全额线下退款，取消时 paymentStatus 进入 REFUND_PENDING，只有 ADMIN 确认线下退款实际完成后才可登记退款 PaymentTransaction 并将 paymentStatus 更新为 REFUNDED，退款金额原则上等于该订单已确认收款金额，不得仅因点击“取消”就伪造退款完成或创建已完成退款记录。零元 NOT_REQUIRED 订单取消遵循 D53，不产生退款。退款失败/争议须保留待处理状态并记录原因，不得标记 REFUNDED。该决策仅规定第一阶段人工业务事实及状态语义，不授权本次订单创建 API 实现取消/退款接口；未来自动原路退款需另行决策 | ACTIVE |
| D60 | 订单动态表单编辑采用完整替换 | CUSTOMER/ADMIN 编辑订单 formData 时必须提交完整 formData 对象；服务端按订单冻结的 formSchemaSnapshot 对整个对象执行严格校验，成功后整体替换原 formData，不采用字段级 PATCH 合并。缺失必填字段、未知字段或任何字段校验失败均拒绝整个请求，原订单及其版本历史保持不变。沿用 D8/D13/D14/D56，不允许编辑造成不完整订单 | ACTIVE |
| D61 | 管理员订单编辑调价原因（澄清既有规则） | ADMIN 通过订单编辑 API 修改 amountFen 时，只有新金额与当前订单 amountFen 实际不同时才必须提交非空 priceAdjustmentReason；金额未变化时原因可省略。金额必须是非负整数分；商品原价 priceSnapshotFen 不变。该规则沿用 D5/D42/D57，不新增调价权限，也不改变 CUSTOMER 不可改价的规则 | ACTIVE |
| D62 | 管理员一次请求修改多个订单字段 | ADMIN 可以在同一次订单编辑请求中同时提交 formData 与 amountFen；两者作为一次原子业务编辑，成功后 Order.version 只递增一次，只创建一条对应 OrderRevision 和一条 OrderEvent，并在同一事务中写入适用的 AdminAuditLog 与幂等响应。CUSTOMER 仍只能提交 formData。任何一个字段验证失败则整个请求回滚 | ACTIVE |
| D63 | 订单核心编辑 API 与内部备注隔离 | 核心订单编辑使用 PATCH `/api/v1/customer/orders/:id` 和 PATCH `/api/v1/admin/orders/:id`。CUSTOMER 只能修改本人订单 formData；ADMIN 可修改订单 formData 和 amountFen。两个接口都必须提交 expectedVersion，并遵守 D13-D15/D40/D42/D43/D54/D60-D62。internalNote 不属于核心订单编辑 payload，继续按 D48 使用独立 ADMIN 接口修改；备注修改同样必须使用 expectedVersion、递增 Order.version、追加完整 OrderRevision 和 OrderEvent，并在同一事务写入 AdminAuditLog 与幂等响应。独立接口不代表绕过订单版本历史或并发控制；该备注接口不属于本次 T15 实现范围 | ACTIVE |
| D64 | 管理员编辑将未付款订单金额调整为零 | 对符合 D13/D14 编辑条件的 UNPAID + NOT_STARTED 普通订单，ADMIN 将 amountFen 从正数调整为 0 时，必须按 D37/D51 的无需付款语义在同一编辑事务中将 paymentStatus 转为 NOT_REQUIRED、fulfillmentStatus 转为 PROCESSING，并保持 paidAt/paymentConfirmedAt 为 NULL、不创建 PaymentTransaction；该请求仍只递增一次 version，并生成一条完整 OrderRevision、一条 OrderEvent、AdminAuditLog 和幂等响应。零元状态提交后订单进入待人工履约队列，不再允许通过核心编辑 API 修改；取消遵循 D53。若原订单已经存在任何付款事实/PaymentTransaction，则不得通过金额编辑转换为零元状态，必须走已付款取消与线下退款流程（D17/D18/D59） | ACTIVE |
| D65 | 订单取消 API | 客户取消使用 POST `/api/v1/customer/orders/:id/cancel`，仅可取消本人符合 D16 的未付款订单；管理员取消使用 POST `/api/v1/admin/orders/:id/cancel`，按 D16/D17/D53 校验订单类别和状态。两个接口均要求 expectedVersion 与 Idempotency-Key，必须由服务端从 Session 确定操作者；取消成功后订单不可恢复、不可物理删除。系统超时取消由后台任务执行，不暴露 SYSTEM 取消 HTTP 接口 | ACTIVE |
| D66 | 取消原因规则 | CUSTOMER 主动取消未付款订单时 reason 可选；ADMIN 主动取消任何订单时必须填写非空取消原因，最多 500 字符；SYSTEM 因 24 小时超时取消时使用固定原因 `PAYMENT_TIMEOUT`，不接受客户端输入。原因写入 Order.cancellationReason、OrderRevision、OrderEvent 和适用的 AdminAuditLog；客户取消不写 AdminAuditLog | ACTIVE |
| D67 | 已付款订单取消权限与退款状态 | 只有 ADMIN 可以取消已确认全额付款但尚未完成履约的普通订单，CUSTOMER 不得取消或发起该取消 API。取消必须与订单状态/付款事实在同一事务中校验；成功后 fulfillmentStatus=CANCELLED、cancelledAt 写入，paymentStatus=REFUND_PENDING，保留原始已确认 PAYMENT 交易，不在取消事务中伪造退款成功或删除付款记录。后续线下实际退款完成后，才由独立退款流程登记退款交易并转为 REFUNDED，遵守 D17/D18/D59 | ACTIVE |
| D68 | 零元订单取消 API 语义 | 对 `NOT_REQUIRED + PROCESSING` 且未完成履约的零元订单，仅 ADMIN 可按 D53 取消；必须填写原因，成功后 fulfillmentStatus=CANCELLED 并记录管理员主体、版本、事件和审计，paymentStatus 保持 NOT_REQUIRED，不创建退款交易、不创建订阅。CUSTOMER 不得取消零元待履约订单；已完成或已取消订单不可再次取消 | ACTIVE |
| D69 | 每分钟 SYSTEM 超时取消任务 | 后台任务每分钟扫描并取消已达到 `createdAt + 24 hours` 且仍未完成付款确认的到期普通订单；截止时间使用数据库 UTC 时间，编辑不延长。每笔成功取消在一个事务中完成条件状态更新、version+1、OrderRevision、OrderEvent 和待核实付款交易的关闭处理；actorType=SYSTEM、actorUserId/actorAdminId 均为 NULL，不写 AdminAuditLog，不创建退款。任务可多实例运行，依靠行锁/条件更新保证每笔订单只成功一次；重复扫描不得重复事件或版本。到期时仍为 PENDING_VERIFICATION 的未确认 PAYMENT 交易须保留原记录并标记 FAILED（注明 PAYMENT_TIMEOUT），禁止事后确认；没有付款交易的 UNPAID 订单直接取消。遵守 D10/D39，超时取消后不得恢复或迟延确认 | ACTIVE |
## 2. 关键概念与字段语义

### 2.1 订单、付款、履约、订阅是不同维度

- 订单记录一次购买约定。
- 付款交易记录实际资金到账。
- 履约记录服务交付结果。
- 订阅记录当前服务权益。

不能用订单状态代替付款交易，也不能因取消订单而删除付款记录。

### 2.2 价格字段

- `priceSnapshotFen`：订单创建时商品原始售价快照。
- `amountFen`：客户最终应付金额。
- 对于管理员调价，原价快照保持不变，最终应付金额可在符合 D13/D14 的待付款阶段修改。
- 付款确认后金额冻结。

### 2.3 时间字段

- `createdAt`：订单最初创建时间，永久不变。
- 待付款截止时间：由 `createdAt + 24 hours` 推导；当前尚未确认需要新增持久化 expiresAt 字段。到期未完成付款确认时系统自动取消；已取消订单不可恢复，也不接受迟延确认。
- `paidAt`：实际付款时间。
- `paymentConfirmedAt`：管理员确认收款时间。
- `fulfilledAt`：实际履约完成时间。
- `cancelledAt`：订单取消时间。
- 修改订单不得延长 24 小时有效期。

### 2.4 商品周期与订阅到期时间

商品服务周期是商品属性和订单快照；订阅到期时间是订阅实例属性。管理员可以调整订阅到期时间，但不能借此改写商品周期或原订单快照。自然月/月末/闰年计算必须使用订单快照及后续经确认的账期规则。

## 3. 业务状态与允许操作

### 3.1 初始状态

所有普通新订单（不含零元订单）：

- `paymentStatus = UNPAID`
- `fulfillmentStatus = NOT_STARTED`
- `paidAt = NULL`
- `paymentConfirmedAt = NULL`
- `fulfilledAt = NULL`
- `cancelledAt = NULL`

零元订单例外：管理员将 `amountFen` 设为 0 时，无需实际付款，不创建 `PaymentTransaction`，`paidAt` 和 `paymentConfirmedAt` 保持 NULL；付款状态使用“无需付款”语义，并直接进入 `PROCESSING` 待履约状态。管理员仍须按普通规则确认履约。具体枚举名称及兼容迁移属于技术实现，不得把零元订单伪装成已付款。

### 3.2 状态转换摘要

| 当前状态 | 操作主体 | 操作 | 结果 |
| --- | --- | --- | --- |
| UNPAID + NOT_STARTED，未超时 | USER（本人） | 编辑 formData | 保持待付款 |
| UNPAID + NOT_STARTED，未超时 | ADMIN | 编辑 formData / amountFen | 保持待付款 |
| UNPAID + NOT_STARTED | USER（本人）/ ADMIN | 取消 | CANCELLED |
| UNPAID + NOT_STARTED，达到 24 小时截止时间 | SYSTEM | 自动取消并记录取消时间及系统原因 | CANCELLED |
| 已超时取消，客户声称此前已转账 | ADMIN | 不得恢复订单或在该订单上迟延确认；订单系统外线下人工处理 | 保持 CANCELLED |
| UNPAID + NOT_STARTED，未超时 | ADMIN | 确认全额收款 | PAID + PROCESSING |
| 零元无需付款订单 | SYSTEM（创建事务） | 建立无需付款状态 | 无需付款 + PROCESSING |
| PAID + PROCESSING | ADMIN | 取消无法履约订单 | 取消，保留付款交易并待退款处理 |
| PAID + PROCESSING | ADMIN | 确认履约完成 | COMPLETED，并按商品类型兑现 |
| COMPLETED / CANCELLED | 任意普通业务主体 | 再次履约/恢复/普通取消 | 拒绝 |

取消已付款订单时沿用现有 REFUND_PENDING 表达待退款状态（D18/D59）；只有线下退款实际完成后才转为 REFUNDED。具体取消/退款 API 尚未实现。超时取消仍按 D39 处理，不转入待核实状态。

## 4. 已有数据库基础与待实现事项

### 4.1 已有基础

PR #6 已合并，十条 Migration 已应用于当前开发数据库。已具备 Order、OrderEvent、PaymentTransaction、Subscription 的快照、来源、时间、事件及账期存储基础。PR #7 已合并订单列表和详情 API。

### 4.2 尚未实现

订单创建 API 已于 PR #11 合并；T15 待付款订单编辑和 version 并发控制已实现待审查，见第 10 节。第十二条 Migration 已进入 main；开发数据库部署须单独授权，本轮不检查或迁移。当前尚待实现的主要内容：

1. 订单 24 小时自动取消任务。
2. 用户/管理员取消 API，以及已付款订单取消后的线下退款登记流程（D17/D18/D59）。
3. 管理员全额付款确认与 PaymentTransaction 原子写入。
4. 管理员履约 API 与订单到订阅原子兑现。
5. 订阅商品自然周期计算与月底/闰年规则。
6. 订单及订阅管理前端。
7. 后续生命周期的并发、回滚、权限、API、浏览器 E2E 验收；创建及核心编辑的本轮覆盖见各自实现报告。

## 5. 待确认技术设计清单

以下事项尚无明确业务决策或实现契约，不得把建议当成已批准规则：

| 编号 | 待确认事项 | 说明 |
| --- | --- | --- |
| T1 | OrderRevision 技术结构（基础设施已实现） | 按 D40、D43、D44 实现独立 OrderRevision 表并增加 Order.version；进一步确定快照 JSON 的字段白名单/版本化格式、索引、actor 关联与数据库级不可变保护，并验证订单创建时 V1、编辑/状态递增、事务回滚和内部审计读取；当前不开发历史版本浏览/比较/恢复界面或 API（D41） |
| T2 | 已付款订单取消状态 | 对照现有枚举，设计“取消/待退款”表达；不能伪造已退款状态 |
| T3 | 商品表单变更兼容 | 订单创建后使用冻结 Schema；管理员修改 formData 时仍按该订单冻结 Schema 校验 |
| T4 | 超时取消调度 | 定时任务、并发条件更新、补偿和停机恢复策略 |
| T5 | 幂等响应存储（通用主体迁移已实现） | 复用/迁移 IdempotencyRecord 时，明确 responseJson、事务、唯一键冲突和永久保留 |
| T6 | 订单创建/编辑 DTO 与路由 | 明确字段白名单、权限、状态码、错误码和响应结构；客户详情按 D46、管理员详情按 D47 提供展示数据；明确剩余有效时间计算契约和管理员额外字段白名单 |
| T7 | 0 元订单技术实现 | 按 D37、D51、D52 实现 USER 商品原价为 0 与 ADMIN 调整 amountFen 为 0 两种路径；新增明确的 NOT_REQUIRED 付款状态，禁止生成 PaymentTransaction，paidAt/paymentConfirmedAt 保持 NULL，创建事务直接进入 NOT_REQUIRED + PROCESSING；明确 CHECK/事件记录和增量迁移，不得伪装为已付款 |
| T8 | 订单超时自动取消实现 | 实现 createdAt + 24 hours 到期自动取消；以条件更新/事务防止超时取消与付款确认竞态；取消后禁止恢复或迟延确认；迟到付款争议走订单系统外的线下人工处理；不实现用户上传付款凭证 |
| T9 | 取消原因与事件类型 | 对照已有 OrderEvent 枚举，确认 USER/ADMIN/SYSTEM 的事件记录和原因要求 |
| T10 | 自然周期算法 | 月末、闰年、时区/DST、原始锚点和人工调整后账期修订的精确算法 |
| T11 | 商品/价格快照重算 | 明确 ADMIN 修改 amountFen 的上下限、原因字段与审计 DTO |
| T12 | 订单创建请求幂等身份（共享存储已实现，创建 API 未接入） | 明确 actorUserId、角色、操作名称、keyHash、requestHash 的规范化和并发回放响应 |
| T13 | 商品结构化周期管理 | 补齐 Product 管理 API、DTO 和前端对 servicePeriodUnit/servicePeriodCount 的读写；新建订阅商品要求完整周期，ONE_TIME 为 NULL；历史 NULL 不推断，需管理员显式补录后才能创建订阅订单 |
| T14 | Order.version 数据库字段（已实现） | 第十一条迁移已增加非空整数 version，历史行默认 1，新订单从 1 开始；数据库强制每次更新恰好 +1。所有成功的 Order 行修改（含状态转换和内部备注）原子递增 version，并与 OrderRevision 同事务；新增 Migration，不改写已应用 Migration |
| T15 | 订单读取 DTO 补强（已实现） | 既有四个 GET 接口已提供 version、expiresAt、remainingSeconds；管理员额外返回 internalNote，客户严格排除。服务端从原始 createdAt +24h 计算截止时间，非可付款状态返回 0；精确字段白名单和 HTTP 测试已同步更新。 |

## 5.1 技术实现默认方案（依据 D50，由助手负责常规设计）

以下是供后续 Codex 实现的技术基线；它们不改变已确认的业务规则。若实现时发现与现有 Schema、MySQL 约束或 ACTIVE 决策冲突，必须先更新本文，不得自行绕过。

### A. IdempotencyRecord

1. 将现有 `actorAdminId` / `actorAdmin` 改为通用 `actorUserId` / `actorUser`，外键指向 `User.id`，唯一键为 `(actorUserId, keyHash)`。新增增量 Migration，保留现有管理员记录的 actor ID、keyHash、requestHash、operation、responseJson、createdAt；不改写已应用 Migration。
2. `keyHash` 使用 SHA-256 对原始 Idempotency-Key 计算，原始 Key 不落库；唯一范围严格按 D34 使用 `(actorUserId, keyHash)`。`requestHash` 包含 operation 和规范化业务请求，因此同一主体复用同一个 Key 调用不同操作时会得到幂等冲突，与现有订阅幂等实现保持一致。
3. `requestHash` 使用 SHA-256 对经过 Zod 校验和默认值规范化后的业务请求 JSON 计算；对象键递归排序，数组顺序保留。包含会影响订单创建意图的字段（例如 customer/product/formData/管理员 amountFen/内部备注），不包含 requestId、网络地址、客户端时间等传输元数据，也不包含从 Product 读取的实时价格或 Schema。这样商品在首次请求后发生变化时，同一请求重试仍能命中原幂等记录。
4. 幂等检查必须在读取当前商品并重新计算价格/快照之前进行：若已有相同 actor + keyHash，先比较包含 operation 的 requestHash；相同则原样回放已提交的 responseJson（首次成功创建时的原始响应），不再次验证当前商品状态或重新创建；不同则返回 409。
5. 首次请求在一个 Prisma 事务中完成订单、OrderRevision V1、ORDER_CREATED OrderEvent、（仅 ADMIN 操作时）AdminAuditLog 和 IdempotencyRecord 写入。responseJson 保存首次成功创建时的完整、已脱敏 API 响应，以满足 D34 的原始响应回放语义；仅服务端按 actor + keyHash 读取，禁止日志输出或跨用户暴露，不保存原始 Key。
6. 并发重复请求由数据库唯一键裁决：竞争失败的一方回滚整个事务；事务外捕获唯一键冲突后重新读取幂等记录并比较 requestHash。相同请求返回原订单，不同请求返回 409。不能仅靠进程内 Map/锁。
7. Key 建议由客户端使用密码学随机 UUID 生成；服务端限制长度/字符集并只保存哈希。幂等记录永久保留，不做定期清理。

### B. OrderRevision 与 Order.version

1. `Order.version` 是单调递增的业务记录版本；初始为 1。每次成功的订单行修改（包括 D48 允许的内部备注修改）均在同一事务中 version + 1，并创建同版本号的 OrderRevision。付款/履约等状态转换若会更新 Order 行，也必须递增 version 并创建相应版本快照，除非后续明确将“业务编辑版本”和“状态版本”拆分为不同字段。
2. `OrderRevision` 建议字段：`id`、`orderId`、`version`、`snapshotSchemaVersion`、`snapshotJson`、`actorUserId`、`actorType`、`reason`、`createdAt`；唯一键 `(orderId, version))，索引 `(orderId, createdAt)`，外键均使用 RESTRICT。
3. `snapshotJson` 使用显式字段白名单和固定 envelope，例如 `{snapshotSchemaVersion: 1, order: {...}}`。包含可还原订单业务状态所需的订单字段、商品/价格/周期/表单快照、付款/履约/取消状态及时间、内部备注、创建者/来源、createdAt/updatedAt/version；排除 Session、Token、密码哈希、请求头、连接信息及无关审计数据。
4. 创建订单时写入 V1；编辑时先读取/构造变更前后快照，使用 `WHERE id = ? AND version = expectedVersion AND editable-state-predicate` 条件更新并 version + 1，成功后写入新 OrderRevision 和 OrderEvent。任何写入失败整个事务回滚。若条件更新影响行数为 0，返回 409，且不产生 revision/event/audit。
5. OrderRevision 只追加，不允许 UPDATE/DELETE；通过数据库触发器或等价的数据库级权限/约束保护，并用真实 MySQL 测试验证直接 SQL、REPLACE、UPSERT 等写路径不能修改或删除历史版本。
6. D48 的内部备注允许付款后修改。该修改仍递增 version 并产生完整 OrderRevision 与 AdminAuditLog，但不改变付款/履约事实，也不解除其他核心字段的付款后冻结。
7. 客户操作写 OrderRevision + OrderEvent；管理员操作写 OrderRevision + OrderEvent + AdminAuditLog（D54）。系统任务写 OrderRevision + OrderEvent，actorType=SYSTEM，不伪造用户或管理员。

### C. 订单截止时间

- 截止时间以服务端 UTC 时间计算：`expiresAt = createdAt + 24 hours`。当前技术基线倾向于从 createdAt 推导，不重复存储 expiresAt；API 返回 ISO 时间和服务端计算的 remainingSeconds，前端倒计时只用于展示，服务端每次操作都重新校验截止时间。
- 超时任务采用可重复执行的批处理：仅条件更新仍为 UNPAID + NOT_STARTED、未取消且已到期的订单；同一事务写 CANCELLED 状态、OrderEvent 和 OrderRevision。多实例并发运行时由条件更新/行锁确保每笔订单只取消一次。
- 付款确认和超时取消竞争时，以数据库事务中先成功提交的合法状态转换为准；订单一旦 CANCELLED，付款确认必须失败。截止后不得通过补录 paidAt 绕过 D39。

### D. 零元订单状态

- 使用独立付款状态 `NOT_REQUIRED`，不要将零元订单伪装为 `PAID`。
- 创建事务校验 `amountFen = 0` 时不创建 PaymentTransaction，paidAt/paymentConfirmedAt 保持 NULL，直接设为 NOT_REQUIRED + PROCESSING。
- `amountFen > 0` 的订单必须走 UNPAID + NOT_STARTED，付款确认后才进入 PAID + PROCESSING。
- 用数据库 CHECK 约束状态、金额、付款时间和交易记录可验证的同一行条件；跨表“不得存在 PAYMENT 交易”等条件由事务服务保证并测试。

### F. 商品快照字段契约

订单创建时从同一份已校验的 Product 记录复制购买约定字段；订单详情和后续订阅兑现只能读取订单快照，不能回读当前 Product 来覆盖历史。

| Product 来源字段 | Order 字段 | 规则 |
| --- | --- | --- |
| `id` | `productId` | 保留稳定外键；Product 禁止硬删除，足以定位商品记录 |
| `name` | `productNameSnapshot` | 创建时名称快照 |
| `description` | `productDescriptionSnapshot` | 创建时说明快照，可为 NULL |
| `type` | `productTypeSnapshot` | SUBSCRIPTION / ONE_TIME，履约分流依据 |
| `priceFen` | `priceSnapshotFen` | 创建时商品原始售价，不等于管理员可调整的最终应付金额 |
| `renewalPriceFen` | `renewalPriceSnapshotFen` | 订阅商品的续费价格快照；ONE_TIME 必须为 NULL |
| `termLabel` | `termSnapshot` | 人类可读的周期描述，仅展示，不参与日期计算 |
| `servicePeriodUnit` | `servicePeriodUnitSnapshot` | DAY / MONTH / YEAR 结构化周期单位 |
| `servicePeriodCount` | `servicePeriodCountSnapshot` | 正整数周期数量；SUBSCRIPTION 新订单必须完整有效，绝不从 termLabel 推断 |
| `formSchema` | `formSchemaSnapshot` | 创建时完整表单结构，包含字段 ID、类型、标签、必填、提示、选项和默认值 |
| 经服务端 Schema 校验及规范化的提交值 | `formData` | 按稳定字段 ID 存储；不得包含密码、Token 或其他被表单契约禁止的敏感凭证 |

其他订单级字段：

- `amountFen`：最终应付金额，独立于 `priceSnapshotFen`；用户按商品原价，管理员可按 D5/D13 调整。
- `contactEmailSnapshot`：订单创建时的客户联系邮箱快照，采用客户 `notificationEmail`，为空时回退 `loginEmail`。它与商品表单中客户填写的第三方会员邮箱是不同概念。
- `targetIdentifier`：保留现有旧字段兼容性；新订单以 `formData` 为动态商品信息的唯一来源，不把旧 `Product.targetField` 当作新表单配置。
- `internalNote`：管理员内部备注，按 D48/D49 管理，不属于商品表单，也不进入客户 DTO。
- `OrderRevision.snapshotJson`：按 D40/D44 保存完整订单业务状态及上述快照，不重复读取可变 Product。

明确不复制为订单快照的 Product 字段：

- `slug`：服务端生成且稳定；`productId` 已是稳定外键，不需要重复存储。
- `targetField`：旧兼容字段；新商品使用 formSchema，targetField 对新流程固定 NONE。
- `listed`、`sortOrder`、`archivedAt`：商品目录/选择资格元数据，不属于客户购买的商品条款。创建事务中按 D3 检查资格；商品之后下架或归档不改变既有订单。
- Product 的 `createdAt` / `updatedAt`：商品记录元数据，不属于订单购买快照。订单自身的 createdAt 记录购买约定创建时间。

### G. 商品周期能力缺口（创建订单前置任务）

T13 已通过复审并合并 PR #8（`c426ae0`）。数据库已有 `servicePeriodUnit` 和 `servicePeriodCount`；商品管理 API、DTO 和前端现在读写这两个字段，不新增 Migration。订单创建 API 尚未开始。

1. 新建 SUBSCRIPTION 商品时，必须提供 DAY/MONTH/YEAR 和正整数数量。
2. ONE_TIME 商品的结构化服务周期为 NULL。
3. 对已有周期字段为 NULL 的历史商品，不从 termLabel 猜测；管理员必须显式补录后，才能创建新的订阅订单。
4. 产品详情/列表 DTO 和管理表单显示结构化周期；编辑其他字段时允许历史 NULL 暂时保留，后续订单创建服务须拒绝缺少周期的 SUBSCRIPTION 商品。
5. 不需要新增 Product 表字段；现有数据库列和 CHECK 已提供存储基础。

补充编辑契约：PATCH 为 SUBSCRIPTION 设置或修改周期时必须同时提交单位和数量，且均非 NULL、数量为 1–2147483647 的整数；ONE_TIME 使用 NULL/NULL。只有原本为 SUBSCRIPTION、两个周期字段均为 NULL 且请求省略这两个字段时，允许保留未知周期并修改其他信息。已配置周期不可重新清空；ONE_TIME 转 SUBSCRIPTION 必须显式补齐周期及续费价格，反向转换清空周期和续费价格（显式提交冲突值会被拒绝）。termLabel 继续独立作为展示说明。

列表和详情展示结构化周期；新建默认不选择单位、不预填数量。历史 NULL 商品显示“尚未配置结构化周期”，可先保存其他信息，再显式补录。动态表单、既有订单和订阅快照不随商品周期修改而改变。DAY 是固定天数，MONTH/YEAR 是自然周期；本任务不实现日历计算或到期日推算。

隔离验证入口（不读取开发 `.env`，不执行 Seed）：

```powershell
npm ci
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:db -w backend -- --products-only
npm run test:e2e -w backend -- --products-only
npm run build
```

`--products-only` 使用现有随机 Compose 项目、随机本机端口、临时密码和独占 MySQL 8.4 测试卷，应用已提交的十条迁移后验证重复部署和 Schema 一致性；只在受保护的空测试库建立虚构管理员及设置夹具，绝不调用 Seed。API 测试通过真实 HTTP 覆盖创建、非法周期、历史 NULL 编辑/补录、类型转换、审计回滚和 API 实例重建后的读取。浏览器测试覆盖桌面及移动视口；现有认证、动态表单、设置和订阅回归继续执行。商品测试每个工作进程通过真实 UI 登录一次，各测试在独立浏览器上下文中复用这个测试会话，避免无关的重复登录触发真实限流；认证套件仍单独验证登录/退出，不放宽或绕过应用鉴权规则。清理仅针对本次随机测试项目。

下一阶段仍须在新订阅订单创建事务中拒绝 NULL 周期商品，冻结周期快照；本次没有新增、修改订单创建接口或数据库约束。

本次本地执行结果（2026-11-19）：Prisma Schema 校验、Client 生成、format:check、typecheck、Lint、前后端 build 均通过；后端单元测试 26/26，前端单元测试 9/9，商品真实 HTTP + 隔离 MySQL 测试 11/11，最终完整 E2E 34/34（桌面 17、移动 17）。首次 E2E 的提示定位歧义和累计登录限流已通过精确定位错误提示、复用工作进程内真实测试会话修正；最终单命令重跑全部通过。没有调整生产认证或限流逻辑，没有新增 Migration，也没有连接开发数据库。

该任务属于订单创建的必要前置工作，应单独实现和验收，不应让订单创建 API 临时解析 termLabel。

### E. 内部备注

- `internalNote` 只出现在管理员 DTO，客户 DTO 和客户查询投影中不得包含。
- 创建时可选填写；之后管理员可在付款前后修改。
- 备注更新使用 version 乐观锁，递增 version，追加 OrderRevision、OrderEvent 和 AdminAuditLog；不改变订单商品、价格、客户归属、付款和履约状态。

## 6. 开发顺序与验收门槛

1. [x] T13 商品结构化周期管理：已合并 PR #8（`c426ae0`）；历史 NULL 周期商品仍须由管理员显式补录后才能创建新的订阅订单。
2. [x] 订单创建 API：已合并 PR #11（`b1f5d14`）；ADMIN/USER 创建、资格/价格/表单校验、V1 快照、事件/审计和幂等均已实现；第十二条增量 Migration 加入 NOT_REQUIRED 零元语义。
3. 订单编辑 API：待付款期间 formData 和管理员 amountFen 编辑、version 冲突、历史审计。
4. 取消与超时：用户/管理员取消、系统 24 小时超时取消。
5. 付款确认：人工全额核对、渠道、流水号、paidAt、paymentConfirmedAt、PaymentTransaction。
6. 履约：管理员确认，事务内完成订单和订阅兑现。
7. 续费：用户/管理员触发、系统生成隐藏续费订单、明确订阅目标和周期幂等。
8. 前端：管理员订单管理与用户订单中心。
9. 上线准备：完整 API/DB/E2E、并发与恢复测试、生产备份恢复演练和安全配置。

每个阶段单独授权、单独 PR、独立测试和审查。订单 API 尚未完整实现、验收前，不部署正式版本，不接入真实客户订单。

---

## 7. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-18 | 初版：将本轮已确认业务规则登记为 D1–D36；未确认技术项登记为 T1–T12。 |
| 2026-11-18 | 新增 D37：明确零元订单无需付款且直接进入待履约状态；补充对应技术设计待确认项。 |
| 2026-11-18 | 新增 D38：曾提出到期后待核实及迟延确认方案，后由 D39 完全取代。 |
| 2026-11-18 | 新增 D39：恢复并明确 D10 的 24 小时自动取消规则；不提供用户上传凭证，不允许对已超时取消订单迟延确认，即使客户声称此前转账，也在订单系统外线下处理。 |
| 2026-11-18 | 新增 D40：确定使用独立 OrderRevision 表保存初始及每次成功编辑后的完整订单快照，永久只读保留，并与订单更新、事件和审计在同一事务提交。 |
| 2026-11-18 | 新增 D41：当前不提供订单历史版本的浏览、比较或恢复界面/API；后台仍永久保存版本快照用于审计追溯。 |
| 2026-11-18 | 新增 D42：明确订单编辑原因要求；管理员调价必须填写原因，表单修改不强制填写，所有编辑仍记录操作者、时间和完整前后快照。 |
| 2026-11-18 | 新增 D43：明确订单编辑采用单调递增 version 乐观锁；expectedVersion 不匹配时返回 409，不产生任何修改或历史事件。 |
| 2026-11-18 | 新增 D44：确认每笔订单创建成功时必须在同一事务中保存 V1 初始完整快照；任一写入失败则订单创建整体回滚。 |
| 2026-11-18 | 新增 D45：通知策略暂缓，订单 API 不自行接入通知；后续统一决定有价值的通知事件、渠道、频率与重试。 |
| 2026-11-18 | 新增 D46：客户订单详情展示商品快照、原价、应付金额、表单填写内容、付款状态和 24 小时有效期剩余时间。 |
| 2026-11-18 | 新增 D47：明确管理员订单详情在客户可见订单信息基础上，额外展示创建者、客户资料、来源、内部备注和当前版本号，并采用字段白名单。 |
| 2026-11-18 | 新增 D48：确认管理员内部备注与商品表单分离，客户永不可见；付款前后管理员均可修改，每次修改记录审计。 |
| 2026-11-18 | 新增 D49：管理员创建订单时可选填写内部备注，后续按 D48 管理。 |
| 2026-11-18 | 新增 D50：项目负责人授权助手处理不改变重大业务、安全、隐私和数据边界的常规细节；重大事项和既有决策冲突仍须确认并编号记录。 |
| 2026-11-18 | 新增 D51：确认 CUSTOMER 可以自主创建售价为 0 的已上架商品订单；与管理员赠送订单一样无需付款交易，直接进入待履约，仍由管理员确认履约。 |
| 2026-11-18 | 新增 D52：澄清 D24 的履约资格；除 PAID + PROCESSING 外，零元订单 NOT_REQUIRED + PROCESSING 也允许管理员确认履约，均受同一原子事务保护。 |
| 2026-11-18 | 新增 D53：确认管理员可取消尚未完成履约的零元订单；必须记录原因和审计，不产生退款或订阅，取消后不可恢复。 |
| 2026-11-18 | 新增 D54：明确客户操作通过 OrderRevision/OrderEvent 追溯，AdminAuditLog 仅记录管理员操作，避免伪造管理员主体。 |
| 2026-11-18 | 技术设计补充：明确 Product 到 Order 的完整快照字段及不复制的目录元数据；发现并登记 Product 周期管理 API/UI 缺口（T13），以及尚缺的 Order.version 和管理员订单读取 DTO 补强（T14/T15）。 |
| 2026-11-19 | T13 商品结构化服务周期管理经复审后合并 PR #8（`c426ae0`）；订单创建 API 尚未开始。 |
| 2026-11-19 | 新增 D55：明确管理员预建客户保持待激活；邀请激活或公开自助注册成功后成为 ACTIVE；只有 ACTIVE 客户可自主下单，管理员代客创建继续遵循 D1。 |
| 2026-11-19 | 新增 D56：明确管理员代客创建订单时必须提交完整有效的必填表单数据，不创建草稿/不完整订单；订单创建后客户仍可在 D13 允许的待付款窗口内按冻结 Schema 编辑 formData，澄清 D8，不改变既有订单状态机。 |
| 2026-11-19 | 新增 D57：管理员创建订单必须显式提交最终应付金额，UI 默认预填商品原价；价格偏离原价时必须填写调整原因，沿用 D5。 |
| 2026-11-19 | 新增 D58：订单创建成功返回完整角色安全 DTO，HTTP 201；幂等重放返回首次原始响应，需要实时倒计时则重新 GET 详情。 |
| 2026-11-19 | 新增 D59：明确第一阶段线下人工收款、人工全额退款；无法履约由管理员取消，已付款订单进入 REFUND_PENDING，只有线下退款实际完成后才登记退款交易并转为 REFUNDED；零元订单沿用 D53。 |
| 2026-11-19 | 新增 D60-D63：订单表单编辑采用完整替换；调价原因仅在金额实际变化时必填（澄清 D5/D42/D57）；管理员可在一个原子请求中同时改表单和价格且只递增一个版本；核心编辑接口与内部备注独立接口隔离，内部备注遵循 D48。 |
| 2026-11-19 | 新增 D64：管理员将符合编辑条件的未付款订单调价为 0 时，同一事务转为 NOT_REQUIRED + PROCESSING；已有付款事实不得转零元，须走取消退款流程。 |
| 2026-11-19 | 新增 D65-D69：定义客户/管理员取消 API、客户原因可选与管理员原因必填、已付款订单仅管理员取消并进入 REFUND_PENDING、零元订单按 D53 取消，以及每分钟 SYSTEM 超时任务和待核实付款交易关闭规则。均补充 D16-D18/D39/D53/D59，不替代既有规则。 |

后续每次业务决定都必须分配新的 D 编号，并按第 1.3 节维护冲突、替代和撤销关系。

## 8. 订单版本与幂等基础设施（2026-11-19）

T1/T5/T12/T14 的存储与保护基础，以及 T15 的既有读取 DTO 补强，详见 [18-order-revision-foundation.md](18-order-revision-foundation.md)。第十一条增量 Migration 增加 Order.version 和 OrderRevision，并原地重命名 IdempotencyRecord.actorAdminId 为 actorUserId，前十条 Migration 不变。PR #11 随后合并第十二条增量 Migration，加入 NOT_REQUIRED 零元订单语义；前十一条 Migration 不变。历史订单仅初始化 version=1，不补造历史操作或 V1 快照。新业务必须在未来创建事务中写 V1；所有成功修改（包括备注和状态）必须 version+1，与 Revision/Event/适用的 AdminAuditLog/幂等响应一起提交。

版本历史使用 V1 明确白名单 JSON 和数据库不可变 Trigger；不开放浏览、比较、恢复 API 或界面。当前数据库要求订单每次更新恰好递增一版，revision 对应父订单当前版本；跨表“每次写入必须有完整历史”的原子性仍须由未来事务服务实现，不能把这些存储约束宣称为完整订单写业务。

四个订单 GET 接口新增 version、expiresAt、remainingSeconds；管理员额外返回 internalNote，客户永不返回。截止时间从原 createdAt +24h 推导，服务端计算秒数；已付款、取消、完成等非可付款状态返回 0。PR #11 已实现并合并两个订单创建 POST；T15 编辑实现见下节。取消/付款/履约/续费 API 和前端订单页面仍未实现。第十一、十二条 Migration 已合并到 main，但开发数据库迁移须单独审查授权，本轮不检查或部署开发数据库。

## 9. 订单创建实现状态（2026-11-19）

PR #11 已合并 docs/19 的两个创建 POST；一次事务完成订单 V1、完整版本快照、事件、仅管理员操作的审计及原始响应幂等记录。普通订单 UNPAID/NOT_STARTED，零元订单 NOT_REQUIRED/PROCESSING；不创建付款或订阅。新增第十二条增量 Migration，不改前十一条历史 SQL，不迁移开发数据库。OrderEvent 沿用互斥主体列：ADMIN 使用 actorAdminId，USER 使用 actorUserId；Revision/IdempotencyRecord 使用通用 actorUserId。后续编辑、取消、超时、付款、履约、续费和前端接入仍待单独授权。历史升级与全新安装隔离测试均已通过；实际测试及已知边界见 docs/19 的实现报告。

## 10. T15 订单编辑实现状态（2026-11-19）

[订单编辑契约及实现报告](20-order-edit-api.md) 实现两个 PATCH 接口。CUSTOMER 只完整替换本人订单 formData；ADMIN 可以在一次编辑中同时替换表单和调整金额。严格 expectedVersion、数据库行锁和写入时数据库时间条件保护原始 24 小时期限。每次成功只增加一版，Revision/Event/适用的 Audit/幂等原始响应原子提交。金额实际变化才要求原因；没有金额变化却提供原因，以及所有有效无变化请求，均返回 400。历史 NULL Schema 不推断、不回退到当前商品。

沿用既有 NOTE 事件并在脱敏状态 JSON 中标记 ORDER_EDITED，不实现内部备注接口。D64 零元转换保持付款时间 NULL，不生成付款或订阅；任何既有付款交易均阻止零元转换。所有十二条 Migration、Schema、原工作区布局和开发数据库均不修改。取消、超时任务、付款、履约、续费和前端接入继续等待单独授权；本轮止于独立 PR。
