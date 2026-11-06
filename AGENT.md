# NBase 架构与开发规范

## 架构

NBase 采用 Web-first，React 网页通过同源 API 访问 Fastify 服务。前端文档编辑器使用 Lexical 0.52。无数据库配置时使用明确标识的会话演示工作台；配置独立 PostgreSQL 与附件目录后，服务先运行迁移、核验文件目录，再提供账号和受授权保护的文档/附件 API，网页进入持久化工作台。浏览器 IndexedDB 草稿只用于故障恢复，不能充当已保存的正式内容或备份。

## 模块职责

- `apps/web/src/App.tsx`：按健康契约选择持久化工作台或明确标识的会话演示；服务状态未知时显示连接失败，不偷偷降级到演示数据。
- `apps/web/src/shell/`：两套工作台共用的方案 B（Notion 家族）外壳展示组件：侧栏、页面树、顶栏、保存状态胶囊、页头（emoji 图标、CSS 预设封面）、右侧目录、菜单、提示条、Toast 与主题（浅/深/跟随系统，存 localStorage）。只收 props、回调，不引用持久化模块。设计 token 和布局在 `shell.css`（`nb-` 前缀，≤720px 抽屉布局）。保存胶囊的色调由 `saveTone.ts` 按状态原文映射，只有服务端确认的状态才显示「已保存」；演示模式固定显示「演示 · 未保存」。
- `apps/web/src/workspace/`：不接数据库的会话演示，复用 shell 外壳，常驻演示模式提示条；含页面组织、收藏（starred）、图标/封面、本地回收站、搜索和导入导出。
- `apps/web/src/persistence/`：同源账号、页面、附件、搜索、历史与回收站客户端，真实页面工作台、单页 Markdown/附件 ZIP 导出、按账号/工作区/页面/页面实例隔离的 IndexedDB 草稿、操作收据查询和冲突另存流程。每次页面加载生成新的实例 ID；不要用可复制到新标签的 `sessionStorage` 标识作为草稿键。待确认创建与恢复/删除按操作 ID 存储，并按账号/工作区找回。比较草稿与服务端 JSON 时忽略对象的未定义字段和属性顺序；恢复或另存成功后只清理版本完全未变化的来源草稿。历史和回收站预览使用独立只读编辑器，不接主页面保存回调。持久化搜索只查询服务端已保存页面，输入时取消过期请求；结果打开仍经现有页面切换流程。目录通过单次 `/page-tree` 请求加载，不逐个父页面请求；`Tree` 保持 memo 和稳定回调。图标、封面和移动统一走 `updatePageMeta`：先等待并完成在途保存，有未解决草稿或待确认操作时拒绝，再以 expectedRevision 提交。收藏按账号存服务端，非乐观更新。历史「显示变更」由 `versionDiff.ts` 在前端比较相邻版本的可见文字（按块 LCS 加按字配对），只读展示，超限时不计算。不要在渲染路径或每次按键中额外调用完整 `getSnapshot()` / Markdown 导出，源码和导出只在需要时计算。
- `persistence/` 内的工作台拆分：`PersistentWorkspace.tsx` 保留会话、页面打开与组合。`usePageSaver.ts` 是页面写入唯一路径，负责本机草稿、串行保存、收据确认、冲突和拒绝处理，行为由 `usePageSaver.test.tsx` 固定。`pageActions.ts`（删除/恢复）和 `pageTransfers.ts`（导出/上传/导入）是每次渲染重建的闭包工厂，不是 Hook，依赖一律从上下文传入。`draftCompare.ts`、`pageTreePaths.ts` 和 `workspaceErrors.ts` 只放纯逻辑，`WorkspaceNotices`、`WorkspacePanels`、`PageActionDialogs`、`LoginForm` 只负责展示。
- `apps/web/src/editor/`：Lexical 节点、版本化快照、Markdown 受限转换、编辑器、安全粘贴及稳定 ID 的同源附件节点；`DocumentEditor` 按文档 ID 隔离实例，并通过 `onReady`、`onChange`、`getSnapshot` 向工作台提供最新状态。搜索定位只选择 DOM 文字或滚动附件，不改写 Lexical 内容。外部图片引用保留为不加载的占位，上传附件另用 `attachment` 节点。斜杠命令在 `plugins/SlashCommandPlugin.tsx`，与工具栏共用 `blockStyles.ts` 的块样式切换。代码高亮用 `@lexical/code-prism`（`plugins/CodeHighlightPlugin.tsx`），语言清单与别名在 `codeLanguages.ts`/`prism-languages.ts`；持久化与比较正文一律先过 `normalizeDocumentContent`（`normalize.ts`），高亮节点不进入快照或修订比较。公式 `nodes/EquationNode.tsx` + `plugins/EquationPlugin.tsx` 用本地 KaTeX 渲染与弹层编辑。正文中文字体优先使用 `Noto Sans SC`，后备为系统中文字体；未打包 Web 字体，跨设备渲染需实测。
- `apps/web/src/components/`：工作台通用图标和对话框。
- `apps/web/src/api.ts`：网页健康请求、8 秒超时和响应契约校验；健康状态只说明进程连通。
- `apps/web/src/styles.css`：全局入口，主题来自 `shell/shell.css`；编辑器局部样式在 `editor/editor.css`，颜色使用 `--nb-*` 变量，以适配深色模式。
- `apps/web/vite.config.ts`：构建时分出 react、lexical 与 katex 三个 vendor chunk；不靠调高 `chunkSizeWarningLimit` 消除体积提示。
- `apps/server/src/app.ts`：可注入测试的 Fastify 应用工厂、健康检查、可选账号/文档/附件路由、静态文件入口。
- `apps/server/src/config.ts` / `index.ts`：共用数据库 URL 或独立字段/密码文件配置；先校验 origin 和附件目录、运行迁移，再监听。Docker 强制数据库配置，缺失时不能降级演示；`/api/ready` 检查数据库与附件读写，`/api/health` 保持存活契约。连接池处理空闲断连，关闭时释放资源。
- `apps/server/src/db/`：PostgreSQL 连接迁移和 schema 版本校验；搜索旧数据回填与历史基线在迁移事务内完成，失败时启动失败。
- `apps/server/src/auth/`：一次性所有者初始化、仅本地的密码重置/会话撤销 CLI、密码散列、数据库会话、Cookie / CSRF / Origin 校验、共享工作区授权与账号仓储。维护仅定位 instance owner 并核对账号名；登录创建会话与维护锁同一用户行，通过 auth_epoch 拒绝维护前读出的旧凭据快照。工作区成员关系由服务端查询，不以客户端 ID 授权。
- `apps/server/src/pages/`：版本化 Lexical JSON 输入校验（含 `equation` 节点源码与 inline 标记）、工作区授权的页面查询（含递归 CTE 的有界目录树，上限 2000）与有界搜索、可见文字与公式源码提取、附件引用校验、分页、修订/历史快照事务、子页面循环保护、子树范围核对、软删除/选择恢复与操作收据。页面 `icon`（单个 emoji 字素）和 `cover`（契约 `pageCoverIds` 白名单）按普通修订写入，并进入 `page_versions`；历史恢复保留当前图标和封面。按账号的 `page_favorites` 是个人偏好：PUT/DELETE 幂等、不产生修订或收据，在工作区锁内限 200 个；页面在回收站时隐藏收藏，恢复后重新显示。
- `apps/server/src/attachments/`：受同一工作区授权保护的上传与读取、文件类型/大小限制、UUID 派生磁盘路径、SHA-256 校验和可重试的附件元数据事务。目录不能位于 Web 静态目录内。
- `packages/contracts/src/`：共享健康、账号、文档、附件、搜索、历史与回收站 API 契约；不承载服务端实现或界面状态。
- `Dockerfile` / `compose.yaml`：固定基础镜像、构建上下文白名单、非 root 应用与独立 PostgreSQL/附件命名卷；数据库不发布端口，应用只发布回环端口。maintenance profile 提供一次性 admin CLI，常驻应用不挂载 owner 密码。`scripts/setup-docker.mjs` 创建随机凭据与本机配置且拒绝覆盖。`compose.p2-local.yaml`、`scripts/reset-p2-workbench-owner.mjs`、`scripts/p2-fault-proxy.mjs`、`scripts/check-p3-deployment.mjs`、`scripts/p3-perf-baseline.mjs` 和 `scripts/p3-perf-browser.mjs`（只接受 `nbase-p3-perf-YYYYMMDD` / 4328 的性能基线，后者通过 CDP 驱动本机 Edge）仅用于限定的本机测试环境，不作为业务数据维护入口。
- `scripts/backup.mjs` / `backup-paths.mjs`：宿主 Docker 维护控制器，项目级互斥、备份目录与数据卷/秘密目录分离、停原应用、拒绝其他卷写入者，结束后重启精确原容器而非按标签重建；恢复目标保持停机。`scripts/backup-engine.mjs`：maintenance 构建目标内的 PostgreSQL 快照导出、附件复制、清单/内容摘要、离线校验及空目标恢复。maintenance 镜像单独安装固定版本 PostgreSQL 客户端，正常应用镜像不包含备份 CLI。
- `docs/`：产品需求、技术决定、计划、设计原则和实际验证记录。

## 数据与接口规范

- Markdown front matter 的 `title` 优先于文件名，`tags` 关联工作区标签，`date` 和安全未知键保存在根节点 NodeState。YAML 使用有界安全解析，错误整篇保留原文。脚注节点保留标识和定义的块位置，解析内部占位只在本次转换使用，不能进入保存内容。引用式链接归一为内联链接。
- `editor/sourceEditing.ts` 核对原正文与输入转换的语义往返，保全根元数据及明确的快速记录标记；不能表达的属性、附件写法、格式或超限结果须阻止应用。`SourceEditorDialog` 提供预览、应用、取消和复制，`sourceDrafts.ts` 独立保存按账号/工作区/页面/编辑实例隔离的原基准及输入，恢复和清理使用版本比较。`DocumentEditor.replaceContent` 接入同一撤销历史，应用后由原页面草稿、修订及冲突流程保存。持久化容器在应用前后核对编辑实例与基准正文，并通过授权附件接口校验文件。
- 文件夹导入先持久化原文件、批次及逐项操作 ID，再创建骨架，最后按骨架修订上传附件和重建正文。IndexedDB 批次按账号和工作区隔离，浏览器锁和租约防止同时执行。子树 ZIP 使用 manifest 保存层级，正文引用使用包内相对路径；页面 ZIP 不是数据库备份。
- Mermaid 节点只保存原始源码，预览按需加载本地固定版本渲染器。渲染在不带 same-origin 的 sandbox iframe 中进行，用 CSP 拦截外部资源，结果经校验后作为 Blob 图片展示；渲染诊断不改写源码或产生正文修订。
- 页面引用节点保存目标 UUID 和显示文字。`page_links` 从已保存正文按引用顺序派生，创建、正文保存和历史恢复同事务更新。读取时校验工作区成员及来源和目标的活动状态。索引可离线清空后在同一事务运行 `backfillPageLinks` 重建，正文和修订保持原值。
- 标签定义和页面关联按工作区持久化，页面标签变更走普通修订。个人模板按账号和工作区保存结构化正文。每日笔记按工作区和日历日期唯一，含回收站中的页面，换日采用工作区时区。快速记录使用正文标题上的持久标记定位章节，客户端先保留待提交文字和操作 ID，再等待正文保存。
- 个人模板写入先由 `persistence/templateWrites.ts` 将完整请求及名称/正文快照写入独立 IndexedDB，键包含账号、工作区与操作 ID；管理弹层按账号/工作区重新挂载，关闭、刷新或重新登录后显式恢复。未知结果按原接口、原正文与原操作 ID 重试，使用当前 CSRF；401/403/404 不能证明原请求未提交。确认拒绝后的纠正/另存原子替换旧记录，成功仅按完整版本 CAS 清理。本机落盘失败时停止网络写入并保留复制/下载入口，尚未落盘的内容阻止静默关闭；每次异步核对后检查实例是否仍在，卸载后保留记录供恢复。
- 普通插表统一仅首行为表头，工具栏和斜杠使用相同契约。源码转换按原 JSON 保全顶层连续、无子节点且属性为已知默认值的普通空尾段，保留表后光标出口，重复往返不增加空段；空白文本、内部空段、真实列头、宽高、合并及未知属性仍受防损比较保护。斜杠插表只清理本次已消费且仍为空的触发段。
- `apps/server/src/notes/` 提供标签、模板、复制、每日笔记及快速记录的授权路由。页面相关写入复用工作区锁、正文校验、历史与操作收据。备份引擎按迁移版本核对表清单和摘要。
- 提示块 `callout` 保存类型、可选标题和子节点，行内高亮使用 Lexical 原生格式位。页内查找按 Lexical 块索引，替换走一次编辑事务。折叠通过视图标记隐藏章节，大纲和查找定位在滚动前展开目标，视图状态不进入文档、草稿或修订。
- 编辑器快照保存结构化正文和大纲，纯文本与 Markdown 投影按需计算。新 IndexedDB 草稿保留结构化正文，冲突下载时转换 Markdown，旧草稿仍可读取已存的 Markdown。转换失败时提供 JSON 原始数据。
- 边界数据先校验再使用；API 不存在时返回明确 404，不返回成功 HTML 掩盖错误。
- 文档与引用使用稳定持久 ID，编辑器运行时 key 不充当业务 ID。
- 正式写入采用工作区行锁、成员角色校验、修订检查和单事务收据；不允许旧版本静默覆盖新内容。
- 每个实际新修订须与页面和收据同事务写入 `page_versions`；子树状态变更保存全部实际变化页面。历史恢复的来源修订纳入操作摘要，只恢复标题/正文并生成新修订，保留当前目录位置。收据重试不能再次插入快照。
- 删除前网页读取新目录并检查目标子树草稿，提交 `expectedSubtreeIds` 让服务端在工作区锁内核对范围。回收站恢复仅恢复选中同组子树；原父不可用时选中页面落根，不复活独立删除的后代。页面、历史和附件不自动清理。
- 页面 `search_text` 是从已校验的 Lexical 正文提取的派生数据，创建/修订更新须与正文同事务维护。查询必须限定工作区成员和未删除页面，采用字面子串与结果上限；不要直接在 JSON 中匹配节点键、URL 或内部 ID，也不要将未提交的浏览器草稿冒充服务端结果。
- 数据库中页面 `revision` 用 bigint，API 中使用十进制字符串；每次写入须有持久化的客户端操作标识与收据，以处理提交成功但响应丢失的重试。页面类收据只在正文与同修订 `page_versions` 快照完全相同时省略 `content`，回放从该修订取回正文，不取当前正文。将来任何清理版本的策略都必须先保证未过期收据引用的修订仍在，或先把正文写回收据。
- 账号会话令牌只将摘要存入数据库；Cookie 为 HttpOnly、SameSite=Strict，变更请求校验配置 Origin 与 CSRF。网页持久化模式通过会话 API 获取账号和工作区，服务端对每次页面读写重新校验成员关系。
- 账号维护的密码更新、auth_epoch 递增和所有会话撤销须在同一事务内完成；不能自动解禁账号。密码从文件读取，不放在 argv 或日志。维护前停止应用并等待在途请求完成，撤销不追溯取消已完成授权的请求。
- 完整数据备份须同一维护窗口取得数据库与附件，表锁/导出快照覆盖复制和 dump；先校验完整包、精确应用镜像和迁移 checksum，再恢复到空数据库/空附件目录。恢复后全表内容摘要与附件元数据须一致，然后清除会话并递增 auth_epoch。失败不启动或自动清空目标，换另一组新卷；升级回退不执行降级 SQL。COMPLETE 仅在全部文件复读及快照提交后生成。
- 不给事务连接配置全局客户端 query_timeout；客户端超时不会取消 PostgreSQL 正在执行的 SQL。就绪探针的独立 pool.query 可使用短超时并在错误时丢弃连接。
- Markdown 是输入和交换格式；完整状态以版本化 JSON 与附件表示。无附件页面导出 `.md`，有附件页面导出 ZIP，包含 Markdown、UUID 命名的附件和清单。标题用于文件名及 front matter，正文不重复标题；导入无有效 YAML title 时使用文件名。附件路径重写只作用于真实正文引用，元数据、代码和公式里的同形内容保持字面。ZIP 不是完整数据库备份。
- `DocumentContent` 含 `schemaVersion: 1` 与 Lexical JSON；服务端拒绝未知版本、未知节点、危险链接和超限内容，读取未知旧版本时不得重置正文。Markdown 导入对不能可靠转换的语法显式提示并保留原文；源码应用遇到有损转换时同时保留输入与原始正文，不静默覆盖。
- 粘贴外部 HTML 先清理可执行元素、危险链接和事件属性；不支持的复杂表格转成可读文字并提示。外部图片引用不会主动加载远程图片。文件上传成功后才插入内部附件节点；切页后完成的异步上传不得写入新页面。
- 附件上传的客户端 UUID 是幂等重试键；服务端在读取请求体前验证会话、Origin、CSRF 和工作区写权限。磁盘路径只能由 UUID 构造，原文件名仅用于展示/下载；读取时校验元数据、文件大小和摘要。回收站、历史和当前正文的引用规则确定前，不做自动附件清理。
- 文档和未来附件统一实施服务端授权；不直接访问 NocoBase 业务库。
- 页面状态真实：连接正常不表示数据库就绪，草稿不表示已保存。
- 服务端写入前须先把正文、修订和操作 ID 写入浏览器草稿；本机写入失败时停止网络写入，并提示用户下载内容。没有正文更改的切页不能产生新的服务端修订。
- 超时或断网时保留同一操作 ID 并查收据；服务端明确拒绝且未提交的更新要释放旧操作 ID，保留最新编辑供修正后重新保存。冲突下载和普通导出采用同一附件打包规则及 front matter 契约。
- 恢复/删除的操作 UUID 必须先写入 IndexedDB `pending-actions`，结果未知时禁止相关页面网络保存，刷新后仍可同 ID 重试。读取本机操作记录失败时暂停网络写入，仍允许输入和下载。恢复前显式等待在途保存；同一份草稿不能重复标记。恢复成功更新当前画面前重新读取服务端，切页后的迟到结果不能覆盖另一页。

## 开发方式

Node.js 24.x、npm 11.x；依赖版本由 package-lock.json 固定。安装运行 `npm ci`，开发运行 `npm run dev`。在 Windows 上运行开发监听进程时不要同时执行 `npm ci`，先停止进程再重装，以免正在使用的原生模块无法卸载。

当前 contracts 仅在 predev 构建一次。修改共享契约后，重启根目录的 `npm run dev`，或手动运行 `npm run build --workspace @nbase/contracts`；不要误以为跨工作区热更新已经实现。

前端只通过 /api 调用后端，开发由 Vite 代理。默认只监听回环，不增加任意 CORS 或无认证业务接口。服务端修改与网页修改可在独立 worktree 并行，共享契约由集成者统一维护。

## 验证

- `npm run typecheck`：共享契约、服务端源码/测试、网页的 TypeScript 检查。
- `npm test`：服务端 Node test、前端 Vitest 与备份离线测试。
- `npm run test:backup`：备份校验/文件复制/路径隔离测试；Windows 符号链接权限不足的场景须在 Linux 维护镜像补验。
- `npm run build`：依次构建 contracts、server、web。
- `npm run check`：一次执行全部检查。
- `NBASE_TEST_DATABASE_URL` 指向本机隔离 `127.0.0.1:54329/nbase_p2` 时，`npm run test:db --workspace @nbase/server` 会创建并删除自己的临时数据库和附件测试目录；不能指向正式库。
- 隔离数据库测试先关闭应用与连接池，再正常删除自己的临时库；不要用强制断连掩盖连接泄漏或制造清理竞态。
- `npm start`：提供构建后网页和 API；生产路径验证应在构建后进行。

功能测试覆盖真实风险，不能用运行速度很快的内存演示替代浏览器或 NAS 实测。阶段结束后检查通过再更新本文件；需求和进度不放入本文件。
