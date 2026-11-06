# 技术选型与架构决定

基线日期：2026-10-24；实施顺序补充：2026-10-25。区分当前实现与未来接入，安装版本以 package-lock.json 为准。

## ADR-001：网页优先，NAS 保存正式内容

**选择**：Web-first。浏览器访问一个 Node 服务，正式内容计划存 PostgreSQL，附件计划存 NAS 持久化目录。浏览器草稿用于恢复，不是第二套权威数据库。

**原因**：用户最新优先级是 NAS 自部署、外网可用、先做好文档，当前不要求完整离线或实时共同编辑。

**替代旧方向**：旧 Tauri + 本地文件 / LocalStore-first 不再是实施基线。未来可增加桌面壳和离线同步，但需单独设计冲突、迁移和多设备身份，不能把草稿缓存描述为完整 local-first。

## ADR-002：一个代码库，三个小工作区

```text
apps/web             React 网页界面与 API 调用
apps/server          Fastify API、未来认证/存储/附件服务
packages/contracts   共享 API 契约与必要校验
docs                 需求、决定、计划与验证
```

**已实现**：React 19、TypeScript 5.9、Vite 8、Node.js 24 LTS、Fastify 5、npm 11 workspaces。采用 TypeScript 5.9 作为起始兼容基线，不为了追逐最新主版本扩大初始化变更。锁定安装版本并保存 lockfile。

**原因**：前后端同语言，初始化简单；同一服务提供构建后网页与 API。NAS 初期不需要微服务、Redis、队列、独立搜索或对象存储。跨工作区仅共享契约，不提前建立通用插件平台。

官方资料：[Node 发布状态](https://nodejs.org/en/about/previous-releases)、[Vite](https://vite.dev/guide/)、[Fastify LTS](https://fastify.dev/docs/latest/Reference/LTS/)。

## ADR-003：Lexical 文档内核，JSON 保留完整状态

**P1 已接入并通过桌面核心写作验证**：Lexical 0.52。MIT 开源，应用实现文档 UI、工具栏、快捷命令与普通表格，不依赖购买 Pro 插件。依赖及许可核对见 [dependencies.md](dependencies.md)；实机手机键盘等补测边界见 [验证记录](../validation.md)。

- 编辑器状态用带 schemaVersion 的结构化 JSON 持久化。
- Markdown 用于快捷输入、导入导出、源码查看和受保护的源码编辑，不作唯一内部模型。
- Lexical 各包用相同版本；先验证中文输入、撤销、列表、粘贴、普通表格和 Markdown 转换，再固定集成方案。
- 页面用稳定 UUID。未来需引用的块显式保存 stableId；运行时 node key 不作业务 ID。
- 源码编辑（N15）必须保留历史、特殊块引用和稳定身份；不能整篇重解析并静默覆盖，语义往返失败时阻止应用。
- 提供转换能力说明；完整备份包含 JSON、附件和元数据，不能只导出 Markdown。

官方资料：[React 集成](https://lexical.dev/docs/getting-started/react)、[MIT 源码](https://github.com/facebook/lexical)、[Markdown](https://lexical.dev/docs/packages/lexical-markdown)、[Key Management](https://lexical.dev/docs/concepts/key-management)。

## ADR-004：PostgreSQL 和附件目录

**本机测试库已接入**：PostgreSQL 18.6 + pg + 参数化 SQL，显式版本迁移。独立 Docker 容器已验证账号、文档、附件和页面搜索；18.6 是本机测试版本，不自动确定 NAS 正式版本。部署时仍须核对兼容性、支持周期和备份恢复。未连接现有 NAS 数据库。

- 独立数据库、独立账号；不得写入 NocoBase 业务表。
- 文档元数据、正文 JSON、revision、历史、删除状态和附件元信息分别有清楚职责。
- 正文可用 JSONB；未来多维表格字段、记录和关系单独设计，不将业务数据全塞成一个巨大 JSON 文档。
- 附件用稳定 ID，持久化目录与元信息协同备份，访问需服务端授权。
- 中文搜索采用从 Lexical 可见正文提取的文本和字面子串查询；同事务更新、迁移回填、工作区授权及当前限制见 [页面搜索](search.md)，不把英文分词默认当成中文搜索方案。
- 正式数据结构与 API 在存储阶段评审，不在骨架里生成空表或假数据接口。

## ADR-005：可靠保存优先，不先引入协作设施

**本机持久化路径已实现**：更新带 expectedRevision，事务内条件更新；不匹配返回 409 Conflict，保留本地内容并提供下载/另存副本。自动保存按页面隔离，操作收据处理提交后响应丢失；禁止静默 last-write-wins。

实时协作、CRDT、离线完整副本后置。保留稳定文档 ID、修订和格式版本，为未来演进提供基础。

## ADR-006：长期能力通过引用连接

多维表格、双链、白板为长期目标。未来对象通过稳定 ID 连接：文档引用记录、记录有详情、白板卡片打开源内容。不要求所有对象继承万能 Block，也不把画布图形和数据行强存为相同 schema。

候选：[Excalidraw](https://github.com/excalidraw/excalidraw) 用于白板，[TanStack Table](https://github.com/TanStack/table) / [Virtual](https://github.com/TanStack/virtual) 用于表格和虚拟列表。开源基础均为 MIT；集成与版本后续重新评估，当前未安装。

## ADR-007：初始化与正式部署边界

无数据库配置时服务端提供 `/api/health` 与静态页面，前端为明确标识的会话演示。显式配置数据库、精确公开 Origin 和已存在的独立附件目录后，先运行迁移和目录检查，再开放受授权的账号、文档、附件与搜索 API，前端进入持久化工作台。健康响应仍只表示进程连通，不表示文档已保存、数据库持续就绪或备份可恢复。

- 开发默认仅监听 127.0.0.1，Vite 代理 /api，不开放任意来源 CORS。
- Docker 内部监听 0.0.0.0，Compose 端口默认只发布到主机回环。
- 无认证时不新增文档业务读写 API，不将骨架当作公网服务。
- Dockerfile 固定基础镜像并以非 root 运行，Compose 提供独立 PostgreSQL 与附件命名卷，强制数据库配置。容器重建与账号维护已通过本机验收，详见 [部署维护](deployment.md)。单独的 maintenance 构建目标负责一致备份与空目标恢复，本机完整恢复和失败升级回退已有证据，见 [备份恢复](backup-recovery.md)；日用/目标 NAS 和 HTTPS 仍须按后续门槛验收。
- 核心需求避免付费授权依赖；项目最终许可证未定，不能把 private / UNLICENSED 仓库当作已授权公开分发的成品。

实施顺序：V1 个人优先，P2 先接入独立数据库、初始账号、会话和工作区级授权，再开放文档业务 API。P2 本机闭环已验收；P3-01～P3-06 的附件、搜索、历史、账号维护、Docker 持久化、备份恢复以及桌面日用/性能基线已通过本机验收。实机手机跳过，外网验收（P3-07）已于 2026-11-03 放弃。预留多人边界不等于实现成员邀请、共享权限或实时协作。完整任务依赖见 [实施计划](../plan.md)。

## ADR-008：V1 使用子页面树

2026-10-25 用户确认页面可以包含子页面。V1 使用同一种页面实体与可空 `parentId` 组织层级，不另设只能分类的文件夹实体。页面改名、移动及恢复保持稳定 ID；服务端已在授权工作区内事务性防止循环与并发覆盖。历史与回收站的进一步规则按 P3-03 处理，已有基础契约见 [子页面树](page-tree.md)。
