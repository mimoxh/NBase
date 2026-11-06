// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $isTableCellNode, $isTableNode, $isTableRowNode, TableCellHeaderStates } from '@lexical/table';
import { $getRoot, $getSelection, $isTextNode, createEditor } from 'lexical';
import { DocumentEditor } from './DocumentEditor';
import { $createSnapshot, createContentFromMarkdown } from './markdown';
import { EDITOR_NODES } from './nodes';
import { $alignTableColumn, $applyTablePaste, $isCurrentTablePaste, $moveTableLine, $previewTablePaste, $tablePasteTarget, parseTsv } from './tableEditing';
import type { DocumentEditorHandle } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sampleTable = '| 第一列 | 第二列 |\n| --- | ---: |\n| 左边 | 右边 |';

function tableEditor(markdown = sampleTable) {
  const editor = createEditor({ nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.setEditorState(editor.parseEditorState(createContentFromMarkdown(markdown).editorState));
  return editor;
}

function $table() {
  const table = $getRoot().getChildren().find($isTableNode);
  if (!table) throw new Error('Expected a table');
  return table;
}

function $cells() {
  return $table().getChildren().filter($isTableRowNode).map(row => row.getChildren().filter($isTableCellNode));
}

describe('TSV format', () => {
  it('accepts mixed newlines, an empty final column, spaces and literal formula text', () => {
    expect(parseTsv(' 名称 \t甲|乙\t\r\n=1+1\t\t\r另行\t列\t\n')).toEqual({
      rows: [[' 名称 ', '甲|乙', ''], ['=1+1', '', ''], ['另行', '列', '']],
    });
    expect(parseTsv('普通两行\n下一行')).toBeNull();
    expect(parseTsv('普通两行\n下一行', true)).toEqual({ rows: [['普通两行'], ['下一行']] });
  });

  it('rejects uneven rows, quoted embedded separators and values beyond the bounds', () => {
    expect(parseTsv('甲\t乙\n第三项')).toEqual({ warning: expect.stringContaining('无法安全解析') });
    expect(parseTsv('"甲\t乙"\t第二格', true)).toEqual({ warning: expect.stringContaining('无法安全解析') });
    expect(parseTsv('甲\t"乙\n丙"\n', true)).toEqual({ warning: expect.stringContaining('无法安全解析') });
    expect(parseTsv(Array.from({ length: 101 }, () => '甲\t乙').join('\n'))).toEqual({ warning: expect.stringContaining('100 行') });
    expect(parseTsv(Array.from({ length: 31 }, () => '甲').join('\t'))).toEqual({ warning: expect.stringContaining('30 列') });
    expect(parseTsv('"甲""乙"\t丙', true)).toEqual({ rows: [['甲"乙', '丙']] });
  });
});

describe('ordinary table editing', () => {
  it('previews expanding both dimensions, writes from the chosen cell and retains column alignment', () => {
    const editor = tableEditor();
    editor.update(() => {
      $cells()[1]![1]!.selectEnd();
      const data = [[' A ', '新|列'], ['底行', '']];
      const target = $tablePasteTarget($getSelection())!;
      const preview = $previewTablePaste(target, data)!;
      expect(preview).toMatchObject({ row: 1, column: 1, rows: 3, columns: 3, confirm: true });
      expect($cells()[1]![1]!.getTextContent()).toBe('右边');
      expect($applyTablePaste(target, data, preview)).toBe('applied');
      expect($cells().map(row => row.map(cell => cell.getTextContent()))).toEqual([
        ['第一列', '第二列', ''], ['左边', ' A ', '新|列'], ['', '底行', ''],
      ]);
      expect($cells().map(row => row[1]!.getFormatType())).toEqual(['right', 'right', 'right']);
    }, { discrete: true });
    expect(editor.read('latest', $createSnapshot).markdown).toContain('新\\|列');
  });

  it('rejects a confirmed paste if a concurrent update changes a target cell with the same geometry', () => {
    const editor = tableEditor();
    const data = [['覆盖', '扩展']];
    let pending: { target: NonNullable<ReturnType<typeof $tablePasteTarget>>; preview: NonNullable<ReturnType<typeof $previewTablePaste>> };
    editor.update(() => {
      $cells()[1]![1]!.selectEnd();
      const target = $tablePasteTarget($getSelection())!;
      pending = { target, preview: $previewTablePaste(target, data)! };
    }, { discrete: true });
    editor.update(() => {
      const text = $cells()[1]![1]!.getAllTextNodes()[0];
      if (!$isTextNode(text)) throw new Error('Expected cell text');
      text.setTextContent('另一个更新先到');
    }, { discrete: true });
    editor.update(() => {
      const { target, preview } = pending;
      expect($previewTablePaste(target, data)).toMatchObject({ row: 1, column: 1, rows: 2, columns: 3, confirm: true });
      expect($isCurrentTablePaste(target, data, preview)).toBe(false);
      expect($applyTablePaste(target, data, preview)).toBe('changed');
      expect($cells()[1]!.map(cell => cell.getTextContent())).toEqual(['左边', '另一个更新先到']);
    }, { discrete: true });
  });

  it('checks projected document bytes before attaching a replacement', () => {
    const editor = tableEditor();
    editor.update(() => {
      $cells()[1]![1]!.selectEnd();
      const data = [['测'.repeat(360_000)]];
      const target = $tablePasteTarget($getSelection())!;
      expect($applyTablePaste(target, data, $previewTablePaste(target, data)!)).toBe('limit');
      expect($cells()[1]![1]!.getTextContent()).toBe('右边');
    }, { discrete: true });
  });

  it('moves rows and columns with content and alignment while the first row remains the header', () => {
    const editor = tableEditor();
    editor.update(() => {
      $cells()[0]![1]!.selectEnd();
      $alignTableColumn('center');
      $moveTableLine('column', -1);
      $moveTableLine('row', 1);
      const cells = $cells();
      expect(cells.map(row => row.map(cell => cell.getTextContent()))).toEqual([['右边', '左边'], ['第二列', '第一列']]);
      expect(cells.map(row => row[0]!.getFormatType())).toEqual(['center', 'center']);
      expect(cells.map(row => row.map(cell => Boolean(cell.getHeaderStyles() & TableCellHeaderStates.ROW))))
        .toEqual([[true, true], [false, false]]);
    }, { discrete: true });
    expect(editor.read('latest', $createSnapshot).markdown).toContain('| :---: | --- |');
  });
});

it('offers an Excel TSV conversion before changing the editor and undoes it in one step', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } },
  });
  Object.defineProperties(Range.prototype, {
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    getClientRects: { configurable: true, value: () => [] },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef<DocumentEditorHandle>();
  const onChange = vi.fn();
  try {
    await act(() => root.render(<DocumentEditor ref={ref} documentId="tsv" initialMarkdown="" onChange={onChange} />));
    await act(() => ref.current!.focus());
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      getData: (type: string) => type === 'text/html' ? '<table><tr><td>中文</td><td> </td></tr></table>'
        : type === 'text/plain' ? '中文\t\r\n=1+1\t管|道' : '',
      files: [],
    } });
    await act(() => { host.querySelector('[aria-label="文档正文"]')!.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(host.querySelector('dialog')?.textContent).toContain('2 行 × 2 列');
    expect(host.querySelector('table')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    const create = [...host.querySelectorAll('dialog button')].find(button => button.textContent?.trim() === '创建表格') as HTMLButtonElement;
    await act(() => create.click());
    expect([...host.querySelectorAll('table th,table td')].map(cell => cell.textContent)).toEqual(['中文', '', '=1+1', '管|道']);
    expect(ref.current!.getSnapshot().markdown).toContain('管\\|道');
    const undo = host.querySelector('[aria-label="撤销"]') as HTMLButtonElement;
    await act(() => undo.click());
    expect(host.querySelector('table')).toBeNull();
    expect(ref.current!.getSnapshot().plainText).toBe('');
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
