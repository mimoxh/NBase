# 新增依赖核对

核对日期：2026-10-25。项目仍为 private / UNLICENSED，以下第三方许可不替代项目最终分发许可决定。

| 依赖 | 锁定版本 | 许可与用途 |
| --- | --- | --- |
| lexical、@lexical/react、rich-text、list、link、code、table、selection、utils、markdown、html、history、clipboard | 0.52.0 | MIT；编辑内核、React 插件、块和格式转换，保持各包同版本 |
| jsdom（开发依赖） | 30.1.3 | MIT；Vitest 中挂载 React / 编辑器与 HTML 粘贴边界测试，不用于产品运行服务 |
| pg | 8.23.1 | MIT；P2 PostgreSQL 连接池、参数化查询与事务；不自动连接现有 NAS 数据库 |
| @types/pg（开发依赖） | 8.23.1 | MIT；pg 的 TypeScript 类型声明，不进入产品运行依赖 |
| @lexical/code-prism | 0.52.0 | MIT；与 lexical 同版本，Prism 代码高亮、行号 gutter 与代码块缩进 |
| prismjs | 1.30.0 | MIT；Prism 语法高亮内核，组件形式按需加载语言 |
| katex | 0.19.1 | MIT；公式本地渲染，字体随构建打包，不产生外部请求 |
| yaml | 2.9.1 | ISC，解析和导出 Markdown front matter |
| mermaid | 12.3.0 | MIT，自部署流程图与时序图的按需渲染 |
| pinyin-pro | 3.29.5 | MIT，仅服务端（`apps/server`）；生成页面搜索的拼音键和解析拼音查询，不进入网页包 |
| @fastify/websocket | 11.3.7 | MIT，仅服务端；在场提示与评论刷新的 WebSocket 通道（第 5 批实时协同复用）。传递依赖 ws 8.23.0（MIT）、duplexify 4.1.3、end-of-stream、readable-stream、stream-shift、string_decoder、safe-buffer、util-deprecate（MIT）与 once、wrappy（ISC），2026-11-18 核对 |
| @types/ws（开发依赖） | 8.18.2 | MIT，仅服务端；ws 的 TypeScript 类型声明，不进入产品运行依赖 |
| yjs | 13.6.33 | MIT，网页与服务端；实时协同的 CRDT 文档（服务端只合并增量与计算状态向量）。传递依赖 lib0 0.2.119、isomorphic.js（MIT），2026-11-18 核对 |
| y-protocols | 1.0.7 | MIT，网页与服务端；Yjs 同步协议与 awareness（光标、选区） |
| @lexical/yjs | 0.52.0 | MIT，仅网页；与 lexical 同版本，Lexical 节点树与 Yjs 的双向绑定和协同撤销（@lexical/react 原本已依赖它） |

版本、许可和兼容条件以 npm 官方 registry 元数据及实际安装包的 package.json / LICENSE 核对。Lexical React 包要求 React >=18、TypeScript >=5.2；当前 React 19 / TypeScript 5.9 满足。jsdom 的 Node 24 条件为 >=24.15，当前 Node 24.19 满足。直接依赖锁定精确版本，完整传递依赖见 package-lock.json。

2026-11-05 核对了 `yaml` 和 `mermaid` 的锁定版本与许可。YAML 限制输入体积、层级和节点数。Mermaid 渲染限制图表类型、源码和复杂度，资源从本机应用加载。 [YAML 官方文档](https://eemeli.org/yaml/) · [Mermaid 官方配置](https://mermaid.js.org/config/schema-docs/config.html)

标签判重固定使用 Unicode 17.0.0 默认完整大小写折叠（C + F），数据生成于 `packages/contracts/src/tagNameKey.ts`，文件头保留 Unicode License V3。输入和结果均 NFC，显示名称不作折叠。来源：[CaseFolding 数据](https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt)、[许可](https://www.unicode.org/license.txt)。2026-11-05 依赖审计仍为既有静态服务链的 3 项 moderate，新增 YAML/Mermaid 没有新增已知审计项；未自动升级其他依赖。

参考：[Lexical 源码与许可](https://github.com/facebook/lexical)、[React 集成](https://lexical.dev/docs/getting-started/react)、[Markdown 包](https://lexical.dev/docs/packages/lexical-markdown)、[jsdom 源码与许可](https://github.com/jsdom/jsdom)。

P2 的 `pg` 版本与许可见 [npm 包](https://www.npmjs.com/package/pg)及[源码](https://github.com/brianc/node-postgres)；事务必须在同一连接中执行，见[官方事务说明](https://node-postgres.com/features/transactions)。`@types/pg` 版本与许可见 [npm 包](https://www.npmjs.com/package/@types/pg)。两者已锁定精确版本；本机独立 PostgreSQL 18.6 已通过迁移、初始化和账号 HTTP 手工集成检查，文档事务自动测试仍待实现。

此次曾安装 @lexical/headless，其传递依赖 happy-dom 被 npm audit 报告 GHSA-834v-8h66-3h79。内容转换只需要 Lexical createEditor，不需要该包的 DOM 适配器，因此移除 @lexical/headless 及传递依赖，没有降级整个编辑器版本或自动执行 audit fix。移除后 npm audit --json 返回 0 项已知漏洞；这是当次数据库检查结果，不是永续安全保证。

安装提示 esbuild 的 postinstall 未获脚本白名单批准，本次没有扩大脚本执行许可。能否运行由实际类型检查、测试和构建结果记录，不凭安装成功推断。

2026-11-03 P3-06 复核：`npm audit` 报告 `@fastify/static 10.1.7 → glob 13.0.6 → minimatch 10.2.6` 共 3 项 moderate（GHSA-3g3m-2fjr-6pw4、GHSA-g3hv-75wg-m249）。glob 只在 `wildcard: false` 时以固定模式枚举静态目录，本项目使用默认 wildcard，该代码路径不执行。npm 建议的大版本降级不采用；修复版本发布不足 7 天且超出上游声明的 `glob ^13` 范围，也不使用 overrides。结论是记录并接受当前风险，待 @fastify/static 更新依赖后再升级。本轮没有新增依赖。

2026-11-12 新增 `pinyin-pro` 3.29.5（发布于 2026-10-10，npm registry 与安装包 LICENSE 均为 MIT，版权 zh-lx，无运行时依赖，解包约 950 KB）。只由服务端 `apps/server/src/search/` 调用：按词典的词语读音给汉字注音，多音字另保留最多两个常见读音；可解析的拼音音节表在首次查询时从该包对 CJK 基本区的读音推导，源码里不放字典或音节表。网页的斜杠命令只用静态拼音别名，不引用此包。版本精确锁定在 `apps/server/package.json` 与 package-lock.json。[npm 包](https://www.npmjs.com/package/pinyin-pro) · [源码与许可](https://github.com/zh-lx/pinyin-pro)

2026-11-19 安卓外壳（`android/`，Gradle 工程，不进入 npm 依赖树）：直接依赖 `androidx.core:core` 1.17.0 与 `androidx.webkit:webkit` 1.18.0（均 Apache-2.0；webkit 提供限定 origin 的 `WebMessageListener` 与 `DocumentStartJavaScript`），测试依赖 `junit:junit` 4.13.2（EPL-1.0，不进入应用包）。运行时传递依赖为 Kotlin 标准库 2.2.10（AGP 内置 Kotlin）、kotlinx-coroutines 1.8.1、JetBrains annotations 23.0.0、androidx annotation / collection / concurrent-futures / core-viewtree / interpolator / lifecycle 2.6.2 / arch-core / profileinstaller / startup / tracing / versionedparcelable、guava `listenablefuture` 1.0 与 jspecify 1.0.0，均为 Apache-2.0（`gradlew :app:dependencies --configuration releaseRuntimeClasspath` 核对）。构建工具 Android Gradle Plugin 9.5.1 与 Gradle 9.9.1（wrapper 校验 SHA-256）均为 Apache-2.0；JDK 用 Eclipse Temurin 21.0.13+9（GPLv2 + Classpath Exception，只用于构建）。`androidx.core` 1.19.1 要求 compileSdk 37，暂留在 1.17.0。[androidx.webkit 发布说明](https://developer.android.com/jetpack/androidx/releases/webkit) · [androidx.core 发布说明](https://developer.android.com/jetpack/androidx/releases/core)
