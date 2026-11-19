import type { AttachmentMetadata, LinkPreview } from '@nbase/contracts';
﻿import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthSessionResponse, DailyNoteSettings, DailyNoteStatus, NoteTemplate, OpenDailyNoteRequest,
  PageBacklink, PageCoverId, PageDocument, PageSummary, PageVersion, QuickCaptureRequest, SearchResult, WorkspaceHistorySearchResult,
  StoredDocumentContent, TrashedPageDocument, UpdatePageRequest, WorkspaceTag } from '@nbase/contracts';
import { bytesToBase64, isWhiteboardContent, pageIdFromReferenceUrl, whiteboardContent } from '@nbase/contracts';
import { LazyWhiteboard } from '../whiteboard/lazy';
import type { WhiteboardCollab } from '../whiteboard/WhiteboardView';
import { attachmentContentUrl, boardSnapshot } from '../whiteboard/host';
import { Icon } from '../components/Icon';
import { DocumentEditor } from '../editor/DocumentEditor';
import { placePage, type PagePlacement } from '../shell/pageOrder';
import { readingMenuItems, useReadingPrefs } from '../shell/readingPrefs';
import { SourceEditorDialog } from '../editor/SourceEditorDialog';
import { addMarkdownFrontMatter, createContentFromMarkdown, markdownFromContent, parseMarkdownImport, rowPropertiesFrontMatter } from '../editor/markdown';
import type { AttachmentPickKind, DocumentCollab, DocumentContent, DocumentEditorHandle, EditorSnapshot } from '../editor/types';
import type { Provider } from '@lexical/yjs';
import { resolveBlockText } from './blockResolver';
import { ApiError, attachmentClient, loadPageTree, pageClient, request, tagClient, workspacePath } from './client';
import { downloadBlob } from './fileDownload';
import { packageFolderSubtree } from './folderExport';
import type { PageProperty, PropertyValue } from '@nbase/contracts';
import { LazyDatabaseView as DatabaseView, LazyPageProperties, LazyRowPanel as RowPanel } from '../database/lazy';
import { createPersistentSource, databaseClient, rowFromPage } from '../database/persistentSource';
import { announceDatabaseChange, requestDatabaseExport } from '../database/source';
import { draftKey, draftVersion, localDrafts, sameDraftVersion,
  type LocalPageDraft, type LocalPendingAction, type LocalPendingCreate, type LocalPendingNoteWrite } from './drafts';
import { useNoteWrites } from './useNoteWrites';
import type { NoteWrite } from './noteWrites';
import { exportAttachments } from './attachmentExport';
import { PersistentSearchDialog } from './PersistentSearchDialog';
import { PageHistoryDialog, TrashDialog } from './PageRecoveryDialogs';
import { PageBacklinks } from './PageBacklinks';
import { RowChildPages } from './RowChildPages';
import { LazyGraphDialog, LazyLocalGraph, useGraphShortcut } from '../graph/lazy';
import { createPersistentGraphSource } from '../graph/persistentSource';
import { LazyWorkspaceCalendar } from '../workspaceCalendar/lazy';
import { createPersistentCalendarSource } from '../workspaceCalendar/persistentSource';
import { syncedReadOnlyHint } from '../database/sync';
import { startReminderRunner } from '../reminders/runner';
import { FolderImportDialog } from './FolderImportDialog';
import { resolveImportTags } from './importTags';
import { CopyNoteDialog, NewNoteDialog, TemplateManagerDialog } from './NoteTemplateDialogs';
import { noteTemplateClient } from './noteTemplateClient';
import { DailyNoteDialog, DailyNoteSettingsPanel, dailyClient } from './DailyNoteDialog';
import { TagFilter, TagManagerDialog, filterPageTree } from './PageTags';
import { canonicalContent, contentMatchesServer, matchesServer } from './draftCompare';
import { LoginForm } from './LoginForm';
import { MembersPanel, roleLabels } from './MembersDialog';
import { commentClient } from './collabClient';
import { CommentsPanel, type CommentLocator } from './CommentsPanel';
import { ShareDialog } from './ShareDialog';
import { useLiveChannel, type LiveSaved } from './useLiveChannel';
import { RoomClient, type RoomEvent, type RoomFallbackCode, type RoomPhase, type RoomSaveResult } from './collab/roomClient';
import { defaultRoomStore, type RoomRecord } from './collab/roomStore';
import { NoticeBar } from '../shell/NoticeBar';
import { ImportMarkdownDialog, MovePageDialog, TrashPageDialog } from './PageActionDialogs';
import { createPageActions } from './pageActions';
import { createPageTransfers, type PendingImport, type PendingUpload } from './pageTransfers';
import { ancestorChain, subtreeIds } from './pageTreePaths';
import { usePageSaver } from './usePageSaver';
import { EmbeddedPagesProvider, EmbedPathProvider, EmbedStates, type EmbeddedPages } from '../embed/source';
import { ConflictCard, EmptyPanel, HomePanel } from './WorkspacePanels';
import { WorkspaceNotices } from './WorkspaceNotices';
import { isAuthError, message } from './workspaceErrors';
import { useTheme } from '../shell/theme';
import { saveToneFor, type SaveStatus } from '../shell/saveTone';
import { Sidebar, SidebarTool } from '../shell/Sidebar';
import { AccountSettings, AppearanceSettings, SettingsDialog } from '../shell/SettingsDialog';
import { Topbar } from '../shell/Topbar';
import { PageHeader } from '../shell/PageHeader';
import { Toc } from '../shell/Toc';
import { Toast } from '../shell/Toast';
import { type MenuItem } from '../shell/Menu';
import { ExportDialog, printPage, type ExportOption } from '../shell/ExportDialog';
import type { TreeRowActions } from '../shell/PageTree';
import '../shell/shell.css';
import './persistent.css';

const attachmentAccept: Record<AttachmentPickKind, string> = {
  image: '.png,.jpg,.jpeg,.gif,.webp',
  file: '.png,.jpg,.jpeg,.gif,.webp,.pdf,.zip,.txt,.md,.mp3,.m4a,.wav,.ogg,.oga,.mp4,.m4v,.webm',
};

const cursorColors = ['#e5484d', '#f76b15', '#e0a800', '#30a46c', '#0090ff', '#6e56cf', '#d6409f', '#697177'];
function cursorColorFor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return cursorColors[hash % cursorColors.length]!;
}

function roomFallbackNotice(code: RoomFallbackCode): string {
  switch (code) {
    case 'TOO_LARGE': return '一次修改超过了实时传输上限，此页已改为普通保存。';
    case 'NOT_FOUND': return '页面已被移入回收站。';
    case 'ROOM_LIMIT': return '同时打开的协同页面过多，此页已改为普通保存。';
    case 'REALTIME_DISABLED': return '服务端未开启实时协同，此页已改为普通保存。';
    default: return '实时协同暂时不可用，此页已改为普通保存。';
  }
}

export function PersistentWorkspace() {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [sessionPhase, setSessionPhase] = useState<'checking' | 'login' | 'ready' | 'error'>('checking');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [historyNameRevision, setHistoryNameRevision] = useState<string | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ pageId: string; revision: string; query: string } | null>(null);
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
    'new' | 'templates' | 'copy' | 'tags' | 'today' | 'quick-capture' | 'settings' | 'folder-import' | 'graph' | 'share' | 'export' | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentRefresh, setCommentRefresh] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  const [remoteSave, setRemoteSave] = useState<LiveSaved | null>(null);
  const [newParent, setNewParent] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [dailyNoteDate, setDailyNoteDate] = useState<string | undefined>(undefined);
  const [copyPreparing, setCopyPreparing] = useState(false);
  const [noteDialogError, setNoteDialogError] = useState('');
  const [templateSource, setTemplateSource] = useState<{ title: string; content: StoredDocumentContent }>();
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [tags, setTags] = useState<WorkspaceTag[]>([]);
  const [treeTagIds, setTreeTagIds] = useState<string[]>([]);
  /** Page whose "add property" form is open. */
  const [propertyAddingFor, setPropertyAddingFor] = useState<string | null>(null);
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
  const embedStates = useRef(new EmbedStates()).current;
  const draftsRef = useRef(new Map<string, LocalPageDraft>());
  const pendingActionsRef = useRef(new Map<string, LocalPendingAction>());
  const pageActionBusyRef = useRef(false);
  const roomRef = useRef<RoomClient | null>(null);
  const roomStore = useRef(defaultRoomStore()).current;
  /** Pages whose room failed over to single-user saving in this session. */
  const roomOffPagesRef = useRef(new Set<string>());
  /** The server reported rooms are turned off; do not join again this session. */
  const roomDisabledRef = useRef(false);
  const [collabProps, setCollabProps] = useState<DocumentCollab | null>(null);
  const [boardCollabProps, setBoardCollabProps] = useState<WhiteboardCollab | null>(null);
  const [roomPhase, setRoomPhase] = useState<RoomPhase | null>(null);
  const [roomConflict, setRoomConflict] = useState<RoomRecord | null>(null);
  const favoriteBusyRef = useRef(new Set<string>());
  const uploadingRef = useRef(0);
  const openSequence = useRef(0);
  const pendingSearchRef = useRef<{ pageId: string; phrase: string; field: SearchResult['matchField'] } | null>(null);
  const pendingBacklinkRef = useRef<{ link: PageBacklink; targetPageId: string } | null>(null);
  const [boardLocate, setBoardLocate] = useState<{ pageId: string; key: number; text?: string; reference?: { pageId: string; occurrence: number } } | null>(null);
  const initialPageReference = useRef(pageIdFromReferenceUrl(location.pathname + location.search));
  const pendingCreatesRef = useRef(new Map<string, LocalPendingCreate>());
  const createBusyRef = useRef(false);
  const workspace = session?.workspaces[0];
  const canWrite = Boolean(workspace && workspace.role !== 'viewer');
  const workspaceScope = session && workspace ? `${session.user.id}:${workspace.id}` : null;
  const liveScope = useRef(workspaceScope);
  liveScope.current = workspaceScope;
  const noteWrites = useNoteWrites(session, workspace?.id, setNotice);
  const dailyMode = dialog === 'today' || dialog === 'quick-capture' ? dialog : null;

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
    const { content: _content, properties: _properties, pageProperties: _pageProperties, ...summary } = page;
    void _content; void _properties; void _pageProperties;
    // Database rows are listed by their database, not by the page tree.
    if (page.kind !== 'row') setPages(previous => previous.some(item => item.id === page.id)
      ? previous.map(item => item.id === page.id ? summary : item) : [...previous, summary]);
    // A page moved into a database became a row and leaves the tree.
    else setPages(previous => previous.some(item => item.id === page.id) ? previous.filter(item => item.id !== page.id) : previous);
    if (activeIdRef.current === page.id) setDocumentPage(page);
  };

  const { queueWrite, persistDraft, scheduleSave, markDraft, savePage, savePageRef, saveTimers, waitForSave } = usePageSaver({
    session, workspace, tabId, actionsLoaded, activeIdRef, docsRef, draftsRef, pendingActionsRef,
    upsertPage, setStatus, setNotice, setReauth, setConflict, setOtherDraft, setEditorSnapshot,
    onPageState: (pageId, state) => embedStates.set(pageId, state) });
  const markDraftRef = useRef(markDraft);
  markDraftRef.current = markDraft;

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
    setCalendarOpen(false);
    if (pendingBacklinkRef.current?.link.sourcePageId !== pageId) pendingBacklinkRef.current = null;
    const previousId = activeIdRef.current;
    if (!force && previousId === pageId && editorRef.current) return true;
    const roomPageId = roomRef.current?.pageId ?? null;
    if (previousId && previousId !== pageId) {
      // A room page has no local draft; closing the room saves it when this tab is the saver.
      if (roomPageId !== previousId) {
        const snapshot = editorRef.current?.getSnapshot();
        if (snapshot && (draftsRef.current.has(previousId)
          || !contentMatchesServer(snapshot.content, docsRef.current.get(previousId)))) {
          markDraft(previousId, titleRef.current, snapshot);
        }
      }
      void savePageRef.current(previousId);
    }
    if (roomPageId && (roomPageId !== pageId || force)) await closeRoomRef.current();
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
        if (!draft && openRoomRef.current(pageId, server)) setStatus('正在连接协同…');
        else {
          setStatus(draft ? '已恢复本机草稿 · 等待服务端确认' : '已从服务端读取');
          if (draft) { void persistDraft(draft); scheduleSave(pageId, 200); }
        }
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
  /** Calendar-synced databases stay reachable by id (links, breadcrumbs, the calendar) but out of navigation and pickers. */
  const visiblePages = useMemo(() => pages.filter(page => !page.calendarSync), [pages]);
  const graphWorkspaceId = workspace?.id;
  const graphSource = useMemo(() => graphWorkspaceId ? createPersistentGraphSource(graphWorkspaceId) : null, [graphWorkspaceId]);
  useGraphShortcut(() => setDialog('graph'), sessionPhase !== 'ready' || !graphSource || dialog !== null);

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

  /** A whiteboard has no document editor to search in; the board itself finds the element once it is on screen. */
  const locateOnBoard = (pageId: string) => {
    if (activeIdRef.current !== pageId) return;
    const search = pendingSearchRef.current, backlink = pendingBacklinkRef.current;
    if (search?.pageId === pageId) {
      if (search.field === 'title') { locatePendingSearch(pageId); return; }
      pendingSearchRef.current = null;
      setBoardLocate(previous => ({ pageId, key: (previous?.key ?? 0) + 1, text: search.phrase }));
    } else if (backlink?.link.sourcePageId === pageId) {
      pendingBacklinkRef.current = null;
      setBoardLocate(previous => ({ pageId, key: (previous?.key ?? 0) + 1,
        reference: { pageId: backlink.targetPageId, occurrence: backlink.link.occurrence } }));
    }
  };

  const locatePendingSearch = (pageId: string) => {
    const pending = pendingSearchRef.current;
    if (!pending || pending.pageId !== pageId || activeIdRef.current !== pageId) return;
    pendingSearchRef.current = null;
    let found = false;
    if (pending.field === 'title') {
      const input = document.querySelector<HTMLInputElement>('.persistent-workspace .document-heading .page-title, .persistent-workspace .wb-host-head input.page-title');
      const heading = document.querySelector<HTMLElement>('.persistent-workspace .document-heading h1, .persistent-workspace .wb-host-head h1');
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
    if (!found) {
      // Page and row properties are part of the search text but not of the editor.
      const phrase = pending.phrase.toLocaleLowerCase();
      const property = [...document.querySelectorAll<HTMLElement>('.persistent-workspace .nb-db-row-props .nb-db-row-prop')]
        .find(item => item.textContent?.toLocaleLowerCase().includes(phrase));
      if (property) { property.scrollIntoView({ behavior: 'smooth', block: 'center' }); found = true; }
    }
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

  const openHistoryResult = (result: WorkspaceHistorySearchResult, phrase: string) => {
    setDialog(null);
    void openPage(result.pageId).then(opened => {
      if (!opened) { setNotice('搜索结果已变化，页面暂时无法打开。请重新搜索。'); return; }
      setHistoryNameRevision(null);
      setHistoryTarget({ pageId: result.pageId, revision: result.version.revision, query: phrase });
      setDialog('history');
    });
  };

  /** Pages whose content a real-time room can carry (docs/architecture/realtime.md). */
  const roomEligible = (page: PageDocument) =>
    ((page.kind ?? 'document') === 'document' || page.kind === 'row' || page.kind === 'whiteboard')
    && page.content.schemaVersion === 1
    && (page.kind === 'whiteboard' ? isWhiteboardContent(page.content) : !isWhiteboardContent(page.content));

  /** Leaves the open room; the close writes a revision first when this tab is the saver. */
  const closeRoom = async () => {
    const client = roomRef.current;
    if (!client) return;
    roomRef.current = null;
    await client.close();
    setCollabProps(null);
    setBoardCollabProps(null);
    setRoomPhase(null);
    setRoomConflict(null);
  };
  const closeRoomRef = useRef(closeRoom);
  closeRoomRef.current = closeRoom;

  /** The saver's revision write: content is fixed first, then the state vector is read to match it. */
  const saveRoomPage = async (client: RoomClient, epoch: number, stateVector: () => Uint8Array): Promise<RoomSaveResult> => {
    const pageId = client.pageId;
    const known = docsRef.current.get(pageId);
    const editor = editorRef.current;
    if (!session || !workspace || !known || activeIdRef.current !== pageId) return 'unavailable';
    let snapshot: EditorSnapshot;
    if (known.kind === 'whiteboard') {
      if (!client.doc) return 'unavailable';
      const { normalizedWhiteboardContent } = await import('../whiteboard/collab');
      snapshot = boardSnapshot(normalizedWhiteboardContent(client.doc));
    } else {
      if (!editor) return 'unavailable';
      snapshot = editor.getSnapshot();
    }
    const vector = stateVector();
    const body: UpdatePageRequest = {
      clientMutationId: crypto.randomUUID(), expectedRevision: known.revision,
      title: client.titleText(), content: snapshot.content,
      collab: { epoch, stateVector: bytesToBase64(vector) },
    };
    try {
      upsertPage(await pageClient.update(workspace.id, pageId, body, session.csrfToken));
      return 'saved';
    } catch (error) {
      if (error instanceof ApiError) {
        // Another saver's write landed first or the room moved on; its roomSaved/roomReset notice settles this tab.
        if (error.status === 409 && (error.code === 'COLLAB_STALE' || error.code === 'COLLAB_EPOCH')) return 'stale';
        if (error.status === 422 || error.status === 400) return 'invalid';
        if (isAuthError(error)) setReauth(true);
      }
      return 'retry';
    }
  };
  const saveRoomPageRef = useRef(saveRoomPage);
  saveRoomPageRef.current = saveRoomPage;

  const handleRoomEvent = (client: RoomClient, event: RoomEvent) => {
    if (roomRef.current !== client || !session) return;
    const pageId = client.pageId;
    if (event.type === 'change') {
      setRoomPhase(client.phase);
      if (activeIdRef.current !== pageId) return;
      setStatus(client.status());
      const roomTitle = client.titleText();
      if (client.phase === 'ready' && roomTitle !== titleRef.current) setCurrentTitle(roomTitle);
      // Search and backlink targets only exist once the room's content has arrived.
      if (client.phase === 'ready') {
        if (pendingSearchRef.current?.pageId === pageId) requestAnimationFrame(() => locatePendingSearch(pageId));
        else if (pendingBacklinkRef.current?.link.sourcePageId === pageId) requestAnimationFrame(() => locatePendingBacklink(pageId));
      }
      return;
    }
    if (event.type === 'local') { live.noteEdit(); return; }
    if (event.type === 'title') {
      if (activeIdRef.current === pageId) setCurrentTitle(event.title);
      return;
    }
    if (event.type === 'saved') {
      const known = docsRef.current.get(pageId);
      if (known && BigInt(known.revision) < BigInt(event.revision)) {
        const next = { ...known, revision: event.revision };
        docsRef.current.set(pageId, next);
        if (activeIdRef.current === pageId) setDocumentPage(next);
      }
      return;
    }
    if (event.type === 'reload') {
      roomRef.current = null; setCollabProps(null); setBoardCollabProps(null); setRoomPhase(null);
      const who = event.by ? (event.by.userId === session.user.id ? '你' : event.by.loginName) : '其他成员';
      setNotice(event.reason === 'restore' ? `${who}恢复了历史版本，页面已重新载入` : '页面内容已在服务端更新，已重新载入');
      void openPageRef.current(pageId, true);
      return;
    }
    if (event.type === 'conflict') {
      roomRef.current = null; setCollabProps(null); setBoardCollabProps(null); setRoomPhase(null);
      const record = event.record;
      void (async () => {
        // Only the conflicting record is kept for review; anything else stored for the page is settled.
        const stored = await roomStore.forPage(session.user.id, record.workspaceId, pageId).catch(() => [] as RoomRecord[]);
        for (const item of stored) if (item.key !== record.key) await roomStore.remove(item.key).catch(() => undefined);
        if (roomRef.current || activeIdRef.current !== pageId) return;
        setRoomConflict(record);
        openRoomRef.current(pageId, undefined, record);
        setNotice('页面在服务端已被恢复或重建；你本机有未同步的修改，请另存为副本或放弃。');
      })();
      return;
    }
    // fallback: the room is gone; what the editor still holds becomes an ordinary local draft.
    roomRef.current = null; setCollabProps(null); setBoardCollabProps(null); setRoomPhase(null);
    roomOffPagesRef.current.add(pageId);
    if (event.code === 'REALTIME_DISABLED') roomDisabledRef.current = true;
    const snapshot = activeIdRef.current === pageId
      ? editorRef.current?.getSnapshot() ?? (docsRef.current.get(pageId)?.kind === 'whiteboard' ? editorSnapshot : undefined) : undefined;
    if (event.unsaved && snapshot) markDraft(pageId, titleRef.current, snapshot);
    setNotice(roomFallbackNotice(event.code));
    if (activeIdRef.current === pageId) void openPageRef.current(pageId, true);
  };
  const handleRoomEventRef = useRef(handleRoomEvent);
  handleRoomEventRef.current = handleRoomEvent;

  /** Joins the page's room; with a conflict record it only opens that local copy for review. */
  const openRoom = (pageId: string, page?: PageDocument, conflictRecord?: RoomRecord): boolean => {
    if (!session || !workspace) return false;
    if (!conflictRecord) {
      if (!live.rooms || !page || !roomEligible(page) || roomDisabledRef.current || roomOffPagesRef.current.has(pageId)) return false;
    }
    const client = new RoomClient({
      userId: session.user.id, workspaceId: workspace.id, pageId,
      canWrite, store: roomStore,
      ...(conflictRecord ? { offline: true } : {}),
      connect: handler => live.rooms!.subscribe(pageId, handler),
      save: (epoch: number, stateVector: () => Uint8Array): Promise<RoomSaveResult> => saveRoomPageRef.current(client, epoch, stateVector),
      onEvent: event => handleRoomEventRef.current(client, event),
    });
    roomRef.current = client;
    setRoomPhase('joining');
    // Taken now: an empty room turns ready before the editor binds, and its blank title replaces titleRef by then.
    const seedTitle = page?.title ?? titleRef.current;
    client.start();
    const isBoard = (page ?? docsRef.current.get(pageId))?.kind === 'whiteboard';
    if (isBoard) {
      const attached = client.attach(seedTitle);
      setCollabProps(null);
      setBoardCollabProps({ doc: attached.doc, provider: attached.provider,
        username: session.user.loginName, cursorColor: cursorColorFor(session.user.id) });
    } else {
      setBoardCollabProps(null);
      setCollabProps({
        providerFactory: (id, docs) => {
          const attached = client.attach(seedTitle);
          docs.set(id, attached.doc);
          return attached.provider as unknown as Provider;
        },
        username: session.user.loginName,
        cursorColor: cursorColorFor(session.user.id),
        onComposition: composing => client.hold(composing),
      });
    }
    return true;
  };
  const openRoomRef = useRef(openRoom);
  openRoomRef.current = openRoom;

  const clearRoomRecords = async (pageId: string) => {
    if (!session || !workspace) return;
    const records = await roomStore.forPage(session.user.id, workspace.id, pageId).catch(() => [] as RoomRecord[]);
    for (const record of records) await roomStore.remove(record.key).catch(() => undefined);
  };

  const saveConflictCopy = async () => {
    if (!roomConflict || !canWrite) return;
    const snapshot = editorRef.current?.getSnapshot() ?? (docsRef.current.get(roomConflict.pageId)?.kind === 'whiteboard' ? editorSnapshot : null);
    if (!snapshot) { setNotice('本机修改还未读取完成，请稍后再试。'); return; }
    const record = roomConflict;
    const created = await createPage(docsRef.current.get(record.pageId)?.parentId ?? null,
      `${record.title || titleRef.current || '未命名页面'}（未同步副本）`, snapshot.content);
    if (created) void clearRoomRecords(record.pageId);
  };

  const discardConflict = async () => {
    if (!roomConflict) return;
    const pageId = roomConflict.pageId;
    setRoomConflict(null);
    await clearRoomRecords(pageId);
    void openPageRef.current(pageId, true);
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
    content: StoredDocumentContent = createContentFromMarkdown(''), resolvesDraft?: LocalPageDraft, tagIds?: string[], openResult = true,
    pageProperties?: PageProperty[]) => {
    if (!session || !workspace || createBusyRef.current) return;
    if (pendingCreatesRef.current.size) {
      const text = '上一笔创建尚未确认，请关闭窗口处理待创建记录。';
      setNotice(text); setNoteDialogError(text); return;
    }
    const clientMutationId = crypto.randomUUID();
    const pending: LocalPendingCreate = {
      key: `${session.user.id}:${workspace.id}:${clientMutationId}`, userId: session.user.id,
      workspaceId: workspace.id,
      body: { clientMutationId, parentId, title: titleValue, content, ...(tagIds?.length ? { tagIds } : {}),
        ...(pageProperties?.length ? { pageProperties } : {}) },
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
    live.noteEdit();
    setCurrentTitle(value);
    const room = roomRef.current;
    if (room?.pageId === activeId) { room.setTitle(value); return; }
    const snapshot = editorRef.current?.getSnapshot() ?? editorSnapshot;
    if (snapshot) markDraft(activeId, value, snapshot);
  };

  const leaveCurrent = async () => {
    const pageId = activeIdRef.current;
    if (pageId && roomRef.current?.pageId !== pageId) {
      const snapshot = editorRef.current?.getSnapshot();
      if (snapshot && (draftsRef.current.has(pageId)
        || !contentMatchesServer(snapshot.content, docsRef.current.get(pageId)))) {
        markDraft(pageId, titleRef.current, snapshot);
      }
      void savePage(pageId);
    }
    await closeRoomRef.current();
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
    if (roomRef.current?.pageId === pageId && !await roomRef.current.whenSaved(10_000)) {
      throw new Error('协同修改尚未保存完成，请稍后再试。');
    }
    await waitForSave(pageId);
    await savePage(pageId);
    await waitForSave(pageId);
    if (draftsRef.current.has(pageId)) throw new Error('请先完成此页的保存或解决冲突。');
  };

  /** Saves pending edits first, so the name lands on a revision that holds what is on screen. */
  const nameCurrentVersion = async (pageId: string) => {
    if (!canWrite) return;
    try { await settlePageBeforeWrite(pageId); }
    catch (error) { setNotice(message(error)); return; }
    const saved = docsRef.current.get(pageId);
    if (!saved || activeIdRef.current !== pageId) return;
    setHistoryNameRevision(saved.revision); setHistoryTarget(null); setDialog('history');
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
  };

  const openTrash = (pageId?: string) => { setTrashTarget(pageId); setDialog('trash'); };

  const { performPageAction, beginPageAction } = createPageActions({ session, workspace, actionsLoaded, pages, pendingUploads, activeIdRef,
    titleRef, docsRef, draftsRef, pendingActionsRef, pendingCreatesRef, pageActionBusyRef, uploadingRef, openSequence, saveTimers, savePageRef,
    editorRef, roomForPage: id => roomRef.current?.pageId === id ? roomRef.current : null,
    setActive, setStatus, setNotice, setReauth, setDialog, setPages, setPendingActions, setPageActionBusy, setDocumentPage,
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
    patch: Pick<UpdatePageRequest, 'parentId' | 'icon' | 'cover' | 'tagIds' | 'title' | 'properties' | 'pageProperties'>,
    done: string, problem = '请先解决本页的保存问题，再修改页面。') => {
    if (!session || !workspace || readOnly || !canWrite) return false;
    if (pageActionBusyRef.current
      || [...pendingActionsRef.current.values()].some(action => action.affectedIds.includes(pageId))
      || [...pendingCreatesRef.current.values()].some(create => create.resolvesDraftPageId === pageId)
      || pendingUploads.some(upload => upload.pageId === pageId)) {
      setNotice('该页面还有待确认的操作，请先完成或重试，再修改页面。'); return false;
    }
    if (roomRef.current?.pageId === pageId && !await roomRef.current.whenSaved(10_000)) { setNotice(problem); return false; }
    await waitForSave(pageId);
    await savePage(pageId);
    await waitForSave(pageId);
    if (draftsRef.current.has(pageId)) { setNotice(problem); return false; }
    let current = docsRef.current.get(pageId);
    if (!current) {
      try { current = normalizePage(await pageClient.get(workspace.id, pageId)); }
      catch (error) { setNotice(message(error)); if (isAuthError(error)) setReauth(true); return false; }
      if (!docsRef.current.has(pageId)) docsRef.current.set(pageId, current);
    }
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
      // Moving into or out of a database changes what the page is, and with it where its child pages show.
      if ((current.kind ?? 'document') !== (updated.kind ?? 'document')) {
        if (current.kind === 'row' && current.parentId) announceDatabaseChange(current.parentId);
        void reloadTree(session);
      }
      if (updated.kind === 'row' && updated.parentId) announceDatabaseChange(updated.parentId);
      if (updated.kind === 'database') announceDatabaseChange(updated.id);
      return true;
    } catch (error) {
      setNotice(error instanceof ApiError && error.code === 'PROPERTY_INVALID' ? '这个值不符合字段设置，未保存。' : message(error));
      if (isAuthError(error)) setReauth(true);
      return false;
    }
  };
  const updatePageMetaRef = useRef(updatePageMeta);
  updatePageMetaRef.current = updatePageMeta;
  const calendarTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const calendarSource = useMemo(() => session && workspace ? createPersistentCalendarSource({
    workspaceId: workspace.id, csrfToken: session.csrfToken, canWrite: canWrite && !readOnly,
    context: { timeZone: calendarTimeZone, weekStart: 1 },
    notice: setNotice,
    openRow: id => void openPageRef.current(id),
    openDatabase: id => void openPageRef.current(id),
    openDailyNote: (date, pageId) => {
      if (pageId) { void openPageRef.current(pageId); return; }
      setDailyNoteDate(date); setDialog('today');
    },
    isRowOpen: id => activeIdRef.current === id,
    writeOpenRowDate: (id, propertyId, value) => updatePageMetaRef.current(id, { properties: { [propertyId]: value } }, ''),
    onDatabaseChanged: id => announceDatabaseChange(id),
  }) : null, [session, workspace, canWrite, readOnly, calendarTimeZone]);

  useEffect(() => {
    if (!session || !workspace || sessionPhase !== 'ready') return;
    return startReminderRunner({ workspaceId: workspace.id, csrfToken: session.csrfToken,
      openRow: id => void openPageRef.current(id), toast: setNotice });
  }, [session, workspace, sessionPhase]);

  /** Rows of the open row page are written here so the page's revision stays in step with its body saves. */
  const [rowSaving, setRowSaving] = useState(false);
  /** The open row whose title a calendar sync source keeps; its header title is read-only. */
  const [lockedTitleRow, setLockedTitleRow] = useState<string | null>(null);
  const savePageProperties = (pageId: string, next: PageProperty[]) =>
    updatePageMeta(pageId, { pageProperties: next }, '', '请先解决本页的保存问题，再修改属性。');

  const setRowProperty = async (pageId: string, propertyId: string, value: PropertyValue | null) => {
    setRowSaving(true);
    try { await updatePageMeta(pageId, { properties: { [propertyId]: value } }, ''); }
    finally { setRowSaving(false); }
  };

  /** Creates an empty database; `open` switches to it, otherwise the id is returned for an inline block. */
  const createDatabase = async (parentId: string | null, open = true, databaseTitle = '未命名数据库'): Promise<string | null> => {
    if (!session || !workspace || !canWrite || createBusyRef.current) return null;
    createBusyRef.current = true; setCreateBusy(true);
    try {
      const created = await databaseClient.create(workspace.id, { clientMutationId: crypto.randomUUID(), parentId,
        title: databaseTitle.slice(0, 255) || '未命名数据库' }, session.csrfToken);
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
  const createWhiteboard = (parentId: string | null) => { if (canWrite) void createPage(parentId, '未命名白板', whiteboardContent([])); };
  const databaseChoices = useMemo(() => visiblePages.filter(page => page.kind === 'database')
    .map(page => ({ id: page.id, title: page.title, icon: page.icon })), [visiblePages]);

  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  const databaseSource = useMemo(() => session && workspace ? createPersistentSource({
    workspaceId: workspace.id, csrfToken: session.csrfToken, canWrite: canWrite && !readOnly,
    tags: () => tagsRef.current,
    openPage: id => { setDialog(null); void openPageRef.current(id); },
    notice: setNotice,
    trashRow: row => beginPageActionRef.current('trash', row.id, row.revision, row.title, undefined, true),
    onRowSaved: page => { if (docsRef.current.has(page.id)) upsertPage(page); },
    onRowsChanged: ids => {
      // An open row page keeps editing, so it needs the new revision; cached ones are simply re-read later.
      for (const id of ids) {
        if (activeIdRef.current === id) void pageClient.get(workspace.id, id).then(upsertPage).catch(() => undefined);
        else docsRef.current.delete(id);
      }
    },
    packageRows: async (doc, rows, csv) => {
      const encoder = new TextEncoder();
      const summaries: PageSummary[] = [doc.page, ...rows.map(row => ({ id: row.id, workspaceId: workspace.id, parentId: doc.page.id, title: row.title, icon: row.icon,
        cover: null, kind: 'row' as const, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt }))];
      const blob = await packageFolderSubtree({ rootPageId: doc.page.id, pages: summaries,
        fetchPage: id => pageClient.get(workspace.id, id), fetchAttachment: id => attachmentClient.download(workspace.id, id),
        formatMarkdown: page => addMarkdownFrontMatter(markdownFromContent(page.content as DocumentContent), page.content, page.title || '未命名页面', [],
          page.kind === 'row' && page.properties ? rowPropertiesFrontMatter(doc.properties, page.properties) : {}),
        extraEntries: [{ name: 'rows.csv', bytes: encoder.encode(csv) }, { name: 'database.json',
          bytes: encoder.encode(JSON.stringify({ properties: doc.properties, views: doc.views }, null, 2)) }] });
      downloadBlob(doc.page.title || '未命名数据库', blob, '.zip');
    },
  }) : null, [session, workspace, canWrite, readOnly]);
  const databaseEmbedding = useMemo(() => databaseSource ? {
    source: databaseSource, databases: databaseChoices,
    createDatabase: (databaseTitle?: string) => {
      const parent = activeIdRef.current;
      return createDatabaseRef.current(parent && ['document', 'row'].includes(docsRef.current.get(parent)?.kind ?? 'document') ? parent : null, false, databaseTitle);
    },
  } : undefined, [databaseSource, databaseChoices]);

  /** Pages shown inside the open page are written through the same saver as the open page itself. */
  const createPageRef = useRef(createPage);
  createPageRef.current = createPage;
  const uploadFilesRef = useRef<(files: File[]) => Promise<AttachmentMetadata[]>>(async () => []);
  const embeddedPages = useMemo<EmbeddedPages | null>(() => session && workspace ? {
    canWrite: canWrite && !readOnly,
    pages,
    load: async pageId => {
      let server: PageDocument;
      try { server = await pageClient.get(workspace.id, pageId); }
      catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        if (isAuthError(error)) setReauth(true);
        throw error;
      }
      // A save of this tab may have landed while the read was on its way; never step back to the older revision.
      const known = docsRef.current.get(pageId);
      if (!known || BigInt(known.revision) <= BigInt(server.revision)) docsRef.current.set(pageId, normalizePage(server));
      const latest = docsRef.current.get(pageId)!;
      const draft = draftsRef.current.get(pageId);
      if (draft && !draft.pending && draft.baseRevision !== latest.revision) embedStates.set(pageId, 'conflict');
      return { id: latest.id, title: draft?.title ?? latest.title, icon: latest.icon, kind: latest.kind ?? 'document',
        content: draft?.content ?? latest.content };
    },
    save: (pageId, pageTitle, snapshot) => markDraftRef.current(pageId, pageTitle, snapshot),
    state: pageId => embedStates.get(pageId),
    subscribe: (pageId, listener) => embedStates.subscribe(pageId, listener),
    openPage: pageId => { setDialog(null); void openPageRef.current(pageId); },
    ...(canWrite && !readOnly ? {
      createWhiteboard: async () => {
        const parent = activeIdRef.current;
        const created = await createPageRef.current(parent && ['document', 'row'].includes(docsRef.current.get(parent)?.kind ?? 'document') ? parent : null,
          '未命名白板', whiteboardContent([]), undefined, undefined, false);
        return created?.id ?? null;
      },
      createPage: async (pageTitle: string) => {
        const parent = activeIdRef.current;
        const created = await createPageRef.current(parent && ['document', 'row'].includes(docsRef.current.get(parent)?.kind ?? 'document') ? parent : null,
          pageTitle.slice(0, 255) || '未命名页面', createContentFromMarkdown(''), undefined, undefined, false);
        return created?.id ?? null;
      },
      uploadImages: (files: File[]) => uploadFilesRef.current(files),
    } : {}),
    editor: {
      pageReferences: pageReferenceAccess, databases: databaseEmbedding, workspaceId: workspace.id,
      resolveBlock: (pageId, blockId) => resolveBlockText(workspace.id, pageId, blockId),
      ...(canWrite && !readOnly ? {
        onUploadFiles: (files: File[]) => uploadFilesRef.current(files),
        onLinkPreview: (url: string) => request<LinkPreview>(workspacePath(workspace.id) + '/link-preview', 'POST', { url }, session.csrfToken),
      } : {}),
    },
    imageUrl: attachmentId => attachmentContentUrl(workspace.id, attachmentId),
    notice: setNotice,
  } : null, [session, workspace, canWrite, readOnly, pages, pageReferenceAccess, databaseEmbedding]);

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
    await closeRoomRef.current();
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
    const persist = () => roomRef.current?.persistNow();
    window.addEventListener('pagehide', persist);
    return () => window.removeEventListener('pagehide', persist);
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
    if (!conflict || isWhiteboardContent(conflict.draft.content)) return null;
    try { return conflict.draft.markdown ?? markdownFromContent(conflict.draft.content as DocumentContent); }
    catch { return null; }
  }, [conflict]);

  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const treePages = useMemo(() => filterPageTree(visiblePages, treeTagIds), [visiblePages, treeTagIds]);
  const treeHandlersRef = useRef<Omit<TreeRowActions, 'onOpen'> | null>(null);
  const treeActions = useMemo<TreeRowActions>(() => ({
    onOpen: openTreePage,
    onFavorite: id => treeHandlersRef.current?.onFavorite(id),
    ...(canWrite ? {
      onAddChild: (id: string) => treeHandlersRef.current?.onAddChild?.(id),
      onAddDatabase: (id: string) => treeHandlersRef.current?.onAddDatabase?.(id),
      onMove: (id: string) => treeHandlersRef.current?.onMove?.(id),
      onTrash: (id: string) => treeHandlersRef.current?.onTrash?.(id),
      onPlace: (id: string, placement: PagePlacement) => treeHandlersRef.current?.onPlace?.(id, placement),
    } : {}),
  }), [openTreePage, canWrite]);

  const live = useLiveChannel({
    workspaceId: sessionPhase === 'ready' ? workspace?.id ?? null : null,
    pageId: calendarOpen ? null : activeId,
    canEdit: canWrite && !readOnly,
    onSaved: saved => {
      // A room page learns about revision writes through roomSaved instead.
      if (roomRef.current?.pageId === saved.pageId) return;
      // This tab's own save can be announced before its response lands; check again once that has had time.
      window.setTimeout(() => {
        if (saved.pageId !== activeIdRef.current) return;
        const known = docsRef.current.get(saved.pageId)?.revision;
        if (known && BigInt(known) >= BigInt(saved.revision)) return;
        setRemoteSave(saved);
      }, 1500);
    },
    onComments: pageId => { if (pageId === activeIdRef.current) setCommentRefresh(value => value + 1); },
    onAuthClosed: () => setReauth(true),
  });
  const commentable = Boolean(documentPage && documentPage.id === activeId
    && (documentPage.kind === 'row' || (documentPage.kind ?? 'document') === 'document'));
  const commentLocator = useMemo<CommentLocator>(() => ({
    anchor: () => editorRef.current?.commentAnchor() ?? null,
    locate: (anchor, reveal) => editorRef.current?.locateComment(anchor, reveal) ?? false,
  }), []);
  useEffect(() => { setRemoteSave(null); setCommentCount(0); }, [activeId]);
  useEffect(() => {
    // The open panel reports its own count.
    if (!workspace || !activeId || !commentable || commentsOpen) return;
    const controller = new AbortController();
    commentClient.list(workspace.id, activeId, controller.signal).then(response => {
      if (!controller.signal.aborted) setCommentCount(response.threads.filter(thread => !thread.resolvedAt).length);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [workspace, activeId, commentable, commentsOpen, commentRefresh]);

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
  // Whiteboards have no Markdown form, so Markdown-only paths fall back to the raw JSON for them.
  const supported = rawContent?.schemaVersion === 1 && !isWhiteboardContent(rawContent);
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
    if (editor!.replaceContent(content) && roomRef.current?.pageId !== sourceSession.pageId) {
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
  const { exportCurrent, exportCurrentAs, exportFolder, uploadFiles, retryUpload, importFile, completeImport } = createPageTransfers({ session, workspace,
    workspaceScope, liveScope, current, title, conflict, conflictMarkdown, supported, tags, readOnly,
    pageTitle: id => pages.find(page => page.id === id)?.title, currentLocked, canWrite, pendingImport,
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
  const favoritePages = favoriteIds.flatMap(id => visiblePages.filter(page => page.id === id));
  const recentPages = recentIds.flatMap(id => visiblePages.filter(page => page.id === id)).slice(0, 5);
  const homePages = [...visiblePages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
  const editorReadOnly = readOnly || currentLocked || !canWrite;
  const collabActive = Boolean(collabProps || boardCollabProps) && roomRef.current?.pageId === current?.id;
  const remoteNotice = !collabActive && remoteSave && current && remoteSave.pageId === current.id && BigInt(current.revision) < BigInt(remoteSave.revision)
    ? remoteSave : null;
  uploadFilesRef.current = uploadFiles;
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
  treeHandlersRef.current = {
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
  // The server-side page copy only handles documents; a board is copied after its room has written a revision.
  const duplicateBoard = async () => {
    if (!current || current.kind !== 'whiteboard' || !canWrite || !workspace) return;
    try {
      await settlePageBeforeWrite(current.id);
      const saved = await pageClient.get(workspace.id, current.id);
      const content = saved.content;
      if (!isWhiteboardContent(content)) { setNotice('白板内容还未读取完成，请稍后再试。'); return; }
      const copyTitle = (titleRef.current.trim() || '未命名白板').slice(0, 251).replace(/[\ud800-\udbff]$/u, '') + '（副本）';
      const { cloneElements, indexElements } = await import('../whiteboard/model');
      const elements = content.board.elements;
      const copies = cloneElements(elements, indexElements(elements), { x: 0, y: 0 }, () => crypto.randomUUID());
      await createPage(current.parentId, copyTitle, whiteboardContent(copies));
    } catch (error) { setNotice(message(error)); }
  };
  const exportOptions: ExportOption[] = [
    { key: 'markdown', label: 'Markdown', description: '.md 文件，可在其他 Markdown 编辑器中打开', onSelect: exportCurrent },
    { key: 'html', label: 'HTML', description: '单个网页文件，可直接用浏览器打开', onSelect: () => void exportCurrentAs('html') },
    { key: 'docx', label: 'Word', description: '.docx 文档，可在 Word 或 WPS 中编辑', onSelect: () => void exportCurrentAs('docx') },
    { key: 'pdf', label: 'PDF', description: '打开浏览器打印，选择“另存为 PDF”', icon: 'page', onSelect: printPage },
    ...(current && current.kind !== 'row' ? [{ key: 'folder-zip', label: 'ZIP（含子页面）', icon: 'folder' as const,
      description: '已保存的本页、所有子页面和附件', disabled: folderExporting, onSelect: () => void exportFolder() }] : []),
  ];
  const exportItem: MenuItem = { key: 'export', label: '导出…', icon: 'download', onSelect: () => setDialog('export') };
  const pageMenuItems: (MenuItem | 'divider')[] = current?.kind === 'database' ? [
    { key: 'move', label: '移动到…', icon: 'folder', disabled: currentLocked || !canWrite, onSelect: () => { setMoveTarget(current.parentId ?? ''); setDialog('move'); } },
    { key: 'export', label: '导入导出…', icon: 'download', onSelect: () => requestDatabaseExport(current.id) },
    'divider',
    { key: 'trash', label: '移入回收站（含所有行）', icon: 'trash', danger: true, disabled: currentLocked || !canWrite, onSelect: () => setDialog('delete') },
  ] : current?.kind === 'whiteboard' ? [
    { key: 'mode', label: readOnly ? '切换为编辑' : '切换为只读', icon: 'focus', disabled: !canWrite, onSelect: () => setReadOnly(!readOnly) },
    { key: 'download', label: '下载白板数据 (JSON)', icon: 'download', onSelect: exportCurrent },
    { key: 'name-version', label: '保存为命名版本…', icon: 'history', disabled: currentLocked || !canWrite, onSelect: () => void nameCurrentVersion(current.id) },
    { key: 'copy', label: '创建白板副本', icon: 'copy', disabled: createBusy || !canWrite, onSelect: () => void duplicateBoard() },
    { key: 'move', label: '移动到…', icon: 'folder', disabled: currentLocked || !canWrite, onSelect: () => { setMoveTarget(current.parentId ?? ''); setDialog('move'); } },
    'divider',
    { key: 'trash', label: '移入回收站', icon: 'trash', danger: true, disabled: currentLocked || !canWrite, onSelect: () => setDialog('delete') },
  ] : current?.kind === 'row' ? [
    ...readingMenuItems(readingPrefs, setReadingPrefs),
    'divider',
    { key: 'mode', label: readOnly ? '切换为编辑' : '切换为阅读', icon: 'focus', disabled: !canWrite, onSelect: () => setReadOnly(!readOnly) },
    { key: 'attach', label: '添加图片或附件', icon: 'image', disabled: editorReadOnly, onSelect: () => pickAttachment('file') },
    { key: 'source', label: 'Markdown 源码', icon: 'code', onSelect: openSource },
    exportItem,
    { key: 'name-version', label: '保存为命名版本…', icon: 'history', disabled: currentLocked || !canWrite, onSelect: () => void nameCurrentVersion(current.id) },
    ...(current.parentId ? [{ key: 'database', label: '返回数据库', icon: 'table' as const, onSelect: () => void openPage(current.parentId!) }] : []),
    { key: 'move', label: '移出数据库或移到别处…', icon: 'folder' as const, disabled: currentLocked || !canWrite, onSelect: () => { setMoveTarget(''); setDialog('move'); } },
    'divider',
    { key: 'trash', label: '移入回收站', icon: 'trash', danger: true, disabled: currentLocked || !canWrite, onSelect: () => setDialog('delete') },
  ] : current ? [
    ...readingMenuItems(readingPrefs, setReadingPrefs),
    'divider',
    { key: 'mode', label: readOnly ? '切换为编辑' : '切换为阅读', icon: 'focus', disabled: !canWrite, onSelect: () => setReadOnly(!readOnly) },
    { key: 'attach', label: '添加图片或附件', icon: 'image', disabled: editorReadOnly, onSelect: () => pickAttachment('file') },
    { key: 'source', label: 'Markdown 源码', icon: 'code', onSelect: openSource },
    exportItem,
    { key: 'name-version', label: '保存为命名版本…', icon: 'history', disabled: currentLocked || !canWrite, onSelect: () => void nameCurrentVersion(current.id) },
    { key: 'share', label: '分享只读链接…', icon: 'share', disabled: !canWrite, onSelect: () => setDialog('share') },
    'divider',
    { key: 'child', label: '添加子页面', icon: 'plus', disabled: createBusy || currentLocked || !canWrite, onSelect: () => openNewNote(current.id) },
    { key: 'copy', label: '复制页面', icon: 'copy', disabled: currentLocked || !canWrite || !noteWrites.ready || noteWrites.busy,
      onSelect: () => { setNoteDialogError(''); setDialog('copy'); } },
    { key: 'template', label: '另存为个人模板', icon: 'page', disabled: currentLocked || !canWrite, onSelect: () => openTemplates(true) },
    { key: 'move', label: '移动到…', icon: 'folder', disabled: currentLocked || !canWrite, onSelect: () => { setMoveTarget(current.parentId ?? ''); setDialog('move'); } },
    'divider',
    { key: 'trash', label: '移入回收站', icon: 'trash', danger: true, disabled: currentLocked || !canWrite, onSelect: () => setDialog('delete') },
  ] : [];

  return <div className={`nb-app persistent-workspace ${sidebarHidden ? 'nb-sidebar-collapsed' : ''}`}>
    <Sidebar workspaceName={workspace?.name ?? '个人空间'} loginName={session.user.loginName}
      onLogout={() => void logout()} onSettings={() => setDialog('settings')}
      onSearch={() => setDialog('search')} onTrash={() => openTrash()}
      noteActions={<>
        <button className="nb-nav-row" onClick={() => { setDailyNoteDate(undefined); setDialog('today'); }}><Icon name="clock" size={15} /><span>今天</span></button>
        {canWrite && <button className="nb-nav-row" disabled={!noteWrites.ready} onClick={() => setDialog('quick-capture')}><Icon name="comment" size={15} /><span>快速记录</span></button>}
        <button className="nb-nav-row" onClick={() => setCalendarOpen(open => !open)}><Icon name="calendar" size={15} /><span>日历</span></button>
        <button className="nb-nav-row" onClick={() => setDialog('graph')}><Icon name="link" size={15} /><span>关系图</span></button>
      </>}
      toolActions={canWrite && <>
        <SidebarTool icon="page" label="模板" onClick={() => openTemplates()} />
        <SidebarTool icon="tag" label="标签" onClick={() => setDialog('tags')} />
      </>}
      treeControls={tags.length > 0 && <TagFilter tags={tags} value={treeTagIds} onChange={setTreeTagIds} />}
      canCreate={canWrite} onNewPage={() => openNewNote(null)}
      {...(canWrite ? { onImport: () => fileRef.current?.click(),
        onNewDatabase: () => void createDatabase(null), onNewWhiteboard: () => createWhiteboard(null) } : {})}
      {...(canWrite ? { onImportFolder: () => setDialog('folder-import') } : {})}
      createBusy={createBusy || !canWrite} pages={treePages} activeId={activeId}
      favorites={favoriteSet} favoritePages={favoritePages} recentPages={recentPages}
      treeLoading={treeLoading} treeError={treeError} onTreeRetry={() => void reloadTree(session)}
      treeActions={treeActions} open={mobileOpen} onClose={() => setMobileOpen(false)} />
    <section className="nb-main">
      {!calendarOpen && activeId && <Topbar status={saveStatus} hasDraft={Boolean(current && draftsRef.current.has(current.id))}
        onRetrySave={() => { if (current) void savePage(current.id); }} onDownload={exportCurrent}
        breadcrumbs={ancestors} currentTitle={title} updatedAt={current?.updatedAt ?? null}
        favorite={Boolean(activeId && favoriteSet.has(activeId))} onFavorite={() => { if (activeId) void toggleFavorite(activeId); }}
        onSidebarToggle={toggleSidebar}
        onOpenBreadcrumb={id => { if (id) void openPage(id); else leaveCurrent(); }}
        readOnly={readOnly} onToggleReadOnly={() => setReadOnly(!readOnly)}
        onHistory={() => { setHistoryNameRevision(null); setHistoryTarget(null); setDialog('history'); }} hideHistory={current?.kind === 'database'} disabled={currentLocked} pageMenuItems={pageMenuItems}
        editedBy={current ? current.lastEditor === undefined ? session.user.loginName : current.lastEditor?.loginName ?? null : null}
        presence={live.others}
        {...(commentable && supported ? { onComments: () => setCommentsOpen(open => !open), commentsOpen, commentCount } : {})} />}
      {!calendarOpen && !activeId && <header className="nb-topbar">
        <button className="icon-button nb-sidebar-toggle" aria-label="切换导航" onClick={toggleSidebar}><Icon name="sidebar" size={17} /></button>
        <nav className="nb-crumbs" aria-label="页面位置"><strong>工作台</strong></nav></header>}
      {calendarOpen && <header className="nb-topbar">
        <button className="icon-button nb-sidebar-toggle" aria-label="切换导航" onClick={toggleSidebar}><Icon name="sidebar" size={17} /></button>
        <nav className="nb-crumbs" aria-label="页面位置"><strong>日历</strong></nav></header>}
      <WorkspaceNotices activeId={activeId} actionStorageError={actionStorageError} pendingActions={pendingActions} pageActionBusy={pageActionBusy}
        performPageAction={performPageAction} pendingCreates={pendingCreates} createBusy={createBusy} performCreate={performCreate}
        untrackPendingCreate={untrackPendingCreate} reloadWorkspaceTree={() => void reloadTree(session)} noteWrites={noteWrites} canWrite={canWrite}
        retryNoteWrite={retryNoteWrite} pendingUploads={pendingUploads} retryUpload={retryUpload} setPendingUploads={setPendingUploads}
        reauth={reauth} setShowReauthForm={setShowReauthForm} current={current} exportCurrent={exportCurrent} otherDraft={otherDraft}
        draftsRef={draftsRef} recoverOtherDraft={recoverOtherDraft} setNotice={setNotice} />
      {workspace?.role === 'viewer' && <NoticeBar tone="info">你是只读成员：可以阅读、搜索、导出、收藏和评论，不能修改内容。</NoticeBar>}
      {remoteNotice && <NoticeBar tone="info">
        {remoteNotice.by.userId === session.user.id ? '你在另一个标签页或设备上' : `${remoteNotice.by.loginName || '其他成员'} `}保存了这个页面的新版本。
        {draftsRef.current.has(remoteNotice.pageId) ? '你还有未保存的修改，保存时会提示冲突，可以对比后再决定。'
          : <button className="nb-btn nb-btn-quiet" onClick={() => void openPage(remoteNotice.pageId, true)}>载入新版本</button>}
      </NoticeBar>}
      <main className="nb-scroll">
        {calendarOpen && calendarSource ? <LazyWorkspaceCalendar source={calendarSource} timeZone={calendarTimeZone} weekStart={1}
          onDatabasesChanged={() => { if (session) void reloadTree(session); }} />
          : activeId ? loadingPage ? <div className="nb-home" role="status">正在读取页面…</div>
          : conflict ? <ConflictCard conflict={conflict} conflictMarkdown={conflictMarkdown} createBusy={createBusy} onDownload={exportCurrent}
            onSaveCopy={() => void createPage(conflict.server.parentId, `${conflict.draft.title || '未命名页面'}（冲突副本）`, conflict.draft.content, conflict.draft)} />
          : current && current.kind === 'whiteboard' ? <div className="wb-host">
            <div className="wb-host-head"><span className="nb-page-icon" aria-hidden="true">{current.icon ?? '🎨'}</span>
              {editorReadOnly ? <h1 className="wb-title" data-nbase-find-title>{title || '未命名白板'}</h1>
                : <input className="wb-title page-title" data-nbase-find-title aria-label="白板标题" value={title} disabled={currentLocked}
                  onChange={event => changeTitle(event.target.value)} placeholder="未命名白板"
                  onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); }} />}
              {workspace && <PageBacklinks key={current.id} workspaceId={workspace.id} pageId={current.id} revision={current.revision}
                onOpen={link => openBacklink(link, current.id)} />}</div>
            {roomConflict && roomConflict.pageId === current.id && <NoticeBar tone="warn" alert>
              此页在服务端已被恢复或重建；当前显示的是你本机未同步的修改，尚未保存。
              <button className="nb-btn nb-btn-quiet" onClick={() => void saveConflictCopy()}>另存为副本</button>
              <button className="nb-btn nb-btn-quiet" onClick={exportCurrent}>下载</button>
              <button className="nb-btn nb-btn-quiet" onClick={() => void discardConflict()}>放弃修改，载入服务端版本</button>
            </NoticeBar>}
            {rawContent && isWhiteboardContent(rawContent) && (!collabActive || roomPhase === 'ready') ? <EmbeddedPagesProvider value={embeddedPages}><EmbedPathProvider pageId={current.id}>
              <LazyWhiteboard key={`${current.id}:${editorEpoch}`} boardId={current.id} content={rawContent}
              readOnly={editorReadOnly} title={title} pages={pages} onNotice={setNotice} onOpenPage={id => void openPage(id)}
              {...(collabActive && boardCollabProps ? { collab: boardCollabProps } : {})}
              imageUrl={id => workspace ? attachmentContentUrl(workspace.id, id) : null}
              onUploadImages={editorReadOnly ? undefined : files => uploadFiles(files)}
              locate={boardLocate?.pageId === current.id ? boardLocate : undefined}
              onLocated={key => setBoardLocate(previous => previous?.key === key ? null : previous)}
              onReady={(id, content) => {
                if (id !== activeIdRef.current) return;
                setEditorSnapshot(boardSnapshot(content));
                requestAnimationFrame(() => locateOnBoard(id));
              }}
              onChange={(id, content) => { if (id === activeIdRef.current) {
                if (roomRef.current?.pageId === id) { setEditorSnapshot(boardSnapshot(content)); return; }
                live.noteEdit(); markDraft(id, titleRef.current, boardSnapshot(content));
              } }} />
              </EmbedPathProvider></EmbeddedPagesProvider>
              : collabActive ? <div className="nb-home" role="status">{saveStatus.text || '正在连接协同…'}</div>
              : <div role="alert" className="nbase-unsupported"><h2>暂不能打开此白板</h2><button className="nb-btn" onClick={exportCurrent}>下载原始 JSON</button></div>}
          </div>
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
            {roomConflict && roomConflict.pageId === current.id && <NoticeBar tone="warn" alert>
              此页在服务端已被恢复或重建；当前显示的是你本机未同步的修改，尚未保存。
              <button className="nb-btn nb-btn-quiet" onClick={() => void saveConflictCopy()}>另存为副本</button>
              <button className="nb-btn nb-btn-quiet" onClick={exportCurrent}>下载</button>
              <button className="nb-btn nb-btn-quiet" onClick={() => void discardConflict()}>放弃修改，载入服务端版本</button>
            </NoticeBar>}
            <PageHeader icon={current.icon} cover={current.cover} editable={!editorReadOnly}
              onIcon={icon => setIcon(current.id, icon)} onCover={cover => setCover(current.id, cover)}
              extraActions={(current.kind ?? 'document') === 'document' && !current.pageProperties?.length
                ? <button onClick={() => setPropertyAddingFor(current.id)}><Icon name="plus" size={14} />添加属性</button> : undefined}
              title={readOnly || !canWrite ? <h1 className="nb-doc-title-static" data-nbase-find-title>{title || '未命名页面'}</h1>
                : <input className="nb-doc-title page-title" data-nbase-find-title aria-label="页面标题" value={title}
                  disabled={currentLocked || lockedTitleRow === current.id} title={lockedTitleRow === current.id ? syncedReadOnlyHint : undefined}
                  onChange={event => changeTitle(event.target.value)} placeholder="未命名页面" />} />
            <div className="nb-doc-body">
              {(current.kind ?? 'document') === 'document' && <LazyPageProperties key={current.id} properties={current.pageProperties ?? []}
                editable={!editorReadOnly} adding={propertyAddingFor === current.id}
                onAddingChange={open => setPropertyAddingFor(open ? current.id : null)}
                onSave={next => savePageProperties(current.id, next)} />}
              {current.kind === 'row' && current.parentId && databaseSource && <RowPanel key={current.parentId}
                source={databaseSource} databaseId={current.parentId} row={rowFromPage(current)} pending={rowSaving}
                editable={!editorReadOnly} onChange={(propertyId, value) => void setRowProperty(current.id, propertyId, value)}
                onTitleLock={locked => setLockedTitleRow(previous => locked ? current.id : previous === current.id ? null : previous)} />}
              {supported && initialContent && (!collabActive || roomPhase === 'ready') ? <DocumentEditor key={`${current.id}:${editorEpoch}`} ref={editorRef} documentId={current.id}
                pageReferences={pageReferenceAccess}
                title={title} onReplaceTitle={(value, bodyChanged) => { if (lockedTitleRow === current.id) return; if (bodyChanged) setCurrentTitle(value); else changeTitle(value); }}
                initialContent={initialContent} readOnly={editorReadOnly}
                {...(collabActive && collabProps ? { collab: collabProps } : {})}
                onChange={(id, snapshot) => { if (id === activeIdRef.current) {
                  // A room page's content lives in the room; the saver writes revisions, not local drafts.
                  if (roomRef.current?.pageId === id) { setEditorSnapshot(snapshot); return; }
                  live.noteEdit(); markDraft(id, titleRef.current, snapshot);
                } }}
                onReady={(id, snapshot) => { setEditorSnapshot(snapshot);
                  if (roomRef.current?.pageId === id && roomRef.current.phase !== 'ready') return;
                  if (pendingSearchRef.current?.pageId === id) requestAnimationFrame(() => locatePendingSearch(id));
                  if (pendingBacklinkRef.current?.link.sourcePageId === id) requestAnimationFrame(() => locatePendingBacklink(id));
                }} onNotice={setNotice}
                workspaceId={workspace?.id} onUploadFiles={uploadFiles} onPickAttachment={pickAttachment} databases={databaseEmbedding}
                embeds={embeddedPages ?? undefined}
                resolveBlock={workspace ? (pageId, blockId) => resolveBlockText(workspace.id, pageId, blockId) : undefined}
                onLinkPreview={workspace && session && !editorReadOnly ? url => request<LinkPreview>(workspacePath(workspace.id) + '/link-preview', 'POST', { url }, session.csrfToken) : undefined} />
                : collabActive ? <div className="nb-home" role="status">{saveStatus.text || '正在连接协同…'}</div>
                : <div role="alert" className="nbase-unsupported"><h2>暂不能打开此格式版本</h2>
                  <p>原始数据仍保留在服务端。请先下载副本，等待兼容升级。</p>
                  <button className="nb-btn" onClick={exportCurrent}>下载原始 JSON</button></div>}
              {workspace && current.kind === 'row' && <RowChildPages workspaceId={workspace.id} rowId={current.id} revision={current.revision}
                onOpen={id => void openPage(id)} />}
              {workspace && <PageBacklinks key={current.id} workspaceId={workspace.id} pageId={current.id} revision={current.revision}
                onOpen={link => openBacklink(link, current.id)} />}
              {graphSource && <LazyLocalGraph source={graphSource} pageId={current.kind === 'row' && current.parentId ? current.parentId : current.id}
                refreshKey={current.revision} onOpen={openReferencedPage} onExpand={() => setDialog('graph')} />}
            </div>
            <Toc outline={editorSnapshot?.outline ?? []} onJump={id => editorRef.current?.jumpToHeading(id)} />
          </> : <section className="nb-home" role="alert">页面暂时无法打开。{saveStatus.text}</section>
          : visiblePages.length ? <HomePanel workspaceName={workspace?.name} pages={pages} homePages={homePages} createBusy={createBusy} canWrite={canWrite}
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
      onClose={() => setDialog(null)} onOpen={openSearchResult} onOpenHistory={openHistoryResult}
      onCommand={command => {
        setDialog(null);
        if (command === 'new') openNewNote(null);
        if (command === 'import' && canWrite) fileRef.current?.click();
        if (command === 'trash') openTrash();
        if (command === 'theme') setTheme(theme === 'dark' ? 'light' : 'dark');
        if (command === 'settings') setDialog('settings');
      }}
      onAuthError={() => { setReauth(true); setShowReauthForm(true); setDialog(null); }} />}
    {dialog === 'graph' && graphSource && <LazyGraphDialog source={graphSource} currentPageId={activeId} tags={tags}
      onOpen={openReferencedPage} onClose={() => setDialog(null)} />}
    {dialog === 'history' && workspace && current && <PageHistoryDialog key={current.id} workspaceId={workspace.id}
      pageId={current.id} currentRevision={current.revision} busy={pageActionBusy} canWrite={canWrite} csrfToken={session.csrfToken}
      nameRevision={historyNameRevision ?? undefined} pageReferences={pageReferenceAccess}
      initialRevision={historyTarget?.pageId === current.id ? historyTarget.revision : undefined}
      initialQuery={historyTarget?.pageId === current.id ? historyTarget.query : undefined}
      onRestore={(version: PageVersion) => void beginPageAction('restore-version', current.id, current.revision, title, version.revision)}
      onAuthError={() => setReauth(true)} onClose={() => { setDialog(null); setHistoryNameRevision(null); setHistoryTarget(null); }} />}
    {dialog === 'trash' && workspace && <TrashDialog workspaceId={workspace.id} busy={pageActionBusy} canWrite={canWrite}
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
    {dialog === 'copy' && workspace && current && canWrite && <CopyNoteDialog source={current} pages={visiblePages}
      busy={copyPreparing || noteWrites.busy} error={noteDialogError} onCopy={(nextTitle, parentId) => void copyCurrentNote(nextTitle, parentId)}
      onClose={() => setDialog(null)} />}
    {dialog === 'tags' && workspace && canWrite && <TagManagerDialog tags={tags} workspaceId={workspace.id} csrfToken={session.csrfToken}
      onChanged={async () => { await Promise.all([refreshTags(), reloadTree(session)]); }} onClose={() => setDialog(null)}
      onAuthError={() => { setDialog(null); setReauth(true); setShowReauthForm(true); }} />}
    {dailyMode && workspace && <DailyNoteDialog workspaceId={workspace.id} mode={dailyMode} initialDate={dailyNoteDate} templates={templates}
      readOnly={!canWrite || !noteWrites.ready} onClose={() => { setDialog(null); setDailyNoteDate(undefined); }}
      onOpenPage={async id => { if (!await openPage(id)) throw new Error('页面暂时无法打开。'); }}
      onRestorePage={id => openTrash(id)} onCreate={openDailyNote} onCapture={quickCapture} />}
    {dialog === 'delete' && current && <TrashPageDialog title={title} childCount={subtreeIds(pages, current.id).length - 1} busy={pageActionBusy}
      onConfirm={() => void beginPageAction('trash', current.id, current.revision, title)} onClose={() => setDialog(null)} />}
    {dialog === 'move' && current && <MovePageDialog current={current} target={moveTarget} onTarget={setMoveTarget}
      pages={visiblePages.filter(page => page.kind !== 'whiteboard' && (page.kind !== 'database' || current.kind === 'row' || (current.kind ?? 'document') === 'document'))}
      onConfirm={() => void movePage()} onClose={() => setDialog(null)} />}
    {dialog === 'folder-import' && workspace && canWrite && <FolderImportDialog userId={session.user.id} workspaceId={workspace.id}
      csrfToken={session.csrfToken} pages={visiblePages} defaultParentId={activeId} parseMarkdown={parseMarkdownImport}
      resolveTagIds={names => resolveImportTags(workspace.id, session.csrfToken, names)}
      onOpenPage={id => { setDialog(null); void openPage(id); }}
      onImported={() => { void reloadTree(session); void refreshTags().catch(() => undefined); }} onClose={() => setDialog(null)} />}
    {commentsOpen && commentable && supported && initialContent && workspace && current && <CommentsPanel key={current.id}
      workspaceId={workspace.id} pageId={current.id} csrfToken={session.csrfToken} userId={session.user.id} role={workspace.role}
      refreshKey={commentRefresh} contentKey={editorSnapshot} locator={commentLocator} onCount={setCommentCount}
      onAuthError={() => { setReauth(true); setShowReauthForm(true); }} onClose={() => setCommentsOpen(false)} />}
    {dialog === 'export' && current && <ExportDialog options={exportOptions} onClose={() => setDialog(null)} />}
    {dialog === 'share' && workspace && current && canWrite && <ShareDialog workspaceId={workspace.id} pageId={current.id} title={title}
      csrfToken={session.csrfToken} onAuthError={() => { setDialog(null); setReauth(true); setShowReauthForm(true); }} onClose={() => setDialog(null)} />}
    {dialog === 'settings' && workspace && <SettingsDialog onClose={() => setDialog(null)} sections={[
      { key: 'appearance', label: '外观与阅读', icon: 'sun',
        content: <AppearanceSettings theme={theme} onTheme={setTheme} reading={readingPrefs} onReading={setReadingPrefs} /> },
      ...(workspace.role === 'owner' ? [
        { key: 'daily', label: '每日笔记', icon: 'clock' as const,
          content: <DailyNoteSettingsPanel workspaceId={workspace.id} templates={templates} parents={visiblePages}
            readOnly={!noteWrites.ready} onSave={saveDailySettings} /> },
        { key: 'members', label: '成员', icon: 'users' as const,
          content: <MembersPanel workspaceId={workspace.id} csrfToken={session.csrfToken}
            onAuthError={() => { setDialog(null); setReauth(true); setShowReauthForm(true); }} /> },
      ] : []),
      { key: 'account', label: '账号', icon: 'logout',
        content: <AccountSettings loginName={session.user.loginName} workspaceName={workspace.name} roleLabel={roleLabels[workspace.role]}
          onLogout={() => { setDialog(null); void logout(); }} /> },
    ]} />}    {dialog === 'import' && pendingImport && <ImportMarkdownDialog pendingImport={pendingImport} importResolving={importResolving} createBusy={createBusy}
      error={noteDialogError} onConfirm={() => void completeImport()} onClose={() => setDialog(null)} />}
  </div>;
}
