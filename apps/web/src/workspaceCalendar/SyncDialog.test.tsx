// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarSyncConflict, CalendarSyncSource } from '@nbase/contracts';
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
  caldav: { serverHost: 'caldav.feishu.cn', calendarName: '工作', writable: true, credentialsOk: true, conflictCount: 0, ...info }, ...patch,
});

function fakeApi(sources: CalendarSyncSource[] = [], patch: Partial<CalendarSyncApi> = {}) {
  const api = {
    list: vi.fn(async () => ({ sources })),
    importIcs: vi.fn(), subscribe: vi.fn(), update: vi.fn(), run: vi.fn(async () => sources[0]!), remove: vi.fn(async () => undefined),
    discoverCaldav: vi.fn(async () => ({ calendars: [
      { url: 'https://caldav.feishu.cn/cal/work/', name: '工作', color: '#3366ff', writable: true },
      { url: 'https://caldav.feishu.cn/cal/holiday/', name: '节假日', color: null, writable: false },
    ] })),
    createCaldav: vi.fn(async (body: { name: string }) => caldavSource({ name: body.name })),
    updateCredentials: vi.fn(async () => sources[0]!),
    conflicts: vi.fn(async () => ({ conflicts: [] as CalendarSyncConflict[] })),
    resolveConflict: vi.fn(async () => ({ source: sources[0]! })),
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

  it('discovers calendars, picks one and starts syncing with a fresh mutation id', async () => {
    const api = fakeApi();
    const { onChanged } = await open(api);
    await setValue(field<HTMLSelectElement>('#nb-wcal-caldav-preset'), 'feishu');
    expect(caldav().textContent).toContain('设置 → 日历 → CalDAV 同步 → 生成');
    const password = field<HTMLInputElement>('input[type="password"]');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    await signIn();
    expect(api.discoverCaldav).toHaveBeenCalledWith({ serverUrl: 'https://caldav.feishu.cn', username: 'me', password: 'secret' });

    const options = [...caldav().querySelectorAll<HTMLLabelElement>('.nb-wcal-caldav-option')];
    expect(options.map(option => option.textContent)).toEqual(['工作', '节假日只读']);
    expect(options[0]!.querySelector<HTMLElement>('.nb-wcal-swatch')!.style.background).not.toBe('');
    expect(field<HTMLInputElement>('#nb-wcal-caldav-name').value).toBe('工作');
    await click(options[1]!.querySelector('input')!);
    expect(field<HTMLInputElement>('#nb-wcal-caldav-name').value).toBe('节假日');
    expect(caldav().textContent).toContain('这个日历只读');
    await setValue(field<HTMLSelectElement>('select[aria-label="同步间隔"]'), '60');
    expect(document.querySelector('select[aria-label="位置"], #nb-wcal-import-parent')).toBeNull();
    await click(button('开始同步', caldav()));

    expect(api.createCaldav).toHaveBeenCalledTimes(1);
    const body = (api.createCaldav as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({ serverUrl: 'https://caldav.feishu.cn', username: 'me', password: 'secret',
      calendarUrl: 'https://caldav.feishu.cn/cal/holiday/', name: '节假日', parentId: null, intervalMinutes: 60 });
    expect(typeof body.clientMutationId).toBe('string');
    expect(field<HTMLInputElement>('input[type="password"]').value).toBe('');
    expect(field<HTMLInputElement>('input[aria-label="账号"]').value).toBe('');
    expect(caldav().querySelector('.nb-wcal-caldav-option')).toBeNull();
    expect(caldav().textContent).toContain('已连接「节假日」');
    expect(onChanged).toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(JSON.stringify({ ...localStorage })).not.toContain('secret');
  });

  it('retries a lost create with the same mutation id', async () => {
    const api = fakeApi([], { createCaldav: vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_UNAVAILABLE'))
      .mockResolvedValueOnce(caldavSource()) });
    await open(api);
    await signIn();
    await click(button('开始同步', caldav()));
    expect(caldav().textContent).toContain('不会重复创建');
    await click(button('重试', caldav()));
    const calls = (api.createCaldav as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0].clientMutationId).toBe(calls[0]![0].clientMutationId);
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
    expect(item().textContent).toContain('出现在页面树中');
    expect(item().textContent).toContain('不能再向它追加导入');
    await click(button('确认停止同步', item()));
    expect(api.remove).toHaveBeenCalledWith('s1');
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
