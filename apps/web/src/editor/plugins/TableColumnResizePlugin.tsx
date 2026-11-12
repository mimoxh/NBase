import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getTableCellNodeFromLexicalNode, $getTableNodeFromLexicalNodeOrThrow, $isTableCellNode, $isTableNode } from '@lexical/table';
import { $getNearestNodeFromDOMNode, $getNodeByKey, HISTORY_PUSH_TAG } from 'lexical';
import { $setColumnWidth, $tableGrid, maxColumnWidth, minColumnWidth } from '../tableLayout';

const edge = 6;

type Drag = { table: HTMLTableElement; key: string; column: number; startX: number; startWidth: number; measured: number[] };

/** The column's right border index and current pixel widths, read from the rendered grid. */
function measure(editor: ReturnType<typeof useLexicalComposerContext>[0], cell: HTMLTableCellElement) {
  return editor.read('latest', () => {
    const node = $getNearestNodeFromDOMNode(cell);
    const cellNode = node && ($isTableCellNode(node) ? node : $getTableCellNodeFromLexicalNode(node));
    if (!cellNode) return null;
    const table = $getTableNodeFromLexicalNodeOrThrow(cellNode);
    const grid = $tableGrid(table);
    const start = grid.flat().find(entry => entry.cell.is(cellNode))?.column;
    if (start === undefined) return null;
    const column = start + cellNode.getColSpan() - 1;
    // A column's width is read from a cell that occupies exactly that column.
    const measured = grid[0]!.map((_, index) => {
      const single = grid.flat().find(entry => entry.column === index && entry.cell.getColSpan() === 1);
      const element = single && editor.getElementByKey(single.cell.getKey());
      return element?.getBoundingClientRect().width ?? 120;
    });
    return { key: table.getKey(), column, measured, stored: table.getColWidths() };
  });
}

/** Drag a cell's right border to set its column width; one undo step per drag. */
export function TableColumnResizePlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let drag: Drag | null = null;
    let hover: HTMLTableCellElement | null = null;
    const cellAtEdge = (event: PointerEvent) => {
      const cell = (event.target as Element | null)?.closest?.('td,th') as HTMLTableCellElement | null;
      if (!cell || !editor.isEditable()) return null;
      const rect = cell.getBoundingClientRect();
      return rect.right - event.clientX <= edge && rect.right - event.clientX >= -2 ? cell : null;
    };
    const setHover = (cell: HTMLTableCellElement | null) => {
      if (hover === cell) return;
      hover?.classList.remove('nbase-col-resize-hover');
      hover = cell;
      hover?.classList.add('nbase-col-resize-hover');
    };
    const columnElements = (table: HTMLTableElement) => [...table.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col')];
    const onHover = (event: PointerEvent) => { if (!drag) setHover(cellAtEdge(event)); };
    const onMove = (event: PointerEvent) => {
      if (!drag) return;
      const width = Math.round(Math.min(maxColumnWidth, Math.max(minColumnWidth, drag.startWidth + event.clientX - drag.startX)));
      const col = columnElements(drag.table)[drag.column];
      // Preview in the DOM only; the document changes once, on release.
      if (col) col.style.width = width + 'px';
    };
    const onUp = (event: PointerEvent) => {
      if (!drag) return;
      const current = drag;
      drag = null;
      document.body.classList.remove('nbase-col-resizing');
      const width = current.startWidth + event.clientX - current.startX;
      if (Math.abs(event.clientX - current.startX) < 2) return;
      editor.update(() => {
        const table = $getNodeByKey(current.key);
        if ($isTableNode(table)) $setColumnWidth(table, current.column, width, current.measured);
      }, { tag: HISTORY_PUSH_TAG });
    };
    const onDown = (event: PointerEvent) => {
      const cell = event.button === 0 ? cellAtEdge(event) : null;
      const table = cell?.closest('table');
      if (!cell || !table) return;
      const info = measure(editor, cell);
      if (!info) return;
      event.preventDefault();
      event.stopPropagation();
      drag = { table, key: info.key, column: info.column, startX: event.clientX,
        startWidth: info.stored?.[info.column] ?? info.measured[info.column] ?? 120, measured: info.measured };
      document.body.classList.add('nbase-col-resizing');
    };
    const stopRoot = editor.registerRootListener((root, previous) => {
      previous?.removeEventListener('pointermove', onHover);
      previous?.removeEventListener('pointerdown', onDown, true);
      root?.addEventListener('pointermove', onHover);
      root?.addEventListener('pointerdown', onDown, true);
    });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      stopRoot();
      setHover(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [editor]);
  return null;
}
