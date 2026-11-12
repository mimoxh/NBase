import { $alignTableColumn, $moveTableLine, type TableAlignment } from '../tableEditing';
import { $mergeSelectedCells, $splitSelectedCell } from '../tableLayout';

type Props = { edit: (action: () => void) => void; canMerge: boolean; canSplit: boolean; merged: boolean; onNotice?: ((message: string) => void) | undefined };

export function TableActions({ edit, canMerge, canSplit, merged, onNotice }: Props) {
  const tool = (label: string, disabled: boolean, action: () => void) => <button type="button" title={label} aria-label={label}
    disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => edit(action)}>{label}</button>;
  return <>
    {tool('合并单元格', !canMerge, $mergeSelectedCells)}
    {tool('拆分单元格', !canSplit, $splitSelectedCell)}
    <select aria-label="列对齐" defaultValue="" onChange={event => {
      const alignment = event.target.value as TableAlignment;
      event.target.value = '';
      edit(() => $alignTableColumn(alignment));
    }}>
      <option value="" disabled>列对齐</option>
      <option value="left">左对齐</option>
      <option value="center">居中</option>
      <option value="right">右对齐</option>
    </select>
    <select aria-label="移动行列" defaultValue="" onChange={event => {
      const [axis, direction] = event.target.value.split(':') as ['row' | 'column', '-1' | '1'];
      event.target.value = '';
      if (merged) { onNotice?.('含合并单元格的表格不能整行或整列移动，请先拆分。'); return; }
      edit(() => { $moveTableLine(axis, direction === '-1' ? -1 : 1); });
    }}>
      <option value="" disabled>移动行列</option>
      <option value="row:-1">上移行</option>
      <option value="row:1">下移行</option>
      <option value="column:-1">左移列</option>
      <option value="column:1">右移列</option>
    </select>
  </>;
}
