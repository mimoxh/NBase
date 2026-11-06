import { describe, expect, it } from 'vitest';
import { createEditor, $getRoot } from 'lexical';
import { markdownFrontMatterKey } from '@nbase/contracts';
import {
  $createSnapshot, addMarkdownFrontMatter, createContentFromMarkdown, getMarkdownFrontMatter, markdownFromContent,
  parseMarkdownImport, readMarkdownFrontMatter,
} from './markdown';
import { EDITOR_NODES } from './nodes';
import type { DocumentContent } from './types';

function snapshot(content: DocumentContent) {
  const editor = createEditor({ namespace: 'markdown-formats-test', nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.setEditorState(editor.parseEditorState(content.editorState));
  return editor.getEditorState().read($createSnapshot);
}
function nodes(content: DocumentContent): Record<string, unknown>[] {
  const visit = (node: unknown): Record<string, unknown>[] => {
    const value = node as Record<string, unknown>;
    return [value, ...(Array.isArray(value.children) ? value.children.flatMap(visit) : [])];
  };
  return visit(content.editorState.root);
}
function expectRaw(source: string) {
  const result = parseMarkdownImport(source);
  expect(result.preservedAsSource).toBe(true);
  expect(result.warnings.length).toBeGreaterThan(0);
  expect(result.title).toBeUndefined();
  expect(result.tagNames).toEqual([]);
  expect(snapshot(result.content).plainText).toBe(source);
  expect(nodes(result.content).filter(node => node.type === 'code')).toHaveLength(1);
}

describe('safe Markdown front matter', () => {
  it('separates page fields from document metadata and retains them through save, reopen and export', () => {
    const source = '---\ntitle: " 导入标题 "\ntags: [" 中文 ", Work]\ndate: 2024-02-29\nauthor: 测试者\noptions: { enabled: true, weight: 1.5, empty: null }\n---\n\n# 正文\n\n==重点==';
    const result = parseMarkdownImport(source);
    expect(result.preservedAsSource, result.warnings.join()).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.title).toBe('导入标题');
    expect(result.tagNames).toEqual(['中文', 'Work']);
    const metadata = { date: '2024-02-29', author: '测试者', options: { enabled: true, weight: 1.5, empty: null } };
    expect(getMarkdownFrontMatter(result.content)).toEqual(metadata);
    const saved = snapshot(result.content);
    expect(getMarkdownFrontMatter(saved.content)).toEqual(metadata);
    expect(saved.plainText).toContain('正文');
    expect(saved.plainText).not.toContain('author');
    const exported = addMarkdownFrontMatter(saved.markdown, saved.content, '编辑后的标题', ['新标签']);
    const imported = parseMarkdownImport(exported);
    expect(imported.title).toBe('编辑后的标题');
    expect(imported.tagNames).toEqual(['新标签']);
    expect(getMarkdownFrontMatter(imported.content)).toEqual(metadata);
    expect(markdownFromContent(imported.content)).toBe(saved.markdown);
    const editor = createEditor({ nodes: EDITOR_NODES, onError: error => { throw error; } });
    editor.setEditorState(editor.parseEditorState(imported.content.editorState));
    expect(editor.read('latest', () => $getRoot().exportJSON())).toHaveProperty(['$', markdownFrontMatterKey], metadata);
  });

  it('previews CRLF and BOM without creating editor content and leaves ordinary rules and quoted/fenced examples alone', () => {
    const result = readMarkdownFrontMatter('\uFEFF---\r\ntitle: 预览\r\ntags: []\r\n---\r\n正文');
    expect(result.body).toBe('正文');
    expect(result.title).toBe('预览');
    for (const source of ['---\n\n正文', '> ---\n> title: 引用\n> ---', '列子\n\n---\ntitle: 普通正文', '```yaml\n---\ntitle: 示例\n---\n```']) {
      expect(readMarkdownFrontMatter(source).body).toBe(source);
      expect(readMarkdownFrontMatter(source).metadata).toEqual({});
    }
  });

  it.each([
    'title: [错误类型]', 'title: 重复\ntitle: 键', 'tags: [Work, work]', 'tags: [Straße, STRASSE]', 'tags: [1]', 'tags: 单个名称',
    'title: 文档\ndate: 2023-02-29', 'date: 2024-13-01', 'date: 0000-01-01', 'date: 2024-01-01T08:00:00Z',
    'author: &name 人名', 'author: *name', 'field: !custom example', 'field: !!str 123',
    '__proto__: { injected: true }', 'nested: { constructor: 无效 }', 'field: .inf', 'field: .nan',
    'field: 9007199254740993', 'field: 9007199254740993.0',
    'field: {nested: {nested: {nested: {nested: {nested: {nested: {nested: {nested: 值}}}}}}}}',
    'field: "' + '长'.repeat(6000) + '"', 'field: [' + Array.from({ length: 513 }, () => 'a').join(',') + ']',
  ])('preserves all source for unsafe or unsupported YAML %s', fields => expectRaw('---\n' + fields + '\n---\n\n正文'));

  it('preserves unclosed YAML and original CRLF on failure', () => {
    expectRaw('---\ntitle: 未闭合\n正文');
    expectRaw('---\r\ntitle: [broken\r\n---\r\n原文');
  });
});

describe('reference-style Markdown links and images', () => {
  it('normalizes full, collapsed and shortcut references into safe inline links with titles', () => {
    const source = '[显示][ref] [ref][] [REF] ![图片][image]\n\n[ref]: <目录/有 空格.md> "标题"\n[image]: <assets/一 张.png> \'说明\'';
    const result = parseMarkdownImport(source);
    expect(result.preservedAsSource, result.warnings.join()).toBe(false);
    expect(nodes(result.content).filter(node => node.type === 'link').map(node => [node.url, node.title]))
      .toEqual(Array.from({ length: 3 }, () => ['目录/有%20空格.md', '标题']));
    expect(nodes(result.content).filter(node => node.type === 'image-reference').map(node => node.markdown))
      .toEqual(['![图片](<assets/一 张.png> "说明")']);
    const exported = markdownFromContent(result.content);
    expect(exported).not.toContain('[ref]:');
    expect(exported).toContain('[显示](目录/有%20空格.md "标题")');
    expect(snapshot(createContentFromMarkdown(exported)).markdown).toBe(exported);
  });

  it('accepts relative angle link destinations with spaces and rejects dangerous, obfuscated or protocol-relative URLs', () => {
    const source = '[相对](<目录/有 空格.md>) [unsafe](<javascript:alert(1)>) [encoded](<javascript&#58;foo>) [network](<//evil.test/x>)';
    const result = parseMarkdownImport(source);
    expect(result.preservedAsSource, result.warnings.join()).toBe(false);
    expect(nodes(result.content).filter(node => node.type === 'link').map(node => node.url)).toEqual(['目录/有%20空格.md']);
    const reference = parseMarkdownImport('[bad][x]\n\n[x]: <javascript:alert(1)>');
    expect(nodes(reference.content).filter(node => node.type === 'link')).toEqual([]);
    expect(snapshot(reference.content).plainText).toContain('javascript:alert(1)');
  });

  it('protects fenced and inline code, escaped labels, equations and legacy wiki references', () => {
    const source = ['[ref]', '\\[ref]', '[[ref]]', '`[missing][no]`', '$[math][no]$', '[ref]: /valid',
      '```markdown\n[not][no]\n[bad]: /not-a-definition\n```'].join('\n\n');
    const result = parseMarkdownImport(source);
    expect(result.preservedAsSource, result.warnings.join()).toBe(false);
    expect(nodes(result.content).filter(node => node.type === 'link').map(node => node.url)).toEqual(['/valid']);
    expect(snapshot(result.content).plainText).toContain('[[ref]]');
    expect(snapshot(result.content).plainText).toContain('[not][no]');
  });

  it.each([
    '[text][missing]', '[x][]', '![image][missing]',
    '[x]\n\n[x]: /one\n[X]: /two',
    '[x]\n\n[x]: <unfinished', '> [x]: /inside-quote\n> [x]',
  ])('reports and preserves unsupported or ambiguous definitions %s', expectRaw);
});

describe('footnote Markdown', () => {
  it('stores repeated inline references and a single rich definition and survives semantic round trips', () => {
    const source = '# 标题\n\n正文[^a] 再次[^A]。\n\n> [!NOTE]\n> 引用[^a]\n\n| 表头 |\n| --- |\n| 内容[^a] |\n\n[^a]: **解释** [官网][site]\n\n    第二段。\n\n[site]: https://example.com';
    const first = parseMarkdownImport(source);
    expect(first.warnings).toEqual([]);
    expect(first.preservedAsSource).toBe(false);
    expect(nodes(first.content).filter(node => node.type === 'footnote-reference').map(node => node.footnoteId)).toEqual(['a', 'a', 'a', 'a']);
    expect(nodes(first.content).filter(node => node.type === 'footnote-definition').map(node => node.footnoteId)).toEqual(['a']);
    const exported = markdownFromContent(first.content);
    expect(exported).toContain('[^a]: **解释** [官网](https://example.com)');
    expect(exported).toContain('    第二段。');
    const second = parseMarkdownImport(exported);
    expect(second.warnings).toEqual([]);
    expect(markdownFromContent(second.content)).toBe(exported);
    expect(snapshot(second.content).content).toEqual(snapshot(first.content).content);
  });

  it('ignores literal examples and normalizes Unicode identifiers', () => {
    const source = '说明[^中文] 与 `[^不存在]` 和 \\[^字面]。\n\n[^中文]: 解释\n\n```md\n[^不存在]: 样例\n```';
    const result = parseMarkdownImport(source);
    expect(result.preservedAsSource).toBe(false);
    expect(nodes(result.content).filter(node => node.type === 'footnote-reference').map(node => node.footnoteId)).toEqual(['中文']);
    const exported = markdownFromContent(result.content);
    expect(parseMarkdownImport(exported).preservedAsSource, exported + '\n' + parseMarkdownImport(exported).warnings.join()).toBe(false);
  });

  it.each(['缺失[^missing]', '重复[^a]\n\n[^a]: 一\n[^A]: 二', '标识[^space id]\n\n[^space id]: 解释'])(
    'preserves source when references cannot be represented %s', expectRaw);
});
