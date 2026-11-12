import { describe, expect, it } from 'vitest';
import { markdownFromContent, parseMarkdownImport } from './markdown';
import { normalizeDocumentContent } from './normalize';
import { prepareSourceEdit } from './sourceEditing';
import { blockTextFromContent } from './blockAnchors';

const page = '11111111-2222-4333-8444-555555555555';
type Json = Record<string, unknown> & { children?: Json[]; $?: Record<string, unknown> };
const flat = (node: Json): Json[] => [node, ...(node.children ?? []).flatMap(flat)];

describe('block anchors and references', () => {
  it('round-trips anchors on paragraphs, headings, lists, toggles and tables, and references to them', () => {
    const source = [
      '<!-- ^para0001 -->', '', '段落 *一*', '',
      '<!-- ^head0001 -->', '', '## 标题', '',
      '<!-- ^list0001 -->', '', '- 列表项', '',
      '<!-- ^togl0001 -->', '', '<details>', '<summary>折叠</summary>', '', '<!-- ^innr0001 -->', '', '内部段落', '', '</details>', '',
      '<!-- ^tabl0001 -->', '', '<!-- nbase-table widths="120,120" -->', '', '| a | b |', '| --- | --- |', '',
      `引用 [段落 一](/?page=${page}#block-para0001) 结束`,
    ].join('\n');
    const imported = parseMarkdownImport(source);
    expect(imported.preservedAsSource, imported.warnings.join()).toBe(false);
    const nodes = flat(imported.content.editorState.root as unknown as Json);
    const anchored = nodes.filter(node => node.$?.nbaseBlockId).map(node => [node.type, node.$!.nbaseBlockId]);
    expect(anchored).toEqual([['paragraph', 'para0001'], ['heading', 'head0001'], ['list', 'list0001'], ['toggle', 'togl0001'],
      ['paragraph', 'innr0001'], ['table', 'tabl0001']]);
    expect(nodes.find(node => node.type === 'block-reference')).toMatchObject({ targetPageId: page, blockId: 'para0001', label: '段落 一' });
    const again = parseMarkdownImport(markdownFromContent(imported.content));
    expect(normalizeDocumentContent(again.content)).toEqual(normalizeDocumentContent(imported.content));
    expect(prepareSourceEdit(imported.content).canApply).toBe(true);
    expect(blockTextFromContent(imported.content.editorState.root, 'innr0001')).toBe('内部段落');
    expect(blockTextFromContent(imported.content.editorState.root, 'missing0')).toBeNull();
  });

  it('keeps the source when an anchor is not followed by a block', () => {
    expect(parseMarkdownImport('正文\n\n<!-- ^dangling -->').preservedAsSource).toBe(true);
  });
});
