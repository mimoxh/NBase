# P2 本机隔离数据库

2026-10-25 已在这台 Windows 机器安装 WSL 2 与 Docker Desktop 个人模式，并用官方 PostgreSQL 18.6 镜像启动 NBase 专用测试库。此环境仅供开发和可丢弃样例验证，不是 NAS 正式库或备份方案。

| 项目 | 本机配置 |
| --- | --- |
| Docker Desktop | 4.96.3，当前用户安装；CLI 29.9.2，Linux 容器引擎 |
| WSL | 3.0.3.0，WSL 2 后端 |
| PostgreSQL | 18.6，镜像 digest 锁定在根目录 `compose.p2-local.yaml` |
| 地址 | `127.0.0.1:54329`，不发布到局域网 |
| 数据库与角色 | `nbase_p2` 为容器初始测试库；`nbase_p2_workbench` 为网页试验库；`nbase_p2_acceptance_20261026` 为 P2 故障验收库。均只放 NBase 可丢弃样例，角色为 `nbase_p2` |
| 数据卷 | `nbase-p2-local-pgdata`；普通停止或重建容器时保留 |
| 本机凭据 | 根目录 `.env.p2.local`（工作库数据库连接）与 `.env.p2.owner`（工作库测试所有者密码）应由 `.gitignore` 忽略；它们是本机临时文件，可能在会话或环境清理后缺失，不复制到文档或提交 |

在仓库根目录、Docker Desktop 引擎运行时执行：

```powershell
docker compose --env-file .env.p2.local -f compose.p2-local.yaml up -d --wait
docker compose --env-file .env.p2.local -f compose.p2-local.yaml ps
```

临时停止容器可使用 `docker compose --env-file .env.p2.local -f compose.p2-local.yaml down`，该命令不删除数据卷。不要在含有想保留的数据时附加删除卷选项。2026-10-26 凭据文件曾多次在环境切换后缺失；为避免改变旧库，保留 `nbase_p2`，另建 `nbase_p2_workbench`。之前只在该工作库使用 `scripts/reset-p2-workbench-owner.mjs` 重设过测试 owner 密码并撤销旧会话；原 `nbase_p2` 库账号没有重置。最近检查根目录两个凭据文件再次缺失：现有 4317 进程可能仍持有启动时的配置，但重启前须先恢复连接配置与正确密码，不要用健康检查代替验证。不要在命令行输出、日志或截图中公开文件内容。

仅当工作库密码文件丢失而需要恢复本机测试账号时，先恢复 `.env.p2.local`，生成新的随机 `.env.p2.owner`，构建服务端后把两者路径提供给 `scripts/reset-p2-workbench-owner.mjs`。脚本只接受 `127.0.0.1:54329/nbase_p2_workbench` 的连接，重设前核对实例 owner 为 `owner`；不能用于 NAS 或正式数据库。重设后浏览器需要重新登录，已有页面不变。

`npm start` 不会自动读取 `.env.p2.local`。P3-01 起，持久化模式还必须指定已存在、可写的绝对路径 `NBASE_ATTACHMENT_DIR`；恢复配置文件时须指定 `127.0.0.1:4317` 和精确网页 Origin。在 PowerShell 进程载入配置后启动已构建服务：

```powershell
npm run build
Get-Content .env.p2.local | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$env:NBASE_ATTACHMENT_DIR = (New-Item -ItemType Directory -Force -Path .data\p2-workbench-attachments).FullName
npm start
```

服务启动时先校验并运行迁移，再核验附件目录；失败则不监听。设置了数据库时开放登录、会话、文档与附件 API；网页会转到真实文档工作台。浏览器草稿保存在 IndexedDB，退出登录不会自动清除；相同账号重新登录后可找回，其他账号按用户 ID 隔离。`/api/health` 只报告进程和已装配页面路由，不代表数据库此刻可用、当前草稿已保存或产品可日用。P2 的断线草稿、修订冲突、响应丢失、会话过期和重启后重开已有本机浏览器实测；P3 完整备份尚未实现。P3 部署前须另定 NAS 兼容的 PostgreSQL 主版本、备份恢复和凭据管理。附件细则见 [附件存储与交换契约](attachments.md)。

P2 故障验收另用 4320 构建后应用、只监听 `localhost:4321` 的 `scripts/p2-fault-proxy.mjs` 和专用验收库进行；代理与 4320 应用在验收后已停止，验收库保留供复核。一次性验收 owner 密码放在系统临时目录，不作为工作库密码。详见 [验证记录](../validation.md) 最后一节。

镜像卷路径使用 PostgreSQL 18 官方镜像的 `/var/lib/postgresql`；17 及更早版本的卷路径不同，不能直接替换主版本复用此卷。[Docker 官方镜像说明](https://hub.docker.com/_/postgres)和[Docker Desktop Windows 安装说明](https://docs.docker.com/desktop/setup/install/windows-install/)是本机安装依据。
