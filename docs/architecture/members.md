# 成员与角色

2026-11-17 起，一个自部署实例可以邀请其他人加入同一个工作区。范围由用户确认：只用邀请链接（不发邮件、不开放注册）；工作区角色为所有者、编辑者、只读成员；收藏等个人数据按账号分开；HTTP 认证只在回环地址或 HTTPS 公网来源下工作的规则不变。

## 角色

| 角色 | 能做什么 |
| --- | --- |
| 所有者（owner） | 全部内容读写；管理成员与邀请；每日笔记设置。每个工作区恰好一个，由 `init-owner` 创建，不能被降级或移除（数据库约束 `workspace_memberships_owner_stays` 兜底）。 |
| 编辑者（editor） | 全部内容读写（页面、数据库、白板、标签、模板、附件、日历来源与同步）。不能管理成员。 |
| 只读成员（viewer） | 阅读、搜索、导出、查看历史与回收站、关系图、日历；可以写自己的个人偏好（见下）。其余写接口一律 403 `FORBIDDEN`。 |

角色变化或移除会立即结束对方的全部会话（`auth_epoch + 1` 并撤销 `sessions`），打开的标签页下一次请求得到 401，重新登录后拿到新角色。

## 个人数据

- **收藏**（`PUT/DELETE /favorites/:pageId`）和**日历显示设置**（`PUT /calendar/settings`）按账号保存，只读成员也可以写。它们走 `post-read` 授权：仍检查 Origin、CSRF 和成员身份，但不检查角色。
- 个人笔记模板创建后用于新建页面，只读成员不能新建页面，所以模板写入仍要求编辑权限。
- 移除成员时保留这些行（`page_favorites`、`calendar_settings` 等以 `ON DELETE RESTRICT` 引用成员关系），恢复后原样可用；进行中的日历 OAuth 授权流程（`calendar_oauth_flows`）会删除，因为它们保存的是这个人的临时密钥。成员写过的页面、历史和已建好的同步来源属于工作区，不受影响。

## 数据（迁移 v26 `workspace_members`）

- `workspace_memberships.removed_at`：非空表示已移除。所有授权与查询路径在连接成员关系时都带 `removed_at IS NULL`（认证、页面、搜索、标签、每日笔记、数据库读写与查询、关系图、日历来源）。已移除的人登录时与密码错误的响应相同（401 `AUTH_INVALID`）；会话读取得到 401 并清除 Cookie；万一存在未撤销的会话，工作区接口返回 404。
- `workspace_invitations`：`token_hash`（32 字节 SHA-256，唯一）、`role`（editor/viewer）、`created_by`、`created_at`、`expires_at`、`revoked_at`、`accepted_at` + `accepted_user_id`。约束保证过期晚于创建、接受字段成对出现、撤销与接受不能同时存在。
- 状态由字段推出：已接受 > 已撤销 > 已过期 > 待接受。

## 邀请链接

1. 所有者在「设置 › 成员」选择角色与有效期（1、7、30 天，默认 7 天）生成链接。服务端生成 32 字节随机令牌，只存它的 SHA-256；令牌与链接只在创建响应里出现一次。同时待接受的邀请最多 50 个（`INVITATION_LIMIT`）。
2. 链接形如 `https://<公开来源>/#invite=<43 位 base64url>`。令牌放在 URL 片段里，不进入服务端访问日志和 Referer。
3. 打开链接的页面用 `x-nbase-invite` 请求头调用 `GET /api/invitations/status`，只在待接受时返回工作区名称、角色和过期时间。
4. 对方自己设置账号名（与 `users` 表规则相同：3–64 位小写字母、数字、点、下划线、连字符）和密码（至少 15 个字符），提交 `POST /api/invitations/accept`。服务端在一个事务里锁定工作区行和邀请行，再创建账号、成员关系、标记邀请已用、建立会话，返回 201 和会话 Cookie。两个人同时使用同一个链接时只有一个成功，另一个得到 `INVITATION_USED`。
5. 成功后页面从地址栏和当前历史记录里去掉 `#invite=`，进入工作区。已登录的浏览器打开邀请链接时，先提示退出当前账号。

公开接口按来源地址计失败次数：15 分钟内 10 次失败后返回 429（查不到的令牌、校验失败、已用/过期/撤销都计入）。接受接口要求同源 Origin 和 JSON；状态接口在带 Origin 时也要求同源。密码哈希只在邀请可用且账号名空闲时才计算。

## 接口

成员管理接口只对所有者开放（其他角色 403 `FORBIDDEN`），写接口要求同源 Origin、JSON 与 CSRF。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/workspaces/:id/members` | 成员列表：账号名、角色、加入时间、移除时间、最近登录 |
| `PATCH /api/workspaces/:id/members/:userId` | `{ role: 'editor' \| 'viewer' }`；对所有者或自己返回 409 `MEMBER_OWNER` |
| `POST /api/workspaces/:id/members/:userId/remove` | 移除（幂等） |
| `POST /api/workspaces/:id/members/:userId/restore` | 恢复（幂等），对方需重新登录 |
| `GET /api/workspaces/:id/invitations` | 最近 200 个邀请及状态，不含令牌 |
| `POST /api/workspaces/:id/invitations` | `{ role, expiresInDays? }` → 201 `{ invitation, token, url }` |
| `POST /api/workspaces/:id/invitations/:invitationId/revoke` | 撤销（幂等）；已接受的返回 409 `INVITATION_USED` |
| `GET /api/invitations/status` | 公开；令牌放在 `x-nbase-invite` 请求头 |
| `POST /api/invitations/accept` | 公开；`{ token, loginName, password }` |

错误码：`INVITATION_NOT_FOUND`、`INVITATION_EXPIRED`、`INVITATION_USED`、`INVITATION_REVOKED`、`INVITATION_LIMIT`、`LOGIN_TAKEN`、`LOGIN_NAME_INVALID`、`PASSWORD_TOO_SHORT`、`MEMBER_OWNER`。

## 写接口审计

`apps/server/test/route-audit-db.test.ts` 通过 `buildApp({ onRoute })` 收集所有非 GET 路由，用只读成员逐个请求：

- 工作区外的写接口只允许登录、退出和接受邀请三个；新增其他公开写接口会让测试失败。
- 除下列 `post-read` 接口外，每个工作区写接口都必须返回 403 `FORBIDDEN`，并且请求后页面数量不变。新增写接口默认按此检查。
- `post-read`（只读成员可用，测试用真实目标要求 2xx）：数据库 `query`、`aggregate`、`rows/read`；日历 `events`、`reminders`、`settings`；收藏的 `PUT` 与 `DELETE`。
- 成员关系被移除但会话仍在时，所有写接口返回 404，所有工作区 GET 接口返回 401 或 404；通过移除接口移除后，所有写接口返回 401。

## 界面

- 所有者在「设置」弹窗的「成员」分区管理：成员列表（改角色、移除需二次确认、恢复）、生成邀请链接（角色与有效期，只显示一次并可复制）、邀请列表（状态与撤销）。
- 只读成员在主区域顶部看到「你是只读成员」提示；目录不显示新建、移动、排序、删除；回收站可浏览但不显示恢复；日历不显示「导入与同步」；编辑器、标题、标签、数据库与白板都是只读。
- 邀请页处理无效、过期、已用、已撤销四种状态，以及已登录、网络失败。

## 备份与恢复

`scripts/backup-engine.mjs` 对 v26 及以后的库导出 `workspace_invitations`。恢复到新环境时撤销所有仍待接受的邀请：备份里可能带着已经发出的链接，恢复后不应继续有效。成员关系（含 `removed_at`）原样恢复。

## 尚未支持

- 成员忘记密码：没有自助找回，也没有所有者重置成员密码的命令；目前只能移除后用新的账号名重新邀请。
- 每个账号只属于一个工作区，界面只使用第一个工作区。
- 邀请不限制使用者身份；拿到链接的人都能加入，所以要通过可信渠道发送，不用时撤销。
