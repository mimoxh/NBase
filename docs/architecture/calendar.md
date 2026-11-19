# 日历

需求见 [日历](../product/calendar.md)。本文记录三期的契约与实现边界，验证结果见文末。

## 日期值

日期字段的值仍是一个字符串，语法和全部辅助函数在 `packages/contracts/src/dateCells.ts`：

```
值     := 区间 *( "|" 参数 )
区间   := 点 [ "/" 点 ]            两点同类，结束晚于开始
点     := YYYY-MM-DD               全天，结束日包含在内
        | YYYY-MM-DDTHH:MM:SSZ     UTC 时刻，结束时刻不包含在内
参数   := tz=<IANA 时区>           仅定时
        | rrule=<RRULE 子集>       规范写法见 formatRecurrenceRule
        | exdate=<点>,<点>…        被删除的单次，升序，需要 rrule
        | remind=<分钟>,…          开始前多少分钟，升序；全天可用负数表示当天零点之后
```

- 旧值 `YYYY-MM-DD` 仍然有效，含义不变（全天单日）。参数顺序固定，各出现一次，列表升序去重；`formatDateCell` 产生规范写法，`parseDateCell` 只接受规范写法。
- 定时的日子按读者时区计算，和创建时间、更新时间一致。重复规则在 `tz` 时区按墙上时间展开（没有 `tz` 时按 UTC），所以每周 9 点的会议跨夏令时仍在 9 点。
- RRULE 支持 FREQ（DAILY/WEEKLY/MONTHLY/YEARLY）、INTERVAL、COUNT、UNTIL、BYMONTH、BYMONTHDAY、BYDAY（月和年可带序数）、BYSETPOS、WKST。BYWEEKNO、BYYEARDAY、BYHOUR 等和更细的频率不支持。重复事件单次最长 31 天。
- 第一次总是开始值本身（与 RFC 5545 一致），被删除的单次仍计入 COUNT。

**筛选：** 一个区间只要有一天满足就算满足。“是”某天为区间与该天重叠；“晚于”看结束日，“早于”看开始日。单日值的结果与之前相同。重复事件的筛选只看第一次。

**排序与统计：** 按开始点的字符串排序，最小值、最大值取开始点。全天值与定时值混排时，按 UTC 日期近似排列。

**公式：** 日期字段在公式里取开始日。定时值按它自己的 `tz` 取日（没有时按 UTC），因为公式缓存不区分读者。

**日历范围查询：** `DatabaseQueryRequest.range = { propertyId, from, to }`（读者时区的日子，含两端，跨度小于 400 天）取代原先附加的两个日期条件。非重复值与范围重叠即返回；重复值的开始日不晚于 `to`，并且没有 UNTIL 或 UNTIL 那天不早于 `from` 减 31 天时返回。具体单次由客户端用 `dateOccurrences` 展开。契约函数 `rowInRange` 与服务端 SQL 必须给出相同结果。

**编辑重复事件：** `editOccurrence(value, occurrenceStart, next, scope)` 和 `deleteOccurrence` 返回系列行的新值，以及需要新建的行的值（`detached`，复制系列行的标题和字段，不复制正文）：

- 仅此次：系列加 `exdate`，新建一行承接这一次；
- 此次及以后：系列在这一次之前结束（用 UNTIL，原来用 COUNT 的改成之前的次数），新建一行从这一次开始；
- 全部：整个系列平移同样的时间，并采用新的时长。每周只有一天的规则会跟着换到新的星期几。

在全天和定时之间切换时，系列从被编辑的这一次重新开始，原有的 `exdate` 丢弃。

**提醒：** `dateCellReminders` 计算 [from, to) 内的提醒时刻。全天事件从读者时区当天零点起算。

## 接口

类型和校验在 `packages/contracts/src/calendar.ts`，都在 `/api/workspaces/:id/calendar` 下：

| 接口 | 说明 |
| --- | --- |
| `GET /sources` | 有日期类字段的数据库（最多 200 个），带同步来源信息 |
| `GET /settings`、`PUT /settings` | 全局日历的来源、颜色、显示开关、每日笔记开关、新建事件的默认数据库。按账号和工作区保存，属于偏好，后写为准 |
| `POST /events` | 范围内可见来源的事件行，每个来源最多 1000 行，超出的列入 `truncated`；以及范围内的每日笔记 |
| `POST /reminders` | 两天以内窗口里到期的提醒，扫描工作区所有带 `remind=` 的日期值 |
| `GET /sync` | 同步来源列表 |
| `POST /import` | 导入 `.ics` 文本（最多 10 MB），新建或追加到之前的文件导入数据库 |
| `POST /subscriptions` | 新建订阅：建数据库和来源，后台首次同步 |
| `PATCH /sync/:id`、`POST /sync/:id/run`、`DELETE /sync/:id` | 改名称、间隔或网址；立即同步；停止同步（数据库保留，字段解锁） |

`GET /databases/:id` 的 `calendarSync` 说明该库由哪个来源维护；`readOnlyPropertyIds` 中的字段（只读订阅时还有标题）不能手动修改。

**错误：** 改动订阅保管的标题或字段（`PATCH /pages/:id`、行批量新建/修改/复制、新建行或移入该库）返回 422 `{ error: 'PROPERTY_INVALID', reason: 'property-synced' }`；值与当前相同的写入不算改动。任何来源（含文件导入）保管的字段都不能删除或改类型，结构 PATCH 返回 422 `DATABASE_SCHEMA_INVALID`（`reason: 'property-synced'`）。日历接口另有 `{ error }`：订阅网址或抓取的 `URL_INVALID`、`URL_BLOCKED`（本机、内网字面地址建来源时即拒绝），导入的 `NOT_CALENDAR`、`PARSE_FAILED`、`TOO_LARGE`、`ROW_LIMIT`，422 `IMPORT_TARGET_INVALID`（追加目标不是文件导入库），422 `SYNC_KIND_INVALID`（对文件导入改间隔、网址或立即同步），409 `SYNC_RUNNING`（该来源正在同步）。写接口与其他接口一致，须带 `Content-Type: application/json`，`run` 和 `DELETE` 发 `{}`。

## 同步日历数据库

新建时带这些字段：名称（标题）、时间（日期）、地点（文本）、说明（文本）、外部 ID（文本，默认视图隐藏，值为 UID，修改过的单次为 `UID#RECURRENCE-ID`）。默认视图依次为日历和表格。字段 ID 存在来源记录的 `fields` 里。用户可以加自己的字段和行正文，同步不会改动它们。

- **匹配：** 按外部 ID 匹配，`calendar_sync_items` 记下每个事件对应的行、上次写入后的行修订号和内容摘要。内容摘要未变时不写入，避免无意义的修订。
- **文件导入：** 字段可编辑。再次导入时，行修订号与上次导入后一致才更新；否则保留原行，另建一行，计入 `conflicts`。文件里没有的事件不删除。
- **订阅：** 服务端按间隔拉取，`webcal://` 当作 `https://`。抓取沿用网页书签的地址防护（只允许公网地址和默认端口，DNS 固定，每次跳转重查），限时限量；`NBASE_CALENDAR_FETCH=off` 关闭。同步来的字段和标题只读。外部删除的事件，对应行进回收站，可恢复；用户自己删除的行不会被重新建出。订阅网址可能带密钥，只存在服务端，接口只返回主机名，日志不记录网址。
- **ICS 解析：** 支持折行、转义、`TZID`（IANA 名称，以及常见 Windows 时区名映射）、`VALUE=DATE`、`DURATION`、`RRULE`、`EXDATE`、`RECURRENCE-ID`、`STATUS:CANCELLED`。修改过的单次落成单独的行，并在系列行加 `exdate`。不支持的规则只保留第一次，并给出警告。`VALARM` 不导入：导入事件的提醒为空，需要时在行上另行设置。
- 每个来源最多 10000 个事件；写入分块进行，每块最多 500 行，工作区锁内不做随事件数增长的工作。

## 界面

- **日期编辑：** 开始和结束、是否包含时间、重复（不重复、每天、工作日、每周、每月、每年、自定义间隔与星期）、提醒。
- **数据库日历视图：** 月、周、日和日程列表，模式按视图存在本机。跨天事件横跨显示。周和日视图有全天栏和时间轴，拖动改时间（15 分钟一格），拉伸改时长，点空白处新建。拖动重复事件时询问作用范围。只读字段不能拖动。
- **全局日历：** 侧栏入口。来源面板选择数据库和日期字段、颜色与显示开关；可以显示每日笔记，点日期打开当天的笔记。新建事件写入默认数据库。还提供导入 `.ics`、管理订阅的入口。
- **提醒：** 持久化工作台打开时，定期取接下来的提醒，到点用浏览器通知（没有权限时用页内提示）。多个标签页只提醒一次。

## 二期：CalDAV 双向同步

2026-11-17 用户确认：凭据密钥不放进备份；内网 CalDAV 服务器默认禁止，用环境变量开启；冲突时保留副本并提供处理列表；实测用飞书账号。契约在 `packages/contracts/src/calendar.ts` 的 CalDAV 部分。

### 接入

- 来源类型 `caldav`：一个同步日历数据库对应一个外部日历（CalDAV 日历集合），只同步 VEVENT。
- 预设服务器：iCloud `https://caldav.icloud.com`（应用专用密码）、飞书 `https://caldav.feishu.cn`、钉钉 `https://calendar.dingtalk.com`、企业微信 `https://caldav.wecom.work`（三家都在各自客户端里生成专用账号和密码）。也可以填任意 http(s) 地址，只写主机名时按 https。不允许写入的日历按只读处理。2026-11-17 实测飞书：日历权限只有 read，PUT 返回 409，所以飞书 CalDAV 只能单向拉取；钉钉、企业微信未实测。
- 发现：先对 `/.well-known/caldav` 发 PROPFIND（跟随跳转），失败再对用户填的地址本身发。依次取 `current-user-principal`、`calendar-home-set`，再对日历主目录做 Depth 1 的 PROPFIND，列出 `resourcetype` 含 `calendar`、`supported-calendar-component-set` 含 VEVENT（或没有声明）的集合，带 `displayname`、`calendar-color`、`current-user-privilege-set`（有 `write` 或 `write-content` 或 `all` 才算可写）。新建来源时服务端重新发现一次，`calendarUrl` 必须在列表里。
- 认证只用 HTTP Basic。401 记为 `AUTH_FAILED`；找不到主体或日历主目录记为 `NOT_CALDAV`；选的日历已不存在记为 `CALENDAR_NOT_FOUND`。

### 网络防护

- CalDAV 请求走与订阅相同的 `net/guardedFetch.ts`，扩展为任意方法（PROPFIND、REPORT、PUT、DELETE）和请求体：默认只允许公网地址和默认端口，DNS 固定，每次跳转重查，单次响应最多 10 MB，30 秒超时。
- `NBASE_CALDAV_PRIVATE=allow` 时，CalDAV（只有 CalDAV）允许本机、内网地址和任意端口，用于 NAS 上的 Nextcloud、Radicale 等。默认关闭。
- 密码只通过 https 发送；只有开启上面的开关且目标是本机或内网地址时，才允许 http。
- 跳转时，只有目标主机与原主机相同，或者两者同属原主机去掉最左一段后的域（`caldav.icloud.com` 跳到 `p52-caldav.icloud.com`）时，才继续带认证头；否则不跟随，记为 `FETCH_FAILED`。
- 日志只记主机名，不记路径、账号和响应内容。

### 凭据加密

- 账号和密码作为一个 JSON 用 AES-256-GCM 加密后存在来源记录里：`版本(1 字节) | IV(12) | 密文 | 标签(16)`，附加数据为来源 ID，另存密钥指纹（SHA-256 的前 8 字节，十六进制）。
- 密钥来自 `NBASE_CREDENTIAL_KEY_FILE` 指向的秘密文件：一行 base64，解码后正好 32 字节，读取规则同其他秘密文件。没有配置或文件为空（0 字节；Compose 没配密钥时挂载的占位文件 `deploy/no-credential-key`）时 CalDAV 接口返回 503 `CREDENTIALS_UNAVAILABLE`，已有来源同步时记同样的错误；其他功能不受影响。
- 指纹与当前密钥不同（换了密钥或恢复到没有原密钥的实例）时，来源显示 `credentialsOk: false`，用 PATCH 的 `credentials` 重新输入即可，数据和对应关系不变。
- 备份包含加密后的凭据，不含密钥文件。恢复时把原密钥文件放到新实例的秘密目录；没有原密钥就重新输入各账号密码。部署脚本生成 `.secrets/nbase/credential-key`，Compose 以 secret 挂载；二期之前的配置用 `--add-credential-key` 补上。轮换密钥 = 换文件后逐个重新输入密码。
- 删除来源时凭据随来源记录删除。

### 存储（迁移 v22）

- `calendar_sync_sources`：`kind` 增加 `caldav`；增加 `caldav_json`（服务器地址、日历地址、日历名、是否可写，均不是秘密）、`credential_cipher`、`credential_key_id`、`sync_token`、`ctag`。CalDAV 来源也有 `interval_minutes` 和 `next_run_at`，由同一个调度循环处理。
- `calendar_sync_resources`：每个外部资源（一个 `.ics` 地址）一行：`href`、`etag`、最近一次取到的原文（最多 1 MB）。写回时在原文上改，保留 NBase 不认识的内容。
- `calendar_sync_items`：沿用，增加 `href`（所属资源）。一个资源里的系列和修改过的单次各占一项、各对应一行。`content_hash` 表示两边上次一致时的同步字段摘要。
- `calendar_sync_conflicts`：未处理的冲突，主键为来源和事件 UID，记行、副本行、类型、外部的 ETag 和原文、发现时间。
- 这些表纳入备份引擎的表清单。

### 同步过程

每次运行先拉取再写回，同一来源同时只有一次运行（沿用 `status = running` 的认领）。

**判断变化：** 同步字段指标题、时间（去掉 `remind=`）、地点和说明。外部变了 = 资源 ETag 与记录不同且解析后的摘要与 `content_hash` 不同；本地变了 = 行的同步字段摘要与 `content_hash` 不同，或者行进了回收站。只改用户自己的字段或正文不算变化。ETag 变了而内容摘要相同时只更新记录。

**拉取：** 服务器支持 sync-collection（RFC 6578）且有 `sync_token` 时增量取变化；令牌失效或不支持时，用 Depth 1 PROPFIND 取全部 `getetag` 与记录比对。变化的资源用 `calendar-multiget` 分批（每批 100 个）取原文，沿用一期的 ICS 解析。

| 外部 | 本地 | 结果 |
| --- | --- | --- |
| 新增 | — | 建行 |
| 修改 | 未变 | 更新行（保留行上的 `remind=`） |
| 删除 | 未变 | 行进回收站，可恢复 |
| 修改 | 修改 | 冲突 both-changed：行保留 NBase 版本，另建副本行存外部版本 |
| 删除 | 修改 | 冲突 remote-deleted |
| 修改 | 进回收站 | 冲突 local-deleted |
| 删除 | 进回收站 | 只清理记录 |

**写回：** 外部日历可写时，对每个本地有变化且没有冲突的事件：

- 新行（库里没有对应记录、不是冲突副本、时间有效）：生成 UID `<uuid>@nbase`，`PUT` 到 `<日历地址><uuid>.ics`，带 `If-None-Match: *`，并把 UID 写进行的外部 ID。时间为空的行不写回。
- 修改：在资源原文上替换对应 VEVENT 的 SUMMARY、DTSTART、DTEND（去掉 DURATION）、RRULE、EXDATE、LOCATION、DESCRIPTION，SEQUENCE 加一，更新 DTSTAMP 和 LAST-MODIFIED；其他属性和组件（VALARM、ATTENDEE、CATEGORIES、X- 属性等）原样保留。`PUT` 带 `If-Match`。
- 系列行的 `exdate` 里，与资源中仍保留的单次例外（RECURRENCE-ID）对应的日子是一期解析时加上的，写回时去掉；单次例外的行进回收站，则删除该 VEVENT，那一天成为真正的排除日。
- 系列行进回收站：`DELETE` 资源（带 `If-Match`），资源里单次例外的行也进回收站。
- 在 NBase 里拆分重复事件（仅此次、此次及以后）新建的行，写回为外部的独立事件。
- 全天值写 `VALUE=DATE`，结束日加一天（外部不含结束日）。带 `tz`（且不是 UTC）的定时值写 `TZID` 和墙上时间，并附 VTIMEZONE；没有 `tz` 的写 UTC。VTIMEZONE 的来源：原文里已有同名时区就沿用，否则按 `Intl` 推算该年的偏移和夏令时切换生成（每年规则相同的时区可以准确表达，其余按该年切换近似）。
- `412` 说明外部刚改过：重新取这个资源，再按上表判断（通常成为冲突）；判断后仍要写回的只重试一次。`403` 和其他拒绝计入警告 `WRITE_REJECTED`，行保持本地修改，下次再试。

**只读：** 外部日历不可写时，同步字段和标题像订阅一样只读。可写日历里带参会人（ATTENDEE）的事件不写回，因为写回可能给参会人发更新通知；这些行的同步字段和标题只读（`readOnlyRowIds`，服务端同样拒绝修改，返回 422 `property-synced`）。外部 ID 字段在 CalDAV 库里总是只读。

**何时运行：** 按间隔定时运行；“立即同步”；以及本地改动 CalDAV 库的行（新建、修改、进回收站、恢复）后，把下次运行提前到 30 秒后，所以本地修改大约一分钟内写到外部。

**冲突处理：** `GET /calendar/sync/:id/conflicts` 列出冲突及两边的同步字段。`POST /calendar/sync/:id/conflicts/:rowId`：

- `local`：保留 NBase 版本（或删除），下次运行写到外部；副本行进回收站。
- `remote`：采用外部版本（或删除）；副本行进回收站。
- `both`（仅 both-changed）：行保留 NBase 版本写到外部，副本行成为外部的一个新事件。

处理后立即开始一次运行。副本行在处理之前不会被当成新事件写回。

### 接口（新增与变化）

| 接口 | 说明 |
| --- | --- |
| `POST /caldav/discover` | 用服务器地址、账号和密码登录，列出可同步的日历，不保存任何内容 |
| `POST /caldav` | 按 `calendars`（1 到 20 个，各带数据库名称）每个日历新建一个 CalDAV 来源和数据库，全部建成或都不建；加密保存凭据，后台首次同步，返回 `{ sources }` |
| `PATCH /sync/:id` | CalDAV 来源可改名称、间隔和 `credentials`（先验证再保存）；不能改服务器和日历 |
| `POST /sync/:id/run` | CalDAV 来源也可立即同步 |
| `DELETE /sync/:id` | 停止同步，删除凭据；数据库保留，外部日历不动 |
| `GET /sync/:id/conflicts`、`POST /sync/:id/conflicts/:rowId` | 冲突列表与处理 |

错误：`AUTH_FAILED`、`NOT_CALDAV`、`CALENDAR_NOT_FOUND`、`URL_INVALID`、`URL_BLOCKED`、`FETCH_FAILED` 在发现、新建和改凭据时以 422 返回；没有密钥时 503 `CREDENTIALS_UNAVAILABLE`；对非 CalDAV 来源用 `credentials` 或冲突接口返回 422 `SYNC_KIND_INVALID`；冲突不存在 404；`both` 用于非 both-changed 冲突返回 422 `CONFLICT_CHOICE_INVALID`；来源正在同步时处理冲突返回 409 `SYNC_RUNNING`。

### 界面

- 同步对话框新增“CalDAV 账号”：选预设或自定义服务器，显示获取专用密码的位置提示；填账号和密码后“连接”，列出日历（标出只读）；勾选一个或多个（默认勾第一个），每个勾选的日历右侧是它的数据库名称（默认日历名），选间隔后开始同步。没有持久化或服务端没有密钥时说明原因并禁用。
- 来源列表显示 CalDAV 来源的服务器、日历名、双向或只读、上次同步、错误和冲突数；“更新密码”用于 `AUTH_FAILED` 或凭据不可用；“处理冲突”打开冲突列表，并排显示 NBase 和外部的标题、时间、地点、说明，按钮为保留 NBase 版本、保留外部版本、两份都保留。
- 数据库日历视图和全局日历对只读行不允许拖动和编辑同步字段。

### 不做

邀请和回复、忙闲、在外部新建日历（MKCALENDAR）、同步 VTODO、把 NBase 提醒写成 VALARM（提醒只在 NBase 内）、OAuth（三期）。

### 同步库不进入导航

2026-11-17 用户确认：同步日历数据库（文件导入、订阅、CalDAV 都算）默认不显示在页面里，也不作为链接目标。

- `PageSummary.calendarSync: true` 标记这类数据库。迁移 v24 起由 `databases.calendar_hidden` 决定（见“汇总同步与日历库显示”），不再按是否有来源记录计算。
- 服务端：搜索不返回这类数据库及其行；关系图不含这类数据库。
- 网页：页面树、最近、收藏、首页、数据库嵌入的选择、复制/移动/导入/每日笔记的目标位置、双链候选和按标题匹配、白板的页面选择、关联字段的目标库都排除它们。已有的链接仍按 ID 解析，可以打开。
- 入口只有全局日历“同步来源”里每个来源的“打开数据库”。新建来源不再选位置，数据库建在工作区顶层。
- ~~停止同步后，数据库成为普通数据库，重新出现在页面树中。~~ 2026-11-17 改为停止同步后仍隐藏，由全局日历“来源”的“显示到页面树”放回。

### 实现与上文的差异

- 可写 CalDAV 库可以复制行，复制出的行作为新事件写回。
- `NBASE_CALENDAR_FETCH=off` 同时关闭 CalDAV：发现、新建、改凭据返回 422 `DISABLED`，定时运行记同样的错误。接口先检查密钥，没有密钥时仍是 503 `CREDENTIALS_UNAVAILABLE`。
- `NBASE_CALDAV_PRIVATE` 只接受 `allow`、`deny` 或空；其他值，以及配置了却读不到或格式不对的密钥文件，都是启动错误。
- `net/guardedFetch.ts` 固定 DNS 的 lookup 在 `options.all` 时必须返回地址数组（Node 20 起 `autoSelectFamily` 默认开启）。修复前所有按主机名的受防护请求（CalDAV、订阅、网页书签）都会失败，回归测试在 `caldav.test.ts`。
## 三期：Google 与 Microsoft（OAuth）

2026-11-17 用户确认：Google 和 Microsoft 都做；每个工作区自己在服务商后台注册 OAuth 应用，在界面里填写；实测只有 Google 账号，Microsoft 只用模拟服务器测试。契约在 `packages/contracts/src/calendar.ts` 的 OAuth 部分。

开工前核实的官方文档（2026-11-17）：

- Google 的设备码授权只开放 `email`、`openid`、`profile` 和 Drive、YouTube 的少数权限，不含日历，所以 Google 只能用浏览器回调。回调地址必须与登记的完全一致；https 之外只允许本机地址（`localhost`、`127.0.0.1`）。应用处于“测试”状态时，刷新令牌 7 天过期；“发布”后不用审核也能用，授权页显示“未经验证的应用”，最多 100 个用户。刷新令牌 6 个月不用会失效。
- Google 提供 CalDAV 接口：`https://apidata.googleusercontent.com/caldav/v2/<日历 ID>/events`，只接受 OAuth（Basic 返回 401），支持 sync-collection，条件请求只支持 `If-Match`（不支持 `If-None-Match`）。需要在 Google Cloud 启用 CalDAV API；列日历用 Calendar API 的 `calendarList`，也要启用。
- Microsoft 的设备码授权支持个人账号（`/common`、`/consumers`），应用要允许公共客户端流，不需要密钥。刷新令牌 90 天，每次刷新得到新的令牌。注册应用需要 Azure 账户（可免费申请）。
- Graph 正式版（v1.0）的事件增量查询只能按固定时间窗口，并且返回展开后的单次；不限时间的增量只在 beta。重复系列用 `recurrence`（patternedRecurrence）表示，被改的单次在 `exceptionOccurrences`，被取消的单次在 `cancelledOccurrences`。

### 来源与提供方

- 来源类型仍是 `caldav`（双向同步），`CalendarCaldavInfo.provider` 区分 `caldav`（账号密码）、`google`、`microsoft`，`account` 是 OAuth 账号的邮箱。冲突、只读规则、本地改动 30 秒后写回、同步库不进入导航，都与二期相同。
- **Google**：沿用二期的 CalDAV 同步引擎，认证换成 `Authorization: Bearer`。日历地址为 `https://apidata.googleusercontent.com/caldav/v2/<encodeURIComponent(日历 ID)>/events/`；`calendarList` 的 `accessRole` 为 `owner` 或 `writer` 时可写。新建事件不带 `If-None-Match`（地址用新 UUID，不会撞上已有资源）。
- **Microsoft**：`calendar/graph/` 把 Graph 翻译成引擎使用的 `RemoteCalendar` 接口（`calendar/remote.ts`），引擎的拉取、比较、冲突和写回逻辑不变：
  - 一个系列（或单个事件）是一个资源，地址为 `https://graph.microsoft.com/v1.0/me/events/<id>`；资源原文是由 Graph 数据合成的 iCalendar：系列 VEVENT（UID 用 `iCalUId`，RRULE 由 patternedRecurrence 转换，EXDATE 来自 `cancelledOccurrences`），每个被改的单次一个带 RECURRENCE-ID 的 VEVENT，参会人写成 ATTENDEE（所以带参会人的事件只读）。
  - 资源的 ETag 由系列和各被改单次的 `changeKey` 合成。没有增量接口：每次运行列出日历里全部事件（系列和单个事件），与记录比对 ETag。
  - 写回：引擎给出的新原文与 Graph 当前内容比较，只发有变化的字段（PATCH 系列或单次，取消单次用 DELETE 该单次）；新建用 POST，Graph 给出的事件地址和 `iCalUId` 由 `RemoteWriteResult.href`、`uid` 带回，引擎改用它们。条件写入用 `If-Match`（`@odata.etag`），412 按二期的流程重读再判断。
  - 时间：请求带 `Prefer: outlook.timezone="UTC"` 和 `outlook.body-content-type="text"`；`originalStartTimeZone` 是 Windows 时区名时按一期的对照表换成 IANA。写回时 `timeZone` 用对应的 Windows 名称，没有对应时用 UTC。全天事件 `isAllDay`，结束日不含。重复规则只支持 patternedRecurrence 能表达的 RRULE（每天、每周若干天、每月第几天、每月第几个星期几、每年同上；结束为日期、次数或不结束）；其他规则的行不写回，计入警告 `WRITE_REJECTED`。
  - 说明（正文）以纯文本写回；地点写 `location.displayName`。

### OAuth 应用与授权

- **应用**：存在 `calendar_oauth_apps`（每个工作区每个提供方一行）。Google 存客户端 ID 和加密后的客户端密钥（界面可直接上传 Google 下载的 JSON，取 `web` 或 `installed` 里的 `client_id`、`client_secret`）；Microsoft 存客户端 ID 和租户（默认 `common`）。需要凭据密钥，没有时 503 `CREDENTIALS_UNAVAILABLE`。有来源在用时不能删除（409 `OAUTH_APP_IN_USE`）；改客户端 ID 后，旧来源刷新失败会显示需要重新授权。
- **Google 授权**：`POST /oauth/start` 生成 `state`（32 字节随机数，库里只存摘要）和 PKCE（S256），返回授权地址：`https://accounts.google.com/o/oauth2/v2/auth`，`scope=openid email https://www.googleapis.com/auth/calendar`，`access_type=offline`，`prompt=consent`，`redirect_uri = NBASE_PUBLIC_ORIGIN + /api/calendar/oauth/google/callback`。网页在新标签页打开它，原页面每 2 秒查一次流程状态。会话 Cookie 是 `SameSite=Strict`，从 Google 跳回时浏览器不会带上，所以回调不依赖会话：`POST /oauth/start` 同时设置一个 `SameSite=Lax`、HttpOnly、15 分钟的浏览器绑定 Cookie（同一浏览器已有就沿用，库里只存摘要）。回调按 `state` 找到未过期的流程，并要求绑定 Cookie 与发起时相同，防止别人诱导用户完成他发起的授权；然后用授权码换令牌，从 `id_token` 取邮箱和 `sub`，列出日历后把流程标为完成。回调页只显示“可以关闭此页”或失败原因，不带脚本。
- **Microsoft 授权**：`POST /oauth/start` 向 `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/devicecode` 申请设备码，`scope=offline_access openid profile email https://graph.microsoft.com/Calendars.ReadWrite`，返回用户码和网址。网页显示用户码（可复制）和链接，按 `interval` 查询流程；查询时服务端最多每个间隔问一次令牌端点（`authorization_pending` 继续等，`slow_down` 加 5 秒，`authorization_declined` 为 `OAUTH_DENIED`，`expired_token` 为 `OAUTH_EXPIRED`）。账号取 `id_token` 的 `preferred_username` 或 `email`，以及 `oid`/`sub`。
- **流程**：存在 `calendar_oauth_flows`，15 分钟过期，只有发起的用户能读。PKCE 校验串、设备码和拿到的令牌都加密保存。新来源流程完成后返回日历列表，`POST /oauth/sources` 用掉流程，为选中的每个日历建库和来源；这些来源各存一份加密的令牌、各自刷新，授权失效时逐个重新授权。重新授权（带 `sourceId`）完成时，账号（`sub`）必须与来源相同，否则为 `ACCOUNT_MISMATCH`；相同则替换来源的令牌并立即同步。
- **令牌**：来源的 `credential_cipher` 存加密后的 `{ refreshToken, subject }`，附加数据仍是来源 ID。访问令牌只在内存里缓存到过期前 60 秒。刷新时服务商若返回新的刷新令牌，立即替换保存。`invalid_grant` 等表示授权失效，记为 `AUTH_FAILED`，界面提示重新授权。

### 网络

服务商地址是固定的，不来自用户输入，所以不做二期那样的私有地址检查（本机开了代理时，这些域名可能解析成 198.18.0.0/15 的地址）。改为固定主机名白名单：`accounts.google.com` 只在浏览器里打开；服务端只访问 `oauth2.googleapis.com`、`www.googleapis.com`、`apidata.googleusercontent.com`、`login.microsoftonline.com`、`graph.microsoft.com`，只用 https 默认端口，跳转只跟随到白名单内的主机，限时 30 秒、单次响应最多 10 MB。用户填写的 CalDAV 地址和订阅地址仍走二期的防护。`NBASE_CALENDAR_FETCH=off` 同样关闭 OAuth 来源。

### 存储（迁移 v23）

- `calendar_oauth_apps`：`workspace_id`、`provider`、`client_id`、`secret_cipher`（Google）、`tenant`（Microsoft）、`key_id`、时间。
- `calendar_oauth_flows`：`id`、`workspace_id`、`user_id`、`provider`、`source_id`、`state_hash`、`binding_hash`、`secret_cipher`（PKCE 校验串或设备码）、`token_cipher`、`status`、`error`、`account_json`、`calendars_json`、`expires_at`、`next_poll_at`、`poll_interval`。过期的流程在访问时清理。
- `calendar_sync_sources.caldav_json` 增加 `provider`、`account`、`subject`（OAuth 来源）。
- 两张新表纳入备份引擎的表清单；恢复后密文仍需原凭据密钥。

### 接口（新增）

| 接口 | 说明 |
| --- | --- |
| `GET /oauth/apps` | 两个提供方的应用（不含密钥）与 Google 回调地址 |
| `PUT /oauth/apps/google`、`PUT /oauth/apps/microsoft`、`DELETE /oauth/apps/:provider` | 保存或删除应用 |
| `POST /oauth/start` | 开始授权；带 `sourceId` 为重新授权 |
| `GET /oauth/flows/:flowId` | 流程状态；完成时带账号和日历列表（或更新后的来源） |
| `POST /oauth/sources` | 用完成的流程为 `calendars` 里每个日历新建来源和数据库，与 `POST /caldav` 相同 |
| `GET /api/calendar/oauth/google/callback` | Google 回调，不在工作区路径下 |

错误：没有应用 422 `OAUTH_APP_MISSING`；Google 项目没有启用 CalDAV API 或 Calendar API 时，流程失败为 `API_DISABLED`，已有来源同步时记同样的错误（授权完成时先试读一次 CalDAV，尽早发现）；流程不存在、已过期被清理或不是本人 404；流程未完成或已用掉 422 `FLOW_NOT_READY`；有一个日历不在流程的日历里 422 `CALENDAR_NOT_FOUND`（都不建）；`sourceId` 不是同一提供方的 OAuth 来源 422 `SYNC_KIND_INVALID`；OAuth 来源用 PATCH `credentials` 也是 422 `SYNC_KIND_INVALID`；应用在用时删除 409 `OAUTH_APP_IN_USE`；没有密钥 503 `CREDENTIALS_UNAVAILABLE`；抓取关闭 422 `DISABLED`。

### 界面

- 同步对话框新增“Google 日历”和“Microsoft 日历”两块。没有配置应用时，显示分步说明（创建项目、启用 API、配置同意屏幕并发布、创建客户端；Microsoft 为注册应用、允许公共客户端流、添加 Calendars.ReadWrite），Google 的回调地址带复制按钮，并提供上传 JSON 或手填。配置后显示“连接 Google 账号”或“连接 Microsoft 账号”。
- Google：点击后在新标签页打开授权页，本页显示等待和“重新打开授权页”；Microsoft：显示用户码、复制按钮和微软登录链接。完成后列出日历（标出只读），与 CalDAV 一样勾选多个、逐个填名称，选间隔后开始同步。
- 来源列表显示提供方、账号邮箱和日历名；授权失效、凭据不可用或应用缺失时显示“重新授权”。其他与 CalDAV 来源相同。

### 不做

服务商推送通知（webhook，需要外网可达的地址）、Graph beta 接口、Google 的 Calendar API 事件接口（事件走 CalDAV）、共享给我的 Microsoft 日历（`Calendars.ReadWrite.Shared`）、内置的共用 OAuth 应用。

### 实现说明（与上文不同或上文没写的）

应用与密钥：

- `GET /oauth/apps` 也要求凭据密钥，没有时 503 `CREDENTIALS_UNAVAILABLE`，网页只显示密钥说明，不显示填写表单。删除应用不需要密钥；提供方不是 `google` 或 `microsoft` 时 404；没有配置时删除也回 204。两个 PUT 是同一个 `PUT /oauth/apps/:provider` 路由，按提供方检查请求体。
- 更换凭据密钥后，旧密钥加密的 Google 客户端密钥解不开：`GET /oauth/apps` 的 `google` 带 `secretUnavailable: true`，界面要求重新上传 JSON 或填写密钥（不能取消）；这时开始授权返回 422 `OAUTH_APP_MISSING`。已有来源的令牌也解不开，同步记 `CREDENTIALS_UNAVAILABLE`，重新保存应用后逐个“重新授权”。Microsoft 应用没有密钥，直接重新授权。

授权流程：

- 一次建多个来源（`POST /caldav` 与 `POST /oauth/sources`）：所有库和来源在同一个事务里，回执只有一份，用同一个 `clientMutationId` 重试返回同样的 `{ sources }`。`calendar_sync_sources` 每个创建者的 `client_mutation_id` 唯一，所以第一个来源存请求的 ID，后面的存由它和序号派生的 UUID（`sourceMutationId`）。两个选择指向同一个日历（地址编码或末尾斜杠不同也算）为 400 `INVALID_REQUEST`。
- 15 分钟过期只限制等待中的流程。已完成的流程在清理前（过期 1 小时后）都能用来建来源；用掉的流程读取时仍是 `ready`，再用于建来源为 422 `FLOW_NOT_READY`。不存在或别人的流程在 `POST /oauth/sources` 里也是 404。
- Google 回调：同一流程正在换令牌时再次回调，返回 409 页面；没有密钥或抓取已关闭时流程失败为 `FETCH_FAILED`；`access_denied` 和授权页上没有勾选日历权限都是 `OAUTH_DENIED`。授权完成时试读 CalDAV，只有 `API_DISABLED` 让流程失败，其他错误留给首次同步。
- Microsoft：查询令牌时网络失败，流程失败为 `FETCH_FAILED`。刷新令牌时 `invalid_grant`、`interaction_required` 等需要用户重新登录的错误记 `AUTH_FAILED`。
- 重新授权完成时，流程返回更新后的来源和空的日历列表，新的访问令牌直接放进缓存，紧接着的同步不再刷新。访问令牌缓存在进程内存里，按单进程部署设计。

Graph 适配（`calendar/graph/`）：

- 每次运行分页列出日历里的事件，系列再按 ID 读一遍（`$batch` 每批最多 20 个，批量失败时逐个读），才能拿到被改和被取消的单次。资源 ETag 是系列 `changeKey`、各被改单次的 (id, changeKey) 和被取消单次列表的 sha256。`calendarState` 读 `canEdit`；401 时换一次令牌，再 401 为 `AUTH_FAILED`。
- 新建全天事件用工作区时区（调度器传入），时区没有 Windows 名称（如 `Asia/Chongqing`）时写 UTC。
- patternedRecurrence 表达不了的规则（多个或负数的 BYMONTHDAY、第五个星期几、多个月份、BYSETPOS、带 BYDAY 的隔天重复、按小时等）：读取时原文写 `RRULE:X-NBASE-UNSUPPORTED=1`，行上警告 `RULE_UNSUPPORTED`；写回时 422，不发任何请求。带参会人的事件写回也是 422。
- 取消一个单次：用 `/instances` 在该时刻前后 2 天内找到它，再 DELETE。Graph 的 409 和 412 都按 412 处理。
- 在 NBase 里给系列新增一个“被改的单次”不会在 Outlook 创建；去掉一个 exdate 不会恢复已取消的单次。这两种改动目前被忽略，不报错。

## 汇总同步与日历库显示（迁移 v24）

需求见产品文档第 5、6 节。

### 日历库的显示

- `databases.calendar_hidden`（默认 false）：建同步库时设为 true；迁移时有来源记录的库补为 true。v24 之前停止的来源没有留下记录，迁移再按表结构认：字段正好是同步建库的“名称（标题）、时间（日期）、地点、说明、外部 ID（文本）”，没有已删除的字段，且每个视图都隐藏“外部 ID”，这样的库也补为 true；用户改过字段的库认不出，保持显示。停止同步只删来源记录，这个标记不变。
- 页面树、搜索、关系图、链接候选的排除条件都改为看这个标记（`PageSummary.calendarSync` 名字不变）。
- `POST /calendar/databases/:databaseId/reveal`（编辑者）：把标记设为 false，204。数据库不存在 404。
- `CalendarDatabaseOption.hidden`：来源面板据此显示“显示到页面树”。

### 新库自动加入

- `CalendarSettings.autoAdd`（可省略，省略即 true）。服务端用“有效设置”：存下的 `sources` 之外、带日期字段的库，在 `autoAdd` 为 true 时按默认值补上（第一个 `date` 字段，没有时第一个日期类字段；颜色按库在列表中的位置取调色板）。用户关掉的库保留 `visible: false` 的记录，不会被补回。
- `GET /settings` 返回有效设置；`POST /events` 和汇总同步都用有效设置。调色板移到契约（`calendarPalette`），网页和服务端共用。
- 每个库只有一个来源记录：库里新加第二个日期字段不会自动多一项。

### 汇总同步

- `calendar_sync_sources.aggregate_user_id`：非空表示这个来源是汇总日历，值为打开汇总的用户；同一工作区最多一个（部分唯一索引）。只允许 `caldav` 类型（CalDAV、Google、Microsoft 账号都是这一类型）且外部日历可写。用户被删除时置空。
- `PATCH /sync/:id` 增加 `aggregate: boolean`：true 时把工作区里其他来源的汇总关掉，再设到这个来源；false 时清空。改完立即排一次同步。`CalendarCaldavInfo.aggregate` 返回当前状态。
- **范围**：打开汇总的用户的有效设置里 `visible` 的 (库, 日期字段)，且库未删除、没有来源记录、`calendar_hidden` 为 false，字段是有效的 `date` 类型。创建时间、更新时间不推送。
- **对应关系**：沿用 `calendar_sync_items`，加 `database_id`、`property_id`（同时为空或同时非空）。为空的是来源自己的库；非空的是汇总项，对应那个库里的行和那个日期字段。普通库没有地点、说明、外部 ID 字段，汇总项的同步字段只有标题和日期。
- **同步过程**：同一个来源的一次运行里一起处理。拉取时每个事件按 UID 找到项，按项所在的库和字段比较、写行、建冲突副本；外部新出现的事件仍进来源自己的库，只有汇总系列被改的单次（`UID#RECURRENCE-ID`）进系列所在的库。推送时汇总项按自己的字段比较；写回外部时地点和说明保留外部原值。不在范围内的汇总项、日期被清空的汇总项，在拉取之后、推送之前删除外部事件（不带条件，404 也算完成）并删掉项。最后把范围内还没有项、日期有值的行作为新事件推送。
- **触发**：行变化时，除了行所在库的来源，工作区的汇总来源也在 30 秒后运行；汇总用户保存来源设置时同样提前。
- 冲突列表与处理按冲突行所在的库取字段；带参会人的汇总事件不在 NBase 里锁定，但不写回。
- 来源的事件数、行数上限（每个来源最多 `calendarEventLimit` 项）包含汇总项。停止同步（删除来源）时汇总项随来源删除，外部事件保留，与其他来源一致。
- 备份：只加列，备份引擎的表清单不变。
- 网页：有效设置的补全规则在契约 `withAutoAddedSources`，服务端、演示工作台和网页刷新来源时共用；来源面板有“新数据库自动显示”开关和“显示到页面树”（只对隐藏、已无来源的库，编辑者可见）；同步对话框对可写的 CalDAV、Google、Microsoft 来源提供“设为汇总日历 / 取消汇总”，都先确认。验证见 `docs/validation.md`（2026-11-17：日历库显示与汇总同步；2026-11-18：优化第 4 批）。

### Google 与 Microsoft 作为汇总日历（优化第 4 批）

- Google、Microsoft 账号的来源与 CalDAV 来源同为 `kind = 'caldav'`，提供方只在 `caldav_json.provider` 里区分，所以迁移 v24 的约束 `calendar_sync_sources_aggregate`（`aggregate_user_id IS NULL OR kind = 'caldav'`）本来就允许三种提供方，也拒绝文件导入和订阅。本批不需要迁移，备份引擎的结构版本不变。`PATCH /sync/:id` 的 `aggregate` 照旧只看两点：两路来源、外部日历可写；只读的 Google 日历（`accessRole` 不是 `owner` / `writer`）和 Microsoft 日历（`canEdit` 为 false）返回 422 `SYNC_KIND_INVALID`。
- 引擎不分提供方：Google 走二期的 CalDAV 引擎，只是带 Bearer 令牌、新建不带 `If-None-Match`；Microsoft 经 Graph 适配器（见三期）。汇总项的拉取、比较、冲突、清空日期删除、外部删除进回收站、带参会人不写回，都与 CalDAV 汇总相同。Graph 写回汇总项时只 PATCH 标题和时间，Outlook 里的地点、正文保留。
- 授权失效（`AUTH_FAILED`）、应用缺失或凭据密钥更换时，汇总来源与普通来源一样记错误、不发任何写请求，`aggregate` 保持打开；期间对汇总范围内行的修改在重新授权后的第一次同步里写出。界面也相同：来源上显示“重新授权”，同时保留“取消汇总”。取消汇总或把汇总移到别的日历时，旧日历上的汇总事件要等它下次同步成功才删除。
- **写入后读回**：写入的回答没有 ETag 时（Graph 的新建和修改都是这样，少数 CalDAV 服务器也是），引擎随即 GET 一次这个资源。服务商会把事件改成自己的写法，例如 Graph 把每周重复补上 `BYDAY=MO`；读回的每个事件都是刚写的内容（标题、地点、说明相同，日期值展开前 500 次的起止相同），没写的事件与记录一致，就把读回的原文和 ETag 记下。下次运行 ETag 相同，不再读取比较。这样服务商的写法不会被当成外部修改写进行里（原先第一次读回会把汇总行的日期值改写成 Graph 的形式，期间本地再改就成了冲突）。读回失败、内容不符或这次写入去掉了被改的单次时，照旧留到下次运行再读。
- 网页：同步对话框点“立即同步”后 30 秒内每 3 秒刷新来源列表（另外，有来源在运行时照旧每 3 秒刷新）。这次运行在调度器认领前不是 `running`，很快的运行又可能在两次刷新之间做完，只看状态会漏掉结果（例如授权失效）。
- 未在真实账号上验证：只用模拟的 Google CalDAV 与 Graph（`calendar-aggregate-oauth-db.test.ts`）。Graph 表达不了的重复规则照旧不写回（`WRITE_REJECTED`）；在 NBase 里给汇总系列新增“被改的单次”不会在 Outlook 创建（与三期相同）。

## 一期验证结果（2026-11-17）

- 自动检查：`npm run check` 通过（服务端单元测试 102、前端 Vitest 77 文件 639 项、备份测试，构建通过）；`npm run test:db` 在便携 PostgreSQL 18.6（127.0.0.1:54329，见 [本机隔离 PostgreSQL](local-postgres.md)）上 22/22 通过，含日历迁移、JS 与 SQL 的范围/重复/时区一致性。
- 持久化工作台浏览器实测（agent-browser，1024×700 深色与浅色、390×700 窄屏）：数据库日历月/周/日/日程切换；点日期新建行；日期编辑器设置时间（Asia/Shanghai 存为 UTC）、每周重复和两个提醒并持久化；全局日历页显示来源事件、来源面板改颜色后刷新仍在、从全局日历新建行并打开；拖动重复事件的单次弹出「修改重复日程」，选「仅此次」后系列行加 `exdate`、拆分出新行；`.ics` 导入新建数据库（定时事件时区换算正确、RRULE 保留），追加模式再导入同一文件为「新建 0 · 未变 2」；`NBASE_CALENDAR_FETCH=off` 时添加订阅能建来源、首次同步失败显示「服务端已关闭日历抓取」，停止同步后来源移除。
- 顺带修复：视图设置菜单曾被网格底部聚合条遮挡（`.nb-db-views` 溢出裁剪），改为 portal 弹出；导入对话框在已有文件导入库时默认追加而不是新建。
- 未实测：浏览器通知的真实触发（调度与去重为单元测试）；真实地址的订阅抓取全流程；CalDAV 见下文，OAuth 属于三期。

## 二期验证结果（2026-11-17）

- 自动检查：`npm run check` 通过（服务端单元测试 113、前端 Vitest 78 文件 667 项、备份测试 13 项中 12 通过 1 跳过，构建通过）；`npm run test:db` 23/23 通过，含迁移 v22、CalDAV 同步读写、同步库不进搜索和关系图、停止同步后恢复显示。
- Radicale 3.5.10（本机 `NBASE_CALDAV_PRIVATE=allow`）：本地新建行写到外部；修改写回且 SEQUENCE 加一，VALARM 与 X- 属性保留；行进回收站后外部 DELETE；外部删除后行进回收站；三种冲突（both-changed、remote-deleted、local-deleted）出现并能按三种方式处理；更新密码；停止同步后 Radicale 上的数据不变。只读日历只在模拟服务器的测试中覆盖。
- 飞书（`https://caldav.feishu.cn`）：发现和登录正常，日历标为只读；拉取的定时事件（Asia/Shanghai）、全天事件、地点、说明正确。
- 浏览器复测：侧栏不显示同步库；“打开数据库”能打开；搜索同步库标题无结果；停止文件导入的同步后，数据库出现在侧栏。
- 实测中修复：行属性在 409 后丢失草稿（只改了行属性时在新修订上重放）；只有根节点的行打开报“编辑器未能打开此文档”；标签为空时显示多余的“0”；CalDAV 表单在窄宽度下换行；新建同步库后页面树不刷新；密码框被浏览器自动填入登录密码；上文的 `guardedFetch` 问题。
- 未实测：钉钉、企业微信；iCloud；真实服务器上的只读日历之外的 412 与 403 路径（只在测试中覆盖）。
