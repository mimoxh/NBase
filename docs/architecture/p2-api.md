# P2 认证与文档 API 契约

日期：2026-10-25。这里是 P2 实施契约。独立本机 PostgreSQL 18.6 已完成迁移，初始账号和登录 / 会话 / 退出 API 在显式配置数据库的本机服务中通过真实 HTTP 验证；**网页登录流程、文档业务路由和文档持久保存尚未开放**。正式部署仍需独立验收。

## 身份与会话

- 初始所有者只通过部署机器上的 `init-owner` CLI 创建；不提供公开注册、网页初始化或找回密码端点。CLI 使用专用 `NBASE_DATABASE_URL`、登录名和密码文件，在单一事务中建立用户、个人工作区、owner membership 与唯一实例标记；重复或并发初始化失败。
- 密码使用异步 scrypt，参数 `N=2^17, r=8, p=1`，独立随机 salt，版本和参数随散列保存。此设置符合 [OWASP 密码存储建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)的 scrypt 最低组合；目标 NAS 的 CPU/内存成本仍需基准测试。
- `POST /api/auth/login` 接受登录名与密码，成功后建立数据库会话，响应用户、授权工作区、CSRF token 与到期时间；错误凭据不泄露哪个字段不对。`GET /api/auth/session` 读取当前身份，不修改数据；`POST /api/auth/logout` 撤销服务端会话并清除 Cookie。没有公开 setup/register。
- 会话令牌由安全随机数生成，数据库只保存 SHA-256 摘要。Cookie 为 host-only、HttpOnly、SameSite=Strict、Path=/；HTTPS 环境必须设置 Secure，本机回环 HTTP 仅用于开发。变更请求还要验证服务端配置的精确 Origin 与会话绑定的 CSRF 请求头；无任意来源 CORS，不信任未配置的转发头。[OWASP CSRF 建议](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)要求在 Cookie 之外校验显式令牌。P3 反向代理部署前单独验证公开 Origin 与 TLS。
- 任何页面路由先校验会话，再从 `workspace_memberships` 查询权限；客户端传来的工作区 ID 只用于定位，不能授予访问。无会话为 401，存在但无权的资源不向其他用户暴露内容。登录尝试限制与超时、撤销、错误密码和跨工作区测试是 P2-02 出口。

## 页面与写入

所有业务接口统一在 `/api/workspaces/:workspaceId` 下，只有完成上述认证/授权后才注册：

| 接口 | 行为 |
| --- | --- |
| `GET /pages?parentId=&cursor=&limit=` | 按父页面分页读取同工作区未删除子页面；单页上限 100，稳定排序 |
| `GET /page-tree` | P3-06 新增：一次返回从未删除根页经未删除父页可达的全部页面摘要，按 created_at、id 排序，上限 2000，超出时 `truncated: true`；网页目录只用此接口 |
| `GET /pages/:pageId` | 读取页面元数据、当前修订与版本化正文 |
| `POST /pages` | 创建页面，正文采用已支持的 `schemaVersion`，初始 revision 为字符串 `"1"`；可携带 `icon` / `cover` |
| `PATCH /pages/:pageId` | 修改标题、正文、父页面或 `icon` / `cover`（显式 `null` 移除）；携带 `expectedRevision` 与 `clientMutationId` |
| `DELETE /pages/:pageId` | 软删除选中页面及当时有效后代；携带修订与写入标识 |
| `POST /pages/:pageId/restore` | 恢复选中页面和同删除组内后代；父页面仍删除时恢复到根 |
| `GET /favorites` | 返回当前用户在该工作区的收藏页面 ID 列表（仅未删除页面，按收藏时间排序） |
| `PUT /favorites/:pageId` | 幂等收藏一个未删除页面；页面不存在或已删除返回 404，超过 200 个收藏返回 409 `FAVORITE_LIMIT` |
| `DELETE /favorites/:pageId` | 幂等取消收藏，始终返回 204 |
| `GET /mutations/:clientMutationId` | 仅供原请求用户在同一工作区查询已提交的写入收据 |

页面 `icon` 是恰好一个字形簇（grapheme）的 emoji（允许 ZWJ、修饰符与 keycap 序列，1–32 UTF-16 单元），`cover` 是契约枚举 `pageCoverIds`（`sage | ochre | slate | rose | sand | sky`）之一；非法值返回 400 `INVALID_REQUEST`，与非法标题同级。页面摘要、文档、目录树、回收站摘要与搜索结果均携带 `icon`/`cover`；历史版本快照保存写入时的 icon/cover，而 `restore-version` 只恢复标题与正文，保留当前外观与目录位置。只改 icon/cover 也是一次正常的修订更新（新修订 + `page_versions` 快照 + 收据，同一事务）。

收藏属于个人偏好而非页面内容：写入天然幂等（`ON CONFLICT DO NOTHING` / 无条件 DELETE），不写操作收据、不增修订、不产生 `page_versions` 行。加入收藏在工作区行锁内先核对页面存在且未删除、再核对数量上限，避免并发突破限制；已删除页面的收藏行保留但 `GET /favorites` 隐藏，页面恢复后重新出现。

每次写入都使用 UUID `clientMutationId`；服务端在业务变更的同一事务中保存请求摘要、结果和状态码。同一用户、工作区、标识、相同请求返回原结果；标识配不同请求返回冲突。收据先不自动清理，以免响应丢失后的重试重新生效；保留策略在有数据规模证据后再定。迁移 v11 起，页面类收据不重复保存正文：写入时核对同修订快照完全相同才省略 `content`，重试和 `GET /mutations/:clientMutationId` 返回的响应形状不变，正文来自该修订的 `page_versions`。请求超时不能据此宣称未保存。

`revision` 对应 PostgreSQL `bigint`，JSON 中只使用十进制字符串。更新在事务中检查修订，旧值返回 409 `REVISION_CONFLICT` 并保留当前服务端版本，客户端草稿也不得被覆盖。页面移动、删除和恢复先锁定所在工作区行，再验证父链、同工作区授权与修订，最后变更，避免并发形成环。未知正文版本、节点或超出限制的数据拒绝写入并保留旧内容；Markdown 导入不绕过此校验。具体树行为见 [子页面树契约](page-tree.md)。

数据库迁移必须先于业务路由开放完成；迁移失败或数据库不可用时不接收业务写入。`/api/health` 只表示进程连通，不表示数据库、备份或产品就绪。
