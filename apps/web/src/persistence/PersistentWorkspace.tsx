import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthSessionResponse, DailyNoteSettings, DailyNoteStatus, NoteTemplate, OpenDailyNoteRequest,
  PageBacklink, PageCoverId, PageDocument, PageSummary, PageVersion, QuickCaptureRequest, SearchResult,
  StoredDocumentContent, TrashedPageDocument, UpdatePageRequest, WorkspaceTag } from '@nbase/contracts';
import { pageIdFromReferenceUrl } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { DocumentEditor } from '../editor/DocumentEditor';
import { placePage, type PagePlacement } from '../shell/pageOrder';
import { readingMenuItems, useReadingPrefs } from '../shell/readingPrefs';
import { SourceEditorDialog } from '../editor/SourceEditorDialog';
import { createContentFromMarkdown, markdownFromContent, parseMarkdownImport } from '../editor/markdown';
import type { AttachmentPickKind, DocumentContent, DocumentEditorHandle, EditorSnapshot } from '../editor/types';
import { ApiError, attachmentClient, loadPageTree, pageClient, tagClient } from './client';
import type { PropertyValue } from '@nbase/contracts';
import { LazyDatabaseView as DatabaseView, LazyRowPanel as RowPanel } from '../database/lazy';
import { createPersistentSource, databaseClient, rowFromPage } from '../database/persistentSource';
import { announceDatabaseChange } from '../database/source';
import { draftKey, draftVersion, localDrafts, sameDraftVersion,
  type LocalPageDraft, type LocalPendingAction, type LocalPendingCreate, type LocalPendingNoteWrite } from './drafts';
import { useNoteWrites } from './useNoteWrites';
import type { NoteWrite } from './noteWrites';
import { exportAttachments } from './attachmentExport';
import { PersistentSearchDialog } from './PersistentSearchDialog';
import { PageHistoryDialog, TrashDialog } from './PageRecoveryDialogs';
import { PageBacklinks } from './PageBacklinks';
import { FolderImportDialog } from './FolderImportDialog';
import { resolveImportTags } from './importTags';
import { CopyNoteDialog, NewNoteDialog, TemplateManagerDialog } from './NoteTemplateDialogs';
import { noteTemplateClient } from './noteTemplateClient';
import { DailyNoteDialog, dailyClient } from './DailyNoteDialog';
import { PageTagControls, TagFilter, TagManagerDialog, filterPageTree } from './PageTags';
import { canonicalContent, contentMatchesServer, matchesServer } from './draftCompare';
import { LoginForm } from './LoginForm';
import { ImportMarkdownDialog, MovePageDialog, TrashPageDialog } from './PageActionDialogs';
import { createPageActions } from './pageActions';
import { createPageTransfers, type PendingImport, type PendingUpload } from './pageTransfers';
import { ancestorChain, subtreeIds } from './pageTreePaths';
import { usePageSaver } from './usePageSaver';
import { ConflictCard, EmptyPanel, HomePanel } from './WorkspacePanels';
import { WorkspaceNotices } from './WorkspaceNotices';
import { isAuthError, message } from './workspaceErrors';
import { useTheme } from '../shell/theme';
import { saveToneFor, type SaveStatus } from '../shell/saveTone';
import { Sidebar } from '../shell/Sidebar';
import { Topbar } from '../shell/Topbar';
import { PageHeader } from '../shell/PageHeader';
import { Toc } from '../shell/Toc';
import { Toast } from '../shell/Toast';
import { type MenuItem } from '../shell/Menu';
import '../shell/shell.css';
import './persistent.css';

const attachmentAccept: Record<AttachmentPickKind, string> = {
  image: '.png,.jpg,.jpeg,.gif,.webp',
  file: '.png,.jpg,.jpeg,.gif,.webp,.pdf,.zip,.txt,.md',
};

export function PersistentWorkspace() {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [sessionPhase, setSessionPhase] = useState<'checking' | 'login' | 'ready' | 'error'>('checking');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [showReauthForm, setShowReauthForm] = useState(false);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [readingPrefs, setReadingPrefs] = useReadingPrefs();
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [sidebarHidden, setSidebarHidden] = useState(() => { try { return localStorage.getItem('nbase.sidebar') === 'collapsed'; } catch { return false; } });
  const [treeError, setTreeError] = useState('');
  const [treeLoading, setTreeLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [documentPage, setDocumentPage] = useState<PageDocument | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [title, setTitle] = useState('');
  const [initialContent, setInitialContent] = useState<DocumentContent | null>(null);
  const [editorSnapshot, setEditorSnapshot] = useState<EditorSnapshot | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ tone: 'idle', text: '' });
  const setStatus = (text: string) => setSaveStatus({ tone: saveToneFor(text), text });
  const [conflict, setConflict] = useState<{ server: PageDocument; draft: LocalPageDraft } | null>(null);
  const [otherDraft, setOtherDraft] = useState<LocalPageDraft | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [notice, setNotice] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dialog, setDialog] = useState<'source' | 'import' | 'move' | 'search' | 'history' | 'trash' | 'delete' |
    'new' | 'templates' | 'copy' | 'tags' | 'today' | 'quick-capture' | 'settings' | 'folder-import' | null>(null);
  const [newParent, setNewParent] = useState<string | null>(null);
  const [copyPreparing, setCopyPreparing] = useState(false);
  const [noteDialogError, setNoteDialogError] = useState('');
  const [templateSource, setTemplateSource] = useState<{ title: string; content: StoredDocumentContent }>();
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [tags, setTags] = useState<WorkspaceTag[]>([]);
  const [treeTagIds, setTreeTagIds] = useState<string[]>([]);
  const [trashTarget, setTrashTarget] = useState<string>();
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [importResolving, setImportResolving] = useState(false);
  const [folderExporting, setFolderExporting] = useState(false);
  const [sourceSession, setSourceSession] = useState<{ pageId: string; instanceId: string; content: DocumentContent;
    baseRevision: string; title: string; parentId: string | null; scope: string } | null>(null);
  const importResolvingRef = useRef(false);
  const folderExportingRef = useRef(false);
  const [moveTarget, setMoveTarget] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [pendingCreates, setPendingCreates] = useState<LocalPendingCreate[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [pendingActions, setPendingActions] = useState<LocalPendingAction[]>([]);
  const [actionsLoaded, setActionsLoaded] = useState(false);
  const [actionStorageError, setActionStorageError] = useState('');
  const [pageActionBusy, setPageActionBusy] = useState(false);
  const editorRef = useRef<DocumentEditorHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useTheme();
  const tabId = useRef(crypto.randomUUID()).current;
  const activeIdRef = useRef<string | null>(null);
  const titleRef = useRef('');
  const docsRef = useRef(new Map<string, PageDocument>());
  const draftsRef = useRef(new Map<string, LocalPageDraft>());
  const pendingActionsRef = useRef(new Map<string, LocalPendingAction>());
  const pageActionBusyRef = useRef(false);
  const favoriteBusyRef = useRef(new Set<string>());
  const uploadingRef = useRef(0);
  const openSequence = useRef(0);
  const pendingSearchRef = useRef<{ pageId: string; phrase: string; field: SearchResult['matchField'] } | null>(null);
  const pendingBacklinkRef = useRef<{ link: PageBacklink; targetPageId: string } | null>(null);
  const initialPageReference = useRef(pageIdFromReferenceUrl(location.pathname + location.search));
  const pendingCreatesRef = useRef(new Map<string, LocalPendingCreate>());
  const createBusyRef = useRef(false);
  const workspace = session?.workspaces[0];
  const canWrite = Boolean(workspace && workspace.role !== 'viewer');
  const workspaceScope = session && workspace ? `${session.user.id}:${workspace.id}` : null;
  const liveScope = useRef(workspaceScope);
  liveScope.current = workspaceScope;
  const noteWrites = useNoteWrites(session, workspace?.id, setNotice);
  const dailyMode = dialog === 'today' || dialog === 'quick-capture' || dialog === 'settings' ? dialog : null;

  const trackPendingCreate = (pending: LocalPendingCreate) => {
    pendingCreatesRef.current.set(pending.key, pending);
    setPendingCreates([...pendingCreatesRef.current.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  };
  const untrackPendingCreate = (key: string) => {
    pendingCreatesRef.current.delete(key);
    setPendingCreates([...pendingCreatesRef.current.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  };

  const setActive = (id: string | null) => { activeIdRef.current = id; setActiveId(id); };
  const setCurrentTitle = (value: string) => { titleRef.current = value; setTitle(value); };
  /** Older receipts/responses may predate appearance fields; normalize them on entry. */
  const normalizePage = <T extends { icon?: string | null; cover?: PageCoverId | null }>(page: T): T =>
    ({ ...page, icon: page.icon ?? null, cover: page.cover ?? null });
  const upsertPage = (input: PageDocument) => {
    const page = normalizePage(input);
    docsRef.current.set(page.id, page);
    const { content: _content, properties: _properties, ...summary } = page;
    void _content; void _properties;
    // Database rows are listed by their database, not by the page tree.
    if (page.kind !== 'row') setPages(previous => previous.some(item => item.id === page.id)
      ? previous.map(item => item.id === page.id ? summary : item) : [...previous, summary]);
    if (activeIdRef.current === page.id) setDocumentPage(page);
  };

  const { queueWrite, persistDraft, scheduleSave, markDraft, savePage, savePageRef, saveTimers, waitForSave } = usePageSaver({
    session, workspace, tabId, actionsLoaded, activeIdRef, docsRef, draftsRef, pendingActionsRef,
    upsertPage, setStatus, setNotice, setReauth, setConflict, setOtherDraft, setEditorSnapshot });

  useEffect(() => {
    const controller = new AbortController();
    pageClient.session(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setSession(value); setSessionPhase('ready');
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (isAuthError(error)) setSessionPhase('login');
      else { setAuthError(message(error)); setSessionPhase('error'); }
    });
    return () => controller.abort();
  }, []);

  const login = async (name: string, password: string) => {
    setAuthBusy(true); setAuthError('');
    try {
      const value = await pageClient.login(name, password);
      if (session && value.user.id !== session.user.id) {
        setAuthError('当前草稿属于另一个账号。请用原账号登录，或先下载当前内容。');
        return;
      }
      setSession(value); setSessionPhase('ready'); setReauth(false); setShowReauthForm(false);
      if (activeIdRef.current) scheduleSave(activeIdRef.current, 50);
    } catch (error) { setAuthError(message(error)); }
    finally { setAuthBusy(false); }
  };

  const reloadTree = useCallback(async (currentSession: AuthSessionResponse) => {
    const scope = currentSession.workspaces[0];
    if (!scope) { setTreeError('账号没有可访问的工作区。'); return; }
    setTreeLoading(true); setTreeError('');
    try {
      const [tree, favorites] = await Promise.all([
        loadPageTree(scope.id), pageClient.favorites(scope.id).catch(() => null)]);
      setPages(tree.map(page => normalizePage(page)));
      if (favorites) setFavoriteIds(favorites.pageIds);
    } catch (error) { setTreeError(message(error)); if (isAuthError(error)) setReauth(true); }
    finally { setTreeLoading(false); }
  }, []);

  useEffect(() => { if (session) void reloadTree(session); }, [session, reloadTree]);
  useEffect(() => {
    setTags([]); setTreeTagIds([]);
    if (!workspace?.id) return;
    const controller = new AbortController();
    void tagClient.list(workspace.id, controller.signal).then(response => {
      if (!controller.signal.aborted) setTags(response.tags);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [workspaceScope, workspace?.id]);
  useEffect(() => {
    if (!dailyMode || !workspace?.id) return;
    let active = true;
    setTemplates([]);
    void noteTemplateClient.list(workspace.id).then(response => {
      if (active) setTemplates(response);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [dailyMode, workspace?.id]);
  useEffect(() => {
    if (!session || !workspace) return;
    let active = true;
    setActionsLoaded(false); setActionStorageError('');
    void localDrafts.forScopeActions(session.user.id, workspace.id).then(items => {
      if (!active) return;
      pendingActionsRef.current = new Map(items.map(item => [item.key, item]));
      setPendingActions(items); setActionsLoaded(true);
    }).catch(() => { if (active) setActionStorageError('无法读取本机待确认操作，网络保存已暂停；仍可继续输入并下载内容。请重试读取。'); });
    return () => { active = false; };
  }, [session, workspace]);
  useEffect(() => {
    if (!session || !workspace) return;
    let active = true;
    void localDrafts.forScopeCreates(session.user.id, workspace.id).then(pending => {
      if (!active) return;
      for (const item of pending) pendingCreatesRef.current.set(item.key, item);
      setPendingCreates([...pendingCreatesRef.current.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    }).catch(() => { if (active) setNotice('本机待创建记录暂不可用，请检查浏览器存储。'); });
    return () => { active = false; };
  }, [session, workspace]);

  const openPage = useCallback(async (pageId: string, force = false) => {
    if (!session || !workspace) return false;
    if (pendingBacklinkRef.current?.link.sourcePageId !== pageId) pendingBacklinkRef.current = null;
    const previousId = activeIdRef.current;
    if (!force && previousId === pageId && editorRef.current) return true;
    if (previousId && previousId !== pageId) {
      const snapshot = editorRef.current?.getSnapshot();
      if (snapshot && (draftsRef.current.has(previousId)
        || !contentMatchesServer(snapshot.content, docsRef.current.get(previousId)))) {
        markDraft(previousId, titleRef.current, snapshot);
      }
      void savePageRef.current(previousId);
    }
    const sequence = ++openSequence.current;
    setActive(pageId); setMobileOpen(false); setLoadingPage(true); setConflict(null); setOtherDraft(null);
    setRecentIds(previous => [pageId, ...previous.filter(id => id !== pageId)].slice(0, 30));
    setDocumentPage(null); setInitialContent(null); setEditorSnapshot(null); setStatus('正在读取页面…');
    try {
      const [server, allCandidates] = await Promise.all([
        pageClient.get(workspace.id, pageId), localDrafts.forPage(session.user.id, workspace.id, pageId)
          .catch(() => { setNotice('本机草稿库暂不可用；编辑前请确认能下载 Markdown。'); return []; }),
      ]);
      if (sequence !== openSequence.current) return false;
      docsRef.current.set(pageId, normalizePage(server));
      for (const item of allCandidates.filter(candidate => matchesServer(candidate, server))) {
        const inMemory = draftsRef.current.get(pageId);
        if (inMemory?.key === item.key && inMemory.sequence === item.sequence
          && inMemory.updatedAt === item.updatedAt && matchesServer(inMemory, server)) {
          draftsRef.current.delete(pageId);
        }
        void queueWrite(item.key, () => localDrafts.removeIfUnchanged(item)).catch(() => undefined);
      }
      const candidates = allCandidates.filter(item => !matchesServer(item, server));
      const ownKey = draftKey(session.user.id, workspace.id, pageId, tabId);
      const draft = candidates.find(item => item.key === ownKey);
      setOtherDraft(draft ? null : candidates[0] ?? null);
      if (draft) draftsRef.current.set(pageId, draft);
      setDocumentPage(server);
      if (draft && draft.baseRevision !== server.revision) {
        setConflict({ server, draft }); setStatus('发现待处理的本机草稿与服务端版本冲突');
        setCurrentTitle(draft.title);
      } else {
        setCurrentTitle(draft?.title ?? server.title);
        const content = draft?.content ?? server.content;
        setInitialContent(content.schemaVersion === 1 ? content as DocumentContent : null);
        setEditorEpoch(value => value + 1);
        setStatus(draft ? '已恢复本机草稿 · 等待服务端确认' : '已从服务端读取');
        if (draft) { void persistDraft(draft); scheduleSave(pageId, 200); }
      }
      return true;
    } catch (error) {
      if (sequence !== openSequence.current) return false;
      setStatus(message(error)); if (isAuthError(error)) setReauth(true);
      return false;
    } finally { if (sequence === openSequence.current) setLoadingPage(false); }
  }, [session, workspace, tabId, markDraft, persistDraft, queueWrite, scheduleSave]);
  const openPageRef = useRef(openPage);
  openPageRef.current = openPage;
  const openTreePage = useCallback((id: string) => { void openPageRef.current(id); }, []);
  const openReferencedPage = useCallback((pageId: string) => {
    setDialog(null); void openPageRef.current(pageId);
  }, []);
  const pageReferenceAccess = useMemo(() => ({ pages, open: openReferencedPage }), [pages, openReferencedPage]);

  useEffect(() => {
    if (!session || !workspace || !initialPageReference.current) return;
    const target = initialPageReference.current;
    initialPageReference.current = null;
    void openPageRef.current(target);
  }, [session, workspace]);

  const locatePendingBacklink = (pageId: string) => {
    const pending = pendingBacklinkRef.current;
    if (!pending || pending.link.sourcePageId !== pageId || activeIdRef.current !== pageId) return;
    pendingBacklinkRef.current = null;
    const editor = editorRef.current;
    const currentRevision = docsRef.current.get(pageId)?.revision;
    const hasLocalChanges = draftsRef.current.has(pageId);
    if (currentRevision === pending.link.sourceRevision && !hasLocalChanges
      && editor?.locatePageReference(pending.targetPageId, pending.link.occurrence)) return;
    const found = editor?.locatePageReference(pending.targetPageId);
    setNotice(found ? '来源页已更新，定位到当前正文中的第一处引用。' : '来源页已打开，引用可能已移除。');
  };

  const openBacklink = (link: PageBacklink, targetPageId: string) => {
    const samePage = activeIdRef.current === link.sourcePageId && Boolean(editorRef.current);
    const pending = { link, targetPageId };
    pendingBacklinkRef.current = pending;
    void openPage(link.sourcePageId).then(opened => {
      if (pendingBacklinkRef.current !== pending) return;
      if (!opened || docsRef.current.get(link.sourcePageId)?.content.schemaVersion !== 1) {
        pendingBacklinkRef.current = null;
        setNotice('来源页暂时无法定位，请刷新反向链接。');
      } else if (samePage) requestAnimationFrame(() => locatePendingBacklink(link.sourcePageId));
    });
  };

  const locatePendingSearch = (pageId: string) => {
    const pending = pendingSearchRef.current;
    if (!pending || pending.pageId !== pageId || activeIdRef.current !== pageId) return;
    pendingSearchRef.current = null;
    let found = false;
    if (pending.field === 'title') {
      const input = document.querySelector<HTMLInputElement>('.persistent-workspace .document-heading .page-title');
      const heading = document.querySelector<HTMLElement>('.persistent-workspace .document-heading h1');
      const position = input?.value.toLocaleLowerCase().indexOf(pending.phrase.toLocaleLowerCase()) ?? -1;
      if (input && position >= 0) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(position, position + pending.phrase.length);
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        found = true;
      } else if (heading?.textContent?.toLocaleLowerCase().includes(pending.phrase.toLocaleLowerCase())) {
        heading.scrollIntoView({ behavior: 'smooth', block: 'center' });
        found = true;
      }
    } else found = editorRef.current?.findText(pending.phrase) ?? false;
    if (!found) setNotice('页面已打开，但搜索词在当前版本或本机草稿中找不到。');
  };

  const openSearchResult = (result: SearchResult, phrase: string) => {
    const samePage = activeIdRef.current === result.pageId && Boolean(editorRef.current);
    pendingSearchRef.current = phrase ? { pageId: result.pageId, phrase, field: result.matchField } : null;
    setDialog(null);
    void openPage(result.pageId).then(opened => {
      if (!opened) {
        if (pendingSearchRef.current?.pageId === result.pageId) pendingSearchRef.current = null;
        setNotice('搜索结果已变化，页面暂时无法打开。请重新搜索。');
        return;
      }
      if (!phrase) return;
      if (samePage) requestAnimationFrame(() => locatePendingSearch(result.pageId));
      else if (docsRef.current.get(result.pageId)?.content.schemaVersion !== 1) {
        pendingSearchRef.current = null;
        setNotice('页面已打开，但当前格式版本暂不支持正文定位。');
      }
    });
  };

  const performCreate = async (pending: LocalPendingCreate, openResult = true) => {
    if (!session || !workspace || createBusyRef.current) return;
    if (pending.userId !== session.user.id || pending.workspaceId !== workspace.id) {
      setNotice('待创建记录属于其他账号或工作区。'); return;
    }
    createBusyRef.current = true; setCreateBusy(true);
    try {
      let page: PageDocument;
      try { page = await pageClient.create(workspace.id, pending.body, session.csrfToken); }
      catch (error) {
        if (!(error instanceof ApiError) || !['TIMEOUT', 'NETWORK_UNAVAILABLE'].includes(error.code)) throw error;
        const receipt = await pageClient.receipt(workspace.id, pending.body.clientMutationId).catch(() => null);
        if (!receipt) throw error;
        page = receipt.response;
      }
      await localDrafts.removeCreate(pending.key);
      untrackPendingCreate(pending.key);
      for (const source of pending.resolvesDrafts ?? []) {
        const inMemory = draftsRef.current.get(pending.resolvesDraftPageId ?? '');
        if (inMemory && sameDraftVersion(inMemory, source)) draftsRef.current.delete(inMemory.pageId);
        try { await queueWrite(source.key, () => localDrafts.removeIfVersion(source)); }
        catch { setNotice('新页面已创建，本机旧草稿清理失败；重新打开原页面时可再次检查。'); }
      }
      upsertPage(page);
      if (openResult) { setDialog(null); setPendingImport(null); await openPage(page.id); }
      if (page.tagIds?.length) void refreshTags().catch(() => undefined);
      return page;
    } catch (error) {
      setNotice(message(error)); setNoteDialogError(message(error)); if (isAuthError(error)) setReauth(true);
    } finally { createBusyRef.current = false; setCreateBusy(false); }
  };

  const createPage = async (parentId: string | null, titleValue = '未命名页面',
    content: StoredDocumentContent = createContentFromMarkdown(''), resolvesDraft?: LocalPageDraft, tagIds?: string[], openResult = true) => {
    if (!session || !workspace || createBusyRef.current) return;
    if (pendingCreatesRef.current.size) {
      const text = '上一笔创建尚未确认，请关闭窗口处理待创建记录。';
      setNotice(text); setNoteDialogError(text); return;
    }
    const clientMutationId = crypto.randomUUID();
    const pending: LocalPendingCreate = {
      key: `${session.user.id}:${workspace.id}:${clientMutationId}`, userId: session.user.id,
      workspaceId: workspace.id,
      body: { clientMutationId, parentId, title: titleValue, content, ...(tagIds?.length ? { tagIds } : {}) },
      createdAt: new Date().toISOString(),
      ...(resolvesDraft ? {
        resolvesDraftPageId: resolvesDraft.pageId,
        resolvesDrafts: [...(resolvesDraft.recoveredFrom ?? []), draftVersion(resolvesDraft)],
      } : {}),
    };
    trackPendingCreate(pending);
    try { await localDrafts.putCreate(pending); }
    catch {
      untrackPendingCreate(pending.key);
      const text = '无法先保留本机创建记录，请检查浏览器存储。';
      setNotice(text); setNoteDialogError(text);
      return;
    }
    return performCreate(pending, openResult);
  };

  const changeTitle = (value: string) => {
    if (!activeId) return;
    setCurrentTitle(value);
    const snapshot = editorRef.current?.getSnapshot() ?? editorSnapshot;
    if (snapshot) markDraft(activeId, value, snapshot);
  };

  const leaveCurrent = () => {
    const pageId = activeIdRef.current;
    if (pageId) {
      const snapshot = editorRef.current?.getSnapshot();
      if (snapshot && (draftsRef.current.has(pageId)
        || !contentMatchesServer(snapshot.content, docsRef.current.get(pageId)))) {
        markDraft(pageId, titleRef.current, snapshot);
      }
      void savePage(pageId);
    }
    ++openSequence.current;
    setActive(null); setDocumentPage(null); setEditorSnapshot(null); setConflict(null); setOtherDraft(null);
  };

  const settlePageBeforeWrite = async (pageId: string) => {
    if (!actionsLoaded || pageActionBusyRef.current
      || [...pendingActionsRef.current.values()].some(item => item.affectedIds.includes(pageId))
      || [...pendingCreatesRef.current.values()].some(item => item.resolvesDraftPageId === pageId)
      || pendingUploads.some(item => item.pageId === pageId)
      || (activeIdRef.current === pageId && otherDraft)) {
      throw new Error('此页还有待确认的操作或草稿，请先处理。');
    }
    await waitForSave(pageId);
    await savePage(pageId);
    await waitForSave(pageId);
    if (draftsRef.current.has(pageId)) throw new Error('请先完成此页的保存或解决冲突。');
  };

  const refreshTags = async () => {
    if (!workspace || !session) return;
    const response = await tagClient.list(workspace.id);
    if (liveScope.current !== workspaceScope) return;
    setTags(response.tags);
    const known = new Set(response.tags.map(tag => tag.id));
    setTreeTagIds(previous => previous.filter(id => known.has(id)));
  };

  const finishNoteWrite = async (write: NoteWrite, saved: PageDocument, pageAtStart: string | null) => {
    if (!session || liveScope.current !== workspaceScope) return;
    void reloadTree(session);
    if (write.kind === 'copy') void refreshTags().catch(() => undefined);
    if (write.kind === 'quick') {
      if (activeIdRef.current === saved.id && !draftsRef.current.has(saved.id)) await openPage(saved.id, true);
      setNotice('快速记录已保存。');
    } else if (activeIdRef.current === pageAtStart) {
      setDialog(null);
      await openPage(saved.id);
    }
  };

  const copyCurrentNote = async (nextTitle: string, parentId: string | null) => {
    if (!canWrite || !workspace || !activeId || copyPreparing) return;
    const sourceId = activeId;
    setNoteDialogError(''); setCopyPreparing(true);
    try {
      await settlePageBeforeWrite(sourceId);
      const saved = await pageClient.get(workspace.id, sourceId);
      if (activeIdRef.current !== sourceId || liveScope.current !== workspaceScope) return;
      const write: NoteWrite = { kind: 'copy', sourceId, body: { clientMutationId: crypto.randomUUID(),
        title: nextTitle, parentId, sourceRevision: saved.revision } };
      await finishNoteWrite(write, await noteWrites.submit(write), sourceId);
    } catch (error) { setNoteDialogError(message(error)); if (isAuthError(error)) setReauth(true); }
    finally { setCopyPreparing(false); }
  };

  const openDailyNote = async (input: Omit<OpenDailyNoteRequest, 'clientMutationId'>) => {
    const pageAtStart = activeIdRef.current;
    const write: NoteWrite = { kind: 'daily', body: { ...input, clientMutationId: crypto.randomUUID() } };
    await finishNoteWrite(write, await noteWrites.submit(write), pageAtStart);
  };

  const prepareQuickWrite = async (write: NoteWrite): Promise<NoteWrite> => {
    if (write.kind !== 'quick' || !write.targetPageId) return write;
    await settlePageBeforeWrite(write.targetPageId);
    const local = docsRef.current.get(write.targetPageId);
    const base = write.body.expectedRevision;
    if (!local || (base && BigInt(local.revision) <= BigInt(base))) return write;
    return { ...write, body: { ...write.body, expectedRevision: local.revision } };
  };

  const quickCapture = async (input: Omit<QuickCaptureRequest, 'clientMutationId'>, target: DailyNoteStatus['page']) => {
    if (!workspace) throw new Error('工作区不可用。');
    const pageAtStart = activeIdRef.current;
    const write: NoteWrite = { kind: 'quick', ...(target ? { targetPageId: target.id } : {}),
      body: { ...input, clientMutationId: crypto.randomUUID() } };
    await finishNoteWrite(write, await noteWrites.submit(write, target ? prepareQuickWrite : undefined), pageAtStart);
  };

  const retryNoteWrite = async (item: LocalPendingNoteWrite, rebase = false) => {
    if (!workspace) return;
    const pageAtStart = activeIdRef.current;
    try {
      if (item.preparing) {
        await finishNoteWrite(item.write, await noteWrites.retry(item, prepareQuickWrite), pageAtStart);
        return;
      }
      const confirmed = await noteWrites.confirm(item);
      if (confirmed) {
        await finishNoteWrite(item.write, confirmed, pageAtStart);
        return;
      }
      if (item.write.kind === 'copy') await settlePageBeforeWrite(item.write.sourceId);
      if (item.write.kind === 'quick') {
        const { page } = await dailyClient.status(workspace.id, item.write.body.date);
        if (page && !page.deleted) await settlePageBeforeWrite(page.id);
        if (rebase) {
          if (page?.deleted) throw new Error('这一天的笔记在回收站，请先恢复。');
          const latest = page ? await pageClient.get(workspace.id, page.id) : null;
          await finishNoteWrite(item.write, await noteWrites.rebaseQuick(item, latest?.revision), pageAtStart);
          return;
        }
      }
      await finishNoteWrite(item.write, await noteWrites.retry(item), pageAtStart);
    } catch (error) { setNotice(message(error)); if (isAuthError(error)) setReauth(true); }
  };

  const saveDailySettings = async (input: DailyNoteSettings) => {
    if (!workspace || !session) throw new Error('请先登录。');
    await dailyClient.updateSettings(workspace.id, { ...input, clientMutationId: crypto.randomUUID() }, session.csrfToken);
    setNotice('每日笔记设置已保存。');
  };

  const openTrash = (pageId?: string) => { setTrashTarget(pageId); setDialog('trash'); };

  const { performPageAction, beginPageAction } = createPageActions({ session, workspace, actionsLoaded, pages, pendingUploads, activeIdRef,
    titleRef, docsRef, draftsRef, pendingActionsRef, pendingCreatesRef, pageActionBusyRef, uploadingRef, openSequence, saveTimers, savePageRef,
    editorRef, setActive, setStatus, setNotice, setReauth, setDialog, setPages, setPendingActions, setPageActionBusy, setDocumentPage,
    setInitialContent, setEditorSnapshot, setConflict, setOtherDraft, openPage, reloadTree, refreshTags, markDraft, waitForSave });
  const beginPageActionRef = useRef(beginPageAction);
  beginPageActionRef.current = beginPageAction;

  const recoverOtherDraft = () => {
    if (!session || !workspace || !documentPage || !otherDraft || draftsRef.current.has(documentPage.id)) return;
    const adopted: LocalPageDraft = {
      ...otherDraft, key: draftKey(session.user.id, workspace.id, documentPage.id, tabId),
      updatedAt: new Date().toISOString(),
      recoveredFrom: [...(otherDraft.recoveredFrom ?? []), draftVersion(otherDraft)],
    };
    if (adopted.baseRevision !== documentPage.revision) {
      setConflict({ server: documentPage, draft: adopted }); setOtherDraft(null);
      return;
    }
    draftsRef.current.set(documentPage.id, adopted);
    setCurrentTitle(adopted.title);
    setInitialContent(adopted.content.schemaVersion === 1 ? adopted.content as DocumentContent : null);
    setEditorEpoch(value => value + 1);
    setOtherDraft(null);
    setStatus('已选用本机草稿 · 等待服务端确认');
    void persistDraft(adopted); scheduleSave(documentPage.id, 200);
  };

  /** One revisioned PATCH for parent/icon/cover; keeps the save-guard sequence of the old move flow. */
  const updatePageMeta = async (pageId: string,
    patch: Pick<UpdatePageRequest, 'parentId' | 'icon' | 'cover' | 'tagIds' | 'title' | 'properties'>,
    done: string, problem = '请先解决本页的保存问题，再修改页面。') => {
    if (!session || !workspace || readOnly || !canWrite) return false;
    if (pageActionBusyRef.current
      || [...pendingActionsRef.current.values()].some(action => action.affectedIds.includes(pageId))
      || [...pendingCreatesRef.current.values()].some(create => create.resolvesDraftPageId === pageId)
      || pendingUploads.some(upload => upload.pageId === pageId)) {
      setNotice('该页面还有待确认的操作，请先完成或重试，再修改页面。'); return false;
    }
    await waitForSave(pageId);
    await savePage(pageId);
    await waitForSave(pageId);
    if (draftsRef.current.has(pageId)) { setNotice(problem); return false; }
    const current = docsRef.current.get(pageId);
    if (!current) return false;
    try {
      const body: UpdatePageRequest = {
        clientMutationId: crypto.randomUUID(), expectedRevision: current.revision, ...patch,
      };
      let updated: PageDocument;
      try { updated = await pageClient.update(workspace.id, pageId, body, session.csrfToken); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 0) throw error;
        const receipt = await pageClient.receipt(workspace.id, body.clientMutationId).catch(() => null);
        if (!receipt) throw error;
        updated = receipt.response;
      }
      upsertPage(updated);
      if (done) setNotice(done);
      if (patch.tagIds) void refreshTags().catch(() => undefined);
      if (updated.kind === 'row' && updated.parentId) announceDatabaseChange(updated.parentId);
      if (updated.kind === 'database') announceDatabaseChange(updated.id);
      return true;
    } catch (error) {
      setNotice(error instanceof ApiError && error.code === 'PROPERTY_INVALID' ? '这个值不符合字段设置，未保存。' : message(error));
      if (isAuthError(error)) setReauth(true);
      return false;
    }
  };

  /** Rows of the open row page are written here so the page's revision stays in step with its body saves. */
  const [rowSaving, setRowSaving] = useState(false);
  const setRowProperty = async (pageId: string, propertyId: string, value: PropertyValue | null) => {
    setRowSaving(true);
    try { await updatePageMeta(pageId, { properties: { [propertyId]: value } }, ''); }
    finally { setRowSaving(false); }
  };

  /** Creates an empty database; `open` switches to it, otherwise the id is returned for an inline block. */
  const createDatabase = async (parentId: string | null, open = true): Promise<string | null> => {
    if (!session || !workspace || !canWrite || createBusyRef.current) return null;
    createBusyRef.current = true; setCreateBusy(true);
    try {
      const created = await databaseClient.create(workspace.id, { clientMutationId: crypto.randomUUID(), parentId,
        title: '未命名数据库' }, session.csrfToken);
      setPages(previous => previous.some(item => item.id === created.page.id) ? previous : [...previous, normalizePage(created.page)]);
      if (!open) return created.page.id;
      setDialog(null);
      createBusyRef.current = false; setCreateBusy(false);
      await openPage(created.page.id);
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('.persistent-workspace .document-heading .page-title');
        input?.focus(); input?.select();
      });
      return created.page.id;
    } catch (error) { setNotice(message(error)); if (isAuthError(error)) setReauth(true); return null; }
    finally { createBusyRef.current = false; setCreateBusy(false); }
  };
  const createDatabaseRef = useRef(createDatabase);
  createDatabaseRef.current = createDatabase;
  const databaseChoices = useMemo(() => pages.filter(page => page.kind === 'database')
    .map(page => ({ id: page.id, title: page.title, icon: page.icon })), [pages]);

  const databaseSource = useMemo(() => session && workspace ? createPersistentSource({
    workspaceId: workspace.id, csrfToken: session.csrfToken, canWrite: canWrite && !readOnly,
    openPage: id => { setDialog(null); void openPageRef.current(id); },
    notice: setNotice,
    trashRow: row => beginPageActionRef.current('trash', row.id, row.revision, row.title, undefined, true),
    onRowSaved: page => { if (docsRef.current.has(page.id)) upsertPage(page); },
    onRowsChanged: ids => { for (const id of ids) docsRef.current.delete(id); },
  }) : null, [session, workspace, canWrite, readOnly]);
  const databaseEmbedding = useMemo(() => databaseSource ? {
    source: databaseSource, databases: databaseChoices,
    createDatabase: () => {
      const parent = activeIdRef.current;
      return createDatabaseRef.current(parent && docsRef.current.get(parent)?.kind === 'document' ? parent : null, false);
    },
  } : undefined, [databaseSource, databaseChoices]);

  const placePageInTree = async (pageId: string, placement: PagePlacement) => {
    if (!session || !workspace || !canWrite) return;
    const page = pages.find(item => item.id === pageId);
    if (!page) return;
    if (page.parentId !== placement.parentId) {
      if (!await updatePageMeta(pageId, { parentId: placement.parentId }, '页面已移动并保存。', '请先解决本页的保存问题，再移动页面。')) return;
    }
    try {
      await pageClient.setPosition(workspace.id, pageId, placement.afterId, session.csrfToken);
      setPages(previous => placePage(previous, pageId, placement));
    } catch (error) { setNotice(message(error)); if (isAuthError(error)) setReauth(true); }
  };

  const movePage = async () => {
    if (!activeId || !session || !workspace || !documentPage) return;
    if (moveTarget === activeId || pages.some(page => {
      let candidate: PageSummary | undefined = page;
      while (candidate?.parentId) {
        if (candidate.parentId === activeId && page.id === moveTarget) return true;
        candidate = pages.find(item => item.id === candidate?.parentId);
      }
      return false;
    })) { setNotice('不能把页面移动到自己的子页面中。'); return; }
    if (await updatePageMeta(activeId, { parentId: moveTarget || null }, '页面已移动并保存。',
      '请先解决本页的保存问题，再移动页面。')) setDialog(null);
  };

  const setIcon = (pageId: string, icon: string | null) =>
    void updatePageMeta(pageId, { icon }, icon ? '图标已更新。' : '图标已移除。');
  const setCover = (pageId: string, cover: PageCoverId | null) =>
    void updatePageMeta(pageId, { cover }, cover ? '封面已更新。' : '封面已移除。');

  const toggleFavorite = async (pageId: string) => {
    if (!session || !workspace || favoriteBusyRef.current.has(pageId)) return;
    favoriteBusyRef.current.add(pageId);
    const favorite = favoriteIds.includes(pageId);
    try {
      if (favorite) await pageClient.removeFavorite(workspace.id, pageId, session.csrfToken);
      else await pageClient.addFavorite(workspace.id, pageId, session.csrfToken);
      setFavoriteIds(previous => favorite ? previous.filter(id => id !== pageId) : [...previous, pageId]);
    } catch (error) { setNotice(message(error)); if (isAuthError(error)) setReauth(true); }
    finally { favoriteBusyRef.current.delete(pageId); }
  };

  const logout = async () => {
    if (!session) return;
    const current = activeIdRef.current;
    if (current) {
      const snapshot = editorRef.current?.getSnapshot();
      if (snapshot && draftsRef.current.has(current)) markDraft(current, titleRef.current, snapshot);
      await savePage(current);
    }
    try { await pageClient.logout(session.csrfToken); }
    catch (error) { setNotice(message(error)); return; }
    setSession(null); setSessionPhase('login'); setActive(null); setDocumentPage(null);
    setPages([]); setRecentIds([]); docsRef.current.clear(); draftsRef.current.clear();
    pendingCreatesRef.current.clear(); setPendingCreates([]);
    pendingActionsRef.current.clear(); setPendingActions([]); setActionsLoaded(false);
  };

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (draftsRef.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (sessionPhase !== 'ready' || !workspace) return;
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === '\\') {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k'
        || (dialog && dialog !== 'search')) return;
      event.preventDefault();
      setDialog('search');
      if (dialog === 'search') document.querySelector<HTMLInputElement>('[aria-label="搜索标题或正文"]')?.focus();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sessionPhase, workspace, dialog]);

  const conflictMarkdown = useMemo(() => {
    if (!conflict) return null;
    try { return conflict.draft.markdown ?? markdownFromContent(conflict.draft.content as DocumentContent); }
    catch { return null; }
  }, [conflict]);

  if (sessionPhase === 'checking') return <div className="nb-gate"><main role="status">正在检查登录状态…</main></div>;
  if (sessionPhase === 'error') return <div className="nb-gate"><main role="alert">
    <h1>无法读取登录状态</h1><p>{authError}</p><button className="nb-btn nb-btn-primary" onClick={() => location.reload()}>重试</button>
  </main></div>;
  if (sessionPhase === 'login' || !session) return <div className="nb-auth">
    <LoginForm onLogin={login} error={authError} busy={authBusy} />
  </div>;

  const current = documentPage;
  const currentLocked = pageActionBusy || pendingActions.some(item => activeId && item.affectedIds.includes(activeId));
  const rawContent = initialContent ?? current?.content;
  const supported = rawContent?.schemaVersion === 1;
  const openSource = () => {
    const snapshot = editorRef.current?.getSnapshot();
    if (!current || !snapshot || !workspaceScope) { setNotice('当前正文还未打开。'); return; }
    setSourceSession({ pageId: current.id, instanceId: crypto.randomUUID(), content: snapshot.content,
      baseRevision: draftsRef.current.get(current.id)?.baseRevision ?? current.revision,
      title: titleRef.current, parentId: current.parentId, scope: workspaceScope });
    setDialog('source');
  };
  const verifySourceAttachments = async (content: DocumentContent) => {
    if (!workspace || !sourceSession || sourceSession.scope !== liveScope.current) throw new Error('账号或工作区已改变，请重新打开源码。');
    try {
      for (const item of exportAttachments(content)) await attachmentClient.verify(workspace.id, item.id);
    } catch (error) { if (isAuthError(error)) setReauth(true); throw new Error(message(error)); }
    if (sourceSession.scope !== liveScope.current) throw new Error('附件校验期间账号或工作区已改变，源码仍保留。');
  };
  const applySource = async (content: DocumentContent, baseContent: DocumentContent, _baseRevision: string) => {
    if (!sourceSession || !canWrite || readOnly || currentLocked || conflict || otherDraft) {
      throw new Error('请先处理此页的只读状态、冲突或待确认操作。源码仍保留。');
    }
    const editor = editorRef.current;
    const isCurrent = () => sourceSession.scope === liveScope.current && sourceSession.pageId === activeIdRef.current
      && editor && editor === editorRef.current
      && canonicalContent(editor.getSnapshot().content) === canonicalContent(baseContent);
    if (!isCurrent()) throw new Error('当前正文已与源码会话的基准不同，请复制源码或另存为新页面。');
    await verifySourceAttachments(content);
    if (!isCurrent()) throw new Error('校验期间正文或页面发生变化，源码仍保留，请重新打开或另存。');
    if (editor!.replaceContent(content)) {
      const draft = draftsRef.current.get(sourceSession.pageId);
      if (!draft || !await persistDraft(draft)) throw new Error('正文已应用到本机编辑器，但草稿写入失败。请保留并复制源码。');
    }
    setNotice('源码已应用，可一次撤销；服务端状态以保存提示为准。');
  };
  const saveSourceCopy = async (content: DocumentContent) => {
    if (!sourceSession || !canWrite || sourceSession.scope !== liveScope.current) throw new Error('当前无法创建副本，源码仍保留。');
    await verifySourceAttachments(content);
    const copyTitle = (sourceSession.title || '未命名页面').slice(0, 240).replace(/[\ud800-\udbff]$/, '') + '-源码副本';
    const saved = await createPage(sourceSession.parentId, copyTitle, content,
      undefined, undefined, false);
    if (!saved) throw new Error('副本尚未确认；源码与待创建操作仍保留，请先处理待创建记录。');
    setNotice('源码已另存为新页面，可从侧栏打开。');
  };
  const { exportCurrent, exportFolder, uploadFiles, retryUpload, importFile, completeImport } = createPageTransfers({ session, workspace,
    workspaceScope, liveScope, current, title, conflict, conflictMarkdown, supported, tags, readOnly, currentLocked, canWrite, pendingImport,
    editorSnapshot, editorRef, activeIdRef, draftsRef, uploadingRef, folderExportingRef, importResolvingRef, createBusyRef, setDialog, setNotice,
    setReauth, setNoteDialogError, setFolderExporting, setImportResolving, setPendingImport, setPendingUploads, settlePageBeforeWrite, createPage });
  const toggleSidebar = () => {
    if (window.innerWidth <= 720) { setMobileOpen(!mobileOpen); return; }
    setSidebarHidden(value => {
      const next = !value;
      try { localStorage.setItem('nbase.sidebar', next ? 'collapsed' : 'open'); } catch { /* best effort */ }
      return next;
    });
  };
  const ancestors = ancestorChain(pages, current?.parentId ?? null);
  const favoriteSet = new Set(favoriteIds);
  const favoritePages = favoriteIds.flatMap(id => pages.filter(page => page.id === id));
  const recentPages = recentIds.flatMap(id => pages.filter(page => page.id === id)).slice(0, 5);
  const homePages = [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
  const editorReadOnly = readOnly || currentLocked || !canWrite;
  const pickAttachment = (kind: AttachmentPickKind) => {
    const input = attachmentInputRef.current;
    if (!input) return;
    input.accept = attachmentAccept[kind];
    input.click();
  };
  const openNewNote = (parentId: string | null) => {
    if (!canWrite || createBusyRef.current) return;
    setNewParent(parentId); setNoteDialogError(''); setDialog('new');
  };
  const openTemplates = (fromPage = false) => {
    if (!canWrite) return;
    const content = fromPage ? editorRef.current?.getSnapshot().content : undefined;
    if (fromPage && !content) return;
    setTemplateSource(content ? { title: titleRef.current, content } : undefined);
    setDialog('templates');
  };
  const treeActions = {
    onOpen: openTreePage,
    onAddChild: (id: string) => openNewNote(id),
    ...(canWrite ? { onAddDatabase: (id: string) => { void createDatabase(id); } } : {}),
    onFavorite: (id: string) => { void toggleFavorite(id); },
    onMove: (id: string) => {
      void openPage(id).then(opened => {
        if (!opened) return;
        setMoveTarget(docsRef.current.get(id)?.parentId ?? ''); setDialog('move');
      });
    },
    onTrash: (id: string) => { void openPage(id).then(opened => { if (opened) setDialog('delete'); }); },
    ...(canWrite ? { onPlace: (id: string, placement: PagePlacement) => { void placePageInTree(id, placement); } } : {}),
  };
  const pageMenuItems: (MenuItem | 'divider')[] = current?.kind === 'database' ? [
    { key: 'move', label: '移动到…', icon: 'folder', disabled: currentLocked || !canWrite, onSelect: () => { setMoveTarget(current.parentId ?? ''); setDialog('move'); } },
    'divider',
    { key: 'trash', label: '移入回收站（含所有行）', icon: 'trash', danger: true, disabled: currentLocked || !canWrite, onSelect: () => setDialog('delete') },
  ] : current?.kind === 'row' ? [
    ...readingMenuItems(readingPrefs, setReadingPrefs),
    'divider',
    { key: 'mode', label: readOnly ? '切换为编辑' : '切换为阅读', icon: 'focus', disabled: !canWrite, onSelect: () => setReadOnly(!readOnly) },
    { key: 'attach', label: '添加图片或附件', icon: 'image', disabled: editorReadOnly, onSelect: () => pickAttachment('file') },
    { key: 'source', label: 'Markdown 源码', icon: 'code', onSelect: openSource },
    { key: 'download', label: '下载页面', icon: 'download', onSelect: exportCurrent },
    ...(current.parentId ? [{ key: 'database', label: '返回数据库', icon: 'table' as const, onSelect: () => void openPage(current.parentId!) }] : []),
    'divider',
    { key: 'trash', label: '移入回收站', icon: 'trash', danger: true, disabled: currentLocked || !canWrite, onSelect: () => setDialog('delete') },
  ] : current ? [
    ...readingMenuItems(readingPrefs, setReadingPrefs),
    'divider',
    { key: 'mode', label: readOnly ? '切换为编辑' : '切换为阅读', icon: 'focus', disabled: !canWrite, onSelect: () => setReadOnly(!readOnly) },
    { key: 'attach', label: '添加图片或附件', icon: 'image', disabled: editorReadOnly, onSelect: () => pickAttachment('file') },
    { key: 'source', label: 'Markdown 源码', icon: 'code', onSelect: openSource },
    { key: 'download', label: '下载页面', icon: 'download', onSelect: exportCurrent },
    { key: 'folder-zip', label: '导出已保存的页面与子页面 ZIP', icon: 'download', disabled: folderExporting, onSelect: () => void exportFolder() },
    'divider',
    { key: 'child', label: '添加子页面', icon: 'plus', disabled: createBusy || currentLocked || !canWrite, onSelect: () => openNewNote(current.id) },
    { key: 'child-database', label: '添加数据库', icon: 'table', disabled: createBusy || currentLocked || !canWrite, onSelect: () => void createDatabase(current.id) },
    { key: 'copy', label: '复制页面', icon: 'copy', disabled: currentLocked || !canWrite || !noteWrites.ready || noteWrites.busy,
      onSelect: () => { setNoteDialogError(''); setDialog('copy'); } },
    { key: 'template', label: '另存为个人模板', icon: 'page', disabled: currentLocked || !canWrite, onSelect: () => openTemplates(true) },
    { key: 'move', label: '移动到…', icon: 'folder', disabled: currentLocked || !canWrite, onSelect: () => { setMoveTarget(current.parentId ?? ''); setDialog('move'); } },
    'divider',
    { key: 'trash', label: '移入回收站', icon: 'trash', danger: true, disabled: currentLocked || !canWrite, onSelect: () => setDialog('delete') },
  ] : [];

  return <div className={`nb-app persistent-workspace ${sidebarHidden ? 'nb-sidebar-collapsed' : ''}`}>
    <Sidebar workspaceName={workspace?.name ?? '个人空间'} loginName={session.user.loginName}
      theme={theme} onTheme={setTheme} onLogout={() => void logout()}
      onSearch={() => setDialog('search')} onTrash={() => openTrash()}
      noteActions={<>
        <button className="nb-nav-row" onClick={() => setDialog('today')}><Icon name="clock" size={15} /><span>今天</span></button>
        {canWrite && <>
          <button className="nb-nav-row" disabled={!noteWrites.ready} onClick={() => setDialog('quick-capture')}><Icon name="plus" size={15} /><span>快速记录</span></button>
          <button className="nb-nav-row" onClick={() => openTemplates()}><Icon name="page" size={15} /><span>笔记模板</span></button>
          <button className="nb-nav-row" onClick={() => setDialog('tags')}><Icon name="folder" size={15} /><span>管理标签</span></button>
        </>}
        {workspace?.role === 'owner' && <button className="nb-nav-row" onClick={() => setDialog('settings')}><Icon name="settings" size={15} /><span>每日笔记设置</span></button>}
      </>}
      treeControls={tags.length > 0 && <TagFilter tags={tags} value={treeTagIds} onChange={setTreeTagIds} />}
      onNewPage={() => openNewNote(null)} onImport={() => { if (canWrite) fileRef.current?.click(); }}
      {...(canWrite ? { onNewDatabase: () => void createDatabase(null) } : {})}
      {...(canWrite ? { onImportFolder: () => setDialog('folder-import') } : {})}
      createBusy={createBusy || !canWrite} pages={filterPageTree(pages, treeTagIds)} activeId={activeId}
      favorites={favoriteSet} favoritePages={favoritePages} recentPages={recentPages}
      treeLoading={treeLoading} treeError={treeError} onTreeRetry={() => void reloadTree(session)}
      treeActions={treeActions} open={mobileOpen} onClose={() => setMobileOpen(false)} />
    <section className="nb-main">
      {activeId && <Topbar status={saveStatus} hasDraft={Boolean(current && draftsRef.current.has(current.id))}
        onRetrySave={() => { if (current) void savePage(current.id); }} onDownload={exportCurrent}
        breadcrumbs={ancestors} currentTitle={title} updatedAt={current?.updatedAt ?? null}
        favorite={Boolean(activeId && favoriteSet.has(activeId))} onFavorite={() => { if (activeId) void toggleFavorite(activeId); }}
        onSidebarToggle={toggleSidebar}
        onOpenBreadcrumb={id => { if (id) void openPage(id); else leaveCurrent(); }}
        readOnly={readOnly} onToggleReadOnly={() => setReadOnly(!readOnly)}
        onHistory={() => setDialog('history')} hideHistory={current?.kind === 'database'} disabled={currentLocked} pageMenuItems={pageMenuItems} />}
      {!activeId && <header className="nb-topbar">
        <button className="icon-button nb-sidebar-toggle" aria-label="切换导航" onClick={toggleSidebar}><Icon name="sidebar" size={17} /></button>
        <nav className="nb-crumbs" aria-label="页面位置"><strong>工作台</strong></nav></header>}
      <WorkspaceNotices activeId={activeId} actionStorageError={actionStorageError} pendingActions={pendingActions} pageActionBusy={pageActionBusy}
        performPageAction={performPageAction} pendingCreates={pendingCreates} createBusy={createBusy} performCreate={performCreate}
        untrackPendingCreate={untrackPendingCreate} reloadWorkspaceTree={() => void reloadTree(session)} noteWrites={noteWrites} canWrite={canWrite}
        retryNoteWrite={retryNoteWrite} pendingUploads={pendingUploads} retryUpload={retryUpload} setPendingUploads={setPendingUploads}
        reauth={reauth} setShowReauthForm={setShowReauthForm} current={current} exportCurrent={exportCurrent} otherDraft={otherDraft}
        draftsRef={draftsRef} recoverOtherDraft={recoverOtherDraft} setNotice={setNotice} />
      <main className="nb-scroll">
        {activeId ? loadingPage ? <div className="nb-home" role="status">正在读取页面…</div>
          : conflict ? <ConflictCard conflict={conflict} conflictMarkdown={conflictMarkdown} createBusy={createBusy} onDownload={exportCurrent}
            onSaveCopy={() => void createPage(conflict.server.parentId, `${conflict.draft.title || '未命名页面'}（冲突副本）`, conflict.draft.content, conflict.draft)} />
          : current && current.kind === 'database' ? <>
            <div className="nb-doc-wide-head">
              <PageHeader icon={current.icon ?? '🗃️'} cover={current.cover} editable={!editorReadOnly}
                onIcon={icon => setIcon(current.id, icon)} onCover={cover => setCover(current.id, cover)}
                title={readOnly || !canWrite ? <h1 className="nb-doc-title-static" data-nbase-find-title>{title || '未命名数据库'}</h1>
                  : <input className="nb-doc-title page-title" data-nbase-find-title aria-label="数据库标题" value={title} disabled={currentLocked}
                    onChange={event => setCurrentTitle(event.target.value)} placeholder="未命名数据库"
                    onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}
                    onBlur={() => { if (titleRef.current !== current.title) void updatePageMeta(current.id, { title: titleRef.current.slice(0, 255) }, ''); }} />} />
            </div>
            <div className="nb-doc-wide">
              {databaseSource && <DatabaseView key={current.id} source={databaseSource} databaseId={current.id} />}
            </div>
          </> : current ? <>
            <PageHeader icon={current.icon} cover={current.cover} editable={!editorReadOnly}
              onIcon={icon => setIcon(current.id, icon)} onCover={cover => setCover(current.id, cover)}
              title={readOnly || !canWrite ? <h1 className="nb-doc-title-static" data-nbase-find-title>{title || '未命名页面'}</h1>
                : <input className="nb-doc-title page-title" data-nbase-find-title aria-label="页面标题" value={title} disabled={currentLocked}
                  onChange={event => changeTitle(event.target.value)} placeholder="未命名页面" />} />
            <div className="nb-doc-body">
              {current.kind === 'row' && current.parentId && databaseSource && <RowPanel key={current.parentId}
                source={databaseSource} databaseId={current.parentId} row={rowFromPage(current)} pending={rowSaving}
                editable={!editorReadOnly} onChange={(propertyId, value) => void setRowProperty(current.id, propertyId, value)} />}
              {(tags.length > 0 || current.tagIds?.length) && <PageTagControls tags={tags} value={current.tagIds ?? []}
                disabled={editorReadOnly} {...(canWrite ? { onApply: (tagIds: string[]) => updatePageMeta(current.id, { tagIds }, '页面标签已保存。') } : {})} />}
              {supported && initialContent ? <DocumentEditor key={`${current.id}:${editorEpoch}`} ref={editorRef} documentId={current.id}
                pageReferences={pageReferenceAccess}
                title={title} onReplaceTitle={(value, bodyChanged) => bodyChanged ? setCurrentTitle(value) : changeTitle(value)}
                initialContent={initialContent} readOnly={editorReadOnly}
                onChange={(id, snapshot) => { if (id === activeIdRef.current) markDraft(id, titleRef.current, snapshot); }}
                onReady={(id, snapshot) => { setEditorSnapshot(snapshot);
                  if (pendingSearchRef.current?.pageId === id) requestAnimationFrame(() => locatePendingSearch(id));
                  if (pendingBacklinkRef.current?.link.sourcePageId === id) requestAnimationFrame(() => locatePendingBacklink(id));
                }} onNotice={setNotice}
                workspaceId={workspace?.id} onUploadFiles={uploadFiles} onPickAttachment={pickAttachment} databases={databaseEmbedding} />
                : <div role="alert" className="nbase-unsupported"><h2>暂不能打开此格式版本</h2>
                  <p>原始数据仍保留在服务端。请先下载副本，等待兼容升级。</p>
                  <button className="nb-btn" onClick={exportCurrent}>下载原始 JSON</button></div>}
              {workspace && <PageBacklinks key={current.id} workspaceId={workspace.id} pageId={current.id} revision={current.revision}
                onOpen={link => openBacklink(link, current.id)} />}
            </div>
            <Toc outline={editorSnapshot?.outline ?? []} onJump={id => editorRef.current?.jumpToHeading(id)} />
          </> : <section className="nb-home" role="alert">页面暂时无法打开。{saveStatus.text}</section>
          : pages.length ? <HomePanel workspaceName={workspace?.name} pages={pages} homePages={homePages} createBusy={createBusy} canWrite={canWrite}
            onOpen={id => void openPage(id)} onNew={() => openNewNote(null)} />
          : treeLoading ? <section className="nb-home" role="status">正在加载目录…</section>
          : <EmptyPanel createBusy={createBusy} canWrite={canWrite} onNew={() => openNewNote(null)} onImport={() => fileRef.current?.click()} />}
      </main>
    </section>
    <input ref={fileRef} type="file" accept=".md,text/markdown" className="visually-hidden" aria-label="选择 Markdown 文件"
      onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
    <input ref={attachmentInputRef} type="file" accept={attachmentAccept.file} multiple
      className="visually-hidden" aria-label="选择图片或附件"
      onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = '';
        void uploadFiles(files).then(uploaded => editorRef.current?.insertAttachments(uploaded)); }} />
    {notice && <Toast text={notice} onClose={() => setNotice('')} />}
    {reauth && showReauthForm && <div className="nb-auth" style={{ position: 'fixed', inset: 0, zIndex: 90 }}><div>
      <LoginForm title="重新登录以继续保存" onLogin={login} error={authError} busy={authBusy} />
      <p style={{ textAlign: 'center' }}><button className="nb-btn nb-btn-quiet" onClick={() => setShowReauthForm(false)}>继续写作</button></p>
      <p className="nb-login-foot">本机草稿仍保留。可以关闭窗口继续输入，稍后再登录。</p>
    </div></div>}
    {dialog === 'source' && sourceSession && workspace && sourceSession.scope === workspaceScope && <SourceEditorDialog key={sourceSession.instanceId}
      scope={{ userId: session.user.id, workspaceId: workspace.id, pageId: sourceSession.pageId,
        instanceId: sourceSession.instanceId, baseRevision: sourceSession.baseRevision }} initialContent={sourceSession.content}
      readOnly={editorReadOnly} attachmentWorkspaceId={workspace.id} pageReferences={pageReferenceAccess}
      onApply={applySource} onSaveCopy={saveSourceCopy} onClose={() => setDialog(null)} />}
    {dialog === 'search' && workspace && <PersistentSearchDialog workspaceId={workspace.id}
      pages={pages} recentPages={recentPages} tags={tags}
      onClose={() => setDialog(null)} onOpen={openSearchResult}
      onCommand={command => {
        setDialog(null);
        if (command === 'new') openNewNote(null);
        if (command === 'import' && canWrite) fileRef.current?.click();
        if (command === 'trash') openTrash();
        if (command === 'theme') setTheme(theme === 'dark' ? 'light' : 'dark');
      }}
      onAuthError={() => { setReauth(true); setShowReauthForm(true); setDialog(null); }} />}
    {dialog === 'history' && workspace && current && <PageHistoryDialog key={current.id} workspaceId={workspace.id}
      pageId={current.id} currentRevision={current.revision} busy={pageActionBusy || !canWrite} pageReferences={pageReferenceAccess}
      onRestore={(version: PageVersion) => void beginPageAction('restore-version', current.id, current.revision, title, version.revision)}
      onClose={() => setDialog(null)} />}
    {dialog === 'trash' && workspace && <TrashDialog workspaceId={workspace.id} busy={pageActionBusy || !canWrite}
      pages={pages} initialPageId={trashTarget} pageReferences={pageReferenceAccess}
      onRestore={(page: TrashedPageDocument) => void beginPageAction('restore', page.id, page.revision, page.title)}
      onClose={() => setDialog(null)} />}
    {dialog === 'new' && workspace && canWrite && <NewNoteDialog workspaceId={workspace.id} csrfToken={session.csrfToken}
      busy={createBusy} error={noteDialogError} onCreate={(nextTitle, content) => {
        setNoteDialogError(''); void createPage(newParent, nextTitle, content);
      }} onClose={() => setDialog(null)} />}
    {dialog === 'templates' && workspace && canWrite && <TemplateManagerDialog key={JSON.stringify([session.user.id, workspace.id])}
      userId={session.user.id} workspaceId={workspace.id}
      csrfToken={session.csrfToken} {...(templateSource ? { source: templateSource } : {})} onClose={() => setDialog(null)} />}
    {dialog === 'copy' && workspace && current && canWrite && <CopyNoteDialog source={current} pages={pages}
      busy={copyPreparing || noteWrites.busy} error={noteDialogError} onCopy={(nextTitle, parentId) => void copyCurrentNote(nextTitle, parentId)}
      onClose={() => setDialog(null)} />}
    {dialog === 'tags' && workspace && canWrite && <TagManagerDialog tags={tags} workspaceId={workspace.id} csrfToken={session.csrfToken}
      onChanged={async () => { await Promise.all([refreshTags(), reloadTree(session)]); }} onClose={() => setDialog(null)}
      onAuthError={() => { setDialog(null); setReauth(true); setShowReauthForm(true); }} />}
    {dailyMode && workspace && <DailyNoteDialog workspaceId={workspace.id} mode={dailyMode} templates={templates} parents={pages}
      readOnly={!canWrite || !noteWrites.ready} onClose={() => setDialog(null)}
      onOpenPage={async id => { if (!await openPage(id)) throw new Error('页面暂时无法打开。'); }}
      onRestorePage={id => openTrash(id)} onCreate={openDailyNote} onCapture={quickCapture} onSaveSettings={saveDailySettings} />}
    {dialog === 'delete' && current && <TrashPageDialog title={title} childCount={subtreeIds(pages, current.id).length - 1} busy={pageActionBusy}
      onConfirm={() => void beginPageAction('trash', current.id, current.revision, title)} onClose={() => setDialog(null)} />}
    {dialog === 'move' && current && <MovePageDialog current={current} pages={pages.filter(page => page.kind !== 'database')} target={moveTarget} onTarget={setMoveTarget}
      onConfirm={() => void movePage()} onClose={() => setDialog(null)} />}
    {dialog === 'folder-import' && workspace && canWrite && <FolderImportDialog userId={session.user.id} workspaceId={workspace.id}
      csrfToken={session.csrfToken} pages={pages} defaultParentId={activeId} parseMarkdown={parseMarkdownImport}
      resolveTagIds={names => resolveImportTags(workspace.id, session.csrfToken, names)}
      onOpenPage={id => { setDialog(null); void openPage(id); }}
      onImported={() => { void reloadTree(session); void refreshTags().catch(() => undefined); }} onClose={() => setDialog(null)} />}
    {dialog === 'import' && pendingImport && <ImportMarkdownDialog pendingImport={pendingImport} importResolving={importResolving} createBusy={createBusy}
      error={noteDialogError} onConfirm={() => void completeImport()} onClose={() => setDialog(null)} />}
  </div>;
}
