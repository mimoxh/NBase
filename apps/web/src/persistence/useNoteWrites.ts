import { useEffect, useRef, useState } from 'react';
import type { AuthSessionResponse, PageDocument } from '@nbase/contracts';
import { ApiError, pageClient } from './client';
import { localDrafts, type LocalPendingNoteWrite } from './drafts';
import { writeNote, type NoteWrite } from './noteWrites';

type PrepareWrite = (write: NoteWrite) => Promise<NoteWrite>;

export function useNoteWrites(session: AuthSessionResponse | null, workspaceId: string | undefined,
  onNotice: (text: string) => void) {
  const userId = session?.user.id;
  const scope = userId && workspaceId ? `${userId}:${workspaceId}` : null;
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [pending, setPending] = useState<LocalPendingNoteWrite[]>([]);
  const entries = useRef(new Map<string, LocalPendingNoteWrite>());
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const sync = () => setPending([...entries.current.values()]);

  useEffect(() => {
    entries.current.clear(); setPending([]); setLoadedScope(null);
    if (!scope || !userId || !workspaceId) return;
    let active = true;
    void localDrafts.forScopeNoteWrites(userId, workspaceId).then(items => {
      if (!active) return;
      entries.current = new Map(items.map(item => [item.key, item]));
      setPending(items); setLoadedScope(scope);
    }).catch(() => { if (active) onNotice('本机待提交记录暂不可用。请检查浏览器存储后重新打开工作台。'); });
    return () => { active = false; };
  }, [onNotice, scope, userId, workspaceId]);

  const ready = scope !== null && loadedScope === scope;
  const exclusive = async <T>(action: () => Promise<T>): Promise<T> => {
    if (!ready) throw new Error('本机待提交记录尚未准备好。');
    if (locked.current) throw new Error('上一笔提交正在确认。');
    locked.current = true; setBusy(true);
    try { return await action(); }
    finally { locked.current = false; setBusy(false); }
  };

  const execute = async (item: LocalPendingNoteWrite, prepare?: PrepareWrite): Promise<PageDocument> => {
    if (!session || !workspaceId || item.userId !== userId || item.workspaceId !== workspaceId || liveScope.current !== scope) {
      throw new Error('待提交记录属于另一个工作区。');
    }
    const mutationId = item.write.body.clientMutationId;
    let page: PageDocument;
    const stored = await localDrafts.getNoteWrite(item.key);
    if (stored?.write.body.clientMutationId !== mutationId) {
      const receipt = await pageClient.receipt(workspaceId, mutationId).catch(() => null);
      if (!receipt) throw new Error('另一标签页已处理此记录，请重新打开工作台确认。');
      page = receipt.response;
    } else {
      item = stored;
      if (item.preparing) {
        if (!prepare) throw new Error('请先检查原页面的保存状态。');
        const prepared = { ...item, write: await prepare(item.write), preparing: false };
        if (!await localDrafts.changeNoteWrite(item, prepared)) throw new Error('记录已在另一标签页处理。');
        item = prepared;
        if (liveScope.current !== scope) throw new Error('工作区已变化。');
        entries.current.set(item.key, item); sync();
      }
      try { page = await writeNote(workspaceId, session.csrfToken, item.write); }
      catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          if (error.code === 'REVISION_CONFLICT') {
            const conflicted = { ...item, conflict: true };
            if (await localDrafts.changeNoteWrite(item, conflicted) && liveScope.current === scope) {
              entries.current.set(item.key, conflicted); sync();
            }
          }
          throw error;
        }
        const receipt = await pageClient.receipt(workspaceId, mutationId).catch(() => null);
        if (!receipt) throw error;
        page = receipt.response;
      }
    }
    try {
      await localDrafts.changeNoteWrite(item);
      if (liveScope.current === scope) { entries.current.delete(item.key); sync(); }
    } catch { onNotice('服务端已确认，本机待提交记录未清理，可安全重试确认。'); }
    return page;
  };

  const submit = (write: NoteWrite, prepare?: PrepareWrite) => exclusive(async () => {
    if (!userId || !workspaceId) throw new Error('请先登录。');
    if (entries.current.size) throw new Error('请先处理工作台上已有的待确认记录。');
    const item = { key: `${scope}:${write.body.clientMutationId}`, userId, workspaceId, write, createdAt: new Date().toISOString(),
      ...(prepare ? { preparing: true } : {}) };
    await localDrafts.putNoteWrite(item);
    if (liveScope.current === scope) { entries.current.set(item.key, item); sync(); }
    return execute(item, prepare);
  });

  return {
    pending: ready ? pending : [], ready, busy,
    submit,
    confirm: (item: LocalPendingNoteWrite) => exclusive(async () => {
      if (!workspaceId || item.userId !== userId || item.workspaceId !== workspaceId) return null;
      const receipt = await pageClient.receipt(workspaceId, item.write.body.clientMutationId).catch(error => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      });
      if (!receipt) return null;
      const stored = await localDrafts.getNoteWrite(item.key);
      if (stored?.write.body.clientMutationId === item.write.body.clientMutationId) await localDrafts.changeNoteWrite(stored);
      if (liveScope.current === scope) { entries.current.delete(item.key); sync(); }
      return receipt.response;
    }),
    retry: (item: LocalPendingNoteWrite, prepare?: PrepareWrite) => exclusive(() => execute(item, prepare)),
    rebaseQuick: (item: LocalPendingNoteWrite, expectedRevision: string | undefined) => exclusive(async () => {
      if (!item.conflict || item.write.kind !== 'quick') throw new Error('此记录需先核对原提交结果。');
      const { date, text } = item.write.body;
      const next: LocalPendingNoteWrite = {
        ...item, conflict: false, write: { kind: 'quick', body: { date, text, clientMutationId: crypto.randomUUID(),
          ...(expectedRevision === undefined ? {} : { expectedRevision }) } },
      };
      if (!await localDrafts.changeNoteWrite(item, next)) throw new Error('记录已在另一标签页处理。');
      if (liveScope.current === scope) { entries.current.set(item.key, next); sync(); }
      return execute(next);
    }),
    dismiss: (item: LocalPendingNoteWrite) => exclusive(async () => {
      if (!await localDrafts.changeNoteWrite(item)) throw new Error('记录已在另一标签页处理。');
      if (liveScope.current === scope) { entries.current.delete(item.key); sync(); }
    }),
  };
}
