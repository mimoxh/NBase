# 项目文档

本目录是 2026-10-24 重建后的规划基线，2026-10-25 补充个人优先的使用范围与实施计划。需求、选型、进度与架构职责分开维护，避免把提案或健康检查写成已完成产品能力。

| 文档 | 内容 |
| --- | --- |
| [product/requirements.md](product/requirements.md) | 用户确认的场景、约束、长期目标、未决事项和历史取舍 |
| [product/v1-documents.md](product/v1-documents.md) | 第一版文档功能边界、验收和不做项 |
| [product/editing-gaps-roadmap.md](product/editing-gaps-roadmap.md) | 编辑体验补齐计划 N16～N27（待确认提案） |
| [architecture/decisions.md](architecture/decisions.md) | 技术选型、Web-first、数据与扩展边界、官方资料 |
| [architecture/p2-api.md](architecture/p2-api.md) | P2 最小账号与后续文档 API 契约 |
| [architecture/local-postgres.md](architecture/local-postgres.md) | 本机隔离 PostgreSQL 测试库的启动、凭据位置与边界 |
| [architecture/attachments.md](architecture/attachments.md) | 附件授权、存储、导出与清理边界 |
| [architecture/databases.md](architecture/databases.md) | 多维表格首版：页面类型、字段与视图契约、接口、文档内嵌和分页边界 |
| [architecture/search.md](architecture/search.md) | 当前页面搜索索引、授权、查询与定位契约 |
| [architecture/graph.md](architecture/graph.md) | 双链关系图接口、边界与布局 |
| [architecture/whiteboards.md](architecture/whiteboards.md) | 白板数据契约、存储、渲染与已知缺口 |
| [architecture/export.md](architecture/export.md) | HTML 与 Word 导出的节点映射、限制与损失 |
| [architecture/history-trash.md](architecture/history-trash.md) | 历史快照、回收站子树、修订恢复与本机重试记录 |
| [architecture/deployment.md](architecture/deployment.md) | Docker 持久卷、秘密文件、启动/就绪检查、账号恢复与会话撤销 |
| [architecture/backup-recovery.md](architecture/backup-recovery.md) | 停写备份、完整性清单、空目标恢复、镜像保管与失败升级回退 |
| [design/principles.md](design/principles.md) | 好看、好用的具体标准；视觉方向仍可调整 |
| [plan.md](plan.md) | 里程碑、任务依赖、交付物、验收、分工、风险和待决事项 |
| [validation.md](validation.md) | 实际执行结果和尚未验证的项目 |

根目录 AGENT.md 仅记录架构、模块职责、开发规范，不承担需求追踪。AGENTS.md 记录 Agent 协作、构建和数据安全规则。
