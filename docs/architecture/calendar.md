# 日历

需求见 [日历](../product/calendar.md)。本文记录一期和二期的契约与实现边界，验证结果见文末。

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
- 密钥来自 `NBASE_CREDENTIAL_KEY_FILE` 指向的秘密文件：一行 base64，解码后正好 32 字节，读取规则同其他秘密文件。没有配置时 CalDAV 接口返回 503 `CREDENTIALS_UNAVAILABLE`，已有来源同步时记同样的错误；其他功能不受影响。
- 指纹与当前密钥不同（换了密钥或恢复到没有原密钥的实例）时，来源显示 `credentialsOk: false`，用 PATCH 的 `credentials` 重新输入即可，数据和对应关系不变。
- 备份包含加密后的凭据，不含密钥文件。恢复时把原密钥文件放到新实例的秘密目录；没有原密钥就重新输入各账号密码。部署脚本生成 `.secrets/nbase/credential-key`，Compose 以 secret 挂载。轮换密钥 = 换文件后逐个重新输入密码。
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
| `POST /caldav` | 新建 CalDAV 来源和数据库，加密保存凭据，后台首次同步 |
| `PATCH /sync/:id` | CalDAV 来源可改名称、间隔和 `credentials`（先验证再保存）；不能改服务器和日历 |
| `POST /sync/:id/run` | CalDAV 来源也可立即同步 |
| `DELETE /sync/:id` | 停止同步，删除凭据；数据库保留，外部日历不动 |
| `GET /sync/:id/conflicts`、`POST /sync/:id/conflicts/:rowId` | 冲突列表与处理 |

错误：`AUTH_FAILED`、`NOT_CALDAV`、`CALENDAR_NOT_FOUND`、`URL_INVALID`、`URL_BLOCKED`、`FETCH_FAILED` 在发现、新建和改凭据时以 422 返回；没有密钥时 503 `CREDENTIALS_UNAVAILABLE`；对非 CalDAV 来源用 `credentials` 或冲突接口返回 422 `SYNC_KIND_INVALID`；冲突不存在 404；`both` 用于非 both-changed 冲突返回 422 `CONFLICT_CHOICE_INVALID`；来源正在同步时处理冲突返回 409 `SYNC_RUNNING`。

### 界面

- 同步对话框新增“CalDAV 账号”：选预设或自定义服务器，显示获取专用密码的位置提示；填账号和密码后“连接”，列出日历（标出只读）；选一个，填数据库名称和间隔后开始同步。没有持久化或服务端没有密钥时说明原因并禁用。
- 来源列表显示 CalDAV 来源的服务器、日历名、双向或只读、上次同步、错误和冲突数；“更新密码”用于 `AUTH_FAILED` 或凭据不可用；“处理冲突”打开冲突列表，并排显示 NBase 和外部的标题、时间、地点、说明，按钮为保留 NBase 版本、保留外部版本、两份都保留。
- 数据库日历视图和全局日历对只读行不允许拖动和编辑同步字段。

### 不做

邀请和回复、忙闲、在外部新建日历（MKCALENDAR）、同步 VTODO、把 NBase 提醒写成 VALARM（提醒只在 NBase 内）、OAuth（三期）。

### 同步库不进入导航

2026-11-17 用户确认：同步日历数据库（文件导入、订阅、CalDAV 都算）默认不显示在页面里，也不作为链接目标。

- `PageSummary.calendarSync: true` 标记这类数据库，由服务端按 `calendar_sync_sources` 是否有记录计算。
- 服务端：搜索不返回这类数据库及其行；关系图不含这类数据库。
- 网页：页面树、最近、收藏、首页、数据库嵌入的选择、复制/移动/导入/每日笔记的目标位置、双链候选和按标题匹配、白板的页面选择、关联字段的目标库都排除它们。已有的链接仍按 ID 解析，可以打开。
- 入口只有全局日历“同步来源”里每个来源的“打开数据库”。新建来源不再选位置，数据库建在工作区顶层。
- 停止同步（文件导入也可以停止）后，数据库成为普通数据库，重新出现在页面树中。

### 实现与上文的差异

- 可写 CalDAV 库可以复制行，复制出的行作为新事件写回。
- `NBASE_CALENDAR_FETCH=off` 同时关闭 CalDAV：发现、新建、改凭据返回 422 `DISABLED`，定时运行记同样的错误。接口先检查密钥，没有密钥时仍是 503 `CREDENTIALS_UNAVAILABLE`。
- `NBASE_CALDAV_PRIVATE` 只接受 `allow`、`deny` 或空；其他值，以及配置了却读不到或格式不对的密钥文件，都是启动错误。
- `net/guardedFetch.ts` 固定 DNS 的 lookup 在 `options.all` 时必须返回地址数组（Node 20 起 `autoSelectFamily` 默认开启）。修复前所有按主机名的受防护请求（CalDAV、订阅、网页书签）都会失败，回归测试在 `caldav.test.ts`。
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
