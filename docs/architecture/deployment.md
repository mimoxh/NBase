# Docker 部署与账号维护

本文件描述单机、自部署、个人优先的持久化实例。默认只发布 `127.0.0.1`，不接入现有 NocoBase 或 NAS 正式数据库。完整备份恢复见 [备份与恢复](backup-recovery.md)；卷保留和容器健康不能代替备份。

## 1. 首次启动

需要 Docker Engine / Desktop 的 Linux containers、Compose v2，以及运行配置生成脚本的 Node.js 24。Windows 使用 PowerShell；以下命令也可在常见 POSIX shell 执行，工作目录为仓库根目录。

```sh
node -- scripts/setup-docker.mjs
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker build nbase
docker compose --env-file .env.docker up -d --wait postgres
docker compose --env-file .env.docker run --rm admin
docker compose --env-file .env.docker up -d --wait nbase
```

生成器创建 `.env.docker`、`.secrets/nbase/db-password`、`.secrets/nbase/owner-password`，使用独立随机密码，不打印内容，也不覆盖已有配置。打开 `http://127.0.0.1:3000/`，账号为 `owner`，从 owner-password 文件复制完整密码（不含末尾换行）。也可按 `.env.docker.example` 手动建立配置与秘密文件。密码文件用 UTF-8、无 BOM、单行文本；owner 密码至少 15 个字符且不超过 1024 UTF-8 字节。

其他端口/隔离实例：`node -- scripts/setup-docker.mjs --project nbase-trial --port 4325 --env-file .env.trial`，后续所有 Compose 命令均使用 `--env-file .env.trial`。`node --` 明确结束 Node 自身的命令行选项。

`admin` 是 maintenance profile 的一次性服务，默认只执行初始化 CLI，不监听网络。已初始化实例再次执行会失败，不能接管原账号。常驻应用不挂载 owner 密码文件。生成密码后应保存到个人密码管理器；秘密文件不会自动删除或轮换。

## 2. 配置与数据边界

| 项目 | 约定 |
| --- | --- |
| `NBASE_COMPOSE_PROJECT` | Compose 项目名，同时决定卷/网络名称。建立数据后保持不变；改名会看到另一组空卷 |
| `NBASE_IMAGE_TAG` | 本地应用镜像标签；基础 Node 与 PostgreSQL 镜像固定版本和摘要 |
| `NBASE_PORT` / `NBASE_PUBLIC_ORIGIN` | 发布端口与浏览器精确 origin 必须一致。origin 不带尾斜杠；HTTP 只允许回环地址 |
| `NBASE_DB_PASSWORD_SOURCE` | 宿主数据库密码文件；Compose 只传文件路径，应用通过 secret 挂载读取，无需 URL 转义 |
| `NBASE_OWNER_PASSWORD_SOURCE` | 初始化/重置时读取的 owner 密码文件；修改此文件本身不会修改数据库密码或 owner 密码 |
| `NBASE_OWNER_LOGIN` | 初始化账号名，也用于维护时核对现有 instance owner；不用于创建任意新账号 |
| `<project>_postgres_data` | PostgreSQL 18 的命名卷，挂到 `/var/lib/postgresql`；容器内 PGDATA 为版本目录 |
| `<project>_attachments` | 应用附件命名卷，挂到 `/data/attachments`；空卷复制镜像目录的 node 用户权限 |

数据库只连接 Compose 内部网络，不发布宿主端口。应用以非 root `node` 用户运行，根文件系统只读，附件卷和临时目录可写。宿主 bind mount 替换命名卷时，必须自行建立目录并授予容器 UID/GID 1000 访问权限；启动探针会拒绝缺失或不可写目录，不自动扩大权限。

Compose 的 secrets 是文件挂载，不是加密保险箱。生成器在 POSIX 系统上以 0700 建秘密目录，文件为 0644 以便容器非 root 用户读取；Windows 应通过本机账户 ACL 保护该目录。不要共享 `.secrets`、`.env.*`、`.data` 或含会话 Cookie 的测试状态。Git 忽略这些本机文件；Docker 构建上下文采用白名单，仅收应用构建输入，不收密码、数据库文件、旧构建或宿主 node_modules。

非 Compose 的 Node 部署保留 `NBASE_DATABASE_URL`，或使用以下全部字段：`NBASE_DATABASE_HOST`、`NBASE_DATABASE_NAME`、`NBASE_DATABASE_USER`、`NBASE_DATABASE_PASSWORD_FILE`，可选 `NBASE_DATABASE_PORT`（默认 5432）。两种方式互斥；设置部分字段即失败，不能回落演示。持久化模式还要求 `NBASE_PUBLIC_ORIGIN` 与现存绝对路径 `NBASE_ATTACHMENT_DIR`。应用镜像强制 `NBASE_REQUIRE_DATABASE=1`；本机开发不配置数据库时仍允许明确标识的会话演示。

## 3. 启动、故障和容器重建

服务按“配置校验 → 附件目录核验 → 迁移事务 → 注册路由 → 监听”启动。迁移有数据库锁、版本与 checksum 检查，失败/数据库不可达/未来版本均退出，不接收业务写入。错误 origin 在迁移前被拒绝。CLI 和应用共用数据库配置及迁移代码。

`GET /api/health` 只表示进程存活，浏览器继续使用既有契约。`GET /api/ready` 查询数据库并写入/移除临时附件探针，成功 200，依赖不可用或演示模式 503，不向外返回配置细节。Docker HEALTHCHECK 使用 `/api/ready`；其结果不表示 owner 已初始化、历史附件全量完整、备份成功或产品可日用。Compose 等待 PG healthy 只解决启动顺序，不能替代运行中的探测。Docker 将容器标记 unhealthy 不会自动修复存储。

应用事务不配置全局客户端 `query_timeout`：客户端计时结束不会取消数据库正在执行的语句，不可让 ROLLBACK 超时后仍归还连接。只有不参与事务的就绪查询使用短超时，由 `pool.query` 在错误时丢弃连接。

```sh
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs --tail 100 nbase
docker compose --env-file .env.docker stop
docker compose --env-file .env.docker up -d --wait
# 在相同配置与相同卷上重建容器
docker compose --env-file .env.docker up -d --force-recreate --wait
```

普通 `down` 删除容器/网络，保留命名卷；不要在保存内容的实例执行带 `--volumes` / `-v` 的清理或删除卷。容器重建前等待所有页面显示服务端保存成功，未保存的浏览器草稿不属于数据库卷。不要把新的 PostgreSQL 主版本直接指向旧卷；升级与回滚必须结合版本匹配的完整备份恢复流程。

## 4. 密码找回与会话撤销

这些是持有 Docker/宿主及数据库访问权的操作员命令，没有 HTTP 找回、公开注册或无认证绕过入口。维护前先等待编辑保存，停止应用并等待在途请求结束；撤销影响后续请求，不能取消已经完成授权的请求。

重置密码：将新的单行强密码写入当前 `NBASE_OWNER_PASSWORD_SOURCE` 指向的文件，再执行：

```sh
docker compose --env-file .env.docker stop nbase
docker compose --env-file .env.docker run --rm admin node apps/server/dist/auth/maintain-owner-cli.js reset-password
docker compose --env-file .env.docker up -d --wait nbase
```

所有旧会话同时撤销，下次登录使用新密码。只撤销所有会话、保留密码：

```sh
docker compose --env-file .env.docker stop nbase
docker compose --env-file .env.docker run --rm admin node apps/server/dist/auth/maintain-owner-cli.js revoke-sessions
docker compose --env-file .env.docker up -d --wait nbase
```

CLI 从 `instance_state` 定位 owner，核对显式 `NBASE_OWNER_LOGIN`，拒绝未初始化、名称不符或禁用的账号，不新建账号、不自动解禁。迁移 v5 新增 `users.auth_epoch`。重置/撤销在同一用户行锁内递增 epoch，更新密码（如有）并撤销会话，任何失败整体回滚。登录完成密码校验后，在同一行锁下重核原密码摘要、epoch、disabled 状态，再创建会话；维护之前读出的旧凭据快照不能继续创建有效会话。口令和会话令牌不写入运维日志。

不使用 Docker 时，先构建服务端并配置同样的数据库字段和 owner 环境变量，执行 `npm run init-owner --workspace @nbase/server` 或 `npm run maintain-owner --workspace @nbase/server -- reset-password` / `revoke-sessions`。`npm start` 不自动读取 env 文件。

## 5. 官方资料与验收

配置依据：[Compose 启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)、[Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)、[PostgreSQL 官方镜像的 PGDATA/秘密文件约定](https://hub.docker.com/_/postgres)、[Node 官方镜像](https://hub.docker.com/_/node)。基础组件版本保持本阶段已验证基线，新增/更新依赖和镜像需另核版本、许可证与检查结果；不自动决定项目分发许可证。

本机执行证据放 [验证记录](../validation.md)。`scripts/check-p3-deployment.mjs` 只接受独立 `nbase-p3-deploy-YYYYMMDD` 配置及 4325 回环端口，创建可丢弃验收样例；它不是业务库维护命令。NAS 路径权限、资源基线、手机与外网仍需对应环境的后续验收。
