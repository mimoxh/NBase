import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEditor, $createParagraphNode, $getRoot, $isElementNode, $isTextNode } from 'lexical';
import type { LexicalNode } from 'lexical';
import { $isLinkNode } from '@lexical/link';
import { $isTableNode, $isTableCellNode } from '@lexical/table';
import { $isListNode, $isListItemNode } from '@lexical/list';
import { $isCodeNode } from '@lexical/code';
import { $createSnapshot, assessMarkdown, createContentFromMarkdown, isSafeLinkUrl } from './markdown';
import { EDITOR_NODES } from './nodes';
import { ImageReferenceNode } from './nodes/ImageReferenceNode';
import { $createAttachmentNode, AttachmentNode } from './nodes/AttachmentNode';
import { EquationNode } from './nodes/EquationNode';
import { $isCalloutNode } from './nodes/CalloutNode';
import { $createPageReferenceNode, $isPageReferenceNode } from './nodes/PageReferenceNode';
import type { DocumentContent } from './types';

function reopen(content: DocumentContent) {
  const editor = createEditor({ namespace: 'test', nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.setEditorState(editor.parseEditorState(content.editorState));
  return editor;
}
function snapshot(markdown: string) {
  return reopen(createContentFromMarkdown(markdown)).getEditorState().read($createSnapshot);
}
function walk(node: LexicalNode = $getRoot()): LexicalNode[] {
  return [node, ...($isElementNode(node) ? node.getChildren().flatMap(child => walk(child)) : [])];
}
const fixture = (name: string) => readFileSync(new URL(`../../../../docs/fixtures/markdown/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('page-reference Markdown', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const link = `[链接标题](/?page=${id})`;

  it('keeps a stable target and the visible label through JSON and Markdown', () => {
    const label = '中文 [注] $值$ ==着重== <字面> \\路径';
    const editor = createEditor({ namespace: 'reference-test', nodes: EDITOR_NODES, onError: error => { throw error; } });
    editor.update(() => $getRoot().append($createParagraphNode().append($createPageReferenceNode(id, label))), { discrete: true });
    const first = editor.getEditorState().read($createSnapshot);
    expect(assessMarkdown(first.markdown).warnings).toEqual([]);
    const parsed = reopen(createContentFromMarkdown(first.markdown));
    parsed.getEditorState().read(() => {
      expect(walk().filter($isPageReferenceNode).map(node => [node.getTargetPageId(), node.getTextContent()]))
        .toEqual([[id, label]]);
    });
    expect(parsed.getEditorState().read($createSnapshot).markdown).toBe(first.markdown);
  });

  it('opens references in callouts and tables while preserving code and unconverted legacy links', () => {
    const input = ['# 页面', '正文 [[同名]] 与 [[缺失]]', `> [!NOTE]\n> ${link}`,
      `| 表格 |\n| --- |\n| ${link} |`, `\`${link}\``, '```md\n' + link + '\n```'].join('\n\n');
    const first = snapshot(input);
    expect(first.plainText).toContain('正文 [[同名]] 与 [[缺失]]');
    expect(first.plainText).toContain(link);
    const references = (content: DocumentContent) => reopen(content).getEditorState().read(() =>
      walk().filter($isPageReferenceNode).map(node => node.getTargetPageId()));
    expect(references(first.content)).toEqual([id, id]);
    expect(references(snapshot(first.markdown).content)).toEqual([id, id]);
    expect(snapshot(first.markdown).plainText).toBe(first.plainText);
  });
});

describe('callout and highlight Markdown', () => {
  it('preserves typed callouts, plain unknown quotes and formatting through JSON and Markdown', () => {
    const first = snapshot(fixture('callout-highlight.md'));
    reopen(first.content).getEditorState().read(() => {
      const nodes = walk();
      const callouts = nodes.filter($isCalloutNode);
      expect(callouts.map(node => [node.getKind(), node.getTitle()])).toEqual([
        ['NOTE', '中文提示 <原样标题>'], ['WARNING', ''], ['IMPORTANT', ''],
      ]);
      expect(callouts[0]!.getChildren().some($isListNode)).toBe(true);
      expect(callouts[2]!.getChildrenSize()).toBe(1);
      const highlighted = nodes.filter($isTextNode).filter(node => node.hasFormat('highlight'));
      expect(highlighted.map(node => node.getTextContent())).toEqual(['重点', '链接']);
      expect(highlighted[0]!.hasFormat('bold')).toBe(true);
      expect($isLinkNode(highlighted[1]!.getParent())).toBe(true);
      expect(nodes.filter(node => node.getType() === 'quote')[0]?.getTextContent()).toContain('[!UNKNOWN]');
    });
    expect(first.markdown).toContain('`[等号==和\\=]`');
    expect(first.markdown).toContain('\\=\\=字面\\=\\=');
    expect(first.markdown).toContain('<p>==代码里的等号==</p>');
    const second = snapshot(first.markdown);
    expect(second.markdown).toBe(first.markdown);
    expect(second.content).toEqual(first.content);
  });

  it('round-trips escaped equal signs in formatted prose and table cells', () => {
    const first = snapshot('甲 **==乙\\=丙==** 后\\\\\\=前\n\n| a | b |\n| --- | --- |\n| ==测试== | \\=\\=普通\\=\\= |');
    const second = snapshot(first.markdown);
    expect(first.plainText).toContain('甲 乙=丙 后\\=前');
    expect(first.plainText).toContain('==普通==');
    expect(second.content).toEqual(first.content);
  });

  it('keeps quoted fenced examples and invalid headers without dropping original text', () => {
    const code = '> [!NOTE]\n> ```html\n> <script>==样例==</script>\n> ```';
    expect(assessMarkdown(code).warnings).toEqual([]);
    expect(snapshot(code).markdown).toContain('> <script>==样例==</script>');
    const invalid = '> [!NOTE] ' + '长'.repeat(121);
    expect(assessMarkdown(invalid).warnings.join()).toContain('标题过长');
    expect(snapshot(invalid).plainText).toContain(invalid);
  });
});

describe('Markdown common document subset', () => {
  it('reopens versioned JSON and preserves headings, inline formats, quote, code, links and divider', () => {
    const first = snapshot(fixture('common.md'));
    expect(first.content.schemaVersion).toBe(1);
    expect(first.outline.map(item => [item.text, item.level])).toEqual([['日常文档', 1], ['结构与格式', 2]]);
    expect(first.outline.every(item => /^heading-/.test(item.id))).toBe(true);
    for (const text of ['**粗体**', '*斜体*', '~~删除线~~', '`inline`', '> 引用内容', '```typescript', '---', '[文档](https://example.com/docs)']) expect(first.markdown).toContain(text);
    const second = reopen(first.content).getEditorState().read($createSnapshot);
    expect(second.markdown).toBe(first.markdown);
    expect(snapshot(first.markdown).markdown).toBe(first.markdown);
    expect(second.plainText).toBe(first.plainText);
  });

  it('preserves nested list types, numbering and checkbox state', () => {
    const editor = reopen(createContentFromMarkdown('3. 三\n4. 四\n    - 子项\n        - 孙项\n\n- [ ] 待办\n- [x] 完成'));
    editor.getEditorState().read(() => {
      const nodes = walk();
      expect(nodes.filter($isListNode).map(node => node.getListType())).toEqual(['number', 'bullet', 'bullet', 'check']);
      expect(nodes.filter($isListNode)[0]!.getStart()).toBe(3);
      expect(nodes.filter($isListItemNode).filter(node => node.getChecked() !== undefined).map(node => node.getChecked())).toEqual([false, true]);
    });
    const first = editor.getEditorState().read($createSnapshot);
    expect(snapshot(first.markdown).markdown).toBe(first.markdown);
  });

  it('imports ordinary aligned GFM tables with escaped pipes and inline formats', () => {
    const first = snapshot(fixture('table.md'));
    expect(first.markdown).toContain(':---');
    expect(first.markdown).toContain('---:');
    expect(first.markdown).toContain('\\|');
    const editor = reopen(first.content);
    editor.getEditorState().read(() => {
      expect(walk().filter($isTableNode)).toHaveLength(1);
      const cells = walk().filter($isTableCellNode);
      expect(cells).toHaveLength(9);
      expect(cells[3]!.getTextContent()).toBe('a | b');
      expect(cells[4]!.getTextContent()).toBe('x|y');
      expect(cells[5]!.getTextContent()).toBe('完成');
    });
    expect(snapshot(first.markdown).markdown).toBe(first.markdown);
  });

  it('treats pipe prose and fenced table examples as text/code', () => {
    const first = snapshot('甲 | 乙\n\n```md\n| a | b |\n| --- | --- |\n| x | y |\n```');
    reopen(first.content).getEditorState().read(() => {
      expect(walk().filter($isTableNode)).toHaveLength(0);
      expect(walk().filter($isCodeNode)).toHaveLength(1);
    });
    expect(assessMarkdown('```html\n<table><tr><td rowspan="2">a</td></tr></table>\n```').warnings).toEqual([]);
  });

  it('preserves image references across JSON/Markdown without DOM or a network loader', () => {
    const input = '图片 ![说明](https://example.com/tracker.png "title") 结束';
    const first = snapshot(input);
    expect(first.markdown).toContain('![说明](https://example.com/tracker.png "title")');
    expect(first.plainText).toContain('图片：说明（未加载）');
    reopen(first.content).getEditorState().read(() => expect(walk().filter(node => node instanceof ImageReferenceNode)).toHaveLength(1));
    expect(snapshot(first.markdown).markdown).toBe(first.markdown);
    expect(assessMarkdown(input).warnings.join()).toContain('不会请求远程图片');
  });
  it('keeps an uploaded attachment ID through JSON reopening and Markdown export', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const editor = createEditor({ namespace: 'attachment-test', nodes: EDITOR_NODES, onError: error => { throw error; } });
    editor.update(() => $getRoot().append($createParagraphNode().append(
      $createAttachmentNode(id, '截图', '截图.png', 'image/png'))), { discrete: true });
    const first = editor.getEditorState().read($createSnapshot);
    expect(first.markdown).toContain(`![截图](nbase-attachment:${id})`);
    const second = reopen(first.content).getEditorState().read($createSnapshot);
    expect(second.markdown).toBe(first.markdown);
    reopen(first.content).getEditorState().read(() => {
      const nodes = walk().filter(node => node instanceof AttachmentNode);
      expect(nodes).toHaveLength(1);
      expect((nodes[0] as AttachmentNode).exportJSON().attachmentId).toBe(id);
    });
  });
});

describe('untrusted and unsupported Markdown', () => {
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'vbscript:msgbox(1)', 'java\nscript:foo', '//tracker.test', '\\evil.test', 'javascript&#58;foo'])('rejects dangerous/ambiguous URL %s', url => expect(isSafeLinkUrl(url)).toBe(false));
  it.each(['https://example.com/a?x=1', 'http://localhost:3000', 'mailto:hello@example.com', '/docs/one', '#heading', './note.md'])('allows supported URL %s', url => expect(isSafeLinkUrl(url)).toBe(true));
  it('does not create clickable nodes for unsafe or HTML-entity-obfuscated links', () => {
    const editor = reopen(createContentFromMarkdown('[bad](javascript:alert%281%29) [encoded](javascript&#58;evil) [safe](https://example.com)'));
    editor.getEditorState().read(() => expect(walk().filter($isLinkNode).map(node => node.getURL())).toEqual(['https://example.com']));
    expect(editor.getEditorState().read($createSnapshot).plainText).toContain('javascript:');
  });
  it.each(['unsupported.md', 'malformed-table.md'])('preserves all raw source for %s with an explicit warning', name => {
    const input = fixture(name);
    expect(assessMarkdown(input).warnings.length).toBeGreaterThan(0);
    const first = snapshot(input);
    expect(first.plainText).toBe(input);
    reopen(first.content).getEditorState().read(() => {
      expect($getRoot().getChildren()).toHaveLength(1);
      expect($isCodeNode($getRoot().getFirstChild())).toBe(true);
    });
    expect(reopen(first.content).getEditorState().read($createSnapshot).plainText).toBe(input);
  });
  it('ignores unsupported-looking syntax in longer fences, including inner short fences', () => {
    const input = '````md\n```\n<script>alert(1)</script>\n[^a]: example\n```\n````';
    expect(assessMarkdown(input).warnings).toEqual([]);
    expect(snapshot(input).plainText).toContain('<script>alert(1)</script>');
  });
  it('warns and preserves tilde fences, invalid front matter, \\( \\) math and unresolved reference links', () => {
    for (const input of ['~~~js\nconst a=1\n~~~', '---\ntitle: [无效\n---\n# body', '公式 \\(a+b\\)', '\\[\nx^2\n\\]', '[ref][missing]']) {
      expect(assessMarkdown(input).warnings.length).toBeGreaterThan(0);
      expect(snapshot(input).plainText).toBe(input);
    }
  });
});

// Regression cases for delimiters: a pipe within an escape is content, not another column.
describe('Markdown boundary regressions', () => {
  it.each([
    '| One | Two |\n| --- | --- |\n| end\\| | value |',
    'One | Two\n--- | ---\na\\|b | **value**',
    '| One |\n| --- |\n| only |',
  ])('round-trips supported table boundary %s', input => {
    expect(assessMarkdown(input).warnings).toEqual([]);
    const first = snapshot(input);
    expect(snapshot(first.markdown).markdown).toBe(first.markdown);
    reopen(first.content).getEditorState().read(() => expect(walk().filter($isTableNode)).toHaveLength(1));
  });
  it('keeps meaningful blank lines and pipe examples inside a code block', () => {
    const input = '```text\none\n\n\n| a | b |\n| --- | --- |\n\nlast\n```';
    const first = snapshot(input);
    expect(first.plainText).toBe('one\n\n\n| a | b |\n| --- | --- |\n\nlast');
    expect(snapshot(first.markdown).plainText).toBe(first.plainText);
  });
  it.each(['heading\n---', 'heading\n===', '![nested](https://example.com/a(b).png)', '![unfinished]('])('warns before degrading complex syntax %s', input => {
    expect(assessMarkdown(input).warnings.length).toBeGreaterThan(0);
    expect(snapshot(input).plainText).toBe(input);
  });
  it('preserves Markdown escapes and Chinese text through structured reopening', () => {
    const first = snapshot('中文输入：\\*不是斜体\\* 与 \\[方括号\\]。\n\n下一段。');
    expect(first.plainText).toContain('中文输入：*不是斜体* 与 [方括号]。');
    expect(snapshot(first.markdown).plainText).toBe(first.plainText);
  });
});

describe('equations and code language aliases', () => {
  it('imports inline $...$ as equations and keeps non-matching $ samples as text', () => {
    const editor = reopen(createContentFromMarkdown('求 $x^2$ 的值'));
    editor.getEditorState().read(() => {
      const equations = walk().filter(node => node instanceof EquationNode);
      expect(equations).toHaveLength(1);
      expect((equations[0] as EquationNode).getEquation()).toBe('x^2');
      expect(equations[0]!.isInline()).toBe(true);
    });
    for (const [input, expected] of [['$ x$', '$ x$'], ['$x $', '$x $'], ['价格 $5 到 $10', '价格 $5 到 $10'], ['\\$x$', '$x$'], ['$x$5', '$x$5']] as const) {
      const snapshot_ = snapshot(input);
      expect(snapshot_.markdown).not.toContain('$$');
      expect(snapshot_.plainText).toBe(expected);
      reopen(snapshot_.content).getEditorState().read(() =>
        expect(walk().filter(node => node instanceof EquationNode)).toHaveLength(0));
    }
  });

  it('imports single-line and fenced $$ blocks, exports them back, and rejects unclosed blocks', () => {
    const single = snapshot('$$x^2$$');
    reopen(single.content).getEditorState().read(() => {
      const equations = walk().filter(node => node instanceof EquationNode);
      expect(equations).toHaveLength(1);
      expect(equations[0]!.isInline()).toBe(false);
      expect((equations[0] as EquationNode).getEquation()).toBe('x^2');
    });
    const multi = snapshot('$$\n\\frac{a}{b}\n$$');
    expect(multi.markdown).toContain('$$\n\\frac{a}{b}\n$$');
    expect(snapshot(multi.markdown).markdown).toBe(multi.markdown);
    expect(assessMarkdown('$$\nx^2\n下一段').warnings.join()).toContain('未闭合的公式块');
    expect(snapshot('$$\nx^2\n下一段').plainText).toContain('$$');
  });

  it('keeps literal $ through markdown round trips', () => {
    for (const input of ['a\\$b\\$c', '价格 \\$5 到 \\$10']) {
      const first = snapshot(input);
      expect(first.markdown).toContain('\\$');
      const second = snapshot(first.markdown);
      expect(second.plainText).toBe(first.plainText);
      expect(second.markdown).toBe(first.markdown);
      reopen(second.content).getEditorState().read(() =>
        expect(walk().filter(node => node instanceof EquationNode)).toHaveLength(0));
    }
  });

  it('round-trips equation JSON through reopen', () => {
    const first = snapshot('求 $x^2$ 与块\n\n$$\ny^2\n$$');
    const second = reopen(first.content).getEditorState().read($createSnapshot);
    expect(second.markdown).toBe(first.markdown);
    expect(second.content).toEqual(first.content);
  });

  it('does not convert $ inside inline code or fenced code', () => {
    const first = snapshot('`$a$` 和\n\n```\n$x$\n```');
    reopen(first.content).getEditorState().read(() =>
      expect(walk().filter(node => node instanceof EquationNode)).toHaveLength(0));
    expect(first.markdown).toContain('`$a$`');
  });

  it('strips the backslash of an escaped pipe inside a table-cell equation', () => {
    // Documented limitation: the table's pipe unescape runs before inline math,
    // so `\|` in LaTeX source is stored as `|`. Export re-escapes it, keeping
    // the Markdown byte-identical but the source semantics changed.
    const first = snapshot('| a | b |\n| --- | --- |\n| $x\\|y$ | 1 |');
    reopen(first.content).getEditorState().read(() => {
      const equation = walk().find(node => node instanceof EquationNode) as InstanceType<typeof EquationNode> | undefined;
      expect(equation?.getEquation()).toBe('x|y');
      expect(equation?.isInline()).toBe(true);
    });
    expect(first.markdown).toContain('$x\\|y$');
  });

  it.each([
    ['js', 'javascript'], ['jsx', 'javascript'], ['ts', 'typescript'], ['tsx', 'typescript'],
    ['sh', 'bash'], ['shell', 'bash'], ['zsh', 'bash'], ['yml', 'yaml'], ['py', 'python'],
    ['html', 'markup'], ['xml', 'markup'], ['golang', 'go'], ['ps1', 'powershell'],
    ['md', 'markdown'], ['objc', 'objectivec'],
  ])('maps code fence language %s to %s on import and exports it', (alias, canonical) => {
    const first = snapshot('```' + alias + '\nx = 1\n```');
    reopen(first.content).getEditorState().read(() => {
      const code = walk().find($isCodeNode);
      expect(code?.getLanguage()).toBe(canonical);
    });
    expect(first.markdown).toContain('```' + canonical);
  });

  it('keeps unknown code fence languages verbatim', () => {
    const first = snapshot('```brainfuck\n++[>++<-]\n```');
    reopen(first.content).getEditorState().read(() => {
      expect(walk().find($isCodeNode)?.getLanguage()).toBe('brainfuck');
    });
    expect(first.markdown).toContain('```brainfuck');
  });
});
