// @vitest-environment jsdom
import { act, type MutableRefObject } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthSessionResponse, PageDocument } from '@nbase/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, pageClient } from './client';
import { localDrafts, type LocalPageDraft, type LocalPendingAction } from './drafts';
import { usePageSaver } from './usePageSaver';

const session: AuthSessionResponse = { user: { id: 'owner', loginName: 'owner' },
  workspaces: [{ id: 'workspace', name: '笔记', role: 'owner' }], csrfToken: 'csrf', expiresAt: '2099-01-01' };
const content = (text: string) => ({ schemaVersion: 1, editorState: { root: { text } } });
const server = (revision: string, text: string): PageDocument => ({ id: 'page', workspaceId: 'workspace', parentId: null, title: '标题',
  revision, icon: null, cover: null, createdAt: '', updatedAt: '', content: content(text) });
const draftFor = (text: string, sequence = 1): LocalPageDraft => ({ key: 'draft', userId: 'owner', workspaceId: 'workspace', pageId: 'page',
  title: '标题', content: content(text), baseRevision: '1', sequence, updatedAt: '2026-11-06T00:00:00.000Z' });

interface Harness {
  saver: ReturnType<typeof usePageSaver>;
  drafts: MutableRefObject<Map<string, LocalPageDraft>>;
  actions: MutableRefObject<Map<string, LocalPendingAction>>;
  setStatus: ReturnType<typeof vi.fn>;
  setConflict: ReturnType<typeof vi.fn>;
  setReauth: ReturnType<typeof vi.fn>;
  upsertPage: ReturnType<typeof vi.fn>;
}

let root: ReturnType<typeof createRoot>;

async function mount(draft: LocalPageDraft): Promise<Harness> {
  const drafts = { current: new Map([['page', draft]]) };
  const actions = { current: new Map<string, LocalPendingAction>() };
  const setStatus = vi.fn(), setConflict = vi.fn(), setReauth = vi.fn(), upsertPage = vi.fn();
  const harness = { drafts, actions, setStatus, setConflict, setReauth, upsertPage } as unknown as Harness;
  function Probe() {
    harness.saver = usePageSaver({ session, workspace: session.workspaces[0], tabId: 'tab', actionsLoaded: true,
      activeIdRef: { current: 'page' }, docsRef: { current: new Map([['page', server('1', '旧正文')]]) }, draftsRef: drafts,
      pendingActionsRef: actions, upsertPage, setStatus, setNotice: vi.fn(), setReauth, setConflict,
      setOtherDraft: vi.fn(), setEditorSnapshot: vi.fn() });
    return null;
  }
  await act(async () => root.render(<Probe />));
  return harness;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.createElement('div'));
  vi.spyOn(localDrafts, 'put').mockResolvedValue('draft');
  vi.spyOn(localDrafts, 'removeIfUnchanged').mockResolvedValue(true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('stores the mutation ID locally before the network write and clears the draft after confirmation', async () => {
  const order: string[] = [];
  vi.mocked(localDrafts.put).mockImplementation(async () => { order.push('draft'); return 'draft'; });
  const update = vi.spyOn(pageClient, 'update').mockImplementation(async () => { order.push('network'); return server('2', '新正文'); });
  const page = await mount(draftFor('新正文'));

  await act(async () => { await page.saver.savePage('page'); });

  expect(order).toEqual(['draft', 'network']);
  const sent = update.mock.calls[0]![2];
  expect(vi.mocked(localDrafts.put).mock.calls[0]![0].pending?.clientMutationId).toBe(sent.clientMutationId);
  expect(sent).toMatchObject({ expectedRevision: '1', title: '标题', content: content('新正文') });
  expect(page.upsertPage).toHaveBeenCalledWith(server('2', '新正文'));
  expect(page.drafts.current.has('page')).toBe(false);
  expect(page.setStatus).toHaveBeenLastCalledWith('已保存到服务端');
});

it('never reaches the network when the local draft cannot be written', async () => {
  vi.mocked(localDrafts.put).mockRejectedValue(new Error('quota'));
  const update = vi.spyOn(pageClient, 'update');
  const page = await mount(draftFor('新正文'));

  await act(async () => { await page.saver.savePage('page'); });

  expect(update).not.toHaveBeenCalled();
  expect(page.drafts.current.has('page')).toBe(true);
  expect(page.setStatus).toHaveBeenLastCalledWith('本机草稿写入失败，请立即下载 Markdown');
});

it('confirms a lost response from its receipt without sending a second write', async () => {
  const update = vi.spyOn(pageClient, 'update').mockRejectedValue(new ApiError(0, 'TIMEOUT'));
  const receipt = vi.spyOn(pageClient, 'receipt').mockResolvedValue({ statusCode: 200, response: server('2', '新正文') });
  const page = await mount(draftFor('新正文'));

  await act(async () => { await page.saver.savePage('page'); });

  expect(update).toHaveBeenCalledTimes(1);
  expect(receipt).toHaveBeenCalledWith('workspace', update.mock.calls[0]![2].clientMutationId);
  expect(page.drafts.current.has('page')).toBe(false);
  expect(page.setStatus).toHaveBeenLastCalledWith('已保存到服务端');
});

it('keeps the same mutation ID for retry when neither the write nor the receipt is confirmed', async () => {
  const update = vi.spyOn(pageClient, 'update').mockRejectedValue(new ApiError(0, 'NETWORK_UNAVAILABLE'));
  vi.spyOn(pageClient, 'receipt').mockRejectedValue(new ApiError(0, 'NETWORK_UNAVAILABLE'));
  const page = await mount(draftFor('新正文'));

  await act(async () => { await page.saver.savePage('page'); });
  await act(async () => { await page.saver.savePage('page'); });

  expect(update).toHaveBeenCalledTimes(2);
  expect(update.mock.calls[1]![2].clientMutationId).toBe(update.mock.calls[0]![2].clientMutationId);
  expect(page.drafts.current.get('page')?.content).toEqual(content('新正文'));
  expect(page.setStatus).toHaveBeenLastCalledWith('网络中断；本机草稿仍可找回。');
});

it('surfaces a revision conflict and keeps the local content', async () => {
  vi.spyOn(pageClient, 'update').mockRejectedValue(new ApiError(409, 'REVISION_CONFLICT'));
  const latest = server('3', '另一处的修改');
  vi.spyOn(pageClient, 'get').mockResolvedValue(latest);
  const page = await mount(draftFor('我的修改'));

  await act(async () => { await page.saver.savePage('page'); });

  expect(page.setConflict).toHaveBeenCalledWith({ server: latest, draft: page.drafts.current.get('page') });
  expect(page.drafts.current.get('page')?.content).toEqual(content('我的修改'));
  expect(localDrafts.removeIfUnchanged).not.toHaveBeenCalled();
});

it('treats a conflict with identical server content as already saved', async () => {
  vi.spyOn(pageClient, 'update').mockRejectedValue(new ApiError(409, 'REVISION_CONFLICT'));
  vi.spyOn(pageClient, 'get').mockResolvedValue(server('2', '新正文'));
  const page = await mount(draftFor('新正文'));

  await act(async () => { await page.saver.savePage('page'); });

  expect(page.drafts.current.has('page')).toBe(false);
  expect(page.setConflict).toHaveBeenCalledWith(null);
  expect(page.setStatus).toHaveBeenLastCalledWith('已保存到服务端');
});

it('releases a definitely rejected mutation ID but keeps the edit for the next save', async () => {
  const update = vi.spyOn(pageClient, 'update').mockRejectedValue(new ApiError(422, 'CONTENT_INVALID'));
  const page = await mount(draftFor('新正文'));

  await act(async () => { await page.saver.savePage('page'); });
  await act(async () => { await page.saver.savePage('page'); });

  expect(update.mock.calls[1]![2].clientMutationId).not.toBe(update.mock.calls[0]![2].clientMutationId);
  expect(page.drafts.current.get('page')?.content).toEqual(content('新正文'));
  expect(page.drafts.current.get('page')?.pending).toBeUndefined();
});

it('keeps the draft and asks for login again when the session expired', async () => {
  vi.spyOn(pageClient, 'update').mockRejectedValue(new ApiError(401, 'AUTH_EXPIRED'));
  const page = await mount(draftFor('新正文'));

  await act(async () => { await page.saver.savePage('page'); });

  expect(page.setReauth).toHaveBeenCalledWith(true);
  expect(page.drafts.current.has('page')).toBe(true);
});

it('does not save a page that an unconfirmed trash or restore action affects', async () => {
  const update = vi.spyOn(pageClient, 'update');
  const page = await mount(draftFor('新正文'));
  page.actions.current.set('action', { affectedIds: ['page'] } as LocalPendingAction);

  await act(async () => { await page.saver.savePage('page'); });

  expect(update).not.toHaveBeenCalled();
  expect(localDrafts.put).not.toHaveBeenCalled();
});

it('saves edits made during a request as a follow-up on the new revision', async () => {
  vi.useFakeTimers();
  try {
    let finish!: (saved: PageDocument) => void;
    const update = vi.spyOn(pageClient, 'update').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(server('3', '第二次'));
    const page = await mount(draftFor('第一次'));
    let saving!: Promise<void>;
    await act(async () => { saving = page.saver.savePage('page'); await Promise.resolve(); await Promise.resolve(); });
    const inFlight = page.drafts.current.get('page')!;
    page.drafts.current.set('page', { ...inFlight, content: content('第二次'), sequence: inFlight.sequence + 1 });
    await act(async () => { finish(server('2', '第一次')); await saving; });

    expect(page.drafts.current.get('page')).toMatchObject({ baseRevision: '2', content: content('第二次') });
    expect(page.drafts.current.get('page')?.pending).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]![2]).toMatchObject({ expectedRevision: '2', content: content('第二次') });
    expect(page.drafts.current.has('page')).toBe(false);
  } finally { vi.useRealTimers(); }
});
