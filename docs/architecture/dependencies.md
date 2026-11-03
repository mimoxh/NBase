# 新增依赖核对

核对日期：2026-10-25。项目仍为 private / UNLICENSED，以下第三方许可不替代项目最终分发许可决定。

| 依赖 | 锁定版本 | 许可与用途 |
| --- | --- | --- |
| lexical、@lexical/react、rich-text、list、link、code、table、selection、utils、markdown、html、history、clipboard | 0.52.0 | MIT；编辑内核、React 插件、块和格式转换，保持各包同版本 |
| jsdom（开发依赖） | 30.1.3 | MIT；Vitest 中挂载 React / 编辑器与 HTML 粘贴边界测试，不用于产品运行服务 |
| pg | 8.23.1 | MIT；P2 PostgreSQL 连接池、参数化查询与事务；不自动连接现有 NAS 数据库 |
| @types/pg（开发依赖） | 8.23.1 | MIT；pg 的 TypeScript 类型声明，不进入产品运行依赖 |

版本、许可和兼容条件以 npm 官方 registry 元数据及实际安装包的 package.json / LICENSE 核对。Lexical React 包要求 React >=18、TypeScript >=5.2；当前 React 19 / TypeScript 5.9 满足。jsdom 的 Node 24 条件为 >=24.15，当前 Node 24.19 满足。直接依赖锁定精确版本，完整传递依赖见 package-lock.json。

参考：[Lexical 源码与许可](https://github.com/facebook/lexical)、[React 集成](https://lexical.dev/docs/getting-started/react)、[Markdown 包](https://lexical.dev/docs/packages/lexical-markdown)、[jsdom 源码与许可](https://github.com/jsdom/jsdom)。

P2 的 `pg` 版本与许可见 [npm 包](https://www.npmjs.com/package/pg)及[源码](https://github.com/brianc/node-postgres)；事务必须在同一连接中执行，见[官方事务说明](https://node-postgres.com/features/transactions)。`@types/pg` 版本与许可见 [npm 包](https://www.npmjs.com/package/@types/pg)。两者已锁定精确版本；本机独立 PostgreSQL 18.6 已通过迁移、初始化和账号 HTTP 手工集成检查，文档事务自动测试仍待实现。

此次曾安装 @lexical/headless，其传递依赖 happy-dom 被 npm audit 报告 GHSA-834v-8h66-3h79。内容转换只需要 Lexical createEditor，不需要该包的 DOM 适配器，因此移除 @lexical/headless 及传递依赖，没有降级整个编辑器版本或自动执行 audit fix。移除后 npm audit --json 返回 0 项已知漏洞；这是当次数据库检查结果，不是永续安全保证。

安装提示 esbuild 的 postinstall 未获脚本白名单批准，本次没有扩大脚本执行许可。能否运行由实际类型检查、测试和构建结果记录，不凭安装成功推断。

2026-11-03 P3-06 复核：`npm audit` 报告 `@fastify/static 10.1.7 → glob 13.0.6 → minimatch 10.2.6` 共 3 项 moderate（GHSA-3g3m-2fjr-6pw4、GHSA-g3hv-75wg-m249）。glob 只在 `wildcard: false` 时以固定模式枚举静态目录，本项目使用默认 wildcard，该代码路径不执行。npm 建议的大版本降级不采用；修复版本发布不足 7 天且超出上游声明的 `glob ^13` 范围，也不使用 overrides。结论是记录并接受当前风险，待 @fastify/static 更新依赖后再升级。本轮没有新增依赖。
