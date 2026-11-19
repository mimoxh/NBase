import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { withAutoAddedSources, type CalendarDatabaseOption, type CalendarEventsResponse, type CalendarSettings, type OptionColor,
  type RecurrenceEditScope } from '@nbase/contracts';
import { Calendar } from '../calendar/Calendar';
import { applyEventChange, newEventValue, type EventSpan, type EventWrite } from '../calendar/editing';
import type { WeekStart } from '../calendar/layout';
import { buildEvents, type CalendarEvent, type CalendarEventInput } from '../calendar/model';
import { RecurrenceScopeDialog } from '../calendar/RecurrenceScopeDialog';
import { Icon } from '../components/Icon';
import { Popover } from '../components/Popover';
import { useCalendarNav } from '../database/views/calendarNav';
import { reminderPermission, requestReminderPermission } from '../reminders/runner';
import { creationTarget, dailyNotesSourceId, upsertSource } from './settings';
import type { WorkspaceCalendarSource } from './source';
import { SourcesPanel } from './SourcesPanel';
import { SyncDialog } from './SyncDialog';
import './workspaceCalendar.css';

/**
 * The workspace-wide calendar: events of every configured database, daily-note markers, sources and
 * sync management. Reads come from `loadEvents`; writes go back to the rows through the source.
 */
export function WorkspaceCalendarPage({ source, timeZone, weekStart, onDatabasesChanged }: {
  source: WorkspaceCalendarSource;
  timeZone: string;
  weekStart: WeekStart;
  /** An import, subscription or CalDAV source may have created a database the page tree does not list yet. */
  onDatabasesChanged?: () => void;
}) {
  const nav = useCalendarNav('workspace', timeZone, weekStart);
  const [databases, setDatabases] = useState<CalendarDatabaseOption[] | null>(null);
  const [settings, setSettings] = useState<CalendarSettings | null>(null);
  const [data, setData] = useState<CalendarEventsResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saveProblem, setSaveProblem] = useState(false);
  const [panel, setPanel] = useState<'sources' | 'sync' | 'settings' | null>(null);
  const [pending, setPending] = useState<{ event: CalendarEvent; next: EventSpan } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [permission, setPermission] = useState(reminderPermission);
  const sequence = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    let alive = true;
    // The settings come with new databases already added (`autoAdd`), so there is nothing to save here.
    void Promise.all([source.listDatabases(), source.loadSettings()]).then(([listed, loaded]) => {
      if (!alive) return;
      setDatabases(listed.databases);
      setSettings(loaded);
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

  /**
   * After an import, a sync change or a reveal: new databases join the settings as the server would add them,
   * and a calendar connected here joins even with `autoAdd` off. Then everything reloads.
   */
  const reloadSources = useCallback(async () => {
    const listed = await source.listDatabases().catch(() => null);
    if (listed) {
      setDatabases(listed.databases);
      const current = settingsRef.current;
      if (current) {
        let next = withAutoAddedSources(current, listed.databases);
        listed.databases.forEach((db, index) => {
          if (db.sync && !next.sources.some(s => s.databaseId === db.databaseId)) next = upsertSource(next, db, index, {});
        });
        if (next !== current) {
          setSettings(next);
          void source.saveSettings(next).catch(() => setSaveProblem(true));
        }
      }
    }
    void refreshRef.current();
  }, [source]);

  const reveal = source.sync ? async (databaseId: string) => {
    try { await source.sync!.reveal(databaseId); }
    catch { source.notice('未能显示到页面树，请重试。'); return; }
    onDatabasesChanged?.();
    await reloadSources();
  } : undefined;

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
    <span className="nb-wcal-toolbar">
      <span className="nb-wcal-actions">
        <button className="nb-btn nb-wcal-btn" aria-expanded={panel === 'sources'} onClick={() => setPanel(item => item === 'sources' ? null : 'sources')}>
          <Icon name="calendar" size={14} /><span>来源</span></button>
        {panel === 'sources' && settings && databases && <Popover label="日历来源设置" className="nb-wcal-pop" portal width={300}
          onClose={() => setPanel(null)}>
          <SourcesPanel databases={databases} settings={settings} canWrite={source.canWrite} onChange={updateSettings}
            {...(reveal ? { onReveal: reveal } : {})} />
        </Popover>}
      </span>
      {source.canWrite && <button className="nb-btn nb-wcal-btn" onClick={() => setPanel('sync')}>
        <Icon name="restore" size={14} /><span>导入与同步</span></button>}
      <span className="nb-wcal-actions">
        <button className="nb-btn nb-wcal-btn nb-wcal-icon-btn" aria-label="日历设置" title="日历设置" aria-expanded={panel === 'settings'}
          onClick={() => setPanel(item => item === 'settings' ? null : 'settings')}><Icon name="gear" size={15} /></button>
        {panel === 'settings' && <Popover label="日历设置" className="nb-wcal-pop" portal width={300} onClose={() => setPanel(null)}>
          <div className="nb-wcal-settings">
            <h3>提醒通知</h3>
            {!source.persistent ? <p>演示模式没有提醒和订阅。</p>
              : permission === 'granted' ? <p>已开启：到提醒时间时，浏览器会弹出通知。</p>
              : permission === 'default' ? <>
                <p>开启后，到提醒时间时浏览器会弹出通知；不开启时，提醒显示在页面内。</p>
                <button className="nb-btn nb-btn-primary" onClick={() => void requestReminderPermission().then(setPermission)}>开启提醒通知</button>
              </>
              : permission === 'denied' ? <p>浏览器通知已关闭，提醒将显示在页面内。如需开启，请在浏览器的网站设置中允许本站发送通知。</p>
              : <p>这个浏览器不支持通知，提醒将显示在页面内。</p>}
          </div>
        </Popover>}
      </span>
    </span>
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
    {panel === 'sync' && source.canWrite && <SyncDialog source={source} timeZone={timeZone} onChanged={() => { void reloadSources(); onDatabasesChanged?.(); }}
      onClose={() => setPanel(null)} />}
  </div>;
}
