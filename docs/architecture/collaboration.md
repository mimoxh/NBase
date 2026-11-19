# 成员活动、评论与只读分享

2026-11-18。优化第 3 批，建立在[成员与角色](members.md)之上。范围由用户确认：在场提示与最后修改人；评论锚定块并带原文引用，不写入正文、不产生修订；页面只读分享链接，外网验收已放弃，只在本机与局域网使用。只读成员可以评论（2026-11-18 确认）。

## 在场与活动提示

- 每个打开工作台的标签页建立一条 WebSocket：`GET /api/workspaces/:id/live`（`@fastify/websocket`，见[依赖](dependencies.md)）。握手要求同源 `Origin`（防跨站 WebSocket 劫持）和有效会话，所有成员角色都可连接。
- 客户端只发两种消息（JSON，单条不超过 1 KB，每秒超过 20 条的部分丢弃）：`{ t: 'focus', pageId, editing }`（当前打开的页面与是否在输入）和 `{ t: 'ping' }`。只读成员的 `editing` 恒为 false。
- 服务端发给关注同一页面的连接：
  - `presence`：该页的在场成员（账号名、查看 / 编辑中），同一账号的多个标签合并为一项；
  - `saved`：某成员保存了该页（修订号、账号名），客户端在没有未保存修改时提示载入新版本；
  - `comments`：该页评论有变化，评论面板重新读取。
- 状态只在服务进程内存中，不落库；服务重启后客户端自动重连并重新报告。每 30 秒重新核对一次会话与成员关系，会话失效、被移除或改角色后连接以 4401 关闭。每个账号最多 20 条、每个进程最多 500 条连接。
- 非 WebSocket 请求访问该路径返回 426；握手后会话或成员关系无效以 4401 关闭，客户端停止重连并回到登录。
- 前端（`useLiveChannel`）：断线按 1、2、4…最长 30 秒（上下浮动 25%）退避重连，每 25 秒发 ping，70 秒收不到任何消息视为断线；输入后 15 秒无新输入，`editing` 回到 false。顶栏显示在场成员头像（编辑中的带标记）和「刚刚编辑 · 账号」。收到别人的 `saved` 后，客户端等 1.5 秒再比对本地修订，没有草稿时提示「…保存了这个页面的新版本。载入新版本」，有未保存修改时提示可能冲突；自己的保存不提示。
- 最后修改人：页面读取（`GET /pages/:id`）与写入响应带 `lastEditor: { userId, loginName } | null`，取当前修订在 `page_versions.actor_user_id` 上记录的账号；早于 v4 的基线修订没有记录，为 null。

## 评论

数据在迁移 v28 `page_comments`，与正文分开保存：评论不进入正文、修订、历史、搜索、导出和分享。

- `page_comment_threads`：`page_id`、锚点（`anchor_block_id` 可空、`anchor_path` 从根到块的子节点序号）、`quote`（创建时块内被引用的原文，最多 500 字符）、`created_by`、`resolved_at` / `resolved_by`。
- `page_comments`：`thread_id`、`author_user_id`、`body`（1–4000 字符）、`created_at`、`edited_at`、`deleted_at`（软删除）。
- 锚点：块已有稳定锚点（`nbaseBlockId`，块引用时生成）就用它；没有时不为评论去写正文，记录块路径与原文。定位顺序：锚点 ID → 路径处的块仍包含原文 → 全文第一个包含原文的块。都找不到时显示「原文已更改」，评论仍可阅读、回复、解决。
- 权限：所有成员可读；所有成员（含只读成员）可以新建讨论、回复、编辑和删除自己的评论（`post-read` 授权：检查 Origin、CSRF、成员身份）；所有者还可以删除任何人的评论；标记解决与重新打开需要编辑权限（只读成员 403）。
- 上限：每页 500 个讨论、每个讨论 200 条评论。页面进入回收站后评论随页面不可见，恢复后回来。
- 幂等：新建讨论与回复由客户端给出 ID，同一账号重复提交返回已有记录。
- 前端：顶栏「评论」按钮带未解决讨论数，打开右侧评论面板。「评论选中段落」取光标或选区所在的块（只读模式也可用），引用选中文字，没有选区时引用整块文字（最多 500 字符）。点击讨论上方的引用会滚动到对应块并闪烁；找不到时显示「原文已更改」。解决与重开按钮只对编辑者和所有者显示；已解决讨论默认收起，可勾选「显示已解决」。

| 方法与路径（前缀 `/api/workspaces/:id`） | 说明 |
| --- | --- |
| `GET /pages/:pageId/comments` | 该页全部讨论与未删除的评论 |
| `POST /pages/:pageId/comments` | `{ id, commentId, anchor: { blockId, path, quote }, body }` 新建讨论 |
| `POST /comment-threads/:threadId/replies` | `{ id, body }` 回复 |
| `PATCH /comments/:commentId` | `{ body }`，只能改自己的 |
| `POST /comments/:commentId/delete` | 作者或所有者 |
| `POST /comment-threads/:threadId/resolve`、`/reopen` | 编辑者与所有者 |

## 只读分享链接

- 编辑者与所有者在页面菜单「分享…」生成链接：可选是否包含子页面，有效期 1、7、30 天（默认 7 天）。每页同时有效的链接最多 20 个。令牌 32 字节随机数，只存 SHA-256（`page_share_links.token_hash`），链接只在创建时显示一次；可随时撤销。
- 链接形如 `<公开来源>/#share=<链接 ID>.<令牌>`，令牌在 URL 片段中，不进访问日志与 Referer。分享页用 `x-nbase-share` 请求头读取；首次读取同时下发只对 `/api/shared/<链接 ID>/` 路径有效的 HttpOnly、SameSite=Strict Cookie，图片和音视频才能直接加载。
- 公开接口（全部 GET，不登录）：
  - `GET /api/shared/:shareId`：根页面标题、范围内页面目录、过期时间；
  - `GET /api/shared/:shareId/pages/:pageId`：页面标题、正文与更新时间；
  - `GET /api/shared/:shareId/attachments/:attachmentId`：附件内容，支持 Range。
- 范围：根页面，加上（选择包含子页面时）未删除的后代。多维表格、行页面不在范围内；白板只列出标题，提示在工作台中查看。只开放范围内页面当前正文引用的附件；不含评论、历史、回收站、收藏、成员信息。
- 响应带 `X-Robots-Tag: noindex, nofollow`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`；分享页另设 `<meta name="robots" content="noindex">`。
- 限速：同一来源地址 15 分钟内 10 次无效令牌后 429；每个链接每分钟最多 300 次请求。
- 只在本机与局域网使用：来源地址不是回环、私有（RFC 1918、IPv6 ULA）或链路本地地址时一律 404。服务没有开启 `trustProxy`，经同机反向代理转发的请求看到的是代理地址，所以通过公网反向代理暴露服务时这条检查不起作用，需要在代理层限制。`NBASE_SHARE_LINKS=off` 可关闭全部分享接口。
- 渲染：分享页在浏览器中用 [HTML 导出](export.md)的渲染器生成页面，放进 `sandbox="allow-same-origin"`（不允许脚本）的 iframe，附件地址指向分享接口；页面引用如果在分享范围内可以点击切换。
- 状态码：令牌不匹配或链接不存在 404（计入无效次数）；令牌正确但链接已撤销、已过期或根页面进入回收站 410 `SHARE_ENDED`，分享页显示「分享已结束」。
- 访问次数：每次成功读取分享根接口（即打开或刷新分享页）`view_count` 加 1 并记录 `last_viewed_at`；读取单个页面和附件不计数。
- 关闭分享：`NBASE_SHARE_LINKS=off` 时公开接口不注册（404），列表接口返回 `enabled: false`，已有链接仍可查看和撤销，新建返回 403 `SHARE_DISABLED`，对话框提示分享已关闭。
- 前端：页面菜单「分享只读链接…」打开分享对话框（只对文档页显示），链接生成后只显示一次并提供复制按钮。分享页左侧是范围内页面目录，右侧 iframe 显示正文，外部链接在新窗口打开。
- 恢复备份时撤销所有仍有效的分享链接，与邀请链接相同。

| 方法与路径（前缀 `/api/workspaces/:id`） | 说明 |
| --- | --- |
| `GET /pages/:pageId/shares` | 该页链接列表（状态、范围、有效期、访问次数），不含令牌 |
| `POST /pages/:pageId/shares` | `{ includeChildren, expiresInDays }` → 201 `{ share, token, url }`，编辑者与所有者 |
| `POST /shares/:shareId/revoke` | 撤销（幂等），编辑者与所有者 |

## 写接口审计

`route-audit-db.test.ts` 把评论的新建、回复、编辑、删除列为 `post-read`（只读成员 2xx），解决、重开与分享链接的创建、撤销按普通写接口要求 403。公开分享接口全是 GET，不增加公开写接口。

## 尚未支持

- 在场状态只在单个服务进程内共享，多实例部署需要另行设计。
- 评论没有 @提及与通知；白板与数据库视图不能评论。
- 分享页不渲染白板与多维表格，不支持密码保护，不统计访问者身份。
