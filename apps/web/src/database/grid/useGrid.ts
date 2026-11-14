import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type CompositionEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { isComputedProperty, type BulkRowPatch, type DatabaseRow, type PropertyDefinition, type PropertyValue } from '@nbase/contracts';
import { setCellEditSeed, type CellNavigation } from '../cells';
import type { RowStore } from '../rowStore';
import { cellClipboardText, parseCellText, parseTsv, toTsv } from './clipboard';
import { rowHeight } from './useWindowedRows';

export interface GridPoint { row: number; col: number }
export interface GridRange { top: number; bottom: number; left: number; right: number }

function rangeOf(anchor: GridPoint, focus: GridPoint): GridRange {
  return { top: Math.min(anchor.row, focus.row), bottom: Math.max(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col), right: Math.max(anchor.col, focus.col) };
}

function isReadOnly(def: PropertyDefinition): boolean {
  return def.type === 'created_time' || def.type === 'updated_time' || isComputedProperty(def);
}

/** Cells that take a value by paste or clear; a relation changes only through its picker. */
function acceptsValue(def: PropertyDefinition): boolean {
  return !isReadOnly(def) && def.type !== 'relation' && def.type !== 'tags';
}

/** Spreadsheet-style cursor and range. Keys, IME text and clipboard all land in one hidden input that follows the cursor. */
export function useGrid({ store, columns, rowCount, canWrite, notice, rootRef, bodyRef }: {
  store: RowStore; columns: PropertyDefinition[]; rowCount: number; canWrite: boolean; notice: (text: string) => void;
  rootRef: RefObject<HTMLDivElement | null>; bodyRef: RefObject<HTMLTableSectionElement | null>;
}) {
  const [focus, setFocus] = useState<GridPoint | null>(null);
  const [anchor, setAnchor] = useState<GridPoint | null>(null);
  const sinkRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const dragging = useRef(false);
  const dragged = useRef(false);
  const range = focus && anchor ? rangeOf(anchor, focus) : null;

  const cellElement = useCallback((point: GridPoint) =>
    rootRef.current?.querySelector<HTMLTableCellElement>(`td[data-r="${point.row}"][data-c="${point.col}"]`) ?? null, [rootRef]);

  const refocus = useCallback(() => { sinkRef.current?.focus({ preventScroll: true }); }, []);

  const scrollIntoView = useCallback((point: GridPoint) => {
    const body = bodyRef.current;
    const scroller = body?.closest<HTMLElement>('.nb-scroll');
    if (!body || !scroller) return;
    const top = body.getBoundingClientRect().top + point.row * rowHeight;
    const view = scroller.getBoundingClientRect();
    if (top < view.top + rowHeight) scroller.scrollTop -= view.top + rowHeight - top;
    else if (top + rowHeight > view.bottom) scroller.scrollTop += top + rowHeight - view.bottom;
    cellElement(point)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [bodyRef, cellElement]);

  const moveTo = useCallback((next: GridPoint, extend = false) => {
    const point = { row: Math.max(0, Math.min(rowCount - 1, next.row)), col: Math.max(0, Math.min(columns.length - 1, next.col)) };
    setFocus(point);
    if (!extend) setAnchor(point);
    scrollIntoView(point);
  }, [columns.length, rowCount, scrollIntoView]);

  // The hidden input sits on the cursor cell so an IME candidate window opens in the right place.
  useLayoutEffect(() => {
    const sink = sinkRef.current;
    if (!sink || !focus) return;
    const cell = cellElement(focus);
    if (cell) { sink.style.left = `${cell.offsetLeft}px`; sink.style.top = `${cell.offsetTop}px`; }
  }, [focus, cellElement]);

  useEffect(() => {
    const stop = () => { dragging.current = false; };
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, []);

  const startEdit = useCallback((seed?: string) => {
    if (!focus || !canWrite) return;
    const def = columns[focus.col];
    if (!def || isReadOnly(def)) return;
    if (def.type === 'checkbox' && seed !== undefined) return;
    if (seed !== undefined) setCellEditSeed(seed);
    cellElement(focus)?.querySelector<HTMLElement>('.nb-db-cell-button')?.click();
  }, [canWrite, cellElement, columns, focus]);

  const navigate = useCallback((direction: CellNavigation) => {
    refocus();
    if (!focus) return;
    if (direction === 'down') moveTo({ row: focus.row + 1, col: focus.col });
    if (direction === 'right') moveTo({ row: focus.row, col: focus.col + 1 });
    if (direction === 'left') moveTo({ row: focus.row, col: focus.col - 1 });
  }, [focus, moveTo, refocus]);

  const editableColumns = (from: number, to: number) => columns.slice(from, to + 1);

  const writeCells = useCallback((cells: { row: number; col: number; value: PropertyValue | null }[]) => {
    const byRow = new Map<string, BulkRowPatch>();
    for (const { row, col, value } of cells) {
      const id = store.order[row];
      const def = columns[col];
      if (!id || !def) continue;
      const patch = byRow.get(id) ?? { id };
      if (def.type === 'title') patch.title = typeof value === 'string' ? value.slice(0, 255) : '';
      else patch.properties = { ...(patch.properties ?? {}), [def.id]: value };
      byRow.set(id, patch);
    }
    if (byRow.size) void store.patchRows([...byRow.values()]);
  }, [columns, store]);

  const clearRange = useCallback(() => {
    if (!range || !canWrite) return;
    const cells: { row: number; col: number; value: null }[] = [];
    for (let row = range.top; row <= range.bottom; row += 1) {
      editableColumns(range.left, range.right).forEach((def, offset) => {
        if (acceptsValue(def)) cells.push({ row, col: range.left + offset, value: null });
      });
    }
    writeCells(cells);
  }, [canWrite, range, writeCells]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyRange = useCallback((event: ClipboardEvent<HTMLInputElement>) => {
    if (!range) return false;
    event.preventDefault();
    const grid: string[][] = [];
    let missing = 0;
    for (let index = range.top; index <= range.bottom; index += 1) {
      const row: DatabaseRow | undefined = store.rowAt(index);
      if (!row) { missing += 1; continue; }
      grid.push(editableColumns(range.left, range.right).map(def => cellClipboardText(row, def)));
    }
    event.clipboardData.setData('text/plain', toTsv(grid));
    if (missing) notice(`选区里有 ${missing} 行还没有载入，这些行没有复制。`);
    return true;
  }, [notice, range, store]); // eslint-disable-line react-hooks/exhaustive-deps

  const paste = useCallback((event: ClipboardEvent<HTMLInputElement>) => {
    if (!range || !canWrite) return;
    event.preventDefault();
    const data = parseTsv(event.clipboardData.getData('text/plain'));
    const single = data.length === 1 && data[0]!.length === 1;
    const rows = single ? range.bottom - range.top + 1 : data.length;
    const cols = single ? range.right - range.left + 1 : Math.max(...data.map(row => row.length));
    const cells: { row: number; col: number; value: PropertyValue | null }[] = [];
    let invalid = 0;
    let clipped = 0;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const text = single ? data[0]![0]! : data[y]?.[x];
        if (text === undefined) continue;
        const row = range.top + y;
        const col = range.left + x;
        const def = columns[col];
        if (row >= rowCount || !def) { clipped += 1; continue; }
        if (!acceptsValue(def)) { invalid += 1; continue; }
        if (def.type === 'title') { cells.push({ row, col, value: text }); continue; }
        const parsed = parseCellText(def, text);
        if (parsed.ok) cells.push({ row, col, value: parsed.value }); else invalid += 1;
      }
    }
    writeCells(cells);
    if (invalid || clipped) {
      notice([invalid ? `${invalid} 个单元格不符合字段类型，已跳过。` : '', clipped ? `${clipped} 个单元格超出表格范围，已忽略。` : ''].join(''));
    }
  }, [canWrite, columns, notice, range, rowCount, writeCells]);

  const sinkKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || !focus) return;
    const extend = event.shiftKey;
    const mod = event.ctrlKey || event.metaKey;
    const go = (next: GridPoint) => { event.preventDefault(); moveTo(next, extend); };
    switch (event.key) {
      case 'ArrowUp': return go({ row: mod ? 0 : focus.row - 1, col: focus.col });
      case 'ArrowDown': return go({ row: mod ? rowCount - 1 : focus.row + 1, col: focus.col });
      case 'ArrowLeft': return go({ row: focus.row, col: mod ? 0 : focus.col - 1 });
      case 'ArrowRight': return go({ row: focus.row, col: mod ? columns.length - 1 : focus.col + 1 });
      case 'Home': return go({ row: mod ? 0 : focus.row, col: 0 });
      case 'End': return go({ row: mod ? rowCount - 1 : focus.row, col: columns.length - 1 });
      case 'PageUp': return go({ row: focus.row - 20, col: focus.col });
      case 'PageDown': return go({ row: focus.row + 20, col: focus.col });
      case 'Tab':
        event.preventDefault();
        if (extend) moveTo(focus.col > 0 ? { row: focus.row, col: focus.col - 1 } : { row: focus.row - 1, col: columns.length - 1 });
        else moveTo(focus.col < columns.length - 1 ? { row: focus.row, col: focus.col + 1 } : { row: focus.row + 1, col: 0 });
        return;
      case 'Enter': case 'F2': event.preventDefault(); return startEdit();
      case ' ':
        if (columns[focus.col]?.type === 'checkbox') { event.preventDefault(); startEdit(); }
        return;
      case 'Escape': event.preventDefault(); setAnchor(focus); return;
      case 'Delete': case 'Backspace': event.preventDefault(); clearRange(); return;
      default: break;
    }
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setAnchor({ row: 0, col: 0 });
      setFocus({ row: rowCount - 1, col: columns.length - 1 });
      return;
    }
    // Browsers only raise copy from an input that has a selection.
    if (mod && ['c', 'x'].includes(event.key.toLowerCase())) {
      const sink = event.currentTarget;
      sink.value = '​';
      sink.select();
    }
  };

  const consume = (text: string) => { if (sinkRef.current) sinkRef.current.value = ''; if (text) startEdit(text); };

  const sinkProps = {
    onKeyDown: sinkKeyDown,
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => { composing.current = false; consume(event.data); },
    onInput: (event: FormEvent<HTMLInputElement>) => { if (!composing.current) consume(event.currentTarget.value.replace('​', '')); },
    onCopy: (event: ClipboardEvent<HTMLInputElement>) => { copyRange(event); event.currentTarget.value = ''; },
    onCut: (event: ClipboardEvent<HTMLInputElement>) => { if (copyRange(event)) clearRange(); event.currentTarget.value = ''; },
    onPaste: paste,
  };

  const cellMouseDown = (event: MouseEvent, point: GridPoint) => {
    dragged.current = false;
    const target = event.target as Element;
    // Editors and portaled pickers keep their own focus; React bubbles portal events here too.
    if (event.button !== 0 || !event.currentTarget.contains(target) || target.closest('input, select, textarea')) return;
    if (event.shiftKey && anchor) { setFocus(point); event.preventDefault(); refocus(); dragged.current = true; return; }
    dragging.current = true;
    setFocus(point);
    setAnchor(point);
    // After the browser has focused whatever was pressed; a cell editor opened by the click then takes focus back.
    setTimeout(refocus, 0);
  };

  const cellMouseEnter = (event: MouseEvent, point: GridPoint) => {
    if (!dragging.current || event.buttons !== 1) return;
    dragged.current = true;
    setFocus(point);
  };

  /** Ends a drag across cells without also opening the cell it stopped on. */
  const clickCapture = (event: MouseEvent) => {
    if (!dragged.current) return;
    dragged.current = false;
    event.stopPropagation();
    event.preventDefault();
    refocus();
  };

  return { focus, range, sinkRef, sinkProps, cellMouseDown, cellMouseEnter, clickCapture, navigate, refocus };
}
