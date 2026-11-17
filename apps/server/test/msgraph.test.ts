import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIcs, type IcsEvent } from '../src/calendar/ics.js';
import { buildIcsResource, patchIcsResource } from '../src/calendar/icsWrite.js';
import { CalDavError } from '../src/calendar/caldav/client.js';
import { createGraphCalendar, graphCalendarUrl, graphEventUrl, listGraphCalendars } from '../src/calendar/graph/adapter.js';
import { graphRecurrence, recurrenceRule, synthesize, type GraphRecurrence } from '../src/calendar/graph/convert.js';
import { MockGraph } from './msgraph-mock.js';

const calendarUrl = new URL(graphCalendarUrl('cal1'));
const now = Date.UTC(2026, 2, 1);
const cst = (dateTime: string) => ({ dateTime, timeZone: 'China Standard Time' });
const utc = (dateTime: string) => ({ dateTime, timeZone: 'UTC' });

function setup() {
  const mock = new MockGraph();
  mock.addCalendar('cal1', '日历');
  mock.addCalendar('readonly', '共享', false);
  let renewals = 0;
  let token = mock.token;
  const auth = { token: async () => token, renew: async () => { renewals++; token = mock.token; return token; } };
  const graph = createGraphCalendar({ transport: mock.transport, auth, timeZone: 'Asia/Shanghai' });
  return { mock, graph, renewals: () => renewals };
}

function fixtures(mock: MockGraph) {
  const standup = mock.add('cal1', { subject: '站会', start: cst('2026-03-10T09:00:00'), end: cst('2026-03-10T09:30:00'), location: '一号会议室',
    body: '带上周报\r\n' });
  const review = mock.add('cal1', { subject: '评审会', start: utc('2026-03-11T06:00:00'), end: utc('2026-03-11T07:00:00'),
    attendees: [{ type: 'required', emailAddress: { name: 'Bob', address: 'bob@example.test' } }] });
  const trip = mock.add('cal1', { subject: '出差', isAllDay: true, start: cst('2026-03-12T00:00:00'), end: cst('2026-03-14T00:00:00') });
  const weekly = mock.add('cal1', { subject: '周会', start: cst('2026-03-02T09:00:00'), end: cst('2026-03-02T10:00:00'),
    recurrence: { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'sunday' },
      range: { type: 'numbered', startDate: '2026-03-02', numberOfOccurrences: 4, recurrenceTimeZone: 'China Standard Time' } } });
  const moved = mock.addException(weekly, '2026-03-09', { subject: '周会（推迟）', start: cst('2026-03-09T10:00:00'), end: cst('2026-03-09T11:00:00') });
  mock.cancelOccurrence(weekly, '2026-03-16');
  const daily = mock.add('cal1', { subject: '打卡', start: utc('2026-03-01T08:00:00'), end: utc('2026-03-01T08:15:00'),
    recurrence: { pattern: { type: 'daily', interval: 2 }, range: { type: 'endDate', startDate: '2026-03-01', endDate: '2026-03-09', recurrenceTimeZone: 'UTC' } } });
  const gone = mock.add('cal1', { subject: '已取消', start: utc('2026-03-13T06:00:00'), end: utc('2026-03-13T07:00:00'), isCancelled: true });
  return { standup, review, trip, weekly, moved, daily, gone };
}

async function readAll(graph: ReturnType<typeof setup>['graph']) {
  const etags = await graph.listEtags(calendarUrl);
  const fetched = await graph.fetchResources(calendarUrl, etags.map(e => e.href));
  assert.deepEqual(fetched.missing, []);
  return { etags: new Map(etags.map(e => [e.href, e.etag])), resources: new Map(fetched.found.map(r => [r.href, r])) };
}

const parsed = (body: string) => parseIcs(body, { timeZone: 'UTC', details: true });
const byTitle = (events: IcsEvent[], title: string) => events.find(e => e.title === title)!;

test('Graph events become iCalendar resources the reader understands', async () => {
  const { mock, graph } = setup();
  const f = fixtures(mock);
  mock.pageSize = 2;
  const { etags, resources } = await readAll(graph);
  assert.equal(resources.size, 5, 'cancelled events are left out');
  assert.ok(!etags.has(graphEventUrl(f.gone.id)));
  assert.ok(mock.requests.filter(r => r.path === 'me/calendars/cal1/events').length >= 3, 'pages are followed');
  assert.ok(mock.requests.every(r => r.batched || r.prefer === 'outlook.timezone="UTC", outlook.body-content-type="text"'));
  // Both series are read by ID in one batch, with their changed and cancelled occurrences.
  const batched = mock.requests.filter(r => r.batched);
  assert.equal(batched.length, 2);
  assert.ok(batched.every(r => r.query.get('$expand') === 'exceptionOccurrences' && r.query.get('$select')!.includes('cancelledOccurrences')));

  const events = [...resources.values()].flatMap(r => parsed(r.body).events);
  const standup = byTitle(events, '站会');
  assert.equal(standup.uid, f.standup.iCalUId);
  assert.equal(standup.value, '2026-03-10T01:00:00Z/2026-03-10T01:30:00Z|tz=Asia/Shanghai');
  assert.equal(standup.location, '一号会议室');
  assert.equal(standup.description, '带上周报');
  assert.equal(standup.attendees, false);
  assert.match(resources.get(graphEventUrl(f.standup.id))!.body, /DTSTART;TZID=Asia\/Shanghai:20260310T090000/);
  const review = byTitle(events, '评审会');
  assert.equal(review.value, '2026-03-11T06:00:00Z/2026-03-11T07:00:00Z');
  assert.equal(review.attendees, true);
  assert.match(resources.get(graphEventUrl(f.review.id))!.body, /ATTENDEE;CN="Bob":mailto:bob@example\.test/);
  // All-day times come back converted to UTC (16:00 the day before); the day is taken in the event's zone.
  assert.equal(byTitle(events, '出差').value, '2026-03-12/2026-03-13');
  const weekly = byTitle(events, '周会');
  assert.equal(weekly.uid, f.weekly.iCalUId);
  assert.equal(weekly.value, '2026-03-02T01:00:00Z/2026-03-02T02:00:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY;COUNT=4;BYDAY=MO;WKST=SU'
    + '|exdate=2026-03-09T01:00:00Z,2026-03-16T01:00:00Z');
  assert.deepEqual(weekly.overrides, ['2026-03-09T01:00:00Z']);
  const moved = byTitle(events, '周会（推迟）');
  assert.equal(moved.uid, `${f.weekly.iCalUId}#2026-03-09T01:00:00Z`);
  assert.equal(moved.value, '2026-03-09T02:00:00Z/2026-03-09T03:00:00Z|tz=Asia/Shanghai');
  assert.equal(byTitle(events, '打卡').value, '2026-03-01T08:00:00Z/2026-03-01T08:15:00Z|tz=UTC|rrule=FREQ=DAILY;INTERVAL=2;UNTIL=20260309T235959Z');
  // get reads the current state again.
  const again = await graph.get(graphEventUrl(f.weekly.id));
  assert.equal(again?.etag, etags.get(graphEventUrl(f.weekly.id)));
  assert.equal(await graph.get(graphEventUrl('missing')), null);
  assert.equal(await graph.syncChanges(calendarUrl, 'token'), null);
});

test('the ETag follows the series, its changed occurrences and its cancellations', async () => {
  const { mock, graph } = setup();
  const f = fixtures(mock);
  const first = (await readAll(graph)).etags;
  const href = graphEventUrl(f.weekly.id);
  mock.update(f.moved, { subject: '周会（再推迟）' });
  const second = (await readAll(graph)).etags;
  assert.notEqual(second.get(href), first.get(href));
  assert.equal(second.get(graphEventUrl(f.standup.id)), first.get(graphEventUrl(f.standup.id)));
  mock.update(f.weekly, { location: '大会议室' });
  const third = (await readAll(graph)).etags;
  assert.notEqual(third.get(href), second.get(href));
  f.weekly.cancelled.add('2026-03-23');
  const fourth = (await readAll(graph)).etags;
  assert.notEqual(fourth.get(href), third.get(href));
  mock.update(f.standup, { subject: '站会（改）' });
  assert.notEqual((await readAll(graph)).etags.get(graphEventUrl(f.standup.id)), first.get(graphEventUrl(f.standup.id)));
});

test('patterned recurrence and RRULE convert both ways for the supported subset', () => {
  const timed = { start: '2026-03-02T01:00:00Z', end: '2026-03-02T02:00:00Z', allDay: false, timeZone: 'Asia/Shanghai' };
  const placement = { zone: 'Asia/Shanghai', zoneName: 'China Standard Time' };
  const range = (extra: Record<string, unknown>) => ({ startDate: '2026-03-02', recurrenceTimeZone: 'China Standard Time', ...extra });
  const cases: [GraphRecurrence, string][] = [
    [{ pattern: { type: 'daily', interval: 3 }, range: range({ type: 'noEnd' }) }, 'FREQ=DAILY;INTERVAL=3'],
    [{ pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday', 'friday'], firstDayOfWeek: 'monday' },
      range: range({ type: 'numbered', numberOfOccurrences: 10 }) }, 'FREQ=WEEKLY;INTERVAL=2;COUNT=10;BYDAY=MO,WE,FR'],
    [{ pattern: { type: 'absoluteMonthly', interval: 2, dayOfMonth: 15 }, range: range({ type: 'endDate', endDate: '2026-06-30' }) },
      'FREQ=MONTHLY;INTERVAL=2;UNTIL=20260630T155959Z;BYMONTHDAY=15'],
    [{ pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['thursday'], index: 'second' }, range: range({ type: 'noEnd' }) },
      'FREQ=MONTHLY;BYDAY=2TH'],
    [{ pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], index: 'last' },
      range: range({ type: 'noEnd' }) }, 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'],
    [{ pattern: { type: 'absoluteYearly', interval: 1, month: 3, dayOfMonth: 2 }, range: range({ type: 'numbered', numberOfOccurrences: 5 }) },
      'FREQ=YEARLY;COUNT=5;BYMONTH=3;BYMONTHDAY=2'],
    [{ pattern: { type: 'relativeYearly', interval: 1, month: 11, daysOfWeek: ['thursday'], index: 'fourth' }, range: range({ type: 'noEnd' }) },
      'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'],
  ];
  for (const [recurrence, rule] of cases) {
    const text = recurrenceRule(recurrence, timed, 'Asia/Shanghai');
    assert.equal(text, rule);
    assert.deepEqual(graphRecurrence({ ...timed, rrule: text! }, placement), recurrence, rule);
  }
  const allDay = { start: '2026-03-02', allDay: true };
  const allDayRule = recurrenceRule({ pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'sunday' },
    range: { type: 'endDate', startDate: '2026-03-02', endDate: '2026-03-30' } }, allDay, null);
  assert.equal(allDayRule, 'FREQ=WEEKLY;UNTIL=20260330;BYDAY=MO;WKST=SU');
  assert.deepEqual(graphRecurrence({ ...allDay, rrule: allDayRule! }, { zone: null, zoneName: 'China Standard Time' })?.range,
    { type: 'endDate', startDate: '2026-03-02', endDate: '2026-03-30', recurrenceTimeZone: 'China Standard Time' });
  // An UNTIL just before the next occurrence (a split series) ends the day before.
  assert.equal(graphRecurrence({ ...timed, rrule: 'FREQ=WEEKLY;UNTIL=20260316T005959Z;BYDAY=MO' }, placement)?.range?.endDate, '2026-03-15');
  // Rules without a missing BYDAY take the start's weekday or day.
  assert.deepEqual(graphRecurrence({ ...timed, rrule: 'FREQ=WEEKLY' }, placement)?.pattern?.daysOfWeek, ['monday']);
  assert.equal(graphRecurrence({ ...timed, rrule: 'FREQ=MONTHLY' }, placement)?.pattern?.dayOfMonth, 2);
  assert.equal(graphRecurrence({ ...timed, rrule: 'FREQ=DAILY;BYDAY=MO,TU' }, placement)?.pattern?.type, 'weekly');
  for (const rule of ['FREQ=MONTHLY;BYMONTHDAY=1,15', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;BYDAY=5FR', 'FREQ=YEARLY;BYMONTH=1,7',
    'FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=2,3', 'FREQ=MONTHLY;BYMONTH=3', 'FREQ=DAILY;INTERVAL=2;BYDAY=MO', 'FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO']) {
    assert.equal(graphRecurrence({ ...timed, rrule: rule }, placement), null, rule);
  }
  // A recurrence without an RRULE form is reported, not read as a single event.
  const odd = synthesize({ id: 'x', type: 'seriesMaster', iCalUId: 'odd', subject: '怪', start: utc('2026-03-02T01:00:00'), end: utc('2026-03-02T02:00:00'),
    recurrence: { pattern: { type: 'hourly', interval: 1 }, range: { type: 'noEnd', startDate: '2026-03-02' } } })!;
  assert.equal(odd.unsupported, true);
  assert.deepEqual(parseIcs(odd.text, { timeZone: 'UTC' }).warnings, [{ code: 'RULE_UNSUPPORTED', count: 1 }]);
});

const writable = (event: IcsEvent, patch: Partial<IcsEvent> = {}) => ({ title: event.title, value: event.value, location: event.location,
  description: event.description, ...patch });

test('writes send only changed fields with If-Match, and stale versions answer 412', async () => {
  const { mock, graph } = setup();
  const f = fixtures(mock);
  const { etags, resources } = await readAll(graph);
  const href = graphEventUrl(f.standup.id);
  const resource = resources.get(href)!;
  const event = parsed(resource.body).events[0]!;
  const etag = f.standup.etag;
  let mark = mock.requests.length;
  const titled = patchIcsResource(resource.body, { edits: [{ component: 0, event: writable(event, { title: '站会（改）', location: '二号会议室' }) }], drop: [] }, now);
  assert.deepEqual(await graph.put(href, titled, { ifMatch: etags.get(href)! }), { status: 200, etag: null });
  const writes = mock.writes(mark);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.method, 'PATCH');
  assert.equal(writes[0]!.ifMatch, etag);
  assert.deepEqual(writes[0]!.body, { subject: '站会（改）', location: { displayName: '二号会议室' } });
  assert.equal(f.standup.subject, '站会（改）');

  // A new time goes in the event's zone, by its Windows name.
  let current = (await graph.get(href))!;
  mark = mock.requests.length;
  const later = patchIcsResource(current.body, { edits: [{ component: 0, event: writable(parsed(current.body).events[0]!,
    { value: '2026-03-10T02:00:00Z/2026-03-10T03:00:00Z|tz=Asia/Shanghai' }) }], drop: [] }, now);
  assert.equal((await graph.put(href, later, { ifMatch: current.etag! })).status, 200);
  assert.deepEqual(mock.writes(mark)[0]!.body, { start: { dateTime: '2026-03-10T10:00:00', timeZone: 'China Standard Time' },
    end: { dateTime: '2026-03-10T11:00:00', timeZone: 'China Standard Time' }, isAllDay: false });
  current = (await graph.get(href))!;
  assert.equal(parsed(current.body).events[0]!.value, '2026-03-10T02:00:00Z/2026-03-10T03:00:00Z|tz=Asia/Shanghai');

  // Nothing is written when the resource changed since it was read, or changes between reading and writing.
  mark = mock.requests.length;
  assert.equal((await graph.put(href, later, { ifMatch: '"old"' })).status, 412);
  assert.equal(mock.writes(mark).length, 0);
  mock.beforeWrite = () => mock.update(f.standup, { subject: '外部改' });
  assert.equal((await graph.put(href, titled, { ifMatch: current.etag! })).status, 412);
  assert.equal(f.standup.subject, '外部改');
  assert.equal((await graph.delete(href, current.etag)).status, 412);
  assert.ok(mock.events.has(f.standup.id));

  // Attendee events are never written, even when asked.
  const review = (await graph.get(graphEventUrl(f.review.id)))!;
  const renamed = patchIcsResource(review.body, { edits: [{ component: 0, event: writable(parsed(review.body).events[0]!, { title: 'x' }) }], drop: [] }, now);
  assert.equal((await graph.put(review.href, renamed, { ifMatch: review.etag! })).status, 422);
  assert.equal(await graph.put(graphEventUrl('missing'), titled, { ifMatch: '"x"' }).then(r => r.status), 404);
});

test('series writes: changed occurrences, dropped ones, new exclusions and rules', async () => {
  const { mock, graph } = setup();
  const f = fixtures(mock);
  await readAll(graph);
  const href = graphEventUrl(f.weekly.id);
  let current = (await graph.get(href))!;
  let events = parsed(current.body).events;
  const series = events.find(e => e.overrides)!;
  const moved = events.find(e => e.uid.includes('#'))!;
  // The changed occurrence gets a new title; the plain occurrence of 03-23 is excluded.
  const movedEtag = f.moved.etag;
  let mark = mock.requests.length;
  let text = patchIcsResource(current.body, { edits: [
    { component: series.component!, event: writable(series, { value: `${series.value},2026-03-23T01:00:00Z` }), keep: series.overrides! },
    { component: moved.component!, event: writable(moved, { title: '周会（改）' }) },
  ], drop: [] }, now);
  assert.equal((await graph.put(href, text, { ifMatch: current.etag! })).status, 200);
  const writes = mock.writes(mark);
  assert.deepEqual(writes.map(w => [w.method, w.path.split('/')[2]]), [['PATCH', f.moved.id], ['DELETE', `occ.${f.weekly.id}.2026-03-23`]]);
  assert.deepEqual(writes[0]!.body, { subject: '周会（改）' });
  assert.equal(writes[0]!.ifMatch, movedEtag);
  assert.ok(mock.requests.slice(mark).some(r => r.path.endsWith('/instances')));
  assert.deepEqual([...f.weekly.cancelled].sort(), ['2026-03-16', '2026-03-23']);
  assert.equal(f.moved.subject, '周会（改）');

  // Dropping the changed occurrence removes it from the series.
  current = (await graph.get(href))!;
  events = parsed(current.body).events;
  const changed = events.find(e => e.uid.includes('#'))!;
  const master = events.find(e => e.overrides)!;
  mark = mock.requests.length;
  text = patchIcsResource(current.body, { edits: [], drop: [changed.component!], exclude: [{ component: master.component!, points: ['2026-03-09T01:00:00Z'] }] }, now);
  assert.equal((await graph.put(href, text, { ifMatch: current.etag! })).status, 200);
  assert.deepEqual(mock.writes(mark).map(w => [w.method, w.path.split('/')[2]]), [['DELETE', f.moved.id]]);
  assert.equal(f.weekly.exceptions.size, 0);
  current = (await graph.get(href))!;
  assert.equal(parsed(current.body).events.length, 1);
  assert.match(parsed(current.body).events[0]!.value, /exdate=2026-03-09T01:00:00Z,2026-03-16T01:00:00Z,2026-03-23T01:00:00Z$/);

  // A new rule is sent as a patterned recurrence; one Graph cannot express is refused before anything is written.
  const only = parsed(current.body).events[0]!;
  mark = mock.requests.length;
  text = patchIcsResource(current.body, { edits: [{ component: 0, event: writable(only, {
    value: only.value.replace('FREQ=WEEKLY;COUNT=4;BYDAY=MO;WKST=SU', 'FREQ=WEEKLY;UNTIL=20260322T235959Z;BYDAY=MO;WKST=SU') }) }], drop: [] }, now);
  assert.equal((await graph.put(href, text, { ifMatch: current.etag! })).status, 200);
  assert.deepEqual(mock.writes(mark)[0]!.body, { recurrence: { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'sunday' },
    range: { type: 'endDate', startDate: '2026-03-02', endDate: '2026-03-22', recurrenceTimeZone: 'China Standard Time' } } });
  current = (await graph.get(href))!;
  mark = mock.requests.length;
  text = patchIcsResource(current.body, { edits: [{ component: 0, event: writable(parsed(current.body).events[0]!, {
    value: '2026-03-02T01:00:00Z/2026-03-02T02:00:00Z|tz=Asia/Shanghai|rrule=FREQ=MONTHLY;BYMONTHDAY=1,15' }) }], drop: [] }, now);
  assert.equal((await graph.put(href, text, { ifMatch: current.etag! })).status, 422);
  assert.equal(mock.writes(mark).length, 0);
});

test('new events are created by POST and named by Graph; deletes are conditional', async () => {
  const { mock, graph } = setup();
  fixtures(mock);
  const allDay = buildIcsResource('a@nbase', { title: '新事件', value: '2026-03-20', location: '', description: '说明' }, now);
  let mark = mock.requests.length;
  const created = await graph.put(new URL('a.ics', calendarUrl).toString(), allDay, { ifNoneMatch: '*' });
  const event = [...mock.events.values()].find(e => e.subject === '新事件')!;
  assert.deepEqual(created, { status: 201, etag: null, href: graphEventUrl(event.id), uid: event.iCalUId });
  const post = mock.writes(mark)[0]!;
  assert.equal(post.path, 'me/calendars/cal1/events');
  assert.deepEqual(post.body, { subject: '新事件', body: { contentType: 'text', content: '说明' }, location: { displayName: '' },
    start: { dateTime: '2026-03-20T00:00:00', timeZone: 'China Standard Time' }, end: { dateTime: '2026-03-21T00:00:00', timeZone: 'China Standard Time' },
    isAllDay: true });
  const read = (await graph.get(created.href!))!;
  assert.equal(parsed(read.body).events[0]!.value, '2026-03-20');
  assert.equal(parsed(read.body).events[0]!.uid, event.iCalUId);

  // A zone without a Windows name is written in UTC; a series with exclusions cancels them after creation.
  const timed = buildIcsResource('b@nbase', { title: '重庆', value: '2026-03-21T01:00:00Z/2026-03-21T02:00:00Z|tz=Asia/Chongqing', location: '', description: '' }, now);
  await graph.put(new URL('b.ics', calendarUrl).toString(), timed, { ifNoneMatch: '*' });
  assert.deepEqual(mock.writes(mark).at(-1)!.body!['start' as never], { dateTime: '2026-03-21T01:00:00', timeZone: 'UTC' });
  const series = buildIcsResource('c@nbase', { title: '晨跑', location: '', description: '',
    value: '2026-03-02T23:00:00Z/2026-03-02T23:30:00Z|tz=Asia/Shanghai|rrule=FREQ=DAILY;COUNT=5|exdate=2026-03-04T23:00:00Z' }, now);
  const run = await graph.put(new URL('c.ics', calendarUrl).toString(), series, { ifNoneMatch: '*' });
  assert.equal(run.status, 201);
  const runner = [...mock.events.values()].find(e => e.subject === '晨跑')!;
  assert.deepEqual([...runner.cancelled], ['2026-03-05']);
  mark = mock.requests.length;
  const odd = buildIcsResource('d@nbase', { title: '月中', value: '2026-03-01|rrule=FREQ=MONTHLY;BYMONTHDAY=1,15', location: '', description: '' }, now);
  assert.equal((await graph.put(new URL('d.ics', calendarUrl).toString(), odd, { ifNoneMatch: '*' })).status, 422);
  assert.equal(mock.writes(mark).length, 0);
  assert.equal((await graph.put(`${graphCalendarUrl('readonly')}e.ics`, allDay, { ifNoneMatch: '*' })).status, 403);

  mark = mock.requests.length;
  assert.equal((await graph.delete(created.href!, read.etag)).status, 204);
  assert.equal(mock.writes(mark)[0]!.ifMatch, event.etag);
  assert.ok(!mock.events.has(event.id));
  assert.equal((await graph.delete(created.href!, read.etag)).status, 404);
});

test('tokens are renewed once after 401; missing calendars and refused access are sync errors', async () => {
  const { mock, graph, renewals } = setup();
  fixtures(mock);
  assert.deepEqual(await graph.calendarState(calendarUrl), { ctag: null, syncToken: null, writable: true });
  assert.equal((await graph.calendarState(new URL(graphCalendarUrl('readonly')))).writable, false);
  mock.token = 'token-2';
  assert.equal((await graph.listEtags(calendarUrl)).length, 5);
  assert.equal(renewals(), 1);

  let calls = 0;
  const stale = createGraphCalendar({ transport: mock.transport, auth: { token: async () => 'expired', renew: async () => { calls++; return 'revoked'; } } });
  await assert.rejects(stale.calendarState(calendarUrl), (error: unknown) => error instanceof CalDavError && error.code === 'AUTH_FAILED');
  assert.equal(calls, 1);
  await assert.rejects(listGraphCalendars({ transport: mock.transport, auth: { token: async () => 'x', renew: async () => 'y' } }),
    (error: unknown) => error instanceof CalDavError && error.code === 'AUTH_FAILED');

  const notFound = (error: unknown) => error instanceof CalDavError && error.code === 'CALENDAR_NOT_FOUND';
  await assert.rejects(graph.calendarState(new URL(graphCalendarUrl('nope'))), notFound);
  await assert.rejects(graph.listEtags(new URL(graphCalendarUrl('nope'))), notFound);
  await assert.rejects(graph.calendarState(new URL('https://example.test/calendars/x/')), notFound);
  const failing = createGraphCalendar({ transport: async request => ({ status: 503, url: request.url, headers: {}, body: Buffer.from('') }),
    auth: { token: async () => 't', renew: async () => 't' } });
  await assert.rejects(failing.listEtags(calendarUrl), (error: unknown) => error instanceof CalDavError && error.code === 'FETCH_FAILED');
  assert.deepEqual((await listGraphCalendars({ transport: mock.transport, auth: { token: async () => mock.token, renew: async () => mock.token } }))
    .map(c => [c.name, c.writable]), [['日历', true], ['共享', false]]);
});
