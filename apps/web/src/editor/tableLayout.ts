import {
  $computeTableMapSkipCellCheck, $getTableCellNodeFromLexicalNode, $isTableCellNode, $isTableNode, $isTableRowNode,
  $isTableSelection, $mergeCells, $unmergeCellNode, TableCellNode, TableNode,
} from '@lexical/table';
import { $addUpdateTag, $getSelection, $isRangeSelection, HISTORY_PUSH_TAG } from 'lexical';

/** Shared with the server validator: spans and widths stay small, finite integers. */
export const maxTableSpan = 64;
export const minColumnWidth = 40;
export const maxColumnWidth = 2000;

export interface TableLayout { widths: number[] | null; spans: { row: number; column: number; colSpan: number; rowSpan: number }[] }

/** Grid positions; a merged cell appears at every position it covers. */
export function $tableGrid(table: TableNode): { cell: TableCellNode; row: number; column: number }[][] {
  const [map] = $computeTableMapSkipCellCheck(table, null, null);
  return map.map(row => row.map(entry => ({ cell: entry.cell, row: entry.startRow, column: entry.startColumn })));
}

export function $hasMergedCells(table: TableNode): boolean {
  return table.getChildren().some(row => $isTableRowNode(row)
    && row.getChildren().some(cell => $isTableCellNode(cell) && (cell.getColSpan() > 1 || cell.getRowSpan() > 1)));
}

/** `<!-- nbase-table widths="…" spans="r.c=wxh,…" -->`, or '' for a plain GFM table. */
export function $tableLayoutComment(table: TableNode): string {
  const widths = table.getColWidths();
  const spans: string[] = [];
  $tableGrid(table).forEach((cells, row) => cells.forEach((entry, column) => {
    const { cell } = entry;
    if (entry.row === row && entry.column === column && (cell.getColSpan() > 1 || cell.getRowSpan() > 1)) {
      spans.push(`${row}.${column}=${cell.getColSpan()}x${cell.getRowSpan()}`);
    }
  }));
  if (!widths?.length && !spans.length) return '';
  return '<!-- nbase-table' + (widths?.length ? ` widths="${widths.join(',')}"` : '') + (spans.length ? ` spans="${spans.join(',')}"` : '') + ' -->';
}

const commentPattern = /^<!-- nbase-table(?: widths="(\d{1,4}(?:,\d{1,4}){0,63})")?(?: spans="(\d{1,3}\.\d{1,3}=\d{1,2}x\d{1,2}(?:,\d{1,3}\.\d{1,3}=\d{1,2}x\d{1,2}){0,499})")? -->$/;

export function parseTableLayoutComment(line: string): TableLayout | null {
  const match = commentPattern.exec(line.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const widths = match[1] ? match[1].split(',').map(Number) : null;
  if (widths?.some(width => width < minColumnWidth || width > maxColumnWidth)) return null;
  const spans = (match[2] ? match[2].split(',') : []).map(item => {
    const [, row, column, colSpan, rowSpan] = /^(\d+)\.(\d+)=(\d+)x(\d+)$/.exec(item)!.map(Number);
    return { row: row!, column: column!, colSpan: colSpan!, rowSpan: rowSpan! };
  });
  if (spans.some(span => span.colSpan < 1 || span.rowSpan < 1 || span.colSpan * span.rowSpan < 2
    || span.colSpan > maxTableSpan || span.rowSpan > maxTableSpan)) return null;
  return { widths, spans };
}

/**
 * Applies an imported layout to a plain grid table. Every covered position must be an empty cell
 * and spans must not overlap; false leaves the document to be kept as source.
 */
export function $applyTableLayout(table: TableNode, layout: TableLayout): boolean {
  const rows = table.getChildren().filter($isTableRowNode).map(row => row.getChildren().filter($isTableCellNode));
  const columns = rows[0]?.length ?? 0;
  if (!columns || rows.some(row => row.length !== columns)) return false;
  if (layout.widths && layout.widths.length !== columns) return false;
  const covered = new Set<string>();
  for (const span of layout.spans) {
    if (span.row + span.rowSpan > rows.length || span.column + span.colSpan > columns) return false;
    for (let row = span.row; row < span.row + span.rowSpan; row++) {
      for (let column = span.column; column < span.column + span.colSpan; column++) {
        const key = row + '.' + column;
        if (covered.has(key)) return false;
        covered.add(key);
        if ((row !== span.row || column !== span.column) && rows[row]![column]!.getTextContent() !== '') return false;
      }
    }
  }
  for (const span of layout.spans) {
    const anchor = rows[span.row]![span.column]!;
    anchor.setColSpan(span.colSpan).setRowSpan(span.rowSpan);
    for (let row = span.row; row < span.row + span.rowSpan; row++) {
      for (let column = span.column; column < span.column + span.colSpan; column++) {
        if (row !== span.row || column !== span.column) rows[row]![column]!.remove();
      }
    }
  }
  if (layout.widths) table.setColWidths(layout.widths);
  return true;
}

function $selectedCells(): TableCellNode[] {
  const selection = $getSelection();
  return $isTableSelection(selection) ? selection.getNodes().filter($isTableCellNode) : [];
}

export function $canMergeSelection(): boolean {
  const cells = $selectedCells();
  return cells.length > 1 && new Set(cells.map(cell => cell.getParent()?.getParent()?.getKey())).size === 1;
}

export function $canSplitSelection(): boolean {
  const selection = $getSelection();
  const cell = $isRangeSelection(selection) ? $getTableCellNodeFromLexicalNode(selection.anchor.getNode()) : null;
  return Boolean(cell && (cell.getColSpan() > 1 || cell.getRowSpan() > 1));
}

export function $mergeSelectedCells(): void {
  if (!$canMergeSelection()) return;
  $addUpdateTag(HISTORY_PUSH_TAG);
  $mergeCells($selectedCells())?.selectEnd();
}

export function $splitSelectedCell(): void {
  const selection = $getSelection();
  const cell = $isRangeSelection(selection) ? $getTableCellNodeFromLexicalNode(selection.anchor.getNode()) : null;
  if (!cell || (cell.getColSpan() === 1 && cell.getRowSpan() === 1)) return;
  $addUpdateTag(HISTORY_PUSH_TAG);
  $unmergeCellNode(cell);
}

/** Sets one column's width; columns without a stored width take the measured fallback. */
export function $setColumnWidth(table: TableNode, column: number, width: number, measured: number[]): void {
  if (!$isTableNode(table)) return;
  const current = table.getColWidths();
  const widths = measured.map((value, index) => Math.round(current?.[index] ?? value));
  if (column >= widths.length) return;
  widths[column] = Math.round(Math.min(maxColumnWidth, Math.max(minColumnWidth, width)));
  table.setColWidths(widths.map(value => Math.min(maxColumnWidth, Math.max(minColumnWidth, value))));
}
