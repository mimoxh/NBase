import { describe, expect, it } from 'vitest';
import { $getRoot, createEditor } from 'lexical';
import { $isTableNode } from '@lexical/table';
import { markdownFromContent, parseMarkdownImport } from './markdown';
import { EDITOR_NODES } from './nodes';
import { normalizeDocumentContent } from './normalize';
import { prepareSourceEdit } from './sourceEditing';
import { $tableGrid } from './tableLayout';
import type { DocumentContent } from './types';

const source = '<!-- nbase-table widths="120,200,80" spans="0.0=2x1,1.2=1x2" -->\n\n| 合并表头 |  | 三 |\n| --- | :---: | ---: |\n| a | b | 竖向 |\n| c | d |  |';

function grid(content: DocumentContent) {
  const editor = createEditor({ namespace: 'table-layout-test', nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.setEditorState(editor.parseEditorState(content.editorState));
  return editor.getEditorState().read(() => {
    const table = $getRoot().getFirstChild();
    if (!$isTableNode(table)) throw new Error('no table');
    return { widths: table.getColWidths(), cells: $tableGrid(table).map(row => row.map(({ cell }) => cell.getTextContent())) };
  });
}

describe('merged cells and column widths', () => {
  it('imports the layout comment and exports it back unchanged', () => {
    const imported = parseMarkdownImport(source);
    expect(imported.preservedAsSource, imported.warnings.join()).toBe(false);
    expect(grid(imported.content)).toEqual({ widths: [120, 200, 80], cells: [['合并表头', '合并表头', '三'], ['a', 'b', '竖向'], ['c', 'd', '竖向']] });
    const markdown = markdownFromContent(imported.content);
    expect(markdown).toContain('<!-- nbase-table widths="120,200,80" spans="0.0=2x1,1.2=1x2" -->');
    expect(normalizeDocumentContent(parseMarkdownImport(markdown).content)).toEqual(normalizeDocumentContent(imported.content));
    expect(prepareSourceEdit(imported.content).canApply).toBe(true);
  });

  it('keeps the document as source when a covered cell has text or spans overlap', () => {
    expect(parseMarkdownImport(source.replace('| 合并表头 |  |', '| 合并表头 | 不该有 |')).preservedAsSource).toBe(true);
    expect(parseMarkdownImport(source.replace('1.2=1x2', '0.1=1x2')).preservedAsSource).toBe(true);
    expect(parseMarkdownImport('<!-- nbase-table widths="120" -->\n\n| a | b |\n| --- | --- |').preservedAsSource).toBe(true);
    expect(parseMarkdownImport('<!-- nbase-table widths="120,200" -->\n\n普通段落').preservedAsSource).toBe(true);
  });
});
