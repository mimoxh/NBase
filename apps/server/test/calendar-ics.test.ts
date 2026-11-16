import assert from 'node:assert/strict';
import test from 'node:test';
import { isDateCellValue } from '@nbase/contracts';
import { IcsError, parseContentLine, parseIcs } from '../src/calendar/ics.js';

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';
const byUid = (result: ReturnType<typeof parseIcs>) => new Map(result.events.map(event => [event.uid, event]));

test('reads content lines with quoted parameters', () => {
  const prop = parseContentLine('DTSTART;TZID="America/New_York";X-A=a,"b;c:d":20250101T090000');
  assert.equal(prop?.name, 'DTSTART');
  assert.deepEqual(prop?.params.get('TZID'), ['America/New_York']);
  assert.deepEqual(prop?.params.get('X-A'), ['a', 'b;c:d']);
  assert.equal(prop?.value, '20250101T090000');
  assert.equal(parseContentLine('no colon here'), null);
});

test('Google export: zones, weekly series with exception and changed occurrence, all-day span, folding', () => {
  const result = parseIcs(crlf([
    'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:工作', 'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Shanghai', 'X-LIC-LOCATION:Asia/Shanghai', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800', 'TZNAME:CST', 'DTSTART:19700101T000000', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Shanghai:20250106T090000', 'DTEND;TZID=Asia/Shanghai:20250106T100000',
    'RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20250331T155959Z;BYDAY=MO', 'EXDATE;TZID=Asia/Shanghai:20250113T090000',
    'DTSTAMP:20250101T000000Z', 'UID:weekly@google.com', 'SUMMARY:周会\\, 例行', 'DESCRIPTION:第一行\\n第二行',
    'LOCATION:会议室 A', 'STATUS:CONFIRMED', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Shanghai:20250120T100000', 'DTEND;TZID=Asia/Shanghai:20250120T110000',
    'RECURRENCE-ID;TZID=Asia/Shanghai:20250120T090000', 'UID:weekly@google.com', 'SUMMARY:周会（改时间）', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20250201', 'DTEND;VALUE=DATE:20250204', 'UID:trip@google.com', 'SUMMARY:出差', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20250210T013000Z', 'DTEND:20250210T023000Z', 'UID:single@google.com', 'SUMMARY:A very long su',
    ' mmary folded', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20250211T013000Z', 'UID:gone@google.com', 'STATUS:CANCELLED', 'SUMMARY:取消', 'END:VEVENT',
    'END:VCALENDAR',
  ]), { timeZone: 'UTC' });
  assert.equal(result.name, '工作');
  assert.deepEqual(result.events.map(event => event.uid),
    ['weekly@google.com', 'weekly@google.com#2025-01-20T01:00:00Z', 'trip@google.com', 'single@google.com']);
  const events = byUid(result);
  assert.deepEqual(events.get('weekly@google.com'), {
    uid: 'weekly@google.com', title: '周会, 例行', location: '会议室 A', description: '第一行\n第二行',
    value: '2025-01-06T01:00:00Z/2025-01-06T02:00:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY;UNTIL=20250331T155959Z;BYDAY=MO;WKST=SU|exdate=2025-01-13T01:00:00Z,2025-01-20T01:00:00Z',
  });
  assert.equal(events.get('weekly@google.com#2025-01-20T01:00:00Z')?.value, '2025-01-20T02:00:00Z/2025-01-20T03:00:00Z|tz=Asia/Shanghai');
  assert.equal(events.get('trip@google.com')?.value, '2025-02-01/2025-02-03');
  assert.equal(events.get('single@google.com')?.title, 'A very long summary folded');
  assert.equal(events.get('single@google.com')?.value, '2025-02-10T01:30:00Z/2025-02-10T02:30:00Z|tz=Asia/Shanghai');
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.warnings, []);
  for (const event of result.events) assert.ok(isDateCellValue(event.value), event.value);
});

test('Outlook export: Windows zone ids, custom VTIMEZONE, alarms ignored', () => {
  const result = parseIcs(crlf([
    'BEGIN:VCALENDAR', 'METHOD:PUBLISH', 'PRODID:Microsoft Exchange Server 2010', 'VERSION:2.0', 'X-WR-CALNAME:日历',
    'BEGIN:VTIMEZONE', 'TZID:China Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800', 'END:STANDARD', 'BEGIN:DAYLIGHT', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800',
    'END:DAYLIGHT', 'END:VTIMEZONE',
    'BEGIN:VTIMEZONE', 'TZID:Customized Time Zone', 'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+1030',
    'TZOFFSETTO:+0930', 'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=4', 'END:STANDARD', 'BEGIN:DAYLIGHT',
    'DTSTART:16010101T020000', 'TZOFFSETFROM:+0930', 'TZOFFSETTO:+1030', 'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=10',
    'END:DAYLIGHT', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'DESCRIPTION:\\n', 'RRULE:FREQ=WEEKLY;UNTIL=20250228T013000Z;INTERVAL=2;BYDAY=TU,TH;WKST=SU',
    'UID:040000008200E00074C5B7101A82E008000000001', 'SUMMARY:双周例会',
    'DTSTART;TZID=China Standard Time:20250107T093000', 'DTEND;TZID=China Standard Time:20250107T103000', 'CLASS:PUBLIC',
    'LOCATION:Teams', 'X-MICROSOFT-CDO-BUSYSTATUS:BUSY', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY',
    'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:custom-zone', 'SUMMARY:Adelaide call', 'DTSTART;TZID=Customized Time Zone:20250310T090000',
    'DTEND;TZID=Customized Time Zone:20250310T093000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:pacific', 'SUMMARY:West coast', 'DTSTART;TZID=Pacific Standard Time:20250701T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:allday-outlook', 'SUMMARY:假期', 'DTSTART;VALUE=DATE:20250501', 'DTEND;VALUE=DATE:20250502', 'END:VEVENT',
    'END:VCALENDAR',
  ]), { timeZone: 'UTC' });
  const events = byUid(result);
  assert.deepEqual(events.get('040000008200E00074C5B7101A82E008000000001'), {
    uid: '040000008200E00074C5B7101A82E008000000001', title: '双周例会', location: 'Teams', description: '',
    value: '2025-01-07T01:30:00Z/2025-01-07T02:30:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY;INTERVAL=2;UNTIL=20250228T013000Z;BYDAY=TU,TH;WKST=SU',
  });
  // An unknown zone falls back to the standard offset of its VTIMEZONE: +09:30, not a whole hour, so no tz.
  assert.equal(events.get('custom-zone')?.value, '2025-03-09T23:30:00Z/2025-03-10T00:00:00Z');
  assert.equal(events.get('pacific')?.value, '2025-07-01T16:00:00Z|tz=America/Los_Angeles');
  assert.equal(events.get('allday-outlook')?.value, '2025-05-01');
  assert.deepEqual(result.warnings, [{ code: 'TIMEZONE_UNKNOWN', count: 1 }]);
});

test('iCloud export: daylight saving, count, sequence, unsupported and over-long series', () => {
  const result = parseIcs(crlf([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 14.0//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VTIMEZONE', 'TZID:America/New_York', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400',
    'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT', 'BEGIN:STANDARD',
    'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:A1B2C3D4-0000-1111-2222-333344445555', 'DTSTART;TZID=America/New_York:20250307T090000',
    'DTEND;TZID=America/New_York:20250307T100000', 'RRULE:FREQ=DAILY;COUNT=5',
    'EXDATE;TZID=America/New_York:20250309T090000,20250310T090000', 'SUMMARY:Standup', 'SEQUENCE:1', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:A1B2C3D4-0000-1111-2222-333344445555', 'DTSTART;TZID=America/New_York:20250307T090000',
    'SUMMARY:Old copy', 'SEQUENCE:0', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:birthday-1', 'DTSTART;VALUE=DATE:20000615', 'DTEND;VALUE=DATE:20000616', 'RRULE:FREQ=YEARLY',
    'SUMMARY:生日', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:long', 'DTSTART;VALUE=DATE:20250101', 'DTEND;VALUE=DATE:20250301', 'RRULE:FREQ=YEARLY', 'SUMMARY:Long', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:hourly', 'DTSTART:20250101T000000Z', 'RRULE:FREQ=HOURLY', 'SUMMARY:Too fine', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:moz', 'DTSTART;TZID=/mozilla.org/20050126_1/Europe/London:20250601T120000', 'END:VEVENT',
    'END:VCALENDAR',
  ]), { timeZone: 'UTC' });
  const events = byUid(result);
  assert.equal(events.get('A1B2C3D4-0000-1111-2222-333344445555')?.title, 'Standup');
  assert.equal(events.get('A1B2C3D4-0000-1111-2222-333344445555')?.value,
    '2025-03-07T14:00:00Z/2025-03-07T15:00:00Z|tz=America/New_York|rrule=FREQ=DAILY;COUNT=5|exdate=2025-03-09T13:00:00Z,2025-03-10T13:00:00Z');
  assert.equal(events.get('birthday-1')?.value, '2000-06-15|rrule=FREQ=YEARLY');
  assert.equal(events.get('long')?.value, '2025-01-01/2025-02-28');
  assert.equal(events.get('hourly')?.value, '2025-01-01T00:00:00Z');
  assert.equal(events.get('moz')?.value, '2025-06-01T11:00:00Z|tz=Europe/London');
  assert.equal(events.get('moz')?.title, '');
  assert.deepEqual(result.warnings, [{ code: 'RULE_UNSUPPORTED', count: 2 }]);
});

test('Feishu-like export: floating times, durations, escapes, LF line ends', () => {
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Feishu//Calendar//CN', 'X-WR-CALNAME:飞书日历', 'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VEVENT', 'UID:feishu-1', 'DTSTART:20250415T090000', 'DTEND:20250415T100000', 'SUMMARY:项目评审',
    'LOCATION:北京\\;3楼', 'DESCRIPTION:链接：https://example.com/a\\,b', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:feishu-2', 'DTSTART;VALUE=DATE:20250416', 'DURATION:P2D', 'SUMMARY:团建', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:feishu-3', 'DTSTART;TZID=Asia/Shanghai:20250417T140000', 'DURATION:PT1H30M', 'SUMMARY:面试', 'END:VEVENT',
    'END:VCALENDAR', ''].join('\n');
  const events = byUid(parseIcs(text, { timeZone: 'UTC' }));
  assert.deepEqual(events.get('feishu-1'), { uid: 'feishu-1', title: '项目评审', location: '北京;3楼',
    description: '链接：https://example.com/a,b', value: '2025-04-15T01:00:00Z/2025-04-15T02:00:00Z|tz=Asia/Shanghai' });
  assert.equal(events.get('feishu-2')?.value, '2025-04-16/2025-04-17');
  assert.equal(events.get('feishu-3')?.value, '2025-04-17T06:00:00Z/2025-04-17T07:30:00Z|tz=Asia/Shanghai');
  // Without a calendar zone, floating times are read in the workspace zone.
  const floating = parseIcs(text.replace('X-WR-TIMEZONE:Asia/Shanghai\n', ''), { timeZone: 'America/New_York' });
  assert.equal(byUid(floating).get('feishu-1')?.value, '2025-04-15T13:00:00Z/2025-04-15T14:00:00Z|tz=America/New_York');
});

test('changed and cancelled occurrences of all-day series', () => {
  const result = parseIcs(crlf(['BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:s', 'DTSTART;VALUE=DATE:20250301', 'RRULE:FREQ=DAILY;UNTIL=20250310', 'SUMMARY:Series', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s', 'RECURRENCE-ID;VALUE=DATE:20250303', 'STATUS:CANCELLED', 'DTSTART;VALUE=DATE:20250303', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s', 'RECURRENCE-ID;VALUE=DATE:20250305', 'DTSTART;VALUE=DATE:20250306', 'SUMMARY:Moved', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:orphan', 'RECURRENCE-ID:20250101T100000Z', 'DTSTART:20250101T110000Z', 'SUMMARY:No series', 'END:VEVENT',
    'END:VCALENDAR']), { timeZone: 'UTC' });
  const events = byUid(result);
  assert.equal(events.get('s')?.value, '2025-03-01|rrule=FREQ=DAILY;UNTIL=20250310|exdate=2025-03-03,2025-03-05');
  assert.equal(events.get('s#2025-03-05')?.value, '2025-03-06');
  assert.equal(events.get('orphan#2025-01-01T10:00:00Z')?.value, '2025-01-01T11:00:00Z');
  assert.equal(result.events.length, 3);
  assert.equal(result.skipped, 1);
});

test('broken input: not a calendar, unbalanced components, bad events, limits', () => {
  assert.throws(() => parseIcs('hello', { timeZone: 'UTC' }), (error: unknown) => error instanceof IcsError && error.code === 'NOT_CALENDAR');
  assert.throws(() => parseIcs('<html>BEGIN:VCALENDAR</html>', { timeZone: 'UTC' }), (error: unknown) => error instanceof IcsError && error.code === 'NOT_CALENDAR');
  assert.throws(() => parseIcs(crlf(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20250101']), { timeZone: 'UTC' }),
    (error: unknown) => error instanceof IcsError && error.code === 'PARSE_FAILED');
  assert.throws(() => parseIcs(crlf(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'END:VTODO', 'END:VCALENDAR']), { timeZone: 'UTC' }),
    (error: unknown) => error instanceof IcsError && error.code === 'PARSE_FAILED');
  const long = 'x'.repeat(300);
  const result = parseIcs('\uFEFF' + crlf(['BEGIN:VCALENDAR', 'garbage line without colon',
    'BEGIN:VEVENT', 'UID:no-start', 'SUMMARY:x', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:bad-date', 'DTSTART;VALUE=DATE:20250230', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:backwards', 'DTSTART:20250101T100000Z', 'DTEND:20250101T090000Z', 'END:VEVENT',
    'BEGIN:VEVENT', `UID:long`, 'DTSTART;VALUE=DATE:20250102', `SUMMARY:${long}`, 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20250103', 'SUMMARY:No uid', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:x1', 'DTSTART;VALUE=DATE:20250104', 'END:VEVENT',
    'END:VCALENDAR']), { timeZone: 'UTC', limit: 3 });
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.events.map(event => event.uid.replace(/^nouid:.*/, 'nouid')), ['backwards', 'long', 'nouid']);
  assert.equal(result.events[0]!.value, '2025-01-01T10:00:00Z');
  assert.equal(result.events[1]!.title.length, 255);
  assert.deepEqual(result.warnings, [{ code: 'EVENT_INVALID', count: 2 }, { code: 'TRUNCATED', count: 1 }, { code: 'VALUE_SHORTENED', count: 1 }]);
  // The same event without a UID gets the same key on every import.
  const again = parseIcs(crlf(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20250103', 'SUMMARY:No uid', 'END:VEVENT', 'END:VCALENDAR']), { timeZone: 'UTC' });
  assert.equal(again.events[0]!.uid, result.events[2]!.uid);
});
