import { useMemo, useRef, useState } from 'react';
import { activeProperties, databaseRowLimit, type PropertyDefinition } from '@nbase/contracts';
import { Modal } from '../../components/Modal';
import { typeLabels } from '../labels';
import type { RowStore } from '../rowStore';
import type { DatabaseState } from '../source';
import { decodeCsv, parseCsv } from './csv';
import { guessTarget, importableTypes, planImport, type ColumnTarget, type ImportPlan } from './plan';

const maxBytes = 30 * 1024 * 1024;
const previewRows = 5;

type Run = { plan: ImportPlan; mutationIds: string[]; done: number };

function encodeTarget(target: ColumnTarget): string {
  return target.kind === 'skip' ? 'skip' : target.kind === 'field' ? `field:${target.id}` : `new:${target.type}`;
}

function decodeTarget(value: string): ColumnTarget {
  if (value === 'skip') return { kind: 'skip' };
  const [kind, rest] = value.split(':') as [string, string];
  return kind === 'field' ? { kind: 'field', id: rest } : { kind: 'new', type: rest as ColumnTarget extends { type: infer T } ? T : never };
}

/** CSV import: choose a file, map its columns, then send fixed chunks that can be resumed after a failure. */
export default function ImportDialog({ store, state, properties, onClose }: {
  store: RowStore; state: DatabaseState; properties: PropertyDefinition[]; onClose: () => void;
}) {
  const [file, setFile] = useState<{ name: string; headers: string[]; rows: string[][] } | null>(null);
  const [targets, setTargets] = useState<ColumnTarget[]>([]);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fields = useMemo(() => activeProperties(properties).filter(p => !['created_time', 'updated_time', 'relation'].includes(p.type)), [properties]);

  const pick = async (selected: File | undefined) => {
    if (!selected) return;
    setProblem('');
    if (selected.size > maxBytes) { setProblem('文件超过 30 MB。'); return; }
    setBusy(true);
    try {
      const parsed = await parseCsv(decodeCsv(await selected.arrayBuffer()));
      const [headers, ...rows] = parsed;
      if (!headers || !rows.length) { setProblem('文件里没有可导入的行。第一行应为列名。'); return; }
      if (rows.length + store.allRows > databaseRowLimit) { setProblem(`导入后将超过每个数据库 ${databaseRowLimit} 行的上限。`); return; }
      const firstGuess = headers.map(header => guessTarget(header, properties));
      // Without a column named like the title field, the first column becomes the title.
      const title = fields.find(p => p.type === 'title')!;
      if (!firstGuess.some(target => target.kind === 'field' && target.id === title.id)) firstGuess[0] = { kind: 'field', id: title.id };
      setFile({ name: selected.name, headers, rows });
      setTargets(firstGuess);
    } catch { setProblem('文件无法读取，请确认它是 CSV。'); } finally { setBusy(false); }
  };

  const usedFields = targets.flatMap(target => target.kind === 'field' ? [target.id] : []);
  const duplicated = new Set(usedFields).size !== usedFields.length;
  const plan = useMemo(() => file ? planImport(file.rows, file.headers, targets, properties) : null, [file, targets, properties]);

  const send = async (current: Run) => {
    setBusy(true);
    setProblem('');
    try {
      const done = await store.importChunks(current.plan.chunks, current.mutationIds, current.done, value => setRun({ ...current, done: value }));
      if (done === current.plan.chunks.length) {
        setRun(null);
        const skipped = current.plan.invalidCells;
        setFinished(`已导入 ${current.plan.rowCount} 行。${skipped ? `${skipped} 个单元格不符合字段类型，已留空。` : ''}`);
      } else {
        setRun({ ...current, done });
        setProblem('导入中断，已完成的部分不会重复。可以继续导入。');
      }
    } finally { setBusy(false); }
  };

  const start = async () => {
    if (!plan) return;
    setBusy(true);
    if (plan.properties) {
      const saved = await state.saveSchema({ properties: plan.properties, views: state.doc!.views });
      if (!saved) { setBusy(false); setProblem('字段或选项没有保存，未开始导入。'); return; }
    }
    const next: Run = { plan, mutationIds: plan.chunks.map(() => crypto.randomUUID()), done: 0 };
    setRun(next);
    await send(next);
  };

  const closeable = !busy;
  return <Modal title="导入 CSV" wide onClose={() => { if (closeable) onClose(); }}>
    {finished ? <>
      <p className="dialog-description">{finished}</p>
      <div className="dialog-actions"><button className="nb-btn nb-btn-primary" onClick={onClose}>完成</button></div>
    </> : !file ? <>
      <p className="dialog-description">第一行作为列名。支持 UTF-8 和 GBK，文件不超过 30 MB。</p>
      <input ref={inputRef} type="file" accept=".csv,.tsv,text/csv" aria-label="选择 CSV 文件" disabled={busy} onChange={event => void pick(event.target.files?.[0])} />
      {busy && <p className="dialog-description">正在读取…</p>}
    </> : <>
      <p className="dialog-description">{file.name}：{file.rows.length} 行。把每一列对应到字段，新字段会在导入前创建。</p>
      <div className="nb-db-import">
        <table className="nb-db-import-table"><thead><tr>{file.headers.map((header, column) => <th key={column}>
          <div className="nb-db-import-head">{header || `列 ${column + 1}`}</div>
          <select className="nb-db-select" aria-label={`列「${header}」对应的字段`} disabled={!!run} value={encodeTarget(targets[column]!)}
            onChange={event => setTargets(targets.map((target, index) => index === column ? decodeTarget(event.target.value) : target))}>
            <option value="skip">不导入</option>
            <optgroup label="现有字段">{fields.map(p => <option key={p.id} value={`field:${p.id}`}>{p.name}</option>)}</optgroup>
            <optgroup label="新建字段">{importableTypes.map(type => <option key={type} value={`new:${type}`}>{typeLabels[type]}</option>)}</optgroup>
          </select>
        </th>)}</tr></thead>
        <tbody>{file.rows.slice(0, previewRows).map((row, index) => <tr key={index}>{file.headers.map((_, column) => <td key={column}>{row[column] ?? ''}</td>)}</tr>)}</tbody></table>
      </div>
      {duplicated && <p className="nb-db-invalid-note" role="alert">同一个字段被多列使用，后面的列会覆盖前面的。</p>}
      {plan && plan.invalidCells > 0 && <p className="nb-db-invalid-note">{plan.invalidCells} 个单元格不符合字段类型，将留空。</p>}
      {problem && <p className="nb-db-invalid-note" role="alert">{problem}</p>}
      {run && <p className="dialog-description" role="status">已完成 {run.plan.chunks.slice(0, run.done).reduce((sum, chunk) => sum + chunk.length, 0)} / {run.plan.rowCount} 行</p>}
      <div className="dialog-actions">
        <button className="nb-btn" disabled={busy} onClick={onClose}>{run ? '放弃未导入的部分' : '取消'}</button>
        {run ? <button className="nb-btn nb-btn-primary" disabled={busy} onClick={() => void send(run)}>继续导入</button>
          : <button className="nb-btn nb-btn-primary" disabled={busy} onClick={() => void start()}>导入 {file.rows.length} 行</button>}
      </div>
    </>}
    {!file && problem && <p className="nb-db-invalid-note" role="alert">{problem}</p>}
  </Modal>;
}
