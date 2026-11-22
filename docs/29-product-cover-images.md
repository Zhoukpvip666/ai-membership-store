# T24.5B 商品主图

每个商品有一个可选的主图引用。迁移 20261122000000_product_cover_image 在 Product 上新增可空的 VARCHAR(64) 字段 coverImageKey。现有行的主图为空。迁移不复制图片，也不更新已有商品和订单快照。

## 上传与展示

- 管理员编辑商品时可以上传、更换或删除主图。新建界面可先选图，商品保存后再通过返回的 ID 上传。上传失败时保留已创建的商品、已有主图与错误信息，管理员可重新尝试。
- 服务端校验 PNG、JPEG、WebP 的文件内容并完整解码。输入和输出各限 4 MiB，单边限 4096 像素，解码限 16,777,216 像素。应用 EXIF 方向后编码 WebP 并去除元数据。显示端使用居中裁切的 4:3 容器，文件保留其纠正后原始比例。
- 列表卡片由主图、商品名称和价格组成，支持懒加载。手机端每行显示两张卡片。详情桌面左图右购买信息，手机先图后购买信息，再展示商品介绍和服务信息。没有图片和加载失败时使用统一占位。购买确认沿用现有紧凑摘要。
- 参考 [API 契约](05-api-contract.md#商品主图t245b) 和 [界面规范](08-interface-specification.md)。

## 存储和访问

PRODUCT_COVER_STORAGE_DIR 可设为独立的绝对路径，默认在工作区的 .local-data/product-covers 下。它与 .local-data/wechat-qr 使用两个存储根和文件格式。为应用账号配置私有读写权限，部署时固定路径并在备份清单中同时包含数据库、主图目录和微信二维码目录。图片通过 API 访问。开发服务器只允许读取前端、依赖和共享契约目录，主图配置会拒绝这些目录及其子目录。部署时把主图目录放在反向代理的静态文件根目录之外。

文件由服务端生成 UUID WebP Key，客户端只收到按商品 ID 或 slug 派生的 URL。URL 的版本参数只用于提示浏览器重新加载。旧版本 URL 也只能读取商品**当前**主图，且每次读取都重新检查权限或上架状态。图片响应使用 private, no-store，不应在反向代理设公共强制缓存。存储层校验 Key、目录真实路径、文件类型、硬链接数量、大小及打开前后的文件标识。

写入使用独占创建和文件同步，随后在锁住商品行的事务中更新引用和审计。事务失败或结果未知时，原图仍可使用。删除只清空引用，归档保留管理员读取能力。换图和删除变更商品 updatedAt，因此已打开的旧购买表单会触发原有 PRODUCT_CHANGED 保护。

## 备份和回收

保留历史和未发布文件，以支持未知事务结果、在途读取及还原备份。维护时按以下顺序回收，避免与上传并发。

1. 安排维护窗口，停止所有实例并确认上传、文件读取和事务均已退出。
2. 对数据库和主图目录做配对备份，确认备份可读取。保留已有备份所需的图片文件。
3. 从全部 Product 行导出非空 coverImageKey，包括下架和归档商品。对照所有需要恢复的保留备份的引用。将创建超过 7 天、符合 UUID WebP 命名、无链接且两处均未引用的普通文件列为候选。
4. 先按文件名和数量人工复核，再把候选移到非公开隔离目录。恢复服务后检查主图读取。度过备份保留窗口后才可删除隔离文件。对结果不明的引用不执行清理。

上线需要先在目标数据库单独批准并应用迁移，配置并备份可持久化目录，然后发布新版本。旧版本若仍在运行可继续使用已有商品字段。若数据库恢复到旧备份，应使用对应版本的图片目录。

## 验证

| 命令 | 实际结果 |
| --- | --- |
| npm test | 后端 80/80，前端 45/45 |
| npm run test:db -w backend -- --covers-only --fresh | 主图 9/9，购买商品接口 5/5 |
| npm run test:db -w backend -- --covers-only | 历史数据校验通过。主图 9/9，购买商品接口 5/5 |
| npm run test:db -w backend -- --products-only --fresh | 商品和系统设置 11/11，微信收款码 6/6 |
| npm run test:db -w backend -- --catalog-only --fresh | 目录接口 6/6 |
| npm run test:db -w backend -- --admin-orders-only --fresh | T20 订单中心 14/14 |
| npm run test:db -w backend -- --customer-orders-only --fresh | T21 指引和订单保护 3/3、付款核实 5/5、认证 14/14、管理员自助购物 4/4 |
| npm run test:e2e -w backend -- --covers-only public-catalog.spec.ts customer-purchase.spec.ts | 桌面 Edge 21/21，移动 Edge 21/21 |
| Playwright T20 与 T21 定向回归 | 桌面 Edge 4/4，移动 Edge 4/4 |
| npm run db:generate、db:validate、typecheck、lint、build | 通过 |
| npm run format:check -- --end-of-line auto、git diff --check | 通过 |

新库安装及历史升级均验证 Prisma Schema 无差异，重复部署没有待应用迁移。数据库和浏览器测试使用随机的 MySQL 8.4 实例和单独的文件目录。

目录 HTTP 首轮有两条搜索用例的预期 DTO 遗漏 coverImageUrl，补齐后 6/6 通过。浏览器首轮桌面 18/21。并行数据库测试期间，登录接口耗时约 4.7 秒，错过原有 5 秒的页面跳转断言。另两项失败分别来自后台下拉框拦截测试点击，以及目录测试捕获了新增的公开图片请求。后台用例改用与现有测试一致的键盘操作，目录保留严格的 JSON 请求集合断言并单独允许正式的公开主图 GET。浏览器重跑串行执行，保留现有超时。桌面和移动端均通过 21 项。截图来自真实页面及隔离数据库中的横图、竖图和方图测试样本。


T20 与 T21 运行命令

```powershell
npm run test:e2e -w backend -- --covers-only admin-order-center.spec.ts customer-order-center.spec.ts --grep 'real ADMIN login|paid cancellation|customer login and real paginated|frozen-form edit'
```
