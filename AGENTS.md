# NBase Agent 执行指南

## 当前基线

2026-10-24 用户授权删除旧实现并重建。Web-first、自部署，V1 只打磨文档。旧 Tauri/Wave 规划已被替代。需求以 docs/product/requirements.md 与 docs/product/v1-documents.md 为准，顺序见 docs/plan.md，选型见 docs/architecture/decisions.md。

## 协作流程

1. 每个开发阶段使用多个 Agent，在独立 worktree 中处理互不冲突的任务；集成者统一契约和合并。并行规模遵守可用槽位，不强行启动超过限制的 Agent。
2. 只读审查可在独立 worktree 进行，不需安装/构建，不修改其他 Agent 的工作区。
3. 每阶段结束运行前后端检查；失败先修复，再进入下一阶段。
4. 构建和检查通过后，更新 AGENT.md 中的架构、职责和开发规范。
5. 需求、计划和进度只放 docs，AGENT.md 不含需求追踪内容。

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
- Markdown 源码编辑只覆盖支持矩阵内的受保护往返，不能表达的内容须阻止应用，不扩大成任意无损编辑。简单页面双链已交付；关系图、块引用、多维表格、白板不抢占文档打磨范围。
