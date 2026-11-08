import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { AuthSessionResponse, PageDocument, PageSummary } from '@nbase/contracts';
import type { DocumentContent, DocumentEditorHandle, EditorSnapshot } from '../editor/types';
import { ApiError, loadPageTree, pageClient } from './client';
import { localDrafts, type LocalPageDraft, type LocalPendingAction, type LocalPendingCreate } from './drafts';
import { canonicalContent, contentMatchesServer, matchesServer } from './draftCompare';
import { subtreeIds } from './pageTreePaths';
import { isAuthError, message } from './workspaceErrors';

export interface PageActionContext {
  session: AuthSessionResponse | null;
  workspace: AuthSessionResponse['workspaces'][number] | undefined;
  actionsLoaded: boolean;
  pages: PageSummary[];
  pendingUploads: { id: string; pageId: string; file: File }[];
  activeIdRef: MutableRefObject<string | null>;
  titleRef: MutableRefObject<string>;
  docsRef: MutableRefObject<Map<string, PageDocument>>;
  draftsRef: MutableRefObject<Map<string, LocalPageDraft>>;
  pendingActionsRef: MutableRefObject<Map<string, LocalPendingAction>>;
  pendingCreatesRef: MutableRefObject<Map<string, LocalPendingCreate>>;
  pageActionBusyRef: MutableRefObject<boolean>;
  uploadingRef: MutableRefObject<number>;
  openSequence: MutableRefObject<number>;
  saveTimers: MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>;
  savePageRef: MutableRefObject<(pageId: string) => Promise<void>>;
  editorRef: RefObject<DocumentEditorHandle | null>;
  setActive: (id: string | null) => void;
  setStatus: (text: string) => void;
  setNotice: (text: string) => void;
  setReauth: (value: boolean) => void;
  setDialog: (dialog: null) => void;
  setPages: Dispatch<SetStateAction<PageSummary[]>>;
  setPendingActions: Dispatch<SetStateAction<LocalPendingAction[]>>;
  setPageActionBusy: Dispatch<SetStateAction<boolean>>;
  setDocumentPage: Dispatch<SetStateAction<PageDocument | null>>;
  setInitialContent: Dispatch<SetStateAction<DocumentContent | null>>;
  setEditorSnapshot: Dispatch<SetStateAction<EditorSnapshot | null>>;
  setConflict: Dispatch<SetStateAction<{ server: PageDocument; draft: LocalPageDraft } | null>>;
  setOtherDraft: Dispatch<SetStateAction<LocalPageDraft | null>>;
  openPage: (pageId: string, force?: boolean) => Promise<boolean>;
  reloadTree: (session: AuthSessionResponse) => Promise<void>;
  refreshTags: () => Promise<void>;
  markDraft: (pageId: string, title: string, snapshot: EditorSnapshot) => void;
  waitForSave: (pageId: string) => Promise<void>;
}

/** Trash, restore and version restore: durable operation ID first, then a confirmable server write. */
export function createPageActions({ session, workspace, actionsLoaded, pages, pendingUploads, activeIdRef, titleRef, docsRef, draftsRef,
  pendingActionsRef, pendingCreatesRef, pageActionBusyRef, uploadingRef, openSequence, saveTimers, savePageRef, editorRef,
  setActive, setStatus, setNotice, setReauth, setDialog, setPages, setPendingActions, setPageActionBusy, setDocumentPage,
  setInitialContent, setEditorSnapshot, setConflict, setOtherDraft, openPage, reloadTree, refreshTags, markDraft, waitForSave }: PageActionContext) {
  const syncPendingActions = () => setPendingActions([...pendingActionsRef.current.values()]);
  const performPageAction = async (pending: LocalPendingAction) => {
    if (!session || !workspace || pageActionBusyRef.current) return;
    if (pending.userId !== session.user.id || pending.workspaceId !== workspace.id) return;
    pageActionBusyRef.current = true; setPageActionBusy(true);
    const visiblePageAtStart = activeIdRef.current;
    try {
      let saved: PageDocument;
      try {
        saved = pending.operation === 'restore-version'
          ? await pageClient.restoreVersion(workspace.id, pending.pageId,
            { ...pending.body, sourceRevision: pending.body.sourceRevision! }, session.csrfToken)
          : await pageClient[pending.operation](workspace.id, pending.pageId, pending.body, session.csrfToken);
      } catch (error) {
        if (!(error instanceof ApiError) || (error.status !== 0 && error.status < 500)) throw error;
        const receipt = await pageClient.receipt(workspace.id, pending.body.clientMutationId).catch(() => null);
        if (!receipt) throw error;
        saved = receipt.response;
      }
      try {
        await localDrafts.removeAction(pending.key);
        pendingActionsRef.current.delete(pending.key); syncPendingActions();
      } catch {
        setDialog(null);
        setNotice('服务端操作已完成，本机待确认记录清理失败；请用同一操作重试确认。');
        return;
      }
      setDialog(null);
      if (pending.operation === 'trash') {
        for (const id of pending.affectedIds) {
          const timer = saveTimers.current.get(id); if (timer) clearTimeout(timer);
          saveTimers.current.delete(id); docsRef.current.delete(id);
        }
        if (activeIdRef.current && pending.affectedIds.includes(activeIdRef.current)) {
          ++openSequence.current; setActive(null); setDocumentPage(null); setInitialContent(null);
          setEditorSnapshot(null); setConflict(null); setOtherDraft(null); setStatus('');
        }
        setNotice('页面已移入回收站，历史、附件和本机草稿保留。');
      } else {
        // Always read the current server page: an idempotency receipt can describe an older revision.
        if (pending.operation === 'restore-version' ? activeIdRef.current === pending.pageId : activeIdRef.current === visiblePageAtStart) {
          await openPage(saved.id, true);
        }
        setNotice(pending.operation === 'restore-version' ? '已恢复为新的修订，恢复前内容仍在历史中。'
          : saved.parentId === null ? '页面已恢复到个人空间根目录。' : '页面已恢复，ID 与子页面关系保留。');
      }
      await reloadTree(session);
      if (pending.operation !== 'restore-version') void refreshTags().catch(() => undefined);
    } catch (error) {
      setDialog(null);
      if (isAuthError(error)) setReauth(true);
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401) {
        try {
          await localDrafts.removeAction(pending.key); pendingActionsRef.current.delete(pending.key); syncPendingActions();
        } catch { setNotice('操作未完成，且本机记录暂时无法清理，请重试。'); return; }
        setNotice(`操作未完成：${message(error)} 请重新打开页面或历史列表后再试。`);
      } else setNotice(`操作结果尚未确认：${message(error)} 请使用“重试同一操作”确认。`);
    } finally { pageActionBusyRef.current = false; setPageActionBusy(false); }
  };

  const beginPageAction = async (operation: LocalPendingAction['operation'], pageId: string,
    expectedRevision: string, pageTitle: string, sourceRevision?: string, databaseRow = false) => {
    if (!session || !workspace || pageActionBusyRef.current) return;
    if (!actionsLoaded || pendingActionsRef.current.size) { setDialog(null); setNotice('请先处理本机待确认操作，再发起新的恢复或删除。'); return; }
    pageActionBusyRef.current = true; setPageActionBusy(true);
    try {
      // A database row is not in the page tree; it has no children of its own.
      const isRow = databaseRow || docsRef.current.get(pageId)?.kind === 'row';
      let affectedIds = operation === 'trash' && !isRow ? subtreeIds(pages, pageId) : [pageId];
      if (operation === 'trash' && !isRow) {
        const freshPages = await loadPageTree(workspace.id);
        const freshIds = subtreeIds(freshPages, pageId);
        setPages(freshPages);
        if (!freshPages.some(page => page.id === pageId) || JSON.stringify([...affectedIds].sort()) !== JSON.stringify([...freshIds].sort())) {
          throw new Error('目录已变化，请重新查看页面与子页数量，再确认删除。');
        }
        affectedIds = freshIds;
      }
      if (operation !== 'restore') {
        if (pendingCreatesRef.current.size || pendingUploads.length || uploadingRef.current) {
          throw new Error('请先完成待确认的创建和附件上传，再恢复历史或删除页面。');
        }
        const active = activeIdRef.current;
        if (active && affectedIds.includes(active)) {
          const snapshot = editorRef.current?.getSnapshot();
          const server = docsRef.current.get(active);
          const existingDraft = draftsRef.current.get(active);
          const changed = snapshot && (existingDraft
            ? titleRef.current !== existingDraft.title || canonicalContent(snapshot.content) !== canonicalContent(existingDraft.content)
            : titleRef.current !== server?.title || !contentMatchesServer(snapshot.content, server));
          if (snapshot && changed) {
            markDraft(active, titleRef.current, snapshot);
          }
        }
        for (const id of affectedIds) {
          await waitForSave(id);
          await savePageRef.current(id);
          await waitForSave(id);
          if (draftsRef.current.has(id)) throw new Error('页面或子页面还有未保存的本机草稿，请先处理保存失败或冲突。');
        }
        const candidates = await localDrafts.forPages(session.user.id, workspace.id, affectedIds);
        const checked = new Map<string, PageDocument>();
        for (const draft of candidates) {
          const server = checked.get(draft.pageId) ?? await pageClient.get(workspace.id, draft.pageId);
          checked.set(draft.pageId, server);
          if (!matchesServer(draft, server)) throw new Error(`“${draft.title || '未命名页面'}”还有其他标签或会话的草稿，请先恢复检查或另存。`);
        }
        expectedRevision = docsRef.current.get(pageId)?.revision ?? expectedRevision;
      }
      const clientMutationId = crypto.randomUUID();
      const pending: LocalPendingAction = {
        key: `${session.user.id}:${workspace.id}:${clientMutationId}`, userId: session.user.id, workspaceId: workspace.id,
        pageId, title: pageTitle, operation, affectedIds, createdAt: new Date().toISOString(),
        body: { clientMutationId, expectedRevision, ...(sourceRevision ? { sourceRevision } : {}),
          ...(operation === 'trash' ? { expectedSubtreeIds: affectedIds } : {}) },
      };
      await localDrafts.putAction(pending);
      pendingActionsRef.current.set(pending.key, pending); syncPendingActions();
      pageActionBusyRef.current = false;
      await performPageAction(pending);
    } catch (error) { setDialog(null); setNotice(message(error)); }
    finally { pageActionBusyRef.current = false; setPageActionBusy(false); }
  };

  return { performPageAction, beginPageAction };
}
