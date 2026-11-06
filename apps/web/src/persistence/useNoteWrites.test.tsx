// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthSessionResponse, PageDocument } from '@nbase/contracts';
import { expect, it, vi } from 'vitest';
import { ApiError, pageClient } from './client';
import { localDrafts, type LocalPendingNoteWrite } from './drafts';
import * as noteWrites from './noteWrites';
import { useNoteWrites } from './useNoteWrites';

it('keeps the capture before waiting for a save and confirms a lost response from its receipt', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const session: AuthSessionResponse = { user: { id: 'owner', loginName: 'owner' },
    workspaces: [{ id: 'workspace', name: '笔记', role: 'owner' }], csrfToken: 'test', expiresAt: '2099-01-01' };
  const write: noteWrites.NoteWrite = { kind: 'quick', body: { clientMutationId: 'quick-id', date: '2026-11-05', text: '待确认内容' } };
  const page: PageDocument = { id: 'daily', workspaceId: 'workspace', parentId: null, title: '2026-11-05',
    revision: '1', icon: null, cover: null, createdAt: '', updatedAt: '', content: { schemaVersion: 1, editorState: { root: {} } } };
  let stored: LocalPendingNoteWrite | undefined;
  vi.spyOn(localDrafts, 'forScopeNoteWrites').mockResolvedValue([]);
  vi.spyOn(localDrafts, 'getNoteWrite').mockImplementation(async () => stored);
  vi.spyOn(localDrafts, 'putNoteWrite').mockImplementation(async item => { stored = item; return item.key; });
  vi.spyOn(localDrafts, 'changeNoteWrite').mockImplementation(async (_item, next) => { stored = next; return true; });
  const send = vi.spyOn(noteWrites, 'writeNote').mockRejectedValue(new ApiError(0, 'TIMEOUT'));
  const receipt = vi.spyOn(pageClient, 'receipt').mockRejectedValueOnce(new ApiError(0, 'TIMEOUT'))
    .mockResolvedValue({ statusCode: 201, response: page });
  const root = createRoot(document.createElement('div'));
  const notice = vi.fn();
  let hook: ReturnType<typeof useNoteWrites>;
  function Harness() { hook = useNoteWrites(session, 'workspace', notice); return null; }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await expect(hook.submit(write, async () => { throw new Error('原页面离线'); })).rejects.toThrow('原页面离线');
    });
    expect(stored).toMatchObject({ preparing: true, write });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      await expect(hook.retry(hook.pending[0]!, async item => item)).rejects.toMatchObject({ code: 'TIMEOUT' });
    });
    expect(hook!.pending[0]?.write).toEqual(write);
    await act(async () => { await expect(hook.confirm(hook.pending[0]!)).resolves.toEqual(page); });
    expect(hook!.pending).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(receipt.mock.calls).toEqual([['workspace', 'quick-id'], ['workspace', 'quick-id']]);
  } finally {
    await act(() => root.unmount());
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
