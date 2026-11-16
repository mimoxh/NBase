import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarDatabaseOption, CalendarEventsResponse, CalendarSettings, OptionColor, RecurrenceEditScope } from '@nbase/contracts';
import { Calendar } from '../calendar/Calendar';
import { applyEventChange, newEventValue, type EventSpan, type EventWrite } from '../calendar/editing';
import type { WeekStart } from '../calendar/layout';
import { buildEvents, type CalendarEvent, type CalendarEventInput } from '../calendar/model';
import { RecurrenceScopeDialog } from '../calendar/RecurrenceScopeDialog';
import { Popover } from '../components/Popover';
import { useCalendarNav } from '../database/views/calendarNav';
import { reminderPermission, requestReminderPermission } from '../reminders/runner';
import { creationTarget, dailyNotesSourceId, defaultSettingsFor, upsertSource } from './settings';
import type { WorkspaceCalendarSource } from './source';
import { SourcesPanel } from './SourcesPanel';
import { SyncDialog } from './SyncDialog';
import './workspaceCalendar.css';

/**
 * The workspace-wide calendar: events of every configured database, daily-note markers, sources and
 * sync management. Reads come from `loadEvents`; writes go back to the rows through the source.
 */
export function WorkspaceCalendarPage({ source, timeZone, weekStart, parents = [] }: {
  source: WorkspaceCalendarSource;
  timeZone: string;
  weekStart: WeekStart;
  /** Documents an import can create its database under; top level is always offered. */
  parents?: readonly { id: string; title: string }[];
}) {
  const nav = useCalendarNav('workspace', timeZone, weekStart);
  const [databases, setDatabases] = useState<CalendarDatabaseOption[] | null>(null);
  const [settings, setSettings] = useState<CalendarSettings | null>(null);
  const [data, setData] = useState<CalendarEventsResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saveProblem, setSaveProblem] = useState(false);
  const [panel, setPanel] = useState<'sources' | 'sync' | null>(null);
  const [pending, setPending] = useState<{ event: CalendarEvent; next: EventSpan } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [permission, setPermission] = useState(reminderPermission);
  const sequence = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    let alive = true;
    void Promise.all([source.listDatabases(), source.loadSettings()]).then(([listed, stored]) => {
      if (!alive) return;
      let next = stored;
      if (stored.sources.length === 0 && listed.databases.length > 0) {
        next = defaultSettingsFor(listed.databases);
        void source.saveSettings(next).catch(() => setSaveProblem(true));
      }
      setDatabases(listed.databases);
      setSettings(next);
    }).catch(() => { if (alive) setLoadError('暂时无法读取日历来源。'); });
    return () => { alive = false; };
  }, [source, attempt]);

  const refreshEvents = useCallback(async () => {
    if (!settingsRef.current) return;
    const run = ++sequence.current;
    setLoading(true);
    try {
      const events = await source.loadEvents(nav.range.from, nav.range.to);
      if (run !== sequence.current) return;
      setData(events); setLoadError('');
    } catch { if (run === sequence.current) setLoadError('暂时无法读取日历事件。'); }
    finally { if (run === sequence.current) setLoading(false); }
  }, [source, nav.range.from, nav.range.to]);
  const refreshRef = useRef(refreshEvents);
  refreshRef.current = refreshEvents;
  useEffect(() => { if (settings) void refreshEvents(); }, [settings !== null, refreshEvents]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const updateSettings = (next: CalendarSettings) => {
    setSettings(next);
    setSaveProblem(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void source.saveSettings(next).then(() => refreshRef.current()).catch(() => setSaveProblem(true));
    }, 600);
  };
  const retrySave = () => {
    const current = settingsRef.current;
    if (!current) return;
    void source.saveSettings(current).then(() => { setSaveProblem(false); void refreshRef.current(); }).catch(() => setSaveProblem(true));
  };

  /** After an import or subscription change: new databases join the settings, then everything reloads. */
  const reloadSources = useCallback(async () => {
    const listed = await source.listDatabases().catch(() => null);
    if (listed) {
      setDatabases(listed.databases);
      const current = settingsRef.current;
      if (current) {
        let next = current;
        listed.databases.forEach((db, index) => {
          if (!next.sources.some(s => s.databaseId === db.databaseId)) next = upsertSource(next, db, index, {});
        });
        if (next !== current) {
          setSettings(next);
          void source.saveSettings(next).catch(() => setSaveProblem(true));
        }
      }
    }
    void refreshRef.current();
  }, [source]);

  const propertyTypes = useMemo(() => {
    const map = new Map<string, CalendarDatabaseOption['dateProperties'][number]['type']>();
    for (const db of databases ?? []) for (const property of db.dateProperties) map.set(`${db.databaseId}:${property.id}`, property.type);
    return map;
  }, [databases]);
  const colors = useMemo(() => new Map<string, OptionColor>((settings?.sources ?? [])
    .map(s => [`${s.databaseId}:${s.propertyId}`, s.color] as const)), [settings]);
  const revisions = useMemo(() => new Map<string, string>((data?.events ?? [])
    .map(item => [`${item.databaseId}:${item.propertyId}:${item.rowId}`, item.revision] as const)), [data]);

  const events = useMemo(() => {
    if (!data || !settings) return [];
    const inputs: CalendarEventInput[] = [];
    for (const item of data.events) {
      const key = `${item.databaseId}:${item.propertyId}`;
      const type = propertyTypes.get(key);
      if (!type) continue;
      inputs.push({ sourceId: key, rowId: item.rowId, title: item.title, icon: item.icon, color: colors.get(key),
        value: item.value, kind: type === 'date' ? 'date' : 'moment', readOnly: item.readOnly || type !== 'date' || !source.canWrite });
    }
    if (settings.showDailyNotes) {
      for (const note of data.dailyNotes) {
        inputs.push({ sourceId: dailyNotesSourceId, rowId: note.pageId, title: note.title, icon: '📓',
          value: note.date, kind: 'date', readOnly: true });
      }
    }
    return buildEvents(inputs, nav.range, timeZone);
  }, [data, settings, propertyTypes, colors, nav.range, timeZone, source.canWrite]);

  const open = (event: CalendarEvent) => {
    if (event.sourceId === dailyNotesSourceId) { source.openDailyNote(event.start, event.rowId); return; }
    source.openRow(event.rowId);
  };

  const write = async (event: CalendarEvent, change: EventWrite | null) => {
    if (!change) { source.notice('这个日期不能这样修改。'); return; }
    if (change.series === null) { source.notice('这次修改会移除整个系列，请在该数据库的日历视图中操作。'); return; }
    const [databaseId = '', propertyId = ''] = event.sourceId.split(':');
    const revision = revisions.get(`${databaseId}:${propertyId}:${event.rowId}`);
    if (!revision) { source.notice('这条日程已有变化，正在刷新。'); void refreshRef.current(); return; }
    let ok: boolean;
    try { ok = await source.writeRowDate({ rowId: event.rowId, propertyId, value: change.series, expectedRevision: revision }); }
    catch { source.notice('修改未保存，请检查网络后重试。'); return; }
    if (!ok) { source.notice('这条日程已在别处修改，已重新载入最新内容。'); void refreshRef.current(); return; }
    if (change.detached !== undefined) {
      try { await source.createDetachedRow({ databaseId, rowId: event.rowId, propertyId, value: change.detached }); }
      catch { source.notice('拆分出的日程未能创建，请重试。'); }
    }
    void refreshRef.current();
  };
  const change = (event: CalendarEvent, next: EventSpan) => {
    if (event.recurring) setPending({ event, next });
    else void write(event, applyEventChange(event, next, 'all', timeZone));
  };
  const choose = (scope: RecurrenceEditScope) => {
    const chosen = pending;
    setPending(null);
    if (chosen) void write(chosen.event, applyEventChange(chosen.event, chosen.next, scope, timeZone));
  };

  const target = databases && settings ? creationTarget(databases, settings) : null;
  const create = (span: EventSpan) => {
    if (!target) { source.notice('请先在「来源」里选择一个新建事件写入的数据库：它需要有可编辑的日期字段。'); return; }
    const value = newEventValue(span, timeZone);
    if (!value) return;
    void source.createEvent({ ...target, value }).then(rowId => {
      void refreshRef.current();
      if (rowId) source.openRow(rowId);
    }).catch(() => source.notice('新建日程失败，请重试。'));
  };

  const dayNotes = useMemo(() => new Map((data?.dailyNotes ?? []).map(note => [note.date, note.pageId] as const)), [data]);
  const dayClick = settings?.showDailyNotes ? (day: string) => source.openDailyNote(day, dayNotes.get(day)) : undefined;

  const truncatedTitles = (data?.truncated ?? [])
    .map(id => databases?.find(db => db.databaseId === id)?.title ?? '未命名数据库');
  const status = <>
    {loading && <span role="status">正在读取…</span>}
    {loadError && data && <span role="alert">{loadError}</span>}
    {truncatedTitles.length > 0 && <span role="status">「{truncatedTitles.join('、')}」的事件太多，只显示一部分。</span>}
    {saveProblem && <button className="nb-btn nb-btn-quiet" onClick={retrySave}>来源设置未保存，点击重试</button>}
    <span className="nb-wcal-actions">
      <button className="nb-btn nb-btn-quiet" onClick={() => setPanel(item => item === 'sources' ? null : 'sources')}>来源</button>
      {panel === 'sources' && settings && databases && <Popover label="日历来源设置" className="nb-wcal-pop" portal width={300}
        onClose={() => setPanel(null)}>
        <SourcesPanel databases={databases} settings={settings} canWrite={source.canWrite} onChange={updateSettings} />
      </Popover>}
    </span>
    <button className="nb-btn nb-btn-quiet" onClick={() => setPanel('sync')}>导入与订阅</button>
    {source.persistent && permission === 'default' && <button className="nb-btn nb-btn-quiet"
      onClick={() => void requestReminderPermission().then(setPermission)}>开启提醒通知</button>}
    {source.persistent && permission === 'denied' && <span className="nb-wcal-muted">浏览器通知已关闭，提醒将显示在页面内。</span>}
    {!source.persistent && <span className="nb-wcal-muted">演示模式没有提醒和订阅。</span>}
  </>;

  if (!databases || !settings) {
    return <div className="nb-wcal nb-db-status" role={loadError ? 'alert' : 'status'}>
      {loadError || '正在读取日历…'}
      {loadError && <button className="nb-btn nb-btn-quiet" onClick={() => setAttempt(value => value + 1)}>重试</button>}
    </div>;
  }
  return <div className="nb-wcal">
    <Calendar mode={nav.mode} anchor={nav.anchor} weekStart={weekStart} timeZone={timeZone} today={nav.today} events={events}
      agendaDays={nav.agendaDays} onMode={nav.setMode} onAnchor={nav.setAnchor} onAgendaMore={nav.loadMore}
      onOpen={open} onCreate={source.canWrite ? create : undefined} onChange={source.canWrite ? change : undefined}
      onDayClick={dayClick} status={status} label="工作区日历" />
    {pending && <RecurrenceScopeDialog onChoose={choose} onClose={() => setPending(null)} />}
    {panel === 'sync' && <SyncDialog source={source} parents={parents} onChanged={() => void reloadSources()}
      onClose={() => setPanel(null)} />}
  </div>;
}
