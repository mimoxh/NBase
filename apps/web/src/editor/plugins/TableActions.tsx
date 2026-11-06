import { $alignTableColumn, $moveTableLine, type TableAlignment } from '../tableEditing';

export function TableActions({ edit }: { edit: (action: () => void) => void }) {
  return <>
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
      edit(() => $moveTableLine(axis, direction === '-1' ? -1 : 1));
    }}>
      <option value="" disabled>移动行列</option>
      <option value="row:-1">上移行</option>
      <option value="row:1">下移行</option>
      <option value="column:-1">左移列</option>
      <option value="column:1">右移列</option>
    </select>
  </>;
}
