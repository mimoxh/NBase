// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCreateCalDavSourceRequest, isCreateCalendarSubscriptionRequest, isUpdateCalendarSyncRequest, type CalendarSyncConflict, type CalendarSyncSource,
  type OAuthAppsResponse, type OAuthFlowResponse } from '@nbase/contracts';
import { ApiError } from '../persistence/client';
import { ConflictDialog } from './ConflictDialog';
import type { CalendarSyncApi, WorkspaceCalendarSource } from './source';
import { SyncDialog } from './SyncDialog';
import { credentialsUnavailableText } from './syncText';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

const ticks = async () => { for (let i = 0; i < 3; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const render = (node: ReactNode) => act(async () => { root.render(node); await ticks(); });

const setValue = (element: HTMLInputElement | HTMLSelectElement, value: string) => act(() => {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});

const buttons = (scope: ParentNode = document.body) => [...scope.querySelectorAll<HTMLButtonElement>('button')];
const button = (text: string, scope: ParentNode = document.body) => {
  const found = buttons(scope).find(item => item.textContent === text);
  if (!found) throw new Error(`no button ${text}: ${buttons(scope).map(item => item.textContent).join(' | ')}`);
  return found;
};
const click = (element: HTMLElement) => act(async () => { element.click(); await ticks(); });
const caldav = () => document.querySelector<HTMLElement>('section[aria-label="CalDAV 账号"]')!;
const field = <T extends Element>(selector: string, scope: ParentNode = caldav()) => scope.querySelector<T>(selector)!;

const fields = { titleId: 't', dateId: 'd', locationId: 'l', descriptionId: 'x', uidId: 'u' };
const caldavSource = (patch: Partial<CalendarSyncSource> = {}, info: Partial<NonNullable<CalendarSyncSource['caldav']>> = {}): CalendarSyncSource => ({
  id: 's1', databaseId: 'db-1', kind: 'caldav', name: '飞书日历', urlHost: null, intervalMinutes: 30, status: 'idle',
  lastSyncedAt: '2026-11-17T01:00:00Z', lastError: null, lastCounts: { created: 1, updated: 2, unchanged: 3, removed: 0, conflicts: 0, skipped: 0, pushed: 4 },
  warnings: [], eventCount: 6, fields, readOnlyPropertyIds: ['u'],
  caldav: { provider: 'caldav', account: null, serverHost: 'caldav.feishu.cn', calendarName: '工作', writable: true, credentialsOk: true, conflictCount: 0, aggregate: false, ...info }, ...patch,
});

function fakeApi(sources: CalendarSyncSource[] = [], patch: Partial<CalendarSyncApi> = {}) {
  const api = {
    list: vi.fn(async () => ({ sources })),
    importIcs: vi.fn(), subscribe: vi.fn(), update: vi.fn(), run: vi.fn(async () => sources[0]!), remove: vi.fn(async () => undefined),
    discoverCaldav: vi.fn(async () => ({ calendars: [
      { url: 'https://caldav.feishu.cn/cal/work/', name: '工作', color: '#3366ff', writable: true },
      { url: 'https://caldav.feishu.cn/cal/holiday/', name: '节假日', color: null, writable: false },
    ] })),
    createCaldav: vi.fn(async (body: { calendars: { name: string }[] }) =>
      ({ sources: body.calendars.map((choice, index) => caldavSource({ id: `s${index + 1}`, name: choice.name })) })),
    updateCredentials: vi.fn(async () => sources[0]!),
    conflicts: vi.fn(async () => ({ conflicts: [] as CalendarSyncConflict[] })),
    resolveConflict: vi.fn(async () => ({ source: sources[0]! })),
    oauthApps: vi.fn(async () => noApps),
    putGoogleApp: vi.fn(), putMicrosoftApp: vi.fn(), deleteOAuthApp: vi.fn(async () => undefined),
    startOAuth: vi.fn(), oauthFlow: vi.fn(), createOAuthSource: vi.fn(),
    ...patch,
  };
  return api as typeof api & CalendarSyncApi;
}

function calendarSource(api: CalendarSyncApi | undefined, persistent = true) {
  return { persistent, canWrite: true, sync: api, openRow: vi.fn(), openDatabase: vi.fn(), notice: vi.fn() } as unknown as WorkspaceCalendarSource
    & { openRow: ReturnType<typeof vi.fn>; openDatabase: ReturnType<typeof vi.fn> };
}

async function open(api: CalendarSyncApi | undefined, persistent = true) {
  const source = calendarSource(api, persistent);
  const onChanged = vi.fn();
  const onClose = vi.fn();
  await render(<SyncDialog source={source} timeZone="Asia/Shanghai"
    onChanged={onChanged} onClose={onClose} />);
  return { source, onChanged, onClose };
}

async function signIn(username = 'me', password = 'secret') {
  await setValue(field<HTMLInputElement>('input[aria-label="账号"]'), username);
  await setValue(field<HTMLInputElement>('input[type="password"]'), password);
  await click(button('连接', caldav()));
}

describe('CalDAV account section', () => {
  it('explains that the demo has no CalDAV', async () => {
    await open(undefined, false);
    expect(document.body.textContent).toContain('连接 CalDAV 账号');
    expect(document.querySelector('section[aria-label="CalDAV 账号"]')).toBeNull();
  });

  it('discovers calendars, picks several with their database names and starts syncing with a fresh mutation id', async () => {
    const api = fakeApi();
    const { onChanged } = await open(api);
    await setValue(field<HTMLSelectElement>('#nb-wcal-caldav-preset'), 'feishu');
    expect(caldav().textContent).toContain('设置 → 日历 → CalDAV 同步 → 生成');
    const password = field<HTMLInputElement>('input[type="password"]');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    await signIn();
    expect(api.discoverCaldav).toHaveBeenCalledWith({ serverUrl: 'https://caldav.feishu.cn', username: 'me', password: 'secret' });

    const options = [...caldav().querySelectorAll<HTMLElement>('.nb-wcal-caldav-option')];
    expect(options.map(option => option.textContent)).toEqual(['工作', '节假日只读']);
    expect(options[0]!.querySelector<HTMLElement>('.nb-wcal-swatch')!.style.background).not.toBe('');
    const checkbox = (index: number) => options[index]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const dbName = (calendar: string) => caldav().querySelector<HTMLInputElement>(`input[aria-label="「${calendar}」的数据库名称"]`);
    // The first calendar starts checked; each checked calendar names its database after itself.
    expect([checkbox(0).checked, checkbox(1).checked]).toEqual([true, false]);
    expect(dbName('工作')!.value).toBe('工作');
    expect(dbName('节假日')).toBeNull();
    expect(caldav().textContent).not.toContain('只读：');
    await click(checkbox(1));
    expect(dbName('节假日')!.value).toBe('节假日');
    expect(caldav().textContent).toContain('「节假日」只读：只会把外部的变化同步到 NBase');
    await setValue(dbName('工作')!, '飞书工作');
    await setValue(field<HTMLSelectElement>('select[aria-label="同步间隔"]'), '60');
    expect(document.querySelector('select[aria-label="位置"], #nb-wcal-import-parent')).toBeNull();
    // With nothing checked there is nothing to start.
    await click(checkbox(0));
    await click(checkbox(1));
    expect(button('开始同步', caldav()).disabled).toBe(true);
    await click(checkbox(0));
    await click(checkbox(1));
    expect(dbName('工作')!.value).toBe('飞书工作');
    await click(button('开始同步 2 个日历', caldav()));

    expect(api.createCaldav).toHaveBeenCalledTimes(1);
    const body = (api.createCaldav as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ clientMutationId: expect.any(String), serverUrl: 'https://caldav.feishu.cn', username: 'me', password: 'secret',
      calendars: [{ calendarUrl: 'https://caldav.feishu.cn/cal/work/', name: '飞书工作' }, { calendarUrl: 'https://caldav.feishu.cn/cal/holiday/', name: '节假日' }],
      parentId: null, intervalMinutes: 60 });
    expect(field<HTMLInputElement>('input[type="password"]').value).toBe('');
    expect(field<HTMLInputElement>('input[aria-label="账号"]').value).toBe('');
    expect(caldav().querySelector('.nb-wcal-caldav-option')).toBeNull();
    expect(caldav().textContent).toContain('已连接 2 个日历：「飞书工作」「节假日」，首次同步在后台进行。');
    expect(onChanged).toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(JSON.stringify({ ...localStorage })).not.toContain('secret');
  });

  it('retries a lost create with the same mutation id', async () => {
    const api = fakeApi([], { createCaldav: vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_UNAVAILABLE'))
      .mockResolvedValueOnce({ sources: [caldavSource()] }) });
    await open(api);
    await signIn();
    // An emptied name falls back to the calendar's.
    await setValue(caldav().querySelector<HTMLInputElement>('input[aria-label="「工作」的数据库名称"]')!, '  ');
    await click(button('开始同步', caldav()));
    expect(caldav().textContent).toContain('不会重复创建');
    await click(button('重试', caldav()));
    const calls = (api.createCaldav as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0].clientMutationId).toBe(calls[0]![0].clientMutationId);
    expect(calls[1]![0].calendars).toEqual([{ calendarUrl: 'https://caldav.feishu.cn/cal/work/', name: '工作' }]);
  });

  it('drops pasted control characters from database names so the server accepts them', async () => {
    const api = fakeApi();
    await open(api);
    await signIn();
    await click(caldav().querySelector<HTMLInputElement>('input[value="https://caldav.feishu.cn/cal/holiday/"]')!);
    await setValue(caldav().querySelector<HTMLInputElement>('input[aria-label="「工作」的数据库名称"]')!, '工作\t日程\u0007');
    await setValue(caldav().querySelector<HTMLInputElement>('input[aria-label="「节假日」的数据库名称"]')!, '😀'.repeat(60));
    await click(button('开始同步 2 个日历', caldav()));
    const body = (api.createCaldav as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(body.calendars.map((choice: { name: string }) => choice.name)).toEqual(['工作 日程', '😀'.repeat(60)]);
    expect(isCreateCalDavSourceRequest(body)).toBe(true);
  });

  it('connects at most 20 calendars at once', async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({ url: `https://caldav.feishu.cn/cal/${index}/`, name: `日历${index}`, color: null,
      writable: true }));
    const api = fakeApi([], { discoverCaldav: vi.fn(async () => ({ calendars: many })) });
    await open(api);
    await signIn();
    const boxes = [...caldav().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    for (const box of boxes.slice(1)) await click(box);
    expect(caldav().querySelector('[role="alert"]')!.textContent).toContain('一次最多连接 20 个日历');
    expect(button('开始同步 21 个日历', caldav()).disabled).toBe(true);
    await click(boxes[20]!);
    expect(caldav().querySelector('[role="alert"]')).toBeNull();
    await click(button('开始同步 20 个日历', caldav()));
    expect((api.createCaldav as ReturnType<typeof vi.fn>).mock.calls[0]![0].calendars).toHaveLength(20);
  });

  it('explains discovery errors', async () => {
    const discover = vi.fn()
      .mockRejectedValueOnce(new ApiError(422, 'AUTH_FAILED'))
      .mockRejectedValueOnce(new ApiError(422, 'NOT_CALDAV'))
      .mockRejectedValueOnce(new ApiError(422, 'URL_BLOCKED'))
      .mockRejectedValueOnce(new ApiError(422, 'FETCH_FAILED'))
      .mockRejectedValueOnce(new ApiError(0, 'TIMEOUT'));
    await open(fakeApi([], { discoverCaldav: discover }));
    const alert = () => caldav().querySelector('[role="alert"]')?.textContent ?? '';
    await signIn();
    expect(alert()).toContain('账号或密码不正确');
    await click(button('连接', caldav()));
    expect(alert()).toContain('不是 CalDAV 服务器');
    await click(button('连接', caldav()));
    expect(alert()).toContain('需要管理员在服务端开启');
    await click(button('连接', caldav()));
    expect(alert()).toContain('无法连接服务器');
    await click(button('连接', caldav()));
    expect(alert()).toContain('网络不可用');

    await setValue(field<HTMLSelectElement>('#nb-wcal-caldav-preset'), 'custom');
    await setValue(field<HTMLInputElement>('input[aria-label="服务器地址"]'), 'ftp://nas.local');
    await click(button('连接', caldav()));
    expect(alert()).toContain('http(s)');
    expect(discover).toHaveBeenCalledTimes(5);
  });

  it('disables the flow when the server has no credential key', async () => {
    await open(fakeApi([], { discoverCaldav: vi.fn().mockRejectedValue(new ApiError(503, 'CREDENTIALS_UNAVAILABLE')) }));
    await signIn();
    expect(caldav().textContent).toContain(credentialsUnavailableText);
    expect(field<HTMLInputElement>('input[type="password"]').disabled).toBe(true);
    expect(button('连接', caldav()).disabled).toBe(true);
  });
});

describe('CalDAV sources in the list', () => {
  const item = () => document.querySelector<HTMLElement>('[data-source-id="s1"]')!;

  it('cleans subscription and rename names the same way', async () => {
    const api = fakeApi([caldavSource()], { subscribe: vi.fn(async () => caldavSource()), update: vi.fn(async () => caldavSource()) });
    await open(api);
    await setValue(document.querySelector<HTMLInputElement>('#nb-wcal-sub-url')!, 'https://example.com/a.ics');
    await setValue(document.querySelector<HTMLInputElement>('input[aria-label="订阅名称"]')!, '\t课程\t表');
    await click(button('添加订阅'));
    const subscribed = (api.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(subscribed.name).toBe('课程 表');
    expect(isCreateCalendarSubscriptionRequest(subscribed)).toBe(true);
    await click(button('编辑', item()));
    await setValue(item().querySelector<HTMLInputElement>('input[aria-label="名称"]')!, '\t');
    await click(button('保存', item()));
    const [, patch] = (api.update as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(patch.name).toBe('飞书日历');
    expect(isUpdateCalendarSyncRequest(patch)).toBe(true);
  });

  it('shows server, calendar, direction, counts and conflicts, and asks before stopping', async () => {
    const api = fakeApi([caldavSource({ lastError: 'AUTH_FAILED' }, { conflictCount: 2 })]);
    await open(api);
    const text = item().textContent!;
    for (const part of ['飞书日历', 'CalDAV', '双向', 'caldav.feishu.cn', '日历：工作', '每 30 分钟', '写回 4', '有 2 个冲突待处理', '账号或密码不正确'])
      expect(text).toContain(part);
    expect(button('更新密码', item()).className).toContain('nb-btn-primary');
    expect(button('处理冲突（2）', item())).toBeTruthy();
    await click(button('立即同步', item()));
    expect(api.run).toHaveBeenCalledWith('s1');
    await click(button('停止同步', item()));
    expect(item().textContent).toContain('外部日历不会被修改，保存的密码会被删除');
    await click(button('确认停止同步', item()));
    expect(api.remove).toHaveBeenCalledWith('s1');
  });

  it('opens the synced database, which the page tree does not list', async () => {
    const { source, onClose } = await open(fakeApi([caldavSource()]));
    expect(document.body.textContent).toContain('不显示在页面树、搜索和关系图中');
    await click(button('打开数据库', item()));
    expect(onClose).toHaveBeenCalled();
    expect(source.openDatabase).toHaveBeenCalledWith('db-1');
  });

  it('lets a file import stop syncing so its database becomes an ordinary one', async () => {
    const api = fakeApi([caldavSource({ kind: 'ics-file', name: '导入', intervalMinutes: null, caldav: null })]);
    await open(api);
    expect(buttons(item()).map(entry => entry.textContent)).toEqual(['打开数据库', '停止同步']);
    await click(button('停止同步', item()));
    expect(item().textContent).toContain('仍不显示在页面树中');
    expect(item().textContent).toContain('显示到页面树');
    expect(item().textContent).toContain('不能再向它追加导入');
    await click(button('确认停止同步', item()));
    expect(api.remove).toHaveBeenCalledWith('s1');
  });

  it('makes a writable calendar the aggregate calendar after confirming, and turns it off again', async () => {
    const other = caldavSource({ id: 's2', name: '家庭日历' }, { calendarName: '家庭', aggregate: true });
    const api = fakeApi([caldavSource(), other], { update: vi.fn(async () => caldavSource()) });
    await open(api);
    const work = () => document.querySelector<HTMLElement>('[data-source-id="s1"]')!;
    const home = () => document.querySelector<HTMLElement>('[data-source-id="s2"]')!;
    expect(home().textContent).toContain('汇总日历');
    expect(home().textContent).toContain('其他数据库日程也同步到这个日历');
    await click(button('设为汇总日历', work()));
    expect(work().textContent).toContain('会全部写到「工作」');
    expect(work().textContent).toContain('「家庭日历」将不再是汇总日历');
    expect(api.update).not.toHaveBeenCalled();
    await click(button('确认设为汇总日历', work()));
    expect(api.update).toHaveBeenCalledWith('s1', { aggregate: true });
    await click(button('取消汇总', home()));
    expect(home().textContent).toContain('会从外部日历删除');
    await click(button('确认取消汇总', home()));
    expect(api.update).toHaveBeenLastCalledWith('s2', { aggregate: false });
  });

  it('offers no aggregate for a read-only calendar and warns when stopping the aggregate one', async () => {
    await open(fakeApi([caldavSource({}, { writable: false }), caldavSource({ id: 's2' }, { aggregate: true })]));
    expect(buttons(document.querySelector<HTMLElement>('[data-source-id="s1"]')!).map(b => b.textContent)).not.toContain('设为汇总日历');
    const home = document.querySelector<HTMLElement>('[data-source-id="s2"]')!;
    await click(button('停止同步', home));
    expect(home.textContent).toContain('汇总到这个日历的其他数据库日程也停止同步');
  });

  it('offers the aggregate for writable Google and Microsoft calendars and keeps re-authorization for an aggregate one', async () => {
    const oauthInfo = (provider: 'google' | 'microsoft') => provider === 'google'
      ? { provider, account: 'alice@gmail.test', serverHost: 'apidata.googleusercontent.com' } as const
      : { provider, account: 'bob@contoso.test', serverHost: 'graph.microsoft.com' } as const;
    const google = caldavSource({ id: 'g1', name: 'Google 日历' }, { ...oauthInfo('google'), calendarName: 'Alice' });
    const outlook = caldavSource({ id: 'm1', name: 'Outlook', status: 'error', lastError: 'AUTH_FAILED' },
      { ...oauthInfo('microsoft'), calendarName: '日历', aggregate: true });
    const birthdays = caldavSource({ id: 'm2', name: '生日' }, { ...oauthInfo('microsoft'), calendarName: '生日', writable: false });
    const api = fakeApi([google, outlook, birthdays], { update: vi.fn(async () => google) });
    await open(api);
    const of = (id: string) => document.querySelector<HTMLElement>(`[data-source-id="${id}"]`)!;
    expect(buttons(of('m2')).map(b => b.textContent)).not.toContain('设为汇总日历');
    expect(of('m1').textContent).toContain('汇总日历');
    expect(of('m1').textContent).toContain('授权已失效，请重新授权');
    expect(buttons(of('m1')).map(b => b.textContent)).toEqual(expect.arrayContaining(['重新授权', '取消汇总']));
    await click(button('设为汇总日历', of('g1')));
    expect(of('g1').textContent).toContain('会全部写到「Alice」');
    expect(of('g1').textContent).toContain('「Outlook」将不再是汇总日历');
    await click(button('确认设为汇总日历', of('g1')));
    expect(api.update).toHaveBeenCalledWith('g1', { aggregate: true });
    await click(button('停止同步', of('m1')));
    expect(of('m1').textContent).toContain('保存的授权会被删除');
    expect(of('m1').textContent).toContain('汇总到这个日历的其他数据库日程也停止同步');
  });
  it('renames without a URL field and updates the password', async () => {
    const api = fakeApi([caldavSource({}, { writable: false, credentialsOk: false })]);
    await open(api);
    expect(item().textContent).toContain('只读');
    expect(item().textContent).toContain('服务端密钥已更换');
    await click(button('编辑', item()));
    expect(item().querySelector('input[type="url"]')).toBeNull();
    await click(button('取消', item()));
    await click(button('更新密码', item()));
    await setValue(item().querySelector<HTMLInputElement>('input[aria-label="账号"]')!, 'me');
    await setValue(item().querySelector<HTMLInputElement>('input[type="password"]')!, 'new-secret');
    await click(button('保存密码', item()));
    expect(api.updateCredentials).toHaveBeenCalledWith('s1', { username: 'me', password: 'new-secret' });
    expect(item().querySelector('input[type="password"]')).toBeNull();
  });

  it('reports a rejected password without closing the form', async () => {
    const api = fakeApi([caldavSource({ lastError: 'AUTH_FAILED' })], { updateCredentials: vi.fn().mockRejectedValue(new ApiError(422, 'AUTH_FAILED')) });
    await open(api);
    await click(button('更新密码', item()));
    await setValue(item().querySelector<HTMLInputElement>('input[aria-label="账号"]')!, 'me');
    await setValue(item().querySelector<HTMLInputElement>('input[type="password"]')!, 'wrong');
    await click(button('保存密码', item()));
    expect(item().querySelector('input[type="password"]')).not.toBeNull();
    expect(item().textContent).toContain('请使用专用密码');
  });
});

const conflicts: CalendarSyncConflict[] = [
  { rowId: 'r1', copyRowId: 'r1-copy', kind: 'both-changed', detectedAt: '2026-11-17T02:00:00Z',
    local: { title: '周会', value: '2026-11-16T01:00:00Z/2026-11-16T02:00:00Z', location: '三楼', description: '' },
    remote: { title: '周会', value: '2026-11-16T01:00:00Z/2026-11-16T02:00:00Z', location: '四楼', description: '带电脑' } },
  { rowId: 'r2', copyRowId: null, kind: 'remote-deleted', detectedAt: '2026-11-17T02:00:00Z',
    local: { title: '评审', value: '2026-11-18', location: '', description: '' }, remote: null },
  { rowId: 'r3', copyRowId: null, kind: 'local-deleted', detectedAt: '2026-11-17T02:00:00Z',
    local: null, remote: { title: '发布', value: '2026-11-19', location: '', description: '' } },
];

describe('conflict dialog', () => {
  async function show(api: CalendarSyncApi) {
    const onResolved = vi.fn();
    const onOpenRow = vi.fn();
    await render(<ConflictDialog api={api} source={caldavSource({}, { conflictCount: 3 })} timeZone="Asia/Shanghai"
      onOpenRow={onOpenRow} onResolved={onResolved} onClose={() => undefined} />);
    const articles = () => [...document.querySelectorAll<HTMLElement>('article.nb-wcal-conflict')];
    return { onResolved, onOpenRow, articles };
  }

  it('shows both versions side by side and offers both only for both-changed', async () => {
    const { articles, onOpenRow } = await show(fakeApi([], { conflicts: vi.fn(async () => ({ conflicts })) }));
    expect(articles()).toHaveLength(3);
    const [both, remoteDeleted, localDeleted] = articles();
    const sides = [...both!.querySelectorAll('.nb-wcal-conflict-side')];
    expect(sides[0]!.textContent).toContain('NBase 版本');
    expect(sides[0]!.textContent).toContain('三楼');
    expect(sides[0]!.textContent).toMatch(/09:00–10:00/);
    expect(sides[1]!.textContent).toContain('四楼');
    expect(sides[1]!.textContent).toContain('带电脑');
    expect(sides[1]!.querySelectorAll('.nb-wcal-conflict-diff')).toHaveLength(2);
    expect(buttons(both!).map(item => item.textContent)).toEqual(['打开这一行', '打开外部版本副本', '保留 NBase 版本', '保留外部版本', '两份都保留']);
    expect(remoteDeleted!.textContent).toContain('外部已删除');
    expect(buttons(remoteDeleted!).map(item => item.textContent)).not.toContain('两份都保留');
    expect(localDeleted!.textContent).toContain('NBase 中已删除');
    expect(buttons(localDeleted!).map(item => item.textContent)).toEqual(['保留 NBase 版本', '保留外部版本']);
    await click(button('打开外部版本副本', both!));
    expect(onOpenRow).toHaveBeenCalledWith('r1-copy');
  });

  it('resolves a conflict, then refreshes the list and the source', async () => {
    const list = vi.fn().mockResolvedValueOnce({ conflicts }).mockResolvedValueOnce({ conflicts: conflicts.slice(1) });
    const api = fakeApi([], { conflicts: list });
    const { articles, onResolved } = await show(api);
    await click(button('两份都保留', articles()[0]!));
    expect(api.resolveConflict).toHaveBeenCalledWith('s1', 'r1', 'both');
    expect(onResolved).toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(2);
    expect(articles()).toHaveLength(2);
    expect(document.body.textContent).toContain('已处理，正在同步到外部日历。');
  });

  it('asks to wait while syncing and refreshes a conflict that is already gone', async () => {
    const list = vi.fn().mockResolvedValueOnce({ conflicts }).mockResolvedValueOnce({ conflicts: [] });
    const resolve = vi.fn().mockRejectedValueOnce(new ApiError(409, 'SYNC_RUNNING')).mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND'));
    const { articles } = await show(fakeApi([], { conflicts: list, resolveConflict: resolve }));
    await click(button('保留外部版本', articles()[1]!));
    expect(document.body.textContent).toContain('正在同步，请稍后再试。');
    expect(list).toHaveBeenCalledTimes(1);
    await click(button('保留 NBase 版本', articles()[1]!));
    expect(resolve).toHaveBeenLastCalledWith('s1', 'r2', 'local');
    expect(document.body.textContent).toContain('这个冲突已经处理过了。');
    expect(list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('没有待处理的冲突。');
  });

  it('opens from the source list', async () => {
    const api = fakeApi([caldavSource({}, { conflictCount: 3 })], { conflicts: vi.fn(async () => ({ conflicts })) });
    await open(api);
    await click(button('处理冲突（3）'));
    expect(api.conflicts).toHaveBeenCalledWith('s1');
    expect(document.querySelectorAll('article.nb-wcal-conflict')).toHaveLength(3);
  });
});

const noApps: OAuthAppsResponse = { googleRedirectUri: 'https://nbase.example.com/api/calendar/oauth/google/callback', google: null, microsoft: null };
const bothApps: OAuthAppsResponse = { ...noApps, google: { clientId: 'abc.apps.googleusercontent.com' },
  microsoft: { clientId: '11111111-2222-4333-8444-555555555555', tenant: 'common' } };
const googleCalendars = [
  { url: 'https://apidata.googleusercontent.com/caldav/v2/me%40gmail.com/events/', name: '我的日历', color: '#4285f4', writable: true },
  { url: 'https://apidata.googleusercontent.com/caldav/v2/zh.china%23holiday/events/', name: '中国节假日', color: null, writable: false },
];
const pending: OAuthFlowResponse = { status: 'pending', error: null, account: null, calendars: [], source: null };
const ready = (patch: Partial<OAuthFlowResponse> = {}): OAuthFlowResponse =>
  ({ status: 'ready', error: null, account: 'me@gmail.com', calendars: googleCalendars, source: null, ...patch });
const googleStart = { flowId: 'f1', provider: 'google' as const, authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x',
  expiresAt: '2099-01-01T00:00:00Z' };
const microsoftStart = { flowId: 'f2', provider: 'microsoft' as const, userCode: 'ABCD-1234', verificationUri: 'https://microsoft.com/devicelogin',
  expiresAt: '2099-01-01T00:00:00Z', intervalSeconds: 5 };

const google = () => document.querySelector<HTMLElement>('section[aria-label="Google 日历"]')!;
const microsoft = () => document.querySelector<HTMLElement>('section[aria-label="Microsoft 日历"]')!;
const link = (text: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLAnchorElement>('a')].find(item => item.textContent === text) ?? null;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

async function upload(input: HTMLInputElement, content: string, name = 'client_secret.json') {
  const file = new File([content], name, { type: 'application/json' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await ticks(); });
}

function fakeTab() {
  return { closed: false, opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
}

describe('dialog layout', () => {
  // The large dialog has a fixed height and hides its own overflow, so long content must sit in a scroll area.
  const scrollArea = () => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog.modal-large')!;
    const children = [...dialog.children];
    const area = children.find(child => child.classList.contains('modal-scroll'));
    return { dialog, children, area };
  };

  it('scrolls every section of the import and sync dialog', async () => {
    await open(fakeApi([caldavSource()]));
    const { children, area } = scrollArea();
    expect(area).toBeTruthy();
    expect(children.filter(child => child !== area).map(child => child.className)).toEqual(['modal-heading']);
    expect(area!.querySelectorAll('section.nb-wcal-sync-section').length).toBeGreaterThanOrEqual(4);
    expect(area!.querySelector('[data-source-id="s1"]')).toBeTruthy();
  });

  it('scrolls the conflicts and keeps the close button below them', async () => {
    await render(<ConflictDialog api={fakeApi([], { conflicts: vi.fn(async () => ({ conflicts })) })} source={caldavSource({}, { conflictCount: 3 })}
      timeZone="Asia/Shanghai" onResolved={() => undefined} onClose={() => undefined} />);
    const { children, area } = scrollArea();
    expect(area!.querySelectorAll('article.nb-wcal-conflict')).toHaveLength(3);
    expect(children.map(child => child.className)).toEqual(['modal-heading', 'modal-scroll', 'dialog-actions']);
  });
});
describe('Google and Microsoft app setup', () => {
  it('shows the Google guide with the redirect URI and saves an uploaded web client', async () => {
    const put = vi.fn(async () => ({ ...noApps, google: { clientId: 'abc.apps.googleusercontent.com' } }));
    const api = fakeApi([], { putGoogleApp: put });
    await open(api);
    const text = google().textContent!;
    for (const part of ['console.cloud.google.com', 'CalDAV API', 'Google Calendar API', '发布应用', '测试状态下授权 7 天后失效',
      'Web 应用', noApps.googleRedirectUri, 'Google 尚未验证此应用', '局域网 IP 的 http 地址 Google 不接受']) expect(text).toContain(part);
    expect(google().querySelectorAll('ol.nb-wcal-oauth-steps > li')).toHaveLength(5);
    expect(button('复制回调地址', google())).toBeTruthy();
    expect(google().querySelector('[role="alert"]')).toBeNull();

    await upload(field<HTMLInputElement>('input[type="file"]', google()), JSON.stringify({ web: {
      client_id: 'abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret', redirect_uris: [noApps.googleRedirectUri] } }));
    expect(field<HTMLInputElement>('input[aria-label="客户端 ID"]', google()).value).toBe('abc.apps.googleusercontent.com');
    expect(field<HTMLInputElement>('input[aria-label="客户端密钥"]', google()).value).toBe('GOCSPX-secret');
    expect(field<HTMLInputElement>('input[aria-label="客户端密钥"]', google()).type).toBe('password');
    expect(google().textContent).toContain('已读取 client_secret.json');
    expect(google().querySelector('.nb-wcal-oauth-warning')).toBeNull();
    await click(button('保存应用', google()));
    expect(put).toHaveBeenCalledWith({ clientId: 'abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
    expect(google().textContent).toContain('客户端 ID：abc.apps.googleusercontent.com');
    expect(button('连接 Google 账号', google())).toBeTruthy();
    expect(google().querySelector('ol')).toBeNull();
  });

  it('asks for the Google client again when its saved secret no longer opens', async () => {
    const stale: OAuthAppsResponse = { ...bothApps, google: { clientId: bothApps.google!.clientId, secretUnavailable: true } };
    const put = vi.fn(async () => bothApps);
    await open(fakeApi([], { oauthApps: vi.fn(async () => stale), putGoogleApp: put }));
    expect(google().querySelector('[role="alert"]')!.textContent).toContain('服务端凭据密钥已更换');
    expect(field<HTMLInputElement>('input[aria-label="客户端 ID"]', google()).value).toBe(bothApps.google!.clientId);
    const labels = buttons(google()).map(entry => entry.textContent);
    expect(labels).not.toContain('连接 Google 账号');
    expect(labels).not.toContain('取消');
    await upload(field<HTMLInputElement>('input[type="file"]', google()), JSON.stringify({ web: {
      client_id: bothApps.google!.clientId, client_secret: 'GOCSPX-new', redirect_uris: [noApps.googleRedirectUri] } }));
    await click(button('保存应用', google()));
    expect(put).toHaveBeenCalledWith({ clientId: bothApps.google!.clientId, clientSecret: 'GOCSPX-new' });
    expect(google().querySelector('[role="alert"]')).toBeNull();
    expect(button('连接 Google 账号', google())).toBeTruthy();
  });

  it('warns about a missing redirect URI, accepts an installed client and rejects other files', async () => {
    await open(fakeApi());
    const input = () => field<HTMLInputElement>('input[type="file"]', google());
    await upload(input(), JSON.stringify({ web: { client_id: 'abc.apps.googleusercontent.com', client_secret: 's1',
      redirect_uris: ['http://192.168.1.5:4310/api/calendar/oauth/google/callback'] } }));
    expect(google().querySelector('.nb-wcal-oauth-warning')!.textContent).toContain(`没有 ${noApps.googleRedirectUri}`);
    expect(button('保存应用', google()).disabled).toBe(false);

    await upload(input(), JSON.stringify({ installed: { client_id: 'desk.apps.googleusercontent.com', client_secret: 's2' } }));
    expect(google().querySelector('.nb-wcal-oauth-warning')).toBeNull();
    expect(field<HTMLInputElement>('input[aria-label="客户端 ID"]', google()).value).toBe('desk.apps.googleusercontent.com');

    for (const bad of ['not json', JSON.stringify({ other: {} }), JSON.stringify({ web: { client_id: 'abc.apps.googleusercontent.com' } })]) {
      await upload(input(), bad);
      expect(google().querySelector('[role="alert"]')!.textContent).toContain('不是 Google 的客户端 JSON 文件');
    }
  });

  it('warns when the redirect URI is plain http on a LAN address', async () => {
    await open(fakeApi([], { oauthApps: vi.fn(async () => ({ ...noApps, googleRedirectUri: 'http://192.168.1.5:4310/api/calendar/oauth/google/callback' })) }));
    expect(google().querySelector('[role="alert"]')!.textContent).toContain('Google 不会接受');
  });

  it('checks the Microsoft client ID and tenant before saving', async () => {
    const put = vi.fn(async () => ({ ...noApps, microsoft: { clientId: '11111111-2222-4333-8444-555555555555', tenant: 'consumers' } }));
    await open(fakeApi([], { putMicrosoftApp: put }));
    const text = microsoft().textContent!;
    for (const part of ['entra.microsoft.com', '任何组织目录中的帐户和个人 Microsoft 帐户', '允许公共客户端流', 'Calendars.ReadWrite', 'Azure'])
      expect(text).toContain(part);
    const tenant = field<HTMLInputElement>('#nb-wcal-microsoft-tenant', microsoft());
    expect(tenant.value).toBe('common');
    await setValue(field<HTMLInputElement>('#nb-wcal-microsoft-client', microsoft()), 'not-a-guid');
    await click(button('保存应用', microsoft()));
    expect(microsoft().querySelector('[role="alert"]')!.textContent).toContain('客户端 ID 格式不对');
    await setValue(field<HTMLInputElement>('#nb-wcal-microsoft-client', microsoft()), '11111111-2222-4333-8444-555555555555');
    await setValue(tenant, 'not a tenant');
    await click(button('保存应用', microsoft()));
    expect(microsoft().querySelector('[role="alert"]')!.textContent).toContain('租户格式不对');
    expect(put).not.toHaveBeenCalled();
    await setValue(tenant, 'consumers');
    await click(button('保存应用', microsoft()));
    expect(put).toHaveBeenCalledWith({ clientId: '11111111-2222-4333-8444-555555555555', tenant: 'consumers' });
    expect(microsoft().textContent).toContain('租户：consumers');
    expect(button('连接 Microsoft 账号', microsoft())).toBeTruthy();
  });

  it('replaces and deletes an app, and explains an app still in use', async () => {
    const remove = vi.fn().mockRejectedValueOnce(new ApiError(409, 'OAUTH_APP_IN_USE')).mockResolvedValueOnce(undefined);
    await open(fakeApi([], { oauthApps: vi.fn(async () => bothApps), deleteOAuthApp: remove }));
    await click(button('更换应用', microsoft()));
    expect(field<HTMLInputElement>('#nb-wcal-microsoft-client', microsoft()).value).toBe(bothApps.microsoft!.clientId);
    await click(button('取消', microsoft()));
    await click(button('删除应用', google()));
    expect(remove).toHaveBeenCalledWith('google');
    expect(google().querySelector('[role="alert"]')!.textContent).toContain('还有同步来源在使用这个应用，先停止这些来源的同步');
    await click(button('删除应用', google()));
    expect(google().querySelector('ol.nb-wcal-oauth-steps')).not.toBeNull();
    expect(button('连接 Microsoft 账号', microsoft())).toBeTruthy();
  });

  it('disables the sections when the server has no credential key', async () => {
    await open(fakeApi([], { oauthApps: vi.fn(async () => bothApps), startOAuth: vi.fn().mockRejectedValue(new ApiError(503, 'CREDENTIALS_UNAVAILABLE')) }));
    await click(button('连接 Microsoft 账号', microsoft()));
    expect(microsoft().textContent).toContain(credentialsUnavailableText);
    expect(google().textContent).toContain(credentialsUnavailableText);
    expect(button('连接 Google 账号', google()).disabled).toBe(true);
  });

  it('shows only the key notice when reading the apps already reports no credential key', async () => {
    await open(fakeApi([], { oauthApps: vi.fn().mockRejectedValue(new ApiError(503, 'CREDENTIALS_UNAVAILABLE')) }));
    for (const section of [google(), microsoft()]) {
      expect(section.textContent).toContain(credentialsUnavailableText);
      expect(section.textContent).not.toContain('正在读取应用设置');
      expect(section.querySelector('button')).toBeNull();
    }
  });
});

describe('connecting Google and Microsoft accounts', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens the tab before the start request, polls until ready and creates the source', async () => {
    const tab = fakeTab();
    const openTab = vi.fn(() => tab);
    vi.stubGlobal('open', openTab);
    let resolveStart!: (value: typeof googleStart) => void;
    const start = vi.fn(() => new Promise<typeof googleStart>(resolve => { resolveStart = resolve; }));
    const flow = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(ready());
    const create = vi.fn(async (body: { calendars: { name: string }[] }) =>
      ({ sources: body.calendars.map(choice => caldavSource({ name: choice.name }, { provider: 'google', account: 'me@gmail.com' })) }));
    const api = fakeApi([], { oauthApps: vi.fn(async () => bothApps), startOAuth: start, oauthFlow: flow, createOAuthSource: create });
    const { onChanged } = await open(api);

    await click(button('连接 Google 账号', google()));
    expect(openTab).toHaveBeenCalledWith('', '_blank');
    expect(start).toHaveBeenCalledWith({ provider: 'google' });
    expect(google().textContent).toContain('正在连接');
    await act(async () => { resolveStart(googleStart); await ticks(); });
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).toHaveBeenCalledWith(googleStart.authorizeUrl);
    expect(google().textContent).toContain('请在新标签页里完成授权');
    const reopen = link('重新打开授权页', google())!;
    expect(reopen.href).toBe(googleStart.authorizeUrl);
    expect(reopen.rel).toContain('noopener');
    expect(flow).not.toHaveBeenCalled();

    await advance(2000);
    expect(flow).toHaveBeenCalledTimes(1);
    expect(flow.mock.calls[0]![0]).toBe('f1');
    expect(google().textContent).toContain('请在新标签页里完成授权');
    await advance(2000);
    expect(flow).toHaveBeenCalledTimes(2);
    expect(google().textContent).toContain('已登录：me@gmail.com');
    const options = [...google().querySelectorAll<HTMLElement>('.nb-wcal-caldav-option')];
    expect(options.map(option => option.textContent)).toEqual(['我的日历', '中国节假日只读']);
    expect(options[0]!.querySelector<HTMLElement>('.nb-wcal-swatch')!.style.background).not.toBe('');
    const dbName = (calendar: string) => google().querySelector<HTMLInputElement>(`input[aria-label="「${calendar}」的数据库名称"]`);
    expect(dbName('我的日历')!.value).toBe('我的日历');
    await click(options[1]!.querySelector('input')!);
    expect(button('开始同步 2 个日历', google())).toBeTruthy();
    await click(options[0]!.querySelector('input')!);
    expect(dbName('我的日历')).toBeNull();
    expect(dbName('中国节假日')!.value).toBe('中国节假日');
    expect(google().textContent).toContain('这个日历只读');
    await setValue(field<HTMLSelectElement>('select[aria-label="同步间隔"]', google()), '60');
    await click(button('开始同步', google()));

    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(body).toEqual({ clientMutationId: expect.any(String), flowId: 'f1',
      calendars: [{ calendarUrl: googleCalendars[1]!.url, name: '中国节假日' }], intervalMinutes: 60 });
    expect(google().textContent).toContain('已连接「中国节假日」');
    expect(button('连接 Google 账号', google())).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(2);
    await advance(4000);
    expect(flow).toHaveBeenCalledTimes(2);
  });

  it('offers a link when the browser blocks the tab', async () => {
    vi.stubGlobal('open', vi.fn(() => null));
    await open(fakeApi([], { oauthApps: vi.fn(async () => bothApps), startOAuth: vi.fn(async () => googleStart),
      oauthFlow: vi.fn(async () => pending) }));
    await click(button('连接 Google 账号', google()));
    expect(google().textContent).toContain('浏览器拦截了新标签页');
    expect(link('打开授权页', google())!.href).toBe(googleStart.authorizeUrl);
  });

  it('shows the Microsoft code and polls at the given interval', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const openTab = vi.fn();
    vi.stubGlobal('open', openTab);
    const flow = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(ready({ account: 'me@outlook.com' }));
    await open(fakeApi([], { oauthApps: vi.fn(async () => bothApps), startOAuth: vi.fn(async () => microsoftStart), oauthFlow: flow }));
    await click(button('连接 Microsoft 账号', microsoft()));
    expect(openTab).not.toHaveBeenCalled();
    expect(microsoft().querySelector('.nb-wcal-oauth-code')!.textContent).toBe('ABCD-1234');
    expect(microsoft().textContent).toContain('打开微软登录页，输入上面的代码并登录');
    const login = link('打开微软登录页', microsoft())!;
    expect(login.href).toBe(microsoftStart.verificationUri);
    expect(login.target).toBe('_blank');
    await click(button('复制代码', microsoft()));
    expect(writeText).toHaveBeenCalledWith('ABCD-1234');
    expect(button('已复制', microsoft())).toBeTruthy();

    await advance(4000);
    expect(flow).not.toHaveBeenCalled();
    await advance(1000);
    expect(flow).toHaveBeenCalledTimes(1);
    await advance(5000);
    expect(flow).toHaveBeenCalledTimes(2);
    expect(microsoft().textContent).toContain('已登录：me@outlook.com');
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('explains failed flows and retries', async () => {
    const flow = vi.fn()
      .mockResolvedValueOnce({ ...pending, status: 'failed', error: 'OAUTH_DENIED' })
      .mockResolvedValueOnce({ ...pending, status: 'failed', error: 'API_DISABLED' })
      .mockResolvedValueOnce({ ...pending, status: 'failed', error: 'OAUTH_FAILED' });
    const start = vi.fn(async () => microsoftStart);
    await open(fakeApi([], { oauthApps: vi.fn(async () => bothApps), startOAuth: start, oauthFlow: flow }));
    const alert = () => microsoft().querySelector('[role="alert"]')?.textContent ?? '';
    await click(button('连接 Microsoft 账号', microsoft()));
    await advance(5000);
    expect(alert()).toContain('你拒绝了授权，或没有勾选日历权限');
    await click(button('重试', microsoft()));
    expect(start).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(alert()).toContain('项目没有启用 CalDAV API 或 Google Calendar API');
    await click(button('重试', microsoft()));
    await advance(5000);
    expect(alert()).toContain('Microsoft 需允许公共客户端流');
    await advance(10000);
    expect(flow).toHaveBeenCalledTimes(3);
    await click(button('取消', microsoft()));
    expect(button('连接 Microsoft 账号', microsoft())).toBeTruthy();
  });

  it('keeps polling through network errors and stops when the flow is gone', async () => {
    const flow = vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_UNAVAILABLE'))
      .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE'))
      .mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND'));
    vi.stubGlobal('open', vi.fn(() => fakeTab()));
    await open(fakeApi([], { oauthApps: vi.fn(async () => bothApps), startOAuth: vi.fn(async () => googleStart), oauthFlow: flow }));
    await click(button('连接 Google 账号', google()));
    await advance(2000);
    await advance(2000);
    expect(google().querySelector('[role="alert"]')).toBeNull();
    await advance(2000);
    expect(flow).toHaveBeenCalledTimes(3);
    expect(google().querySelector('[role="alert"]')!.textContent).toContain('流程已过期，请重新连接');
    await advance(6000);
    expect(flow).toHaveBeenCalledTimes(3);
  });

  it('stops at the expiry time, on cancel and when the dialog closes', async () => {
    const flow = vi.fn(async () => pending);
    const start = vi.fn(async () => ({ ...microsoftStart, expiresAt: new Date(Date.now() + 7000).toISOString() }));
    await open(fakeApi([], { oauthApps: vi.fn(async () => bothApps), startOAuth: start, oauthFlow: flow }));
    await click(button('连接 Microsoft 账号', microsoft()));
    await advance(5000);
    await advance(5000);
    expect(flow).toHaveBeenCalledTimes(1);
    expect(microsoft().querySelector('[role="alert"]')!.textContent).toContain('授权超时');

    start.mockResolvedValue(microsoftStart);
    await click(button('重试', microsoft()));
    await click(button('取消', microsoft()));
    await advance(10000);
    expect(flow).toHaveBeenCalledTimes(1);

    await click(button('连接 Microsoft 账号', microsoft()));
    await act(() => root.unmount());
    root = createRoot(host);
    await advance(10000);
    expect(flow).toHaveBeenCalledTimes(1);
  });

  it('explains start errors and reloads the apps when one is missing', async () => {
    const apps = vi.fn(async () => bothApps);
    const start = vi.fn()
      .mockRejectedValueOnce(new ApiError(422, 'OAUTH_FAILED'))
      .mockRejectedValueOnce(new ApiError(422, 'OAUTH_APP_MISSING'));
    await open(fakeApi([], { oauthApps: apps, startOAuth: start }));
    await click(button('连接 Microsoft 账号', microsoft()));
    expect(microsoft().querySelector('[role="alert"]')!.textContent).toContain('服务商拒绝了这个应用');
    await click(button('重试', microsoft()));
    expect(microsoft().querySelector('[role="alert"]')!.textContent).toContain('还没有配置这个服务商的 OAuth 应用');
    expect(apps).toHaveBeenCalledTimes(2);
  });
});

describe('OAuth sources in the list', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });
  const item = () => document.querySelector<HTMLElement>('[data-source-id="s1"]')!;
  const googleSource = (patch: Partial<CalendarSyncSource> = {}, info: Partial<NonNullable<CalendarSyncSource['caldav']>> = {}) =>
    caldavSource({ name: 'Google 日历', ...patch }, { provider: 'google', account: 'me@gmail.com',
      serverHost: 'apidata.googleusercontent.com', calendarName: '我的日历', ...info });

  it('shows provider, account and calendar, and re-authorizes instead of asking for a password', async () => {
    const tab = fakeTab();
    vi.stubGlobal('open', vi.fn(() => tab));
    const updated = googleSource({ status: 'running' });
    const start = vi.fn(async () => googleStart);
    const flow = vi.fn(async () => ready({ calendars: [], source: updated }));
    const list = vi.fn().mockResolvedValueOnce({ sources: [googleSource({ lastError: 'AUTH_FAILED' })] }).mockResolvedValue({ sources: [updated] });
    const api = fakeApi([], { list, startOAuth: start, oauthFlow: flow });
    const { onChanged } = await open(api);
    const text = item().textContent!;
    for (const part of ['Google', 'me@gmail.com', '日历：我的日历', '授权已失效，请重新授权']) expect(text).toContain(part);
    expect(text).not.toContain('apidata.googleusercontent.com');
    expect(buttons(item()).map(entry => entry.textContent)).not.toContain('更新密码');
    await click(button('重新授权', item()));
    expect(start).toHaveBeenCalledWith({ provider: 'google', sourceId: 's1' });
    expect(tab.location.replace).toHaveBeenCalledWith(googleStart.authorizeUrl);
    expect(item().textContent).toContain('请在新标签页里完成授权');
    await advance(2000);
    expect(item().textContent).toContain('已重新授权，正在同步');
    expect(item().textContent).toContain('同步中');
    expect(buttons(item()).map(entry => entry.textContent)).not.toContain('重新授权');
    expect(onChanged).toHaveBeenCalled();
    await click(button('停止同步', item()));
    expect(item().textContent).toContain('保存的授权会被删除');
  });

  it('asks Microsoft sources with unreadable tokens or a missing app to authorize again', async () => {
    const start = vi.fn(async () => microsoftStart);
    const flow = vi.fn(async () => ({ ...pending, status: 'failed' as const, error: 'ACCOUNT_MISMATCH' as const }));
    await open(fakeApi([caldavSource({ name: 'Outlook' }, { provider: 'microsoft', account: 'me@outlook.com', credentialsOk: false })],
      { startOAuth: start, oauthFlow: flow }));
    expect(item().textContent).toContain('Microsoft');
    expect(item().textContent).toContain('保存的授权无法读取');
    expect(buttons(item()).map(entry => entry.textContent)).not.toContain('更新密码');
    await click(button('重新授权', item()));
    expect(start).toHaveBeenCalledWith({ provider: 'microsoft', sourceId: 's1' });
    expect(item().querySelector('.nb-wcal-oauth-code')!.textContent).toBe('ABCD-1234');
    await advance(5000);
    expect(item().textContent).toContain('登录的不是这个来源原来的账号');
    await click(button('取消', item()));
    expect(button('重新授权', item())).toBeTruthy();
  });

  it('keeps reloading for a while after 立即同步, since the queued run may start and finish between reloads', async () => {
    const before = googleSource();
    const list = vi.fn().mockResolvedValueOnce({ sources: [before] }).mockResolvedValueOnce({ sources: [before] })
      .mockResolvedValueOnce({ sources: [before] }).mockResolvedValue({ sources: [googleSource({ status: 'error', lastError: 'AUTH_FAILED' })] });
    await open(fakeApi([before], { list }));
    await click(button('立即同步', item()));
    expect(item().textContent).not.toContain('授权已失效');
    await advance(3000);
    await advance(3000);
    expect(item().textContent).toContain('授权已失效，请重新授权');
    expect(button('重新授权', item())).toBeTruthy();
    await advance(30_000);
    const calls = list.mock.calls.length;
    await advance(9000);
    expect(list.mock.calls.length).toBe(calls);
  });

  it('offers neither a password nor re-authorization to a healthy OAuth source', async () => {
    await open(fakeApi([googleSource()]));
    const labels = buttons(item()).map(entry => entry.textContent);
    expect(labels).not.toContain('更新密码');
    expect(labels).not.toContain('重新授权');
    expect(labels).toContain('立即同步');
    await open(fakeApi([googleSource({ lastError: 'OAUTH_APP_MISSING' })]));
    expect(item().textContent).toContain('OAuth 应用已移除');
    expect(button('重新授权', item())).toBeTruthy();
  });
});
