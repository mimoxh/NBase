// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { TableCellHeaderStates } from '@lexical/table';
import mixed from '../../../../docs/fixtures/markdown/notes-mixed.md?raw';
import { quickCaptureMarker, markdownFrontMatterKey } from '@nbase/contracts';
import { createContentFromMarkdown, parseMarkdownImport } from './markdown';
import { prepareSourceEdit, parseSourceEdit, quickCaptureSourceMarker } from './sourceEditing';
import type { DocumentContent } from './types';

type Node = Record<string, unknown> & { type: string; children?: Node[]; $?: Record<string, unknown> };
function root(content: DocumentContent) { return content.editorState.root as unknown as Node & { children: Node[] }; }
function walk(node: Node): Node[] { return [node, ...(node.children?.flatMap(walk) ?? [])]; }
const id = '11111111-1111-4111-8111-111111111111';
const image = { type: 'attachment', version: 1, attachmentId: id, alt: '截图 [原样]', fileName: '测试.png', mediaType: 'image/png' };
const file = { type: 'attachment', version: 1, attachmentId: '22222222-2222-4222-8222-222222222222', alt: '', fileName: '报告 [文件].pdf', mediaType: 'application/pdf' };
function withAttachments() {
  const content = createContentFromMarkdown('正文\n\n> [!NOTE]\n> 附件\n\n| 图 | 文件 |\n| --- | --- |\n| 单元格 | 单元格 |');
  root(content).children[0]!.children!.push({ ...image }, { ...file });
  const quote = root(content).children.find(node => node.type === 'callout')!;
  quote.children![0]!.children!.push({ ...image });
  const cell = walk(root(content)).find(node => node.type === 'tablecell')!;
  cell.children![0]!.children!.push({ ...image });
  return content;
}
function daily() {
  const content = createContentFromMarkdown('# 当天\n\n## 随手记\n\n已有记录\n\n## 下一节\n\n其他内容');
  const heading = root(content).children.find(node => node.type === 'heading' && node.tag === 'h2')!;
  heading.$ = { [quickCaptureMarker]: true };
  return content;
}

it('allows the frozen A–D mixed body and keeps root metadata outside the editable source', () => {
  const original = parseMarkdownImport(mixed).content;
  const prepared = prepareSourceEdit(original);
  expect(prepared.diagnostics).toEqual([]);
  expect(prepared.canApply).toBe(true);
  expect(prepared.source).not.toContain('review:');
  const parsed = parseSourceEdit(prepared.source.replace('中文 **粗体**', '修改 **粗体**'), original);
  expect(parsed.diagnostics).toEqual([]);
  expect(root(parsed.content!).$).toEqual(root(original).$);
  expect(JSON.stringify(parsed.content)).toContain('修改');
});

it.each([0, 1, 2, 3])('keeps a footnote definition at block position %i, including body appended after it', position => {
  const original = createContentFromMarkdown('前文[^a]\n\n中间[^a]\n\n尾段\n\n[^a]: **说明**。');
  const children = root(original).children;
  const definition = children.pop()!;
  expect(definition.type).toBe('footnote-definition');
  children.splice(position, 0, definition);
  const before = JSON.stringify(original);
  const prepared = prepareSourceEdit(original);
  expect(prepared.canApply, prepared.diagnostics.join('\n')).toBe(true);
  expect(prepared.source).not.toContain('NBASE_FOOTNOTE_');
  const parsed = parseSourceEdit(prepared.source, original);
  expect(parsed.diagnostics).toEqual([]);
  expect(root(parsed.content!).children.map(node => node.type)).toEqual(children.map(node => node.type));
  expect(root(parsed.content!).children[position]?.footnoteId).toBe('a');
  expect(JSON.stringify(original)).toBe(before);
  const appended = parseSourceEdit(prepared.source + '\n\n后续新正文', original);
  expect(appended.diagnostics).toEqual([]);
  expect(root(appended.content!).children[position]?.footnoteId).toBe('a');
  expect(JSON.stringify(appended.content)).toContain('后续新正文');
});

it('keeps literal slot-like strings and fenced footnote definitions as ordinary source', () => {
  const original = createContentFromMarkdown('正文');
  const source = '\ue000NBASE_FOOTNOTE_fake_0\ue001\n\n```md\n[^fake]: 代码\n```\n\n真实[^a]\n\n[^a]: 定义\n\n后文';
  const parsed = parseSourceEdit(source, original);
  expect(parsed.diagnostics).toEqual([]);
  expect(JSON.stringify(parsed.content)).toContain('NBASE_FOOTNOTE_fake_0');
  const notes = walk(root(parsed.content!)).filter(node => node.type === 'footnote-definition');
  expect(notes.map(note => note.footnoteId)).toEqual(['a']);
});

it('preserves page-reference UUIDs, missing image placeholders and known attachments inside callouts and tables', () => {
  const original = withAttachments();
  root(original).children.push(...root(createContentFromMarkdown('[页面](/?page=' + id + ')\n\n![缺失图片](./missing.png)')).children);
  const prepared = prepareSourceEdit(original);
  expect(prepared.diagnostics).toEqual([]);
  expect(prepared.canApply).toBe(true);
  const result = parseSourceEdit(prepared.source, original);
  expect(result.diagnostics).toEqual([]);
  expect(walk(root(result.content!)).filter(node => node.type === 'attachment')).toHaveLength(4);
  expect(walk(root(result.content!)).filter(node => node.type === 'page-reference')[0]?.targetPageId).toBe(id);
});

it('blocks unknown attachment IDs, changed file labels and image/file syntax swaps', () => {
  const original = withAttachments();
  const source = prepareSourceEdit(original).source;
  for (const candidate of [
    source.replace(id, '33333333-3333-4333-8333-333333333333'),
    source.replace('报告 \\[文件\\].pdf', '改名.pdf'),
    source.replace('![截图', '[截图'),
  ]) expect(parseSourceEdit(candidate, original).content).toBeNull();
  expect(parseSourceEdit(source.replace('截图', '新截图'), original).content).not.toBeNull();
});

it('rejects attachment titles and angle destinations before they can fall back to literal text', () => {
  const original = withAttachments();
  const source = prepareSourceEdit(original).source;
  for (const changed of [
    source.replace('nbase-attachment:' + id + ')', 'nbase-attachment:' + id + ' "新增标题")'),
    source.replace('(nbase-attachment:' + id + ')', '(<nbase-attachment:' + id + '>)'),
  ]) expect(parseSourceEdit(changed, original).content).toBeNull();
});

it('keeps image empty-alt fallback and file hidden alt rather than rebuilding metadata from display text', () => {
  const original = createContentFromMarkdown('附件');
  root(original).children[0]!.children!.push({ ...image, alt: '' }, { ...file, alt: '检索附注' });
  expect(prepareSourceEdit(original).diagnostics).toEqual([]);
  const result = parseSourceEdit(prepareSourceEdit(original).source, original);
  expect(result.diagnostics).toEqual([]);
  expect(walk(root(result.content!)).filter(node => node.type === 'attachment').map(node => node.alt)).toEqual(['', '检索附注']);
});

it('preserves an explicit quick capture marker and accepts moving its whole unchanged heading', () => {
  const original = daily();
  const prepared = prepareSourceEdit(original);
  expect(prepared.diagnostics).toEqual([]);
  expect(prepared.source).toContain(quickCaptureSourceMarker + '\n## 随手记');
  const result = parseSourceEdit(prepared.source, original);
  expect(result.diagnostics).toEqual([]);
  expect(walk(root(result.content!)).filter(node => node.$?.[quickCaptureMarker] === true)).toHaveLength(1);
  const moved = prepared.source.replace(quickCaptureSourceMarker + '\n## 随手记\n\n已有记录\n\n', '')
    + '\n\n' + quickCaptureSourceMarker + '\n## 随手记\n\n已有记录';
  expect(parseSourceEdit(moved, original).diagnostics).toEqual([]);
});

it('rejects deleting, duplicating or individually moving a quick capture marker', () => {
  const original = daily();
  const source = prepareSourceEdit(original).source;
  for (const candidate of [
    source.replace(quickCaptureSourceMarker, ''),
    source + '\n\n' + quickCaptureSourceMarker + '\n## 随手记',
    source.replace(quickCaptureSourceMarker + '\n', '').replace('## 下一节', quickCaptureSourceMarker + '\n## 下一节'),
    source.replace(quickCaptureSourceMarker + '\n## 随手记', '> ' + quickCaptureSourceMarker + '\n> ## 随手记'),
    source.replace('## 随手记', '## 已改名'),
  ]) expect(parseSourceEdit(candidate, original).content).toBeNull();
  expect(parseSourceEdit(quickCaptureSourceMarker + '\n## 随手记', createContentFromMarkdown('普通页')).content).toBeNull();
});

it('does not treat marker samples inside literal fences as persistent markers', () => {
  const original = createContentFromMarkdown('```markdown\n' + quickCaptureSourceMarker + '\n## 样例\n```');
  expect(prepareSourceEdit(original).diagnostics).toEqual([]);
});

it('blocks front matter changes while keeping the original metadata exactly', () => {
  const original = parseMarkdownImport('---\ndate: 2026-11-05\ncustom: {author: 中文, empty: null}\n---\n正文').content;
  const prepared = prepareSourceEdit(original);
  const result = parseSourceEdit('---\ntitle: 越界\n---\n' + prepared.source, original);
  expect(result.content).toBeNull();
  expect(root(original).$?.[markdownFrontMatterKey]).toEqual({ date: '2026-11-05', custom: { author: '中文', empty: null } });
});

it('keeps unknown nodes and attributes in the original instead of claiming a safe roundtrip', () => {
  for (const original of [
    { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [{ type: 'future-node', version: 1, payload: '原数据' }] } } } as unknown as DocumentContent,
    createContentFromMarkdown('已知正文'),
  ]) {
    if (root(original).children[0]!.type === 'paragraph') root(original).children[0]!.futureAttribute = '原属性';
    const before = JSON.stringify(original);
    const prepared = prepareSourceEdit(original);
    expect(prepared.canApply).toBe(false);
    expect(prepared.source).toBeTruthy();
    expect(parseSourceEdit('替换正文', original).content).toBeNull();
    expect(JSON.stringify(original)).toBe(before);
  }
});

it('blocks lossy whitespace, multiple-block cells, column widths and row heights while allowing ordinary empty cells', () => {
  const ordinary = createContentFromMarkdown('| A | B |\n| --- | --- |\n| 内容 | |');
  expect(prepareSourceEdit(ordinary).diagnostics).toEqual([]);
  const changes = [
    (cell: Node) => { cell.children![0]!.children![0]!.text = ' 空格 '; },
    (cell: Node) => { cell.children!.push(...root(createContentFromMarkdown('另一段')).children); },
    (cell: Node) => { cell.width = 250; },
  ];
  for (const change of changes) {
    const original = structuredClone(ordinary);
    const cell = walk(root(original)).find(node => node.type === 'tablecell')!;
    change(cell);
    expect(prepareSourceEdit(original).canApply).toBe(false);
  }
  const row = structuredClone(ordinary);
  walk(root(row)).find(node => node.type === 'tablerow')!.height = 120;
  expect(prepareSourceEdit(row).canApply).toBe(false);
});

it('keeps existing column headers protected when Markdown cannot express them', () => {
  const original = createContentFromMarkdown('表格外正文\n\n| A | B |\n| --- | --- |\n| 内容 | 值 |');
  const table = walk(root(original)).find(node => node.type === 'table')!;
  for (const row of table.children!) {
    const firstCell = row.children![0]!;
    firstCell.headerState = Number(firstCell.headerState ?? 0) | TableCellHeaderStates.COLUMN;
  }
  const before = JSON.stringify(original);
  const prepared = prepareSourceEdit(original);
  expect(prepared.canApply).toBe(false);
  expect(prepared.diagnostics).toContain('原始正文含 Markdown 不能完整表达的结构或属性，已阻止源码应用。');
  expect(parseSourceEdit(prepared.source.replace('表格外正文', '修改正文'), original).content).toBeNull();
  expect(JSON.stringify(original)).toBe(before);
});

it('preserves the original ordinary empty suffix rather than dropping table cursor exits', () => {
  const original = createContentFromMarkdown('原正文\n\n| A | B |\n| --- | --- |\n| 内容 | 值 |');
  const blank = root(createContentFromMarkdown('')).children[0]!;
  root(original).children.push(structuredClone(blank), structuredClone(blank));
  const before = JSON.stringify(original);
  const prepared = prepareSourceEdit(original);
  expect(prepared.diagnostics).toEqual([]);
  const parsed = parseSourceEdit(prepared.source.replace('原正文', '修改正文'), original);
  expect(parsed.diagnostics).toEqual([]);
  expect(root(parsed.content!).children.slice(-2)).toEqual([blank, blank]);
  expect(root(parsed.content!).children).toHaveLength(root(original).children.length);
  const emptied = parseSourceEdit('', original);
  expect(emptied.diagnostics).toEqual([]);
  expect(root(emptied.content!).children).toEqual([blank, blank]);
  expect(JSON.stringify(original)).toBe(before);
});

it('does not hide styled empty paragraphs or unknown attributes in the implicit suffix', () => {
  const blank = root(createContentFromMarkdown('')).children[0]!;
  for (const properties of [{ format: 'right' }, { futureAttribute: null }, { textStyle: 'color:red' }, { $: { futureState: true } }]) {
    const original = createContentFromMarkdown('原正文');
    root(original).children.push({ ...structuredClone(blank), ...properties });
    const before = JSON.stringify(original);
    const prepared = prepareSourceEdit(original);
    expect(prepared.canApply).toBe(false);
    expect(parseSourceEdit('修改正文', original).content).toBeNull();
    expect(JSON.stringify(original)).toBe(before);
  }
});

it.each([1, 3])('keeps %i all-empty paragraphs stable across repeated source applications', count => {
  const original = createContentFromMarkdown('');
  const blank = structuredClone(root(original).children[0]!);
  root(original).children = Array.from({ length: count }, () => structuredClone(blank));
  let current = original;
  for (let repeat = 0; repeat < 3; repeat++) {
    const prepared = prepareSourceEdit(current);
    expect(prepared.diagnostics).toEqual([]);
    const parsed = parseSourceEdit(prepared.source, current);
    expect(parsed.diagnostics).toEqual([]);
    expect(root(parsed.content!).children).toEqual(root(original).children);
    current = parsed.content!;
  }
  const changed = parseSourceEdit('新增正文', original);
  expect(changed.diagnostics).toEqual([]);
  expect(root(changed.content!).children.slice(-count)).toEqual(root(original).children);
  expect(root(changed.content!).children).toHaveLength(count + 1);
});

it('does not treat leading or middle empty paragraphs as an implicit suffix', () => {
  const blank = root(createContentFromMarkdown('')).children[0]!;
  for (const position of [0, 1]) {
    const original = createContentFromMarkdown('首段\n\n尾段');
    root(original).children.splice(position, 0, structuredClone(blank));
    expect(prepareSourceEdit(original).canApply).toBe(false);
  }
});

it.each([
  '<img src="https://outside.invalid">',
  '[不安全](javascript:alert(1))',
  '[不支持](ftp://outside.invalid)',
  '[^missing]',
  '---\na: &alias 原文\nb: *alias\n---\n正文',
  '字'.repeat(800_000),
])('rejects malformed, unsafe or oversized source without mutating the original %#', source => {
  const original = createContentFromMarkdown('原始正文');
  const before = JSON.stringify(original);
  expect(parseSourceEdit(source, original).content).toBeNull();
  expect(JSON.stringify(original)).toBe(before);
});

it('checks candidate storage bytes, node count and source expressibility before applying', () => {
  const original = createContentFromMarkdown('正文');
  const tooMany = Array.from({ length: 10_001 }, (_, index) => '段落' + index).join('\n\n');
  expect(parseSourceEdit(tooMany, original).content).toBeNull();
  expect(parseSourceEdit('字'.repeat(350_000), original).content).toBeNull();
});

it.each([
  '脚注[^a]\n\n[^a]: [不安全](javascript:alert(1))',
  '脚注[^a]\n\n[^a]: [不支持](ftp://outside.invalid)',
  '脚注[^a]\n\n[^a]: [远程空格](<https://outside.invalid/a b>)',
  '[远程空格](<https://outside.invalid/a b>)',
  '脚注[^a]\n\n[^a]: [引用][unsafe]\n\n[unsafe]: data:text/html,original',
])('blocks unsafe links in the body and footnote definitions before literal fallback %#', source => {
  const original = createContentFromMarkdown('正文');
  expect(parseSourceEdit(source, original).content).toBeNull();
});

it('allows relative angle links with spaces and leaves unsafe-looking code alone', () => {
  const original = createContentFromMarkdown('正文');
  for (const source of [
    '[相对路径](<文件夹/我的 文档.md>)',
    '脚注[^a]\n\n[^a]: [相对路径](<我的 文档.md>)',
    '```text\n[不安全](javascript:alert(1))\n```',
    '`[不安全](javascript:alert(1))`',
  ]) {
    const result = parseSourceEdit(source, original);
    expect(result.diagnostics, source).toEqual([]);
  }
});

it('detects default-looking unknown attributes on leaf nodes and code children', () => {
  const original = withAttachments();
  const attachment = walk(root(original)).find(node => node.type === 'attachment')!;
  attachment.direction = null;
  expect(prepareSourceEdit(original).canApply).toBe(false);
  const code = createContentFromMarkdown('```text\n源码\n```');
  walk(root(code)).find(node => node.type === 'text')!.unexpected = null;
  expect(prepareSourceEdit(code).canApply).toBe(false);
});

it('retains ordinary text formats, code highlighting equivalence, list starts and literal delimiters', () => {
  const original = createContentFromMarkdown('3. **粗体** *斜体* ==高亮== ~~删除~~\n4. `a == b` 与 \\=\\=字面\\=\\=\n\n```js\nconst code = 1;\n```');
  const codeText = walk(root(original)).find(node => node.type === 'text' && node.text === 'const code = 1;')!;
  codeText.type = 'code-highlight';
  codeText.highlightType = 'keyword';
  const prepared = prepareSourceEdit(original);
  expect(prepared.diagnostics).toEqual([]);
  expect(parseSourceEdit(prepared.source.replace('粗体', '新粗体'), original).diagnostics).toEqual([]);
});

it('blocks original unexpressed text styles and layout attributes', () => {
  for (const [key, value] of [['format', 8], ['detail', 2], ['style', 'color:red'], ['future', null]] as const) {
    const original = createContentFromMarkdown('正文');
    const text = walk(root(original)).find(node => node.type === 'text')!;
    text[key] = value;
    expect(prepareSourceEdit(original).canApply, key).toBe(false);
  }
  // A quote has no Markdown form for an indent; paragraphs and headings do (`<div style="margin-left">`).
  const original = createContentFromMarkdown('> 引用');
  root(original).children[0]!.indent = 2;
  expect(prepareSourceEdit(original).canApply).toBe(false);
  const indented = createContentFromMarkdown('正文');
  root(indented).children[0]!.indent = 2;
  expect(prepareSourceEdit(indented).canApply).toBe(true);
  // Alignment has a Markdown form (`<div align>`), so it no longer blocks the source editor.
  const aligned = createContentFromMarkdown('正文');
  root(aligned).children[0]!.format = 'right';
  expect(prepareSourceEdit(aligned).canApply).toBe(true);
  const heading = createContentFromMarkdown('## 标题');
  Object.assign(root(heading).children[0]!, { format: 'center', indent: 1 });
  expect(prepareSourceEdit(heading).canApply).toBe(true);
});

it('rejects ambiguous quick capture headings and malformed original marker locations', () => {
  const original = daily();
  root(original).children.push(...root(createContentFromMarkdown('## 随手记')).children);
  expect(prepareSourceEdit(original).canApply).toBe(false);
  const malformed = createContentFromMarkdown('> ## 错误位置');
  const heading = walk(root(malformed)).find(node => node.type === 'heading');
  if (heading) heading.$ = { [quickCaptureMarker]: true };
  else root(malformed).children[0]!.$ = { [quickCaptureMarker]: true };
  expect(prepareSourceEdit(malformed).canApply).toBe(false);
});

it('rejects inconsistent original attachment metadata and ambiguous hidden file notes', () => {
  const original = withAttachments();
  root(original).children[0]!.children!.push({ ...image, fileName: '不一致.png' });
  expect(prepareSourceEdit(original).canApply).toBe(false);
  const ambiguous = createContentFromMarkdown('附件');
  root(ambiguous).children[0]!.children!.push({ ...file, alt: '隐藏甲' }, { ...file, alt: '隐藏乙' });
  expect(prepareSourceEdit(ambiguous).canApply).toBe(false);
});

it('retains parser diagnostics for malformed original JSON and unsupported content versions', () => {
  for (const original of [
    { schemaVersion: 9, editorState: { root: {} } },
    { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: 'bad' } } },
  ] as unknown as DocumentContent[]) {
    const prepared = prepareSourceEdit(original);
    expect(prepared.canApply).toBe(false);
    expect(prepared.source).toContain('schemaVersion');
    expect(prepared.diagnostics.length).toBeGreaterThan(0);
  }
});
