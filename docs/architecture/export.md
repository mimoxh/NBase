# 页面 HTML 与 Word 导出

2026-11-12。与 Markdown / ZIP 导出并列，从页面菜单「下载为 HTML」「下载为 Word」触发。持久化工作台与会话演示均提供；演示没有上传附件，导出只含文字、图表与占位。

## 原则

- 只在用户点击时于浏览器端计算，代码在 `apps/web/src/export/`，由菜单动作按需 `import()`，不进入首屏包，也不在渲染路径或按键中运行。
- 输入是已序列化的 Lexical JSON（`StoredDocumentContent`），不是实时编辑器状态。取内容的规则与 Markdown 导出一致：正常时用编辑器当前快照（含未保存修改），冲突时导出本机草稿（文件名带「-本机草稿」），无法识别格式时只给原始 JSON。
- 渲染按节点类型登记：`registerHtmlRenderer(type, fn)`（`html.ts`）与 `registerDocxRenderer(type, { block, inline })`（`docx.ts`）。未登记类型渲染子节点，叶子输出可见文字；渲染器抛错时退回可见文字。不抛出、不静默丢字。
- 异步资源（附件字节、Mermaid SVG/PNG、Prism 高亮）由 `resources.ts` 先行加载，期间每步让出主线程；渲染本身同步。附件读取失败与 Markdown ZIP 一样终止整次导出，不生成残缺副本；附件总量上限 190 MB。
- 不新增依赖。ZIP 复用 `persistence/attachmentExport.ts` 的 `zipEntries`（存储方式，无压缩）。本次修正了该写入器结束记录中央目录大小多算 12 字节的问题（Word 对此严格，Markdown ZIP 同样受益）。

## HTML

- 单文件 `.html`：语义标记、内嵌 CSS（`htmlStyles.ts`，中文字体栈、`prefers-color-scheme` 深浅色、打印样式），`<title>` 与 `<h1>` 为页面标题。图片以 `data:` URI 内嵌。
- 图片合计超过 20 MB，或页面含非图片附件（PDF、音视频、ZIP、文本）时，改为 ZIP：`index.html` + `assets/<附件ID>.<扩展名>`。
- 公式用 KaTeX 输出 **MathML**（`output: 'mathml'`）：文件自包含，不需要 KaTeX 样式和字体；依赖浏览器 MathML Core 支持（Chromium 109+、Firefox、Safari）。
- 安全：所有文字与属性转义；链接只输出 `isSafeLinkUrl` 允许的 http/https/mailto/相对地址，否则只保留文字；从不输出脚本或事件属性；`<meta http-equiv="Content-Security-Policy">` 另行禁止脚本、插件、`base` 与表单提交。文字颜色只来自调色板 ID，不透传任意 CSS。Mermaid SVG 沿用 `renderMermaid` 的输出校验，并把共用的元素 ID 改为逐图唯一。

## Word (.docx)

手写 OOXML 包：`[Content_Types].xml`、`_rels/.rels`、`docProps/core.xml`、`word/document.xml`、`styles.xml`（Calibri/Consolas + 东亚字体 Microsoft YaHei，`zh-CN` 语言）、`numbering.xml`、`footnotes.xml`（含分隔符）、`settings.xml`、`word/_rels/document.xml.rels`、`word/media/*`。A4，页边距 2.54 cm。属性元素按架构顺序输出；文字去除 XML 1.0 不允许的控制字符和孤立代理项。

- 列表：一个共享的项目符号实例；每个有序列表各自一个 `w:num` 并带 `startOverride`，因此相邻有序列表会重新编号、保留起始序号。层级 0–8（编辑器最多 6 级）。
- 脚注：真实 Word 脚注。Word 每个脚注只能有一个引用，同一定义被引用多次时重复生成脚注。没有引用的定义原位输出为「脚注 ID」段落。
- 图片尺寸：有 `width` 百分比时为正文栏宽（表格中为单元格宽）× 百分比，否则按原始像素（96 DPI）且不超过栏宽；高度按文件头读出的宽高比，超出页高时等比缩小。WebP 在浏览器中转为 PNG。
- Mermaid：浏览器中把渲染出的 SVG 画到 canvas 转 PNG 嵌入；渲染失败时输出源码代码块。

## 节点映射

| 节点 | HTML | Word |
| --- | --- | --- |
| paragraph / heading | `<p>` / `<h1–6>`，`text-align`、缩进 | 段落 / 标题 1–6，`w:jc`（justify→both）、缩进 |
| text | `strong/em/s/u/code/mark/sub/sup`，颜色用 `var(--nb-c-*, 浅色值)` | 粗/斜/删除/下划线/行内代码样式/黄色高亮/上下标、`w:color`、`w:shd` |
| link / autolink | 安全地址为 `<a rel="noopener noreferrer">`；`/?page=` 为页面引用 | http/https/mailto 为超链接关系；其他只留文字 |
| page-reference | `<span data-nbase-page="ID">` 文字 | 蓝色文字 |
| quote | `<blockquote>` | Quote 样式（左边框） |
| callout | `<aside>` + 类型 · 标题 | 带边框、底纹的连续段落，首段为标签 |
| toggle | `<details open><summary>` | 粗体摘要段 + 缩进正文 |
| list (bullet/number/check) | `ul/ol start`，任务为禁用复选框 | 编号定义；任务为 ☐ / ☑ + 悬挂缩进 |
| code | `<pre><code>`，Prism `token` 类 + 内嵌配色 | Code 样式（等宽、底纹、边框，保留空白与换行） |
| table / tablecell | `colgroup` 列宽、`colspan/rowspan`、表头 `th` | `tblGrid`（px×15 twips，超宽等比缩放）、`gridSpan`、`vMerge`、表头行底纹加粗并跨页重复 |
| horizontalrule | `<hr>` | 下边框段落 |
| attachment 图片 | `data:` 或 `assets/`，宽度、对齐、图注 | 内嵌图片 + 对齐 + Caption 段 |
| attachment 音视频/PDF/其他 | 单文件：命名占位；ZIP：`<audio>/<video controls>` 或链接 | 命名占位文字 |
| image-reference | 「外部图片」占位，http(s) 地址给链接，不加载 | 占位文字 |
| equation | KaTeX MathML，块级居中 | LaTeX 源码（行内代码样式，块级居中） |
| mermaid | 内联 SVG，失败为源码 | PNG，失败为源码 |
| footnote-reference / definition | 上标锚点 ↔ 文末脚注区与返回链接 | Word 脚注 |
| database-view | 带数据库标题的占位块，不含行 | 带边框占位段 |
| bookmark | 边框链接卡片（标题、描述、站点 · 地址） | 超链接标题 + 描述 + 地址段，带边框 |
| block-reference | 显示文字（`label`） | 灰色文字 |
| 未知类型 | 子节点或可见文字，`data-nbase-type` 标记 | 子节点或可见文字段落 |

## 已知损失与限制

- 公式在 Word 中是 LaTeX 源码，不是 Office 公式；HTML 依赖浏览器的 MathML 支持。
- 单文件 HTML 不含非图片附件（因此会改为 ZIP）；Word 只给附件名占位。
- 数据库视图不导出行数据；页面引用不生成可跳转链接（导出文件中无法解析 NBase 地址）。
- 外部图片引用不下载。HTML 打印时会在外链后附上地址。
- Word：提示块内的表格不带提示块边框；文字颜色为浅色主题值；重复脚注引用会多出脚注编号；单元格背景色、垂直对齐、行高未映射。
- Mermaid 在 Word 中是位图（2 倍分辨率）；HTML 的 Mermaid SVG 固定白底。
- 导出未在真实 Microsoft Word / WPS / LibreOffice 中打开验证；包结构、XML 良构、关系、编号与脚注 ID 由测试校验。

## 新节点类型

在 `html.ts` / `docx.ts` 内置表中加一项，或在模块初始化时调用 `registerHtmlRenderer` / `registerDocxRenderer`。Word 渲染器分 `block`（返回段落/表格 XML，需要时用 `context.paragraph`、`context.blocks`）和 `inline`（返回 run XML，用 `context.run`、`context.inlines`）；只能出现在行内的节点也可只给 `inline`，块级位置会自动包成段落。需要异步数据的节点在 `resources.ts` 预取，渲染器保持同步。补测试于 `apps/web/src/export/*.test.ts`。
