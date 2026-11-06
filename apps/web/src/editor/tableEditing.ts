import { $generateNodesFromSerializedNodes } from '@lexical/clipboard';
import {
  $createTableCellNode, $createTableNode, $createTableRowNode, $getTableCellNodeFromLexicalNode,
  $isTableCellNode, $isTableNode, $isTableRowNode, $isTableSelection, TableCellHeaderStates,
} from '@lexical/table';
import type { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import {
  $addUpdateTag, $createParagraphNode, $createTextNode, $getNodeByKey, $getRoot, $getSelection,
  $isElementNode, $isParagraphNode, $isRangeSelection, $isRootNode, HISTORY_PUSH_TAG,
} from 'lexical';
import type { BaseSelection, LexicalNode, NodeKey, SerializedLexicalNode, SerializedRootNode } from 'lexical';
import { normalizeDocumentContent } from './normalize';

const maxRows = 100;
const maxColumns = 30;
// The serialized document must also fit the server's validation limits.
const maxContentBytes = 1024 * 1024;
const maxContentNodes = 20_000;
const maxContentDepth = 64;

export type TableAlignment = 'left' | 'center' | 'right';
type TableGrid = { table: TableNode; rows: TableRowNode[]; cells: TableCellNode[][] };

export type TablePasteTarget = { kind: 'paragraph'; key: NodeKey } | { kind: 'table'; key: NodeKey };
type TablePastePreview = { row: number; column: number; rows: number; columns: number; confirm: boolean; snapshot?: string };
type TablePasteResult = 'applied' | 'limit' | 'changed';

const unsafeMatrix = '无法安全解析矩形数据，已按纯文本粘贴。';
const matrixLimit = '矩形数据超出 100 行或 30 列，已按纯文本粘贴。';

export function parseTsv(text: string, fromTable = false): { rows: string[][] } | { warning: string } | null {
  if (!text.includes('\t') && !(fromTable && /[\r\n]/.test(text))) return null;
  if (text.length > maxContentBytes) return { warning: '矩形数据过大，已按纯文本粘贴。' };
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > maxRows) return { warning: matrixLimit };
  const rows = lines.map(line => line.split('\t'));
  const columns = rows[0]?.length ?? 0;
  if (rows.some(row => row.length > maxColumns)) return { warning: matrixLimit };
  if (!columns || rows.some(row => row.length !== columns)) return { warning: unsafeMatrix };
  // Excel quotes values containing delimiters or literal quotation marks.
  // Multiline and tab-containing cells are outside the ordinary GFM table format.
  for (const row of rows) {
    for (let column = 0; column < row.length; column++) {
      const cell = row[column]!;
      if (!cell.startsWith('"')) continue;
      if (!/^"(?:[^"]|"")*"$/.test(cell)) return { warning: unsafeMatrix };
      if (fromTable) row[column] = cell.slice(1, -1).replaceAll('""', '"');
    }
  }
  return { rows };
}

function $grid(table: TableNode): TableGrid | null {
  const rows = table.getChildren();
  if (!rows.length || !rows.every($isTableRowNode)) return null;
  const cells = rows.map(row => row.getChildren());
  const columns = cells[0]?.length ?? 0;
  if (!columns || !cells.every(row => row.length === columns
    && row.every(cell => $isTableCellNode(cell) && cell.getRowSpan() === 1 && cell.getColSpan() === 1))) return null;
  return { table, rows, cells: cells as TableCellNode[][] };
}

function $cellPosition(cell: TableCellNode) {
  const row = cell.getParent();
  const table = row?.getParent();
  if (!$isTableRowNode(row) || !$isTableNode(table)) return null;
  const grid = $grid(table);
  if (!grid) return null;
  return { grid, row: row.getIndexWithinParent(), column: cell.getIndexWithinParent() };
}

function $currentCell(selection: BaseSelection | null): TableCellNode | null {
  if (!$isRangeSelection(selection) && !$isTableSelection(selection)) return null;
  return $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
}

function $isEmptyTopLevelParagraph(node: LexicalNode | null): boolean {
  return $isParagraphNode(node) && $isRootNode(node.getParent()) && node.getChildrenSize() === 0;
}

export function $tablePasteTarget(selection: BaseSelection | null): TablePasteTarget | null {
  const cell = $currentCell(selection);
  if (cell) {
    // Leave a range crossing the table boundary on the ordinary paste path.
    if ($isRangeSelection(selection) && !selection.isCollapsed()) {
      const focusCell = $getTableCellNodeFromLexicalNode(selection.focus.getNode());
      if (focusCell?.getParent()?.getParent()?.getKey() !== cell.getParent()?.getParent()?.getKey()) return null;
    }
    return { kind: 'table', key: cell.getKey() };
  }
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const node = selection.anchor.getNode();
  if (!$isEmptyTopLevelParagraph(node)) return null;
  return { kind: 'paragraph', key: node.getKey() };
}

export function $previewTablePaste(target: TablePasteTarget, data: string[][]): TablePastePreview | null {
  const node = $getNodeByKey(target.key);
  const height = data.length;
  const width = data[0]!.length;
  if (target.kind === 'paragraph') {
    if (!node || !$isEmptyTopLevelParagraph(node)) return null;
    return { row: 0, column: 0, rows: height, columns: width, confirm: true, snapshot: $pasteSnapshot(node) };
  }
  const position = $isTableCellNode(node) ? $cellPosition(node) : null;
  if (!position) return null;
  const { grid, row, column } = position;
  const rows = Math.max(grid.rows.length, row + height);
  const columns = Math.max(grid.cells[0]!.length, column + width);
  const extendRows = rows > grid.rows.length;
  const extendColumns = columns > grid.cells[0]!.length;
  if ((extendRows && rows > maxRows) || (extendColumns && columns > maxColumns)) return null;
  const confirm = extendRows || extendColumns;
  return { row, column, rows, columns, confirm, ...(confirm ? { snapshot: $pasteSnapshot(grid.table) } : {}) };
}

function $pasteSnapshot(node: LexicalNode): string {
  return JSON.stringify([node.getKey(), $serialize(node)]);
}

export function $isCurrentTablePaste(target: TablePasteTarget, data: string[][], expected: TablePastePreview): boolean {
  const preview = $previewTablePaste(target, data);
  return preview !== null && preview.row === expected.row && preview.column === expected.column
    && preview.rows === expected.rows && preview.columns === expected.columns
    && preview.confirm === expected.confirm && preview.snapshot === expected.snapshot;
}

function $serialize(node: LexicalNode, original?: NodeKey, replacement?: TableNode): SerializedLexicalNode {
  if (node.getKey() === original && replacement) return $serialize(replacement);
  const json = node.exportJSON();
  return $isElementNode(node)
    ? { ...json, children: node.getChildren().map(child => $serialize(child, original, replacement)) } as SerializedLexicalNode
    : json;
}

function $fitsDocument(original: LexicalNode, replacement: TableNode): boolean {
  const content = normalizeDocumentContent({
    schemaVersion: 1,
    editorState: { root: $serialize($getRoot(), original.getKey(), replacement) as SerializedRootNode },
  });
  let count = 0;
  const fitsNodes = (node: unknown, depth: number): boolean => {
    if (++count > maxContentNodes || depth > maxContentDepth) return false;
    const children = (node as { children?: unknown[] }).children;
    return !children || children.every(child => fitsNodes(child, depth + 1));
  };
  return fitsNodes(content.editorState.root, 0)
    && new TextEncoder().encode(JSON.stringify(content)).byteLength <= maxContentBytes;
}

function $fillCell(cell: TableCellNode, value: string): void {
  const paragraph = $createParagraphNode();
  if (value) paragraph.append($createTextNode(value));
  cell.clear().append(paragraph);
}

function $normalizeRowHeaders(grid: TableGrid): void {
  grid.cells.forEach((row, index) => {
    for (const cell of row) {
      const state = index === 0 ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS;
      if ((cell.getHeaderStyles() & TableCellHeaderStates.ROW) !== state) {
        cell.setHeaderStyles(state, TableCellHeaderStates.ROW);
      }
    }
  });
}

function $fillTable(table: TableNode, data: string[][], preview: TablePastePreview): TableCellNode {
  const columns = table.getColWidths();
  if (columns && preview.columns > columns.length) {
    const defaultWidth = columns.at(-1) ?? 100;
    table.setColWidths([...columns, ...Array<number>(preview.columns - columns.length).fill(defaultWidth)]);
  }
  const firstRow = table.getFirstChild();
  const headers = $isTableRowNode(firstRow) ? firstRow.getChildren().filter($isTableCellNode) : [];
  const rows = table.getChildren().filter($isTableRowNode);
  for (let row = 0; row < preview.rows; row++) {
    const rowNode = rows[row] ?? $createTableRowNode();
    if (!rows[row]) table.append(rowNode);
    const cells = rowNode.getChildren().filter($isTableCellNode);
    for (let column = cells.length; column < preview.columns; column++) {
      const header = headers[column];
      const cell = $createTableCellNode((header?.getHeaderStyles() ?? 0) & TableCellHeaderStates.COLUMN);
      if (header) cell.setFormat(header.getFormatType());
      $fillCell(cell, '');
      rowNode.append(cell);
    }
  }
  const grid = $grid(table)!;
  $normalizeRowHeaders(grid);
  data.forEach((row, y) => row.forEach((value, x) => $fillCell(grid.cells[preview.row + y]![preview.column + x]!, value)));
  return grid.cells[preview.row]![preview.column]!;
}

export function $applyTablePaste(
  target: TablePasteTarget, data: string[][], expected: TablePastePreview,
): TablePasteResult {
  if (!$isCurrentTablePaste(target, data, expected)) return 'changed';
  const node = $getNodeByKey(target.key)!;
  const original = $isTableCellNode(node) ? $cellPosition(node)!.grid.table : node;
  // Prepare a detached replacement so an over-limit paste leaves existing content intact.
  const replacement = $isTableNode(original)
    ? $generateNodesFromSerializedNodes([$serialize(original)])[0]
    : $createTableNode();
  if (!$isTableNode(replacement)) return 'changed';
  const cell = $fillTable(replacement, data, expected);
  if (!$fitsDocument(original, replacement)) return 'limit';
  $addUpdateTag(HISTORY_PUSH_TAG);
  original.replace(replacement);
  cell.selectEnd();
  return 'applied';
}

export function $alignTableColumn(alignment: TableAlignment): void {
  const cell = $currentCell($getSelection());
  const position = cell ? $cellPosition(cell) : null;
  if (!position) return;
  const column = position.grid.cells.map(row => row[position.column]!);
  if (column.every(item => item.getFormatType() === alignment)) return;
  $addUpdateTag(HISTORY_PUSH_TAG);
  for (const item of column) item.setFormat(alignment);
}

export function $moveTableLine(axis: 'row' | 'column', direction: -1 | 1): void {
  const cell = $currentCell($getSelection());
  const position = cell ? $cellPosition(cell) : null;
  if (!position) return;
  const { grid, row, column } = position;
  const next = (axis === 'row' ? row : column) + direction;
  if (axis === 'row') {
    const other = grid.rows[next];
    if (!other) return;
    const current = grid.rows[row]!;
    $addUpdateTag(HISTORY_PUSH_TAG);
    if (direction === -1) other.insertBefore(current);
    else other.insertAfter(current);
    $normalizeRowHeaders($grid(grid.table)!);
  } else {
    if (!grid.cells[0]![next]) return;
    $addUpdateTag(HISTORY_PUSH_TAG);
    for (const cells of grid.cells) {
      if (direction === -1) cells[next]!.insertBefore(cells[column]!);
      else cells[next]!.insertAfter(cells[column]!);
    }
    const widths = grid.table.getColWidths();
    if (widths?.length === grid.cells[0]!.length) {
      const reordered = [...widths];
      [reordered[column], reordered[next]] = [reordered[next]!, reordered[column]!];
      grid.table.setColWidths(reordered);
    }
  }
}
