import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEditor, $createParagraphNode, $getRoot, $isElementNode } from 'lexical';
import type { LexicalNode } from 'lexical';
import { $isLinkNode } from '@lexical/link';
import { $isTableNode, $isTableCellNode } from '@lexical/table';
import { $isListNode, $isListItemNode } from '@lexical/list';
import { $isCodeNode } from '@lexical/code';
import { $createSnapshot, assessMarkdown, createContentFromMarkdown, isSafeLinkUrl } from './markdown';
import { EDITOR_NODES } from './nodes';
import { ImageReferenceNode } from './nodes/ImageReferenceNode';
import { $createAttachmentNode, AttachmentNode } from './nodes/AttachmentNode';
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

describe('Markdown common document subset', () => {
  it('reopens versioned JSON and preserves headings, inline formats, quote, code, links and divider', () => {
    const first = snapshot(fixture('common.md'));
    expect(first.content.schemaVersion).toBe(1);
    expect(first.outline.map(item => [item.text, item.level])).toEqual([['日常文档', 1], ['结构与格式', 2]]);
    expect(first.outline.every(item => /^heading-/.test(item.id))).toBe(true);
    for (const text of ['**粗体**', '*斜体*', '~~删除线~~', '`inline`', '> 引用内容', '```ts', '---', '[文档](https://example.com/docs)']) expect(first.markdown).toContain(text);
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
  it('warns and preserves tilde fences, front matter, formula and reference links', () => {
    for (const input of ['~~~js\nconst a=1\n~~~', '---\ntitle: 文档\n---\n# body', '公式 $a+b$', '[ref][id]\n\n[id]: https://example.com']) {
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
