# NBase Agent 执行指南

## 当前基线

2026-10-24 用户授权删除旧实现并重建。Web-first、自部署，V1 只打磨文档。旧 Tauri/Wave 规划已被替代。需求以 docs/product/requirements.md 与 docs/product/v1-documents.md 为准，顺序见 docs/plan.md，选型见 docs/architecture/decisions.md。

## 协作流程

1. 每个开发阶段使用多个 Agent，在独立 worktree 中处理互不冲突的任务；集成者统一契约和合并。并行规模遵守可用槽位，不强行启动超过限制的 Agent。
2. 只读审查可在独立 worktree 进行，不需安装/构建，不修改其他 Agent 的工作区。
3. 每阶段结束运行前后端检查；失败先修复，再进入下一阶段。
4. 构建和检查通过后，更新 AGENT.md 中的架构、职责和开发规范。
5. 需求、计划和进度只放 docs，AGENT.md 不含需求追踪内容。

## 提交与推送

- 用户要求提交或推送时，默认新建以 `codex/` 开头的临时分支，将本次变更提交并推送到远端分支，再合并到远端 `main`。用户指定其他流程时按用户要求执行。
- 对 `origin` 和 `github` 两个远端分别执行上述流程。两个远端的提交历史可能不同，先核对各自的最新状态，在各自的历史上合并，并核对两个 `main` 的文件内容一致。
- 确认两个远端 `main` 均包含本次变更后，删除本次新建的远端和本地临时分支。保留其他分支和用户现有变更，不强制推送。

## 验证命令（仓库根目录）

```sh
npm ci
npm run typecheck
npm test
npm run build
# 或 npm run check 一次执行全部检查
```

npm run dev 启动前后端；npm start 提供构建后的页面与 API。当前无 Rust/Tauri 后端，不再执行 cargo 命令。

## 目录

- apps/web：React 界面。
- apps/server：Fastify 服务端。
- packages/contracts：共享 API 契约。
- docs：需求、技术决定、设计原则、计划和验证。

## 约束

- 保留 .git 和用户现有变更，不做未授权重置或自动提交。
- 不操作 NAS 的 NocoBase 或正式 PostgreSQL，不在真实业务表中试验。
- 无持久化时不显示已保存；健康检查不等于产品就绪。
- 开发默认只监听回环地址；认证授权完成前不暴露业务读写到公网。
- 优先免费开源基础组件，新增依赖核对许可证、锁定版本，不自动决定项目最终分发许可证。
- Markdown 源码编辑只覆盖支持矩阵内的受保护往返，不能表达的内容须阻止应用，不扩大成任意无损编辑。简单页面双链、多维表格（含看板、日历、双向关联、公式、汇总）、关系图、块引用、白板，以及折叠块、颜色对齐、表格合并与列宽、音视频/PDF 预览、网页书签、拼音搜索、HTML/Word 导出已交付；业务数据迁移须另行确认范围。
