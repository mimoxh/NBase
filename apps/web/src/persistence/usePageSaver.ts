import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { AuthSessionResponse, PageDocument, UpdatePageRequest } from '@nbase/contracts';
import type { EditorSnapshot } from '../editor/types';
import { ApiError, pageClient } from './client';
import { draftKey, localDrafts, type LocalPageDraft, type LocalPendingAction } from './drafts';
import { matchesServer } from './draftCompare';
import { isDefiniteUpdateRejection, releaseRejectedMutation } from './savePolicy';
import { isAuthError, message } from './workspaceErrors';

export interface PageSaverOptions {
  session: AuthSessionResponse | null;
  workspace: AuthSessionResponse['workspaces'][number] | undefined;
  tabId: string;
  actionsLoaded: boolean;
  activeIdRef: MutableRefObject<string | null>;
  docsRef: MutableRefObject<Map<string, PageDocument>>;
  draftsRef: MutableRefObject<Map<string, LocalPageDraft>>;
  pendingActionsRef: MutableRefObject<Map<string, LocalPendingAction>>;
  upsertPage: (page: PageDocument) => void;
  setStatus: (text: string) => void;
  setNotice: (text: string) => void;
  setReauth: (value: boolean) => void;
  setConflict: Dispatch<SetStateAction<{ server: PageDocument; draft: LocalPageDraft } | null>>;
  setOtherDraft: Dispatch<SetStateAction<LocalPageDraft | null>>;
  setEditorSnapshot: Dispatch<SetStateAction<EditorSnapshot | null>>;
}

/** The per-page write path: local draft first, then one serialized server save per page. */
export function usePageSaver({ session, workspace, tabId, actionsLoaded, activeIdRef, docsRef, draftsRef, pendingActionsRef,
  upsertPage, setStatus, setNotice, setReauth, setConflict, setOtherDraft, setEditorSnapshot }: PageSaverOptions) {
  const savingRef = useRef(new Set<string>());
  const saveWaitersRef = useRef(new Map<string, (() => void)[]>());
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const writeQueues = useRef(new Map<string, Promise<void>>());

  const queueWrite = useCallback((key: string, action: () => Promise<unknown>): Promise<void> => {
    const previous = writeQueues.current.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action).then(() => undefined);
    writeQueues.current.set(key, next);
    return next;
  }, []);

  const persistDraft = useCallback(async (draft: LocalPageDraft): Promise<boolean> => {
    try { await queueWrite(draft.key, () => localDrafts.put(draft)); return true; }
    catch {
      if (activeIdRef.current === draft.pageId) setStatus('本机草稿写入失败，请立即下载 Markdown');
      return false;
    }
  }, [queueWrite]);

  const clearResolvedDraft = useCallback(async (draft: LocalPageDraft) => {
    if (draftsRef.current.get(draft.pageId) === draft) draftsRef.current.delete(draft.pageId);
    let cleanupFailed = false;
    try { await queueWrite(draft.key, () => localDrafts.removeIfUnchanged(draft)); }
    catch { cleanupFailed = true; }
    for (const source of draft.recoveredFrom ?? []) {
      try { await queueWrite(source.key, () => localDrafts.removeIfVersion(source)); }
      catch { cleanupFailed = true; }
    }
    if (cleanupFailed) setNotice('服务端已保存，本机旧草稿清理失败；重开页面时会再检查。');
  }, [queueWrite]);

  const scheduleSave = useCallback((pageId: string, delay = 900) => {
    const prior = saveTimers.current.get(pageId);
    if (prior) clearTimeout(prior);
    saveTimers.current.set(pageId, setTimeout(() => {
      saveTimers.current.delete(pageId);
      void savePageRef.current(pageId);
    }, delay));
  }, []);
  const savePageRef = useRef<(pageId: string) => Promise<void>>(async () => undefined);

  const markDraft = useCallback((pageId: string, nextTitle: string, snapshot: EditorSnapshot) => {
    if (!session || !workspace) return;
    const server = docsRef.current.get(pageId);
    if (!server) return;
    const previous = draftsRef.current.get(pageId);
    const draft: LocalPageDraft = {
      key: draftKey(session.user.id, workspace.id, pageId, tabId),
      userId: session.user.id, workspaceId: workspace.id, pageId,
      title: nextTitle, content: snapshot.content,
      baseRevision: previous?.baseRevision ?? server.revision,
      sequence: (previous?.sequence ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      ...(previous?.pending ? { pending: previous.pending } : {}),
      ...(previous?.recoveredFrom ? { recoveredFrom: previous.recoveredFrom } : {}),
    };
    draftsRef.current.set(pageId, draft);
    if (activeIdRef.current === pageId) {
      setOtherDraft(null); setEditorSnapshot(snapshot); setStatus('正在写入本机草稿…');
    }
    void persistDraft(draft).then(stored => {
      if (stored && activeIdRef.current === pageId && draftsRef.current.get(pageId)?.sequence === draft.sequence) {
        setStatus('本机草稿已保留 · 等待服务端确认');
      }
    });
    scheduleSave(pageId);
  }, [session, workspace, tabId, persistDraft, scheduleSave]);

  const savePage = useCallback(async (pageId: string) => {
    if (!session || !workspace || !actionsLoaded || savingRef.current.has(pageId)
      || [...pendingActionsRef.current.values()].some(item => item.affectedIds.includes(pageId))) return;
    let draft = draftsRef.current.get(pageId);
    if (!draft) return;
    savingRef.current.add(pageId);
    const sentSequence = draft.sequence;
    const body: UpdatePageRequest = draft.pending ?? {
      clientMutationId: crypto.randomUUID(), expectedRevision: draft.baseRevision,
      title: draft.title, content: draft.content,
    };
    try {
      if (!draft.pending) {
        draft = { ...draft, pending: body };
        draftsRef.current.set(pageId, draft);
      }
      // A retry also needs its mutation ID durably stored before any network write.
      if (!await persistDraft(draft)) return;
      if (activeIdRef.current === pageId) setStatus('正在保存到服务端…');
      let saved: PageDocument;
      try { saved = await pageClient.update(workspace.id, pageId, body, session.csrfToken); }
      catch (error) {
        if (!(error instanceof ApiError) || !['TIMEOUT', 'NETWORK_UNAVAILABLE'].includes(error.code)) throw error;
        const receipt = await pageClient.receipt(workspace.id, body.clientMutationId).catch(() => null);
        if (!receipt) throw error;
        saved = receipt.response;
      }
      upsertPage(saved);
      const latest = draftsRef.current.get(pageId);
      if (!latest || latest.pending?.clientMutationId !== body.clientMutationId) return;
      if (latest.sequence === sentSequence) {
        await clearResolvedDraft(latest);
        if (activeIdRef.current === pageId && !draftsRef.current.has(pageId)) setStatus('已保存到服务端');
      } else {
        const { pending: _pending, ...remaining } = latest;
        void _pending;
        const advanced: LocalPageDraft = { ...remaining, baseRevision: saved.revision };
        draftsRef.current.set(pageId, advanced);
        await persistDraft(advanced);
        scheduleSave(pageId, 100);
      }
    } catch (error) {
      if (isAuthError(error)) setReauth(true);
      if (error instanceof ApiError && error.code === 'REVISION_CONFLICT') {
        try {
          const server = await pageClient.get(workspace.id, pageId);
          const latest = draftsRef.current.get(pageId);
          if (latest && matchesServer(latest, server)) {
            await clearResolvedDraft(latest);
            upsertPage(server);
            if (activeIdRef.current === pageId && !draftsRef.current.has(pageId)) {
              setConflict(null); setStatus('已保存到服务端');
            }
            return;
          }
          if (latest && activeIdRef.current === pageId) setConflict({ server, draft: latest });
        } catch { /* Keep the draft and surface the original conflict. */ }
      } else if (isDefiniteUpdateRejection(error)) {
        const latest = draftsRef.current.get(pageId);
        const remaining = latest && releaseRejectedMutation(latest, body.clientMutationId);
        if (remaining) {
          draftsRef.current.set(pageId, remaining);
          if (!await persistDraft(remaining)) return;
          if (remaining.sequence !== sentSequence) scheduleSave(pageId, 100);
        }
      }
      if (activeIdRef.current === pageId) setStatus(message(error));
    } finally {
      savingRef.current.delete(pageId);
      for (const resolve of saveWaitersRef.current.get(pageId) ?? []) resolve();
      saveWaitersRef.current.delete(pageId);
    }
  }, [session, workspace, actionsLoaded, persistDraft, clearResolvedDraft, scheduleSave]);
  savePageRef.current = savePage;
  useEffect(() => {
    if (actionsLoaded) for (const id of draftsRef.current.keys()) scheduleSave(id, 100);
  }, [actionsLoaded, scheduleSave]);

  const waitForSave = (pageId: string): Promise<void> => {
    if (!savingRef.current.has(pageId)) return Promise.resolve();
    return new Promise(resolve => saveWaitersRef.current.set(pageId, [...(saveWaitersRef.current.get(pageId) ?? []), resolve]));
  };

  return { queueWrite, persistDraft, clearResolvedDraft, scheduleSave, markDraft, savePage, savePageRef, saveTimers, waitForSave };
}
