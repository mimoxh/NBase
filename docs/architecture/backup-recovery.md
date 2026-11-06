# 备份、恢复与升级回退

适用于当前单机 Compose 部署。备份目录由参数指定，自动频率和异盘/NAS/S3 位置先不确定；本实现提供本机目录后端，尚不包含 S3 上传或定时任务。Docker 配置见 [部署维护](deployment.md)，实际执行结果见 [验证记录](../validation.md)。

## 备份内容与一致性

一个成功的备份目录包含 `database.dump`、`attachments/`、`manifest.json` 和 `COMPLETE`。数据库包包含账号密码摘要、工作区、成员、页面、历史、回收站、附件元数据、操作收据、收藏和迁移记录。迁移 v7 起包含工作区标签和页面关联，v8 起包含个人模板，v9 起包含工作区每日笔记设置和页面日期身份。会话数据在导出时排除。附件目录保留所有受支持的 UUID 文件，包括暂时未被正文引用的文件。

清单记录格式版本、应用版本/镜像 ID、PostgreSQL 镜像 ID/主版本、迁移名称/checksum、每张数据表行数及稳定排序后的内容 SHA-256、数据库包与每个附件的大小/SHA-256。COMPLETE 保存清单摘要，仅在全部文件复读验证及数据库快照事务提交后生成。中断、空间不足、缺失/损坏附件会失败并留下无完成标记的目录，不能作为恢复包。

宿主控制器先取得 Docker 守护进程范围的项目维护锁，停止原应用容器并等待退出，拒绝其他运行中容器可写同一附件卷。引擎持有数据库 advisory lock，在 REPEATABLE READ 事务中对固定业务表加 SHARE 锁并导出快照；`pg_dump --snapshot` 使用同一快照。锁覆盖附件复制和数据库导出全过程。不要在维护窗口通过其他数据库客户端或手工文件操作改写该实例。

备份结束（包括失败）只重新启动原应用容器 ID，并等待健康，不根据更新后的镜像标签或 Compose 配置重建服务。原应用本来停止时保持停止。强制结束工具可能留下名称为 `nbase-maintenance-lock-<project>` 的未运行锁容器；先确认无维护任务运行，再由操作员检查并移除该锁，不自动抢锁。

## 操作命令

在仓库根目录构建维护镜像，Node/npm 与 PostgreSQL 客户端版本分别固定在 Dockerfile/lockfile：

```sh
docker build --target maintenance -t nbase-maintenance:local .
node -- scripts/backup.mjs backup --config .env.docker --directory /absolute/path/nbase-backup-20261103
node -- scripts/backup.mjs verify --directory /absolute/path/nbase-backup-20261103
```

Windows 可将目录写为 `D:/backups/nbase-20261103`。目录必须为空，不能是数据库/附件卷，也不要放进秘密目录；宿主目录须允许镜像中的 UID/GID 1000 读写。工具不自动放宽目录权限。每次用新目录，失败目录保留用于检查，不自动覆盖、删除或续写。

verify 完全离线，无数据库连接、网络或业务写入。它核对固定入口、普通文件、路径、大小、摘要、文件清单和附件元数据。哈希用于发现损坏，不能证明来源可信；仅恢复自己生成且受控保管的备份。数据库 dump 可包含源超级用户定义的可执行 SQL，不能把任意上传文件当作备份执行。

备份有私人正文与密码摘要，访问权限应与源数据相当。数据库连接密码、owner 明文密码和浏览器草稿不在包内；密码管理器与本机配置也需要独立保管。此阶段没有加密或异地上传功能。本机同盘验收包用于恢复演练，日用需另选择能承受原设备损坏的副本位置。

## 版本与镜像保管

恢复要求清单中的精确应用镜像 ID、当前维护工具的迁移 checksum 与 PostgreSQL 主版本匹配。先恢复同版本，再单独升级，不能只凭一直为 0.1.0 的 package version 判断兼容性。备份不包含容器镜像字节；自建应用/维护镜像必须与备份配套保管，官方 PostgreSQL 镜像也应保留摘要及获取方式。

升级前可在独立文件中保存旧镜像，使用 Docker 自带二进制输出参数，避免 shell 重定向破坏归档：

```sh
docker image save --output /absolute/path/nbase-before-upgrade-images.tar nbase:local nbase-maintenance:local
# 新机器先加载归档，再核对 docker image inspect 的 Id 与 manifest
docker image load --input /absolute/path/nbase-before-upgrade-images.tar
```

同时记录归档 SHA-256 并保管 Dockerfile、Compose、非秘密配置和恢复说明。更新镜像标签时保留清单中的原 image ID，避免镜像清理将唯一的旧版本删除。镜像归档和数据包是配套恢复材料；只保留数据库 dump 无法恢复附件，只保留数据卷不能保证找回程序版本。

## 恢复到全新实例

先准备新的 Compose 项目、独立数据库/附件卷、端口与秘密文件，应用镜像标签指向已保管的旧镜像 ID。不要执行 owner 初始化。目标数据库角色的连接密码可重新生成，恢复后 owner 登录仍使用备份时的账号密码；遗忘时按部署文档执行本地维护 CLI。

```sh
node -- scripts/setup-docker.mjs --project nbase-recovery --port 3002 --env-file .env.recovery
# 编辑 .env.recovery 的 NBASE_IMAGE_TAG，使其引用与备份 appImageId 一致的本地镜像
node -- scripts/backup.mjs restore --config .env.recovery --directory /absolute/path/nbase-backup-20261103
# restore 成功后，应用仍保持停止；确认恢复结果，再启动
docker compose --env-file .env.recovery up -d --wait nbase
```

restore 在创建目标存储前离线校验完整包。进入引擎后再次校验，拒绝已运行的目标应用、非空附件目录、含 public 对象的数据库、错误应用镜像/PG 主版本或迁移清单。没有覆盖、清库或强制恢复选项。

文件先复制并校验，再用 `pg_restore --single-transaction --exit-on-error --no-owner --no-acl` 恢复。随后逐表核对内容摘要和行数、迁移与附件元数据，再清除会话并递增 auth_epoch。恢复后旧 Cookie 必须失效，owner 重新登录。应用启动仍执行正常迁移、目录核验和授权检查。

数据库与文件系统没有跨介质原子事务：复制或 SQL 恢复失败时，目标可能已有部分文件或数据库。工具不会启动失败目标，也不会自动删除半成品；保留用于排查，下一次使用另一组全新空卷。恢复成功后至少核对正文、父子关系、历史、回收站、搜索、附件实际字节及账号登录；健康 200 不能替代这些核对。

## 升级与失败回退

1. 等待所有页面显示服务端已保存，制作并验证升级前完整包，保管旧应用/维护镜像。
2. 在恢复副本上验证新镜像与迁移，确认通过再安排实际实例升级；迁移失败不能继续开放业务写入。
3. 失败后停止新应用并保留失败卷。用升级前包恢复到另一组新数据库/附件卷和旧应用镜像，完成数据核对后切换访问地址。
4. 备份后的新增编辑不在升级前包中；切换前由操作员核对需要保全的内容，不能用旧快照覆盖仍在使用的实例。

这条路径不执行降级 SQL，不把新 schema 直接交给旧镜像，也不接触 NAS 正式业务表。当前主版本之间的 PostgreSQL 迁移、在线连续备份、PITR、自动调度及 S3 传输均需另立验证。

官方依据：[pg_dump 的快照与 custom 格式](https://www.postgresql.org/docs/18/app-pgdump.html)、[pg_restore 的事务、角色与可信来源边界](https://www.postgresql.org/docs/18/app-pgrestore.html)。
