import { optionColors, type CalendarDatabaseOption, type CalendarSettings, type OptionColor } from '@nbase/contracts';
import { creationTarget, defaultColorFor, defaultsForDatabase, optionColorLabels, setDefaultDatabase,
  setShowDailyNotes, upsertSource } from './settings';
import { syncKindLabels } from './syncText';

const propertyLabel = (property: CalendarDatabaseOption['dateProperties'][number]) =>
  `${property.name}${property.type === 'created_time' ? '（创建时间）' : property.type === 'updated_time' ? '（更新时间）' : ''}`;

const hasWritableDate = (db: CalendarDatabaseOption) =>
  db.dateProperties.some(p => p.type === 'date' && !db.sync?.readOnlyPropertyIds.includes(p.id));

export function syncBadge(db: Pick<CalendarDatabaseOption, 'sync'>): string | null {
  if (!db.sync) return null;
  const kind = syncKindLabels[db.sync.kind];
  if (db.sync.kind === 'ics-file') return kind;
  const conflicts = db.sync.caldav?.conflictCount ? ` · ${db.sync.caldav.conflictCount} 个冲突` : '';
  return db.sync.status === 'running' ? `${kind} · 同步中` : db.sync.status === 'error' ? `${kind} · 失败` : `${kind}${conflicts}`;
}

/** Source toggles, property and color choices, and the default database for new events. */
export function SourcesPanel({ databases, settings, canWrite, onChange }: {
  databases: readonly CalendarDatabaseOption[];
  settings: CalendarSettings;
  canWrite: boolean;
  onChange: (next: CalendarSettings) => void;
}) {
  const target = creationTarget(databases, settings);
  const writable = databases.filter(hasWritableDate);
  return <div className="nb-wcal-sources">
    <label className="nb-wcal-daily"><input type="checkbox" checked={settings.showDailyNotes}
      onChange={event => onChange(setShowDailyNotes(settings, event.target.checked))} />显示每日笔记</label>
    {!databases.length && <p className="dialog-description">工作区里还没有带日期字段的数据库。</p>}
    {databases.map((db, index) => {
      const setting = settings.sources.find(s => s.databaseId === db.databaseId) ?? null;
      const visible = setting?.visible ?? false;
      const propertyId = setting?.propertyId ?? defaultsForDatabase(db, defaultColorFor(index))?.propertyId ?? '';
      const color = setting?.color ?? defaultColorFor(index);
      const badge = syncBadge(db);
      const patch = (value: Parameters<typeof upsertSource>[3]) => onChange(upsertSource(settings, db, index, value));
      return <div className="nb-wcal-source" key={db.databaseId}>
        <label className="nb-wcal-source-head">
          <input type="checkbox" checked={visible} onChange={event => patch({ visible: event.target.checked })} />
          <span className="nb-page-icon">{db.icon ?? '🗃️'}</span>
          <span className="nb-wcal-source-title">{db.title || '未命名数据库'}</span>
          {badge && <span className={`nb-wcal-sync-badge ${db.sync!.status}`}>{badge}</span>}
        </label>
        {visible && <div className="nb-wcal-source-body">
          <select className="select-field" aria-label={`${db.title || '未命名数据库'}的日期字段`} value={propertyId}
            onChange={event => patch({ propertyId: event.target.value })}>
            {db.dateProperties.map(p => <option key={p.id} value={p.id}>{propertyLabel(p)}</option>)}
          </select>
          <select className="select-field nb-wcal-color" aria-label={`${db.title || '未命名数据库'}的颜色`} value={color}
            onChange={event => patch({ color: event.target.value as OptionColor })}>
            {optionColors.map(c => <option key={c} value={c}>{optionColorLabels[c]}</option>)}
          </select>
        </div>}
      </div>;
    })}
    {canWrite && writable.length > 0 && <>
      <label className="field-label" htmlFor="nb-wcal-default-db">新建事件写入</label>
      <select id="nb-wcal-default-db" className="select-field" value={settings.defaultDatabaseId ?? target?.databaseId ?? ''}
        onChange={event => onChange(setDefaultDatabase(settings, event.target.value || null))}>
        {writable.map(db => <option key={db.databaseId} value={db.databaseId}>{db.title || '未命名数据库'}</option>)}
      </select>
    </>}
  </div>;
}
