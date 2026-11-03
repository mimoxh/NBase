import type { Page, Workspace } from './model';
const page = (id: string, title: string, markdown: string, parentId: string | null = null, starred = false): Page => ({ id, title, markdown, parentId, starred, deleted: false, dirty: false });
export function initialWorkspace(): Workspace {
  return { currentId: 'welcome', view: 'document', recent: ['welcome', 'weekly', 'writing'], pages: [
    page('welcome', '开始使用 NBase', '把零散的想法，慢慢写成自己的知识。这里是你的文档工作台。\n\n> 当前是演示模式。所有修改仅在本次会话内保留，刷新页面会重置；需要保留的内容请下载 Markdown。\n\n## 从一页开始\n\n写下一段文字，列一个清单，或整理最近的阅读笔记。无需一开始就安排好所有目录。\n\n- 在左侧新建页面，为想法找到一个位置\n- 用 **粗体**、标题和引用，让内容更容易阅读\n- 用搜索快速回到一段记忆\n\n## 让内容有条理\n\n页面可以包含子页面。把相关内容放在一起，重要的页面加入收藏。\n\n### 一个轻量的日常习惯\n\n- [x] 写下今天想到的一件事\n- [ ] 补充一段值得保留的材料\n- [ ] 回顾并整理你的笔记\n\n## 安静地阅读与写作\n\n切换到阅读模式，或者打开专注模式，让注意力回到内容本身。右侧目录可以帮助你在长文中定位。\n\n---\n\n从左侧的「写作与排版」开始，试试这张工作台。', null, true),
    page('writing', '写作与排版', '## 给文字留一点空间\n\n使用工具栏编辑段落、列表与引用。也可以使用常见快捷键进行加粗、斜体和撤销。\n\n### 列一个清单\n\n1. 先写下核心想法\n2. 再补充例子和依据\n3. 最后整理标题与顺序\n\n> 好的笔记，是留给未来自己的解释。\n\n## 表格与代码\n\n| 内容 | 用途 |\n| --- | --- |\n| 日常笔记 | 随手记录 |\n| 工作记录 | 追踪思考 |\n\n```javascript\nconst thought = "从一句话开始";\nconsole.log(thought);\n```', 'welcome'),
    page('markdown', 'Markdown 指南', '## 轻量的文本格式\n\nMarkdown 让文字可以在不同工具之间流动。可通过页面菜单查看只读 Markdown，或下载当前页面。\n\n## 关于导入\n\n导入采用基本语法转换，复杂 HTML、自定义块或部分样式可能改变。导入时会提示已检测到的风险，并保留原始文件供下载。\n\n## 关于数据\n\n这版工作台没有持久化服务。关闭或刷新页面前，请导出需要保留的内容。', 'welcome'),
    page('notes', '日常笔记', '## 留下生活里的细节\n\n这里收集日常的想法、阅读和观察。'),
    page('weekly', '本周随记', '## 这周想做的事\n\n- [ ] 整理桌面和笔记\n- [ ] 读完正在读的书\n- [x] 给新项目写一页介绍\n\n## 一个小发现\n\n当记录足够简单时，就更容易坚持。', 'notes', true),
    page('reading', '阅读摘记', '## 阅读之后\n\n记录一句触动自己的话，再用自己的语言解释它。\n\n## 可以继续追问\n\n- 作者的核心观点是什么？\n- 它和已有经验有什么联系？', 'notes'),
    page('work', '工作记录', '## 项目备忘\n\n把问题、决定和下一步写在一起。\n\n### 下一步\n\n- [ ] 列出需要验证的问题\n- [ ] 记录讨论的结论'),
    { ...page('old', '一份旧的草稿', '## 未完成的想法\n\n这是一份回收站示例，可以恢复继续编辑。'), deleted: true, deletionRoot: 'old' },
  ] };
}
