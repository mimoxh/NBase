import { useCallback, useEffect, useState } from 'react';
import type { CalendarConflictChoice, CalendarConflictKind, CalendarEventSnapshot, CalendarSyncConflict, CalendarSyncSource } from '@nbase/contracts';
import { DateText } from '../calendar/DateText';
import { Modal } from '../components/Modal';
import { ApiError } from '../persistence/client';
import type { CalendarSyncApi } from './source';
import { requestErrorText, timeText } from './syncText';

const kindText: Record<CalendarConflictKind, string> = {
  'both-changed': 'NBase 和外部日历都修改了这个日程',
  'remote-deleted': '外部已删除，NBase 中有修改',
  'local-deleted': 'NBase 中已删除，外部有修改',
};

const kindHint: Partial<Record<CalendarConflictKind, string>> = {
  'both-changed': '两份都保留时，外部版本的副本会成为外部日历的一个新日程。',
  'remote-deleted': '保留外部版本会把这一行移入回收站，可以在回收站恢复。',
  'local-deleted': '保留 NBase 版本会同时删除外部日历中的这个日程。',
};

const fields: { key: keyof CalendarEventSnapshot; label: string }[] = [
  { key: 'title', label: '标题' }, { key: 'value', label: '时间' }, { key: 'location', label: '地点' }, { key: 'description', label: '说明' },
];

function Side({ label, snapshot, other, missing, timeZone }: {
  label: string; snapshot: CalendarEventSnapshot | null; other: CalendarEventSnapshot | null; missing: string; timeZone: string | undefined;
}) {
  return <div className="nb-wcal-conflict-side">
    <h4>{label}</h4>
    {snapshot ? <dl>
      {fields.map(({ key, label: name }) => {
        const value = snapshot[key];
        const differs = !!other && other[key] !== value;
        return <div key={key} className={differs ? 'nb-wcal-conflict-diff' : undefined}>
          <dt>{name}</dt>
          <dd className={key === 'description' ? 'nb-wcal-conflict-desc' : undefined}>
            {!value ? <span className="nb-wcal-muted">无</span> : key === 'value' ? <DateText value={value} {...(timeZone ? { timeZone } : {})} /> : value}
          </dd>
        </div>;
      })}
    </dl> : <p className="nb-wcal-conflict-missing">{missing}</p>}
  </div>;
}

/** Open conflicts of one CalDAV source, both versions side by side, with a choice per conflict. */
export function ConflictDialog({ api, source, timeZone, onOpenRow, onResolved, onClose }: {
  api: CalendarSyncApi;
  source: CalendarSyncSource;
  timeZone?: string | undefined;
  onOpenRow?: ((rowId: string) => void) | undefined;
  onResolved: (source: CalendarSyncSource) => void;
  onClose: () => void;
}) {
  const [conflicts, setConflicts] = useState<CalendarSyncConflict[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    try { setConflicts((await api.conflicts(source.id)).conflicts); setLoadError(''); }
    catch (failure) { setLoadError(requestErrorText(failure, '暂时无法读取冲突列表，请重试。')); }
  }, [api, source.id]);
  useEffect(() => { void load(); }, [load]);

  const resolve = async (conflict: CalendarSyncConflict, choice: CalendarConflictChoice) => {
    if (busy) return;
    setBusy(conflict.rowId); setError(''); setStatus('');
    try {
      const response = await api.resolveConflict(source.id, conflict.rowId, choice);
      setStatus('已处理，正在同步到外部日历。');
      onResolved(response.source);
      await load();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) {
        setStatus('这个冲突已经处理过了。');
        await load();
      } else setError(requestErrorText(failure));
    } finally { setBusy(null); }
  };

  return <Modal title={`处理冲突：${source.name}`} variant="large" onClose={onClose}>
    <div className="modal-scroll">
      <p className="dialog-description">这些日程在 NBase 和外部日历两边都有变化。处理之前，它们不会写回外部日历。</p>
      {loadError && <p className="dialog-description" role="alert">{loadError}
        <button className="nb-btn nb-btn-quiet" onClick={() => void load()}>重试</button></p>}
      {!conflicts && !loadError && <p className="dialog-description" role="status">正在读取…</p>}
      {conflicts && !conflicts.length && <p className="dialog-description" role="status">没有待处理的冲突。</p>}
      {status && <p className="dialog-description" role="status">{status}</p>}
      {error && <p className="dialog-description" role="alert">{error}</p>}
      {(conflicts ?? []).map(conflict => <article key={conflict.rowId} className="nb-wcal-conflict"
        aria-label={conflict.local?.title || conflict.remote?.title || '未命名日程'}>
        <div className="nb-wcal-sync-head">
          <strong>{conflict.local?.title || conflict.remote?.title || '未命名日程'}</strong>
          <span className="nb-wcal-sync-badge">{kindText[conflict.kind]}</span>
          <span className="nb-wcal-sync-host">发现于 {timeText(conflict.detectedAt, timeZone)}</span>
        </div>
        <div className="nb-wcal-conflict-sides">
          <Side label="NBase 版本" snapshot={conflict.local} other={conflict.remote} missing="NBase 中已删除" timeZone={timeZone} />
          <Side label="外部版本" snapshot={conflict.remote} other={conflict.local} missing="外部已删除" timeZone={timeZone} />
        </div>
        {kindHint[conflict.kind] && <p className="dialog-description">{kindHint[conflict.kind]}</p>}
        <div className="nb-wcal-sync-actions">
          {onOpenRow && conflict.kind !== 'local-deleted' && <button className="nb-btn nb-btn-quiet" onClick={() => onOpenRow(conflict.rowId)}>打开这一行</button>}
          {onOpenRow && conflict.copyRowId && <button className="nb-btn nb-btn-quiet" onClick={() => onOpenRow(conflict.copyRowId!)}>打开外部版本副本</button>}
          <span className="nb-wcal-conflict-spacer" />
          <button className="nb-btn" disabled={!!busy} onClick={() => void resolve(conflict, 'local')}>保留 NBase 版本</button>
          <button className="nb-btn" disabled={!!busy} onClick={() => void resolve(conflict, 'remote')}>保留外部版本</button>
          {conflict.kind === 'both-changed' && <button className="nb-btn" disabled={!!busy}
            onClick={() => void resolve(conflict, 'both')}>两份都保留</button>}
        </div>
      </article>)}
    </div>
    <div className="dialog-actions"><button className="nb-btn" onClick={onClose}>关闭</button></div>
  </Modal>;
}
