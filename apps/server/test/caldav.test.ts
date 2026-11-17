import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CalDavClient, CalDavError, caldavServerUrl, guardedDavTransport, hrefKey, normalizeColor, parseMultistatus } from '../src/calendar/caldav/client.js';
import { parseXml, XmlError } from '../src/calendar/caldav/xml.js';
import { parseIcs } from '../src/calendar/ics.js';
import { buildIcsResource, patchIcsResource, vtimezoneLines } from '../src/calendar/icsWrite.js';
import { keptPropertyIds, changesKeptField } from '../src/calendar/locks.js';
import { serverConfig } from '../src/config.js';
import { anyPortTarget, guardedRequest, sameSiteRedirect } from '../src/net/guardedFetch.js';
import { credentialKeyFromText, loadCredentialKey, openCredentials, sealCredentials } from '../src/secrets/credentials.js';
import { icsText, MockCalDav } from './caldav-mock.js';

const keyText = Buffer.alloc(32, 7).toString('base64');
const otherKeyText = Buffer.alloc(32, 9).toString('base64');
const fields = { titleId: 't', dateId: 'd', locationId: 'l', descriptionId: 'x', uidId: 'u' };

test('credentials are sealed per source and refuse other keys and owners', () => {
  const key = credentialKeyFromText(`${keyText}\n`);
  assert.match(key.id, /^[0-9a-f]{16}$/);
  const account = { username: 'alice', password: 'p@ss 密码' };
  const sealed = sealCredentials(key, 'source-1', account);
  assert.equal(sealed[0], 1);
  assert.ok(!sealed.includes(Buffer.from('p@ss')));
  assert.deepEqual(openCredentials(key, 'source-1', sealed, key.id), account);
  assert.equal(openCredentials(key, 'source-2', sealed, key.id), null);
  const other = credentialKeyFromText(otherKeyText);
  assert.notEqual(other.id, key.id);
  assert.equal(openCredentials(other, 'source-1', sealed, key.id), null);
  assert.equal(openCredentials(other, 'source-1', sealed, null), null);
  const damaged = Buffer.from(sealed);
  damaged[20] = damaged[20]! ^ 1;
  assert.equal(openCredentials(key, 'source-1', damaged, key.id), null);
  assert.throws(() => credentialKeyFromText('not base64!'), /base64/);
  assert.throws(() => credentialKeyFromText(Buffer.alloc(16).toString('base64')), /32 bytes/);
});

test('credential key file and CalDAV private mode configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nbase-key-'));
  try {
    const good = join(dir, 'key');
    await writeFile(good, `${keyText}\n`);
    const bad = join(dir, 'bad');
    await writeFile(bad, 'short\n');
    assert.equal(await loadCredentialKey({}), null);
    assert.equal((await loadCredentialKey({ NBASE_CREDENTIAL_KEY_FILE: good }))?.id, credentialKeyFromText(keyText).id);
    await assert.rejects(loadCredentialKey({ NBASE_CREDENTIAL_KEY_FILE: bad }), /base64|32 bytes/);
    await assert.rejects(loadCredentialKey({ NBASE_CREDENTIAL_KEY_FILE: join(dir, 'none') }), /cannot be read/);
    assert.equal((await serverConfig({ NBASE_CALDAV_PRIVATE: 'allow' })).caldavPrivate, true);
    assert.equal((await serverConfig({})).caldavPrivate, false);
    assert.equal((await serverConfig({})).credentialKey, null);
    await assert.rejects(serverConfig({ NBASE_CALDAV_PRIVATE: 'yes' }), /NBASE_CALDAV_PRIVATE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CalDAV addresses: https and public by default, private servers only when allowed', () => {
  assert.equal(caldavServerUrl('caldav.example.com', false).toString(), 'https://caldav.example.com/');
  assert.equal(caldavServerUrl(' https://caldav.example.com/dav ', false).pathname, '/dav');
  const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (error) { return error instanceof CalDavError ? error.code : String(error); } };
  assert.equal(code(() => caldavServerUrl('http://caldav.example.com', false)), 'URL_BLOCKED');
  assert.equal(code(() => caldavServerUrl('https://127.0.0.1', false)), 'URL_BLOCKED');
  assert.equal(code(() => caldavServerUrl('https://localhost', false)), 'URL_BLOCKED');
  assert.equal(code(() => caldavServerUrl('https://caldav.example.com:8443', false)), 'URL_BLOCKED');
  assert.equal(code(() => caldavServerUrl('ftp://x', false)), 'URL_INVALID');
  assert.equal(code(() => caldavServerUrl('http://127.0.0.1:5232', true)), 'ok');
  assert.equal(code(() => caldavServerUrl('http://192.168.1.20:8080', true)), 'ok');
  assert.equal(code(() => caldavServerUrl('https://192.168.1.20:8443', true)), 'ok');
  // Passwords never go over plain http to a public address.
  assert.equal(code(() => caldavServerUrl('http://8.8.8.8', true)), 'URL_BLOCKED');
});

test('redirects keep credentials only within the same site', () => {
  const u = (s: string) => new URL(s);
  assert.equal(sameSiteRedirect(u('https://caldav.icloud.com/'), u('https://p52-caldav.icloud.com/x')), true);
  assert.equal(sameSiteRedirect(u('https://caldav.icloud.com/'), u('https://caldav.icloud.com/y')), true);
  assert.equal(sameSiteRedirect(u('https://caldav.icloud.com/'), u('https://evil.com/')), false);
  assert.equal(sameSiteRedirect(u('https://example.com/'), u('https://other.example.com/')), false);
  assert.equal(sameSiteRedirect(u('https://caldav.feishu.cn/'), u('https://feishu.cn.evil.com/')), false);
  assert.equal(sameSiteRedirect(u('http://127.0.0.1:1/'), u('http://127.0.0.2:1/')), false);
});

test('multistatus parsing, XML safety and helpers', () => {
  const base = new URL('https://dav.example.com/cal/');
  const status = parseMultistatus(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/cal/a%20b.ics</D:href>
    <D:propstat><D:prop><D:getetag>"1"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    <D:response><D:href>/cal/gone.ics</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>
    <D:sync-token>tok-2</D:sync-token></D:multistatus>`, base);
  assert.equal(status.items.length, 2);
  assert.equal(status.items[0]!.url.toString(), 'https://dav.example.com/cal/a%20b.ics');
  assert.equal(status.items[1]!.status, 404);
  assert.equal(status.syncToken, 'tok-2');
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>'), XmlError);
  assert.throws(() => parseMultistatus('<x xmlns="DAV:"/>', base), (error: unknown) => error instanceof CalDavError && error.code === 'NOT_CALDAV');
  assert.equal(hrefKey('https://Dav.example.com/cal/a%20b.ics'), hrefKey('https://dav.example.com/cal/a b.ics'));
  assert.equal(normalizeColor('#FF00AAFF'), '#ff00aa');
  assert.equal(normalizeColor('#abc'), '#aabbcc');
  assert.equal(normalizeColor('red'), null);
});

test('guarded requests reach a server given by host name, not only by address', async () => {
  const [first] = await lookup('localhost', { all: true, verbatim: true });
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise<void>(resolve => server.listen(0, first!.address, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await guardedRequest(new URL(`http://localhost:${port}/`), { method: 'GET', headers: {}, timeoutMs: 5000,
      maxBytes: 1000, maxRedirects: 0, oversize: 'error', target: anyPortTarget, addresses: 'private' });
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), 'ok');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('discovery against a CalDAV server: well-known redirect, principal, home, calendars', async () => {
  const mock = new MockCalDav();
  mock.addCalendar('work', { name: '工作', writable: true, color: '#3366FFFF' });
  mock.addCalendar('holidays', { name: '节假日', writable: false });
  mock.addCalendar('tasks', { name: '任务', writable: true, components: ['VTODO'] });
  await mock.start();
  try {
    const transport = guardedDavTransport(true);
    const client = new CalDavClient(transport, { username: mock.username, password: mock.password }, true);
    const calendars = await client.discover(caldavServerUrl(mock.origin, true));
    assert.deepEqual(calendars.map(c => [c.name, c.writable, c.color]), [['工作', true, '#3366ff'], ['节假日', false, null]]);
    assert.ok(calendars[0]!.url.endsWith('/dav/calendars/alice/work/'));
    assert.equal(mock.requests[0]?.path, '/.well-known/caldav');
    const wrong = new CalDavClient(transport, { username: mock.username, password: 'nope' }, true);
    await assert.rejects(wrong.discover(caldavServerUrl(mock.origin, true)), (error: unknown) => error instanceof CalDavError && error.code === 'AUTH_FAILED');
    // Without private mode the same server is refused before any request.
    const before = mock.requests.length;
    const strict = new CalDavClient(guardedDavTransport(false), { username: mock.username, password: mock.password }, false);
    await assert.rejects(strict.discover(new URL(mock.origin)), (error: unknown) => error instanceof CalDavError && error.code === 'URL_BLOCKED');
    assert.equal(mock.requests.length, before);
    const state = await client.calendarState(new URL(calendars[0]!.url));
    assert.equal(state.writable, true);
    assert.equal(state.syncToken, 'http://mock.test/sync/1');
    await assert.rejects(client.calendarState(new URL('/dav/calendars/alice/none/', mock.origin)),
      (error: unknown) => error instanceof CalDavError && error.code === 'CALENDAR_NOT_FOUND');
  } finally { await mock.close(); }
});

const roundTrip = (text: string) => parseIcs(text, { timeZone: 'Asia/Shanghai', details: true }).events
  .map(e => ({ uid: e.uid, title: e.title, value: e.value, location: e.location, description: e.description }));

test('new resources read back as the same events', () => {
  const source = icsText([
    ['UID:a', 'DTSTART;VALUE=DATE:20260312', 'DTEND;VALUE=DATE:20260314', 'SUMMARY:出差; 北京, 上海', 'DESCRIPTION:第一行\\n第二行'],
    ['UID:b', 'DTSTART:20260310T010000Z', 'DTEND:20260310T013000Z', 'SUMMARY:站会', 'LOCATION:一号会议室'],
    ['UID:c', 'DTSTART;TZID=Asia/Shanghai:20260302T090000', 'DTEND;TZID=Asia/Shanghai:20260302T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'EXDATE;TZID=Asia/Shanghai:20260309T090000', 'SUMMARY:周会'],
    ['UID:d', 'DTSTART;TZID=America/New_York:20260302T090000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=40', 'SUMMARY:跨夏令时'],
  ], ['X-WR-TIMEZONE:Asia/Shanghai']);
  for (const event of roundTrip(source)) {
    const built = buildIcsResource(`${event.uid}-new`, event, Date.UTC(2026, 0, 1));
    assert.match(built, /\r\nEND:VCALENDAR\r\n$/);
    for (const line of built.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
    const [back] = roundTrip(built);
    assert.deepEqual({ ...back, uid: event.uid }, event);
  }
  assert.throws(() => buildIcsResource('x', { title: 'x', value: '', location: '', description: '' }, 0));
});

test('patching keeps what NBase does not know and replaces the synced properties', () => {
  const original = icsText([
    ['UID:s', 'SEQUENCE:3', 'DTSTAMP:20250101T000000Z', 'DTSTART:20260301T010000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=5',
      'SUMMARY:原标题', 'ATTENDEE;CN=Bob:mailto:bob@example.test', 'X-CUSTOM:keep me', 'CATEGORIES:A,B',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM'],
    ['UID:s', 'RECURRENCE-ID:20260302T010000Z', 'DTSTART:20260302T020000Z', 'DTEND:20260302T030000Z', 'SUMMARY:改过的一次'],
    ['UID:s', 'RECURRENCE-ID:20260303T010000Z', 'DTSTART:20260303T020000Z', 'DTEND:20260303T030000Z', 'SUMMARY:另一次'],
  ]);
  const events = parseIcs(original, { timeZone: 'UTC', details: true }).events;
  const series = events.find(e => e.uid === 's')!;
  assert.deepEqual(series.overrides, ['2026-03-02T01:00:00Z', '2026-03-03T01:00:00Z']);
  assert.equal(series.attendees, true);
  assert.equal(series.component, 0);
  assert.equal(events.find(e => e.uid === 's#2026-03-03T01:00:00Z')?.component, 2);
  assert.match(series.value, /exdate=/);

  // Edit the series, drop the second override: its day becomes a real exclusion, the first stays an override.
  const patched = patchIcsResource(original, { edits: [{ component: 0, event: { ...series, title: '新标题', location: '二号会议室' },
    keep: series.overrides!.filter(p => p !== '2026-03-03T01:00:00Z') }], drop: [2] }, Date.UTC(2026, 1, 1));
  assert.match(patched, /SUMMARY:新标题/);
  assert.match(patched, /LOCATION:二号会议室/);
  assert.match(patched, /SEQUENCE:4/);
  assert.match(patched, /DTSTAMP:20260201T000000Z/);
  assert.doesNotMatch(patched, /DURATION/);
  assert.match(patched, /ATTENDEE;CN=Bob/);
  assert.match(patched, /X-CUSTOM:keep me/);
  assert.match(patched, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM/);
  assert.match(patched, /SUMMARY:改过的一次/);
  assert.doesNotMatch(patched, /另一次/);
  const exdates = /EXDATE[^\r]*/.exec(patched)?.[0] ?? '';
  assert.match(exdates, /20260303T010000Z/);
  assert.doesNotMatch(exdates, /20260302/);
  const again = parseIcs(patched, { timeZone: 'UTC', details: true }).events;
  assert.deepEqual(again.map(e => e.uid), ['s', 's#2026-03-02T01:00:00Z']);
  assert.equal(again[0]!.value, series.value);

  // Without editing the series, a dropped override is excluded explicitly.
  const excluded = patchIcsResource(original, { edits: [], drop: [1], exclude: [{ component: 0, points: ['2026-03-02T01:00:00Z'] }] }, 0);
  const third = parseIcs(excluded, { timeZone: 'UTC', details: true }).events;
  assert.equal(third.find(e => e.uid === 's')!.value, series.value);
  assert.equal(third.length, 2);
});

test('generated time zones follow the clock changes of the year', () => {
  const ny = vtimezoneLines('America/New_York', 2026).join('\n');
  assert.match(ny, /BEGIN:DAYLIGHT\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nDTSTART:19700308T020000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU/);
  assert.match(ny, /BEGIN:STANDARD\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nDTSTART:19701101T020000\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU/);
  const sh = vtimezoneLines('Asia/Shanghai', 2026).join('\n');
  assert.match(sh, /TZOFFSETFROM:\+0800\nTZOFFSETTO:\+0800/);
  assert.doesNotMatch(sh, /DAYLIGHT/);
});

test('CalDAV field locks: the external ID always, everything for read-only calendars and attendee rows', () => {
  assert.deepEqual(keptPropertyIds({ kind: 'caldav', fields_json: fields, caldav_json: { writable: true } }), ['u']);
  assert.equal(keptPropertyIds({ kind: 'caldav', fields_json: fields, caldav_json: { writable: false } }).length, 5);
  assert.deepEqual(keptPropertyIds({ kind: 'ics-file', fields_json: fields }), []);
  const lock = { propertyIds: new Set(['u']), titleKept: false, rowPropertyIds: new Set(Object.values(fields)), rows: new Set(['r1']) };
  assert.equal(changesKeptField(lock, { title: '新', previousTitle: '旧', rowId: 'r2' }), false);
  assert.equal(changesKeptField(lock, { properties: { d: '2026-01-01' }, previous: {}, rowId: 'r2' }), false);
  assert.equal(changesKeptField(lock, { properties: { u: 'x' }, previous: {}, rowId: 'r2' }), true);
  assert.equal(changesKeptField(lock, { title: '新', previousTitle: '旧', rowId: 'R1' }), true);
  assert.equal(changesKeptField(lock, { properties: { d: '2026-01-01' }, previous: {}, rowId: 'r1' }), true);
});
