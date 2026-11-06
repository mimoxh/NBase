import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AttachmentMetadata, AuthSessionResponse, DailyNoteSettings, DailyNoteStatus, NoteTemplate, OpenDailyNoteRequest,
  PageBacklink, PageCoverId, PageDocument, PageSummary, PageVersion, QuickCaptureRequest, SearchResult,
  StoredDocumentContent, TrashedPageDocument, UpdatePageRequest, WorkspaceTag } from '@nbase/contracts';
import { pageIdFromReferenceUrl } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { DocumentEditor } from '../editor/DocumentEditor';
import { SourceEditorDialog } from '../editor/SourceEditorDialog';
import { addMarkdownFrontMatter, createContentFromMarkdown, markdownFromContent, parseMarkdownImport } from '../editor/markdown';
import { normalizeDocumentContent } from '../editor/normalize';
import type { DocumentContent, DocumentEditorHandle, EditorSnapshot } from '../editor/types';
import { ApiError, attachmentClient, loadPageTree, pageClient, tagClient } from './client';
import { draftKey, draftVersion, localDrafts, sameDraftVersion,
  type LocalPageDraft, type LocalPendingAction, type LocalPendingCreate, type LocalPendingNoteWrite } from './drafts';
import { useNoteWrites } from './useNoteWrites';
import type { NoteWrite } from './noteWrites';
import { isDefiniteUpdateRejection, releaseRejectedMutation } from './savePolicy';
import { exportAttachments, packagePage } from './attachmentExport';
import { PersistentSearchDialog } from './PersistentSearchDialog';
import { PageHistoryDialog, TrashDialog } from './PageRecoveryDialogs';
import { PageBacklinks } from './PageBacklinks';
import { FolderImportDialog } from './FolderImportDialog';
import { packageFolderSubtree } from './folderExport';
import { resolveImportTags } from './importTags';
import { CopyNoteDialog, NewNoteDialog, TemplateManagerDialog } from './NoteTemplateDialogs';
import { noteTemplateClient } from './noteTemplateClient';
import { DailyNoteDialog, dailyClient } from './DailyNoteDialog';
import { PageTagControls, TagFilter, TagManagerDialog, filterPageTree } from './PageTags';
import { useTheme } from '../shell/theme';
import { saveToneFor, type SaveStatus } from '../shell/saveTone';
import { Sidebar } from '../shell/Sidebar';
import { Topbar, relativeTime } from '../shell/Topbar';
import { PageHeader } from '../shell/PageHeader';
import { Toc } from '../shell/Toc';
import { NoticeBar } from '../shell/NoticeBar';
import { Toast } from '../shell/Toast';
import { type MenuItem } from '../shell/Menu';
import { PageIcon } from '../shell/PageTree';
import '../shell/shell.css';
import './persistent.css';

function message(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : '操作失败，请重试。';
  const messages: Record<string, string> = {
    AUTH_REQUIRED: '请重新登录，当前草稿仍保留在本机。', AUTH_EXPIRED: '登录已过期，当前草稿仍保留在本机。',
    AUTH_INVALID: '账号或密码不正确。', RATE_LIMITED: '尝试次数过多，请稍后再试。',
    NETWORK_UNAVAILABLE: '网络中断；本机草稿仍可找回。', TIMEOUT: '请求超时，正在保留本机草稿。',
    REVISION_CONFLICT: '另一标签或设备已更新这篇页面，请先处理冲突。',
    MUTATION_CONFLICT: '本次重试内容不一致，请保留本地内容并重新打开。',
    PAGE_TREE_INVALID: '目标页面无效或会形成循环。', CONTENT_VERSION_UNSUPPORTED: '此文档的格式版本暂不支持。',
    PAGE_TREE_CHANGED: '子页面范围已变化，请重新确认删除。',
    CONTENT_INVALID: '当前正文包含无法保存的内容，请下载 Markdown 保留。',
    PAGE_LIMIT_EXCEEDED: '页面数量超过当前工作台加载上限。',
    ATTACHMENT_TOO_LARGE: '附件超过 10 MB 限制。', ATTACHMENT_EMPTY: '不能上传空文件。',
    ATTACHMENT_TYPE_UNSUPPORTED: '仅支持 PNG、JPEG、GIF、WebP、PDF、ZIP、TXT 和 Markdown。',
    ATTACHMENT_TYPE_MISMATCH: '文件后缀与实际类型不一致。',
    ATTACHMENT_NAME_INVALID: '附件名称包含不允许的字符。',
    ATTACHMENT_ID_CONFLICT: '附件重试 ID 与已有内容冲突，请重新添加。',
    ATTACHMENT_INVALID: '文档中有无效附件引用，请保留本机草稿并检查附件。',
    ATTACHMENT_MISSING: '附件文件缺失，导出已停止。',
    ATTACHMENT_CORRUPT: '附件文件与数据库记录不一致，导出已停止。',
    FAVORITE_LIMIT: '收藏已达 200 个上限。',
    DAILY_NOTE_TRASHED: '这一天的笔记在回收站，请先恢复。',
    DAILY_PARENT_UNAVAILABLE: '每日笔记的默认父页不可用，请更新设置。',
    PAGE_REFERENCE_INVALID: '正文引用的页面不在当前工作区，请检查引用或下载本机草稿。',
  };
  return messages[error.code] ?? '服务暂时无法完成操作，请重试。';
}

function download(name: string, text: string, type = 'text/markdown', extension = '.md') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '未命名页面'}${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBlob(name: string, blob: Blob, extension: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '未命名页面'}${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function Login({ onLogin, error, busy, title = '登录 NBase' }: {
  onLogin: (name: string, password: string) => Promise<void>; error: string; busy: boolean; title?: string;
}) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const submit = (event: FormEvent) => { event.preventDefault(); void onLogin(name, password); };
  return <form className="nb-login" onSubmit={submit}>
    <span className="nb-logo">N</span><h1>{title}</h1>
    <label>账号名<input autoComplete="username" value={name} onChange={event => setName(event.target.value)} required /></label>
    <label>密码<span className="nb-pass-wrap"><input autoComplete="current-password" type={showPassword ? 'text' : 'password'} value={password}
      onChange={event => setPassword(event.target.value)} required />
      <button type="button" className="icon-button nb-eye" aria-label={showPassword ? '隐藏密码' : '显示密码'}
        onClick={() => setShowPassword(!showPassword)}><Icon name={showPassword ? 'close' : 'search'} size={15} /></button></span></label>
    {error && <div className="nb-login-err" role="alert">{error}</div>}
    <button className="nb-btn nb-btn-primary" disabled={busy} type="submit">{busy ? '正在登录…' : '登录'}</button>
    <p className="nb-login-foot">自部署实例 · 仅限已初始化账号</p>
  </form>;
}

function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Code blocks compare in canonical text form so highlight tokens never register as edits. */
function canonicalContent(content: StoredDocumentContent): string {
  return canonical(content.schemaVersion === 1 ? normalizeDocumentContent(content as DocumentContent) : content);
}

function matchesServer(draft: LocalPageDraft, server: PageDocument): boolean {
  return draft.title === server.title && canonicalContent(draft.content) === canonicalContent(server.content);
}

function contentMatchesServer(content: StoredDocumentContent, server: PageDocument | undefined): boolean {
  return !!server && canonicalContent(content) === canonicalContent(server.content);
}

export function PersistentWorkspace() {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [sessionPhase, setSessionPhase] = useState<'checking' | 'login' | 'ready' | 'error'>('checking');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [showReauthForm, setShowReauthForm] = useState(false);
  const [pages, setPages] = useState<PageSummary[]>([]);
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
  const [pendingImport, setPendingImport] = useState<{ title: string; markdown: string; parsed: ReturnType<typeof parseMarkdownImport> } | null>(null);
  const [importResolving, setImportResolving] = useState(false);
  const [folderExporting, setFolderExporting] = useState(false);
  const [sourceSession, setSourceSession] = useState<{ pageId: string; instanceId: string; content: DocumentContent;
    baseRevision: string; title: string; parentId: string | null; scope: string } | null>(null);
  const importResolvingRef = useRef(false);
  const folderExportingRef = useRef(false);
  const [moveTarget, setMoveTarget] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [pendingCreates, setPendingCreates] = useState<LocalPendingCreate[]>([]);
  const [pendingUploads, setPendingUploads] = useState<{ id: string; pageId: string; file: File }[]>([]);
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
  const savingRef = useRef(new Set<string>());
  const saveWaitersRef = useRef(new Map<string, (() => void)[]>());
  const pendingActionsRef = useRef(new Map<string, LocalPendingAction>());
  const pageActionBusyRef = useRef(false);
  const favoriteBusyRef = useRef(new Set<string>());
  const uploadingRef = useRef(0);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const writeQueues = useRef(new Map<string, Promise<void>>());
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
    const { content: _content, ...summary } = page;
    void _content;
    setPages(previous => previous.some(item => item.id === page.id)
      ? previous.map(item => item.id === page.id ? summary : item) : [...previous, summary]);
    if (activeIdRef.current === page.id) setDocumentPage(page);
  };

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

  const subtreeIds = (rootId: string, source = pages): string[] => {
    const ids = new Set([rootId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const page of source) if (page.parentId && ids.has(page.parentId) && !ids.has(page.id)) {
        ids.add(page.id); changed = true;
      }
    }
    return [...ids];
  };

  const waitForSave = (pageId: string): Promise<void> => {
    if (!savingRef.current.has(pageId)) return Promise.resolve();
    return new Promise(resolve => saveWaitersRef.current.set(pageId, [...(saveWaitersRef.current.get(pageId) ?? []), resolve]));
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
    expectedRevision: string, pageTitle: string, sourceRevision?: string) => {
    if (!session || !workspace || pageActionBusyRef.current) return;
    if (!actionsLoaded || pendingActionsRef.current.size) { setDialog(null); setNotice('请先处理本机待确认操作，再发起新的恢复或删除。'); return; }
    pageActionBusyRef.current = true; setPageActionBusy(true);
    try {
      let affectedIds = operation === 'trash' ? subtreeIds(pageId) : [pageId];
      if (operation === 'trash') {
        const freshPages = await loadPageTree(workspace.id);
        const freshIds = subtreeIds(pageId, freshPages);
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
  const updatePageMeta = async (pageId: string, patch: Pick<UpdatePageRequest, 'parentId' | 'icon' | 'cover' | 'tagIds'>,
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
      upsertPage(updated); setNotice(done);
      if (patch.tagIds) void refreshTags().catch(() => undefined);
      return true;
    } catch (error) { setNotice(message(error)); if (isAuthError(error)) setReauth(true); return false; }
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
    <Login onLogin={login} error={authError} busy={authBusy} />
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
  const tagNamesFor = (ids: string[] | undefined) => tags.filter(tag => ids?.includes(tag.id)).map(tag => tag.name);
  const downloadPage = async (name: string, markdown: string, content: StoredDocumentContent, documentTitle: string, tagNames: string[]) => {
    try {
      const portable = addMarkdownFrontMatter(markdown, content, documentTitle, tagNames);
      const attachments = exportAttachments(content);
      if (!attachments.length) { download(name, portable); return; }
      if (!workspace) { setNotice('当前工作区不可用，无法导出附件。'); return; }
      setNotice(`正在读取 ${attachments.length} 个附件并生成 ZIP…`);
      const packageBlob = await packagePage(portable, content, id => attachmentClient.download(workspace.id, id));
      downloadBlob(name, packageBlob, '.zip');
      setNotice('页面和附件 ZIP 已发起下载，请检查浏览器下载记录。');
    } catch (error) { setNotice(`导出未完成：${message(error)} 原页面没有修改。`); }
  };
  const exportCurrent = () => {
    if (!current) return;
    if (conflict) {
      const name = `${conflict.draft.title || '未命名页面'}-本机草稿`;
      if (conflictMarkdown !== null) void downloadPage(name, conflictMarkdown, conflict.draft.content,
        conflict.draft.title || '未命名页面', tagNamesFor(conflict.server.tagIds));
      else download(name, JSON.stringify(conflict.draft.content, null, 2), 'application/json', '.json');
      return;
    }
    if (!supported) download(`${current.title || '页面'}-原始数据`, JSON.stringify(current.content, null, 2), 'application/json', '.json');
    else {
      const snapshot = editorRef.current?.getSnapshot();
      void downloadPage(title || '未命名页面', snapshot?.markdown ?? editorSnapshot?.markdown ?? '',
        snapshot?.content ?? editorSnapshot?.content ?? current.content, title || '未命名页面', tagNamesFor(current.tagIds));
    }
  };
  const exportFolder = async () => {
    if (!current || !workspace || folderExportingRef.current) return;
    folderExportingRef.current = true; setFolderExporting(true);
    try {
      if (draftsRef.current.has(current.id)) await settlePageBeforeWrite(current.id);
      setNotice('正在打包已保存的页面、子页面和附件…');
      const currentPages = await loadPageTree(workspace.id);
      const availableTags = (await tagClient.list(workspace.id)).tags;
      const blob = await packageFolderSubtree({ rootPageId: current.id, pages: currentPages,
        fetchPage: id => pageClient.get(workspace.id, id), fetchAttachment: id => attachmentClient.download(workspace.id, id),
        formatMarkdown: page => addMarkdownFrontMatter(markdownFromContent(page.content as DocumentContent),
          page.content, page.title || '未命名页面', availableTags.filter(tag => page.tagIds?.includes(tag.id)).map(tag => tag.name)),
      });
      if (liveScope.current !== workspaceScope) return;
      downloadBlob(current.title || '页面与子页面', blob, '.zip');
      setNotice('页面与子页面 ZIP 已发起下载。');
    } catch (error) { setNotice(message(error)); if (isAuthError(error)) setReauth(true); }
    finally { folderExportingRef.current = false; setFolderExporting(false); }
  };
  const uploadFiles = async (files: File[]): Promise<AttachmentMetadata[]> => {
    const pageId = activeIdRef.current;
    if (!session || !workspace || !pageId || readOnly || currentLocked) return [];
    const uploaded: AttachmentMetadata[] = [];
    for (const file of files) {
      if (!file.size || file.size > 10 * 1024 * 1024) {
        setNotice(`${file.name || '附件'}：请选择 1 字节至 10 MB 的文件。`); continue;
      }
      const id = crypto.randomUUID();
      uploadingRef.current += 1;
      try {
        uploaded.push(await attachmentClient.upload(workspace.id, id, file, session.csrfToken));
      } catch (error) {
        setNotice(`${file.name || '附件'}：${message(error)}`);
        if (error instanceof ApiError && error.status === 0) {
          setPendingUploads(previous => [...previous, { id, pageId, file }]);
        }
        if (isAuthError(error)) setReauth(true);
      } finally { uploadingRef.current -= 1; }
    }
    if (uploaded.length && activeIdRef.current !== pageId) {
      setNotice('附件已上传，但页面已切换；请返回原页面重新添加文件。');
      return [];
    }
    if (uploaded.length) setNotice(`${uploaded.length} 个附件已上传，正在插入页面；请等待正文保存。`);
    return uploaded;
  };
  const retryUpload = async (pending: { id: string; pageId: string; file: File }) => {
    if (!session || !workspace || activeIdRef.current !== pending.pageId || currentLocked) return;
    uploadingRef.current += 1;
    try {
      const uploaded = await attachmentClient.upload(workspace.id, pending.id, pending.file, session.csrfToken);
      setPendingUploads(previous => previous.filter(item => item.id !== pending.id));
      if (activeIdRef.current === pending.pageId) {
        editorRef.current?.insertAttachments([uploaded]);
        setNotice('附件上传已确认，已插入页面；请等待正文保存。');
      } else setNotice('附件已上传，但页面已切换；请返回原页面重新添加文件。');
    } catch (error) {
      setNotice(`${pending.file.name || '附件'}：${message(error)}`);
      if (!(error instanceof ApiError && error.status === 0)) {
        setPendingUploads(previous => previous.filter(item => item.id !== pending.id));
      }
      if (isAuthError(error)) setReauth(true);
    } finally { uploadingRef.current -= 1; }
  };
  const importFile = async (file: File | undefined) => {
    if (!file || !canWrite) return;
    if (!/\.md$/i.test(file.name) || file.size > 1024 * 1024) { setNotice('请选择不超过 1 MB 的 .md 文件。'); return; }
    try {
      const markdown = await file.text();
      const parsed = parseMarkdownImport(markdown);
      setNoteDialogError('');
      setPendingImport({ title: parsed.title ?? file.name.replace(/\.md$/i, ''), markdown, parsed }); setDialog('import');
    } catch { setNotice('无法读取文件，请重试。'); }
  };
  const completeImport = async () => {
    if (!pendingImport || !workspace || !canWrite || importResolvingRef.current || createBusyRef.current) return;
    importResolvingRef.current = true; setImportResolving(true); setNoteDialogError('');
    try {
      const tagIds = await resolveImportTags(workspace.id, session.csrfToken, pendingImport.parsed.tagNames);
      if (liveScope.current !== workspaceScope) return;
      await createPage(null, pendingImport.title, pendingImport.parsed.content, undefined, tagIds);
    } catch (error) { setNoteDialogError(message(error)); if (isAuthError(error)) setReauth(true); }
    finally { importResolvingRef.current = false; setImportResolving(false); }
  };
  const toggleSidebar = () => {
    if (window.innerWidth <= 720) { setMobileOpen(!mobileOpen); return; }
    setSidebarHidden(value => {
      const next = !value;
      try { localStorage.setItem('nbase.sidebar', next ? 'collapsed' : 'open'); } catch { /* best effort */ }
      return next;
    });
  };
  const ancestorsOf = (pageId: string): string => {
    const names: string[] = [];
    let cursor = pages.find(page => page.id === pageId)?.parentId ?? null;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = pages.find(page => page.id === cursor);
      if (!parent) break;
      names.unshift(parent.title || '未命名页面');
      cursor = parent.parentId;
    }
    return names.join(' / ') || '个人空间';
  };
  const ancestors = (() => {
    const chain: PageSummary[] = [];
    let cursor = current?.parentId ?? null;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = pages.find(page => page.id === cursor);
      if (!parent) break;
      chain.unshift(parent);
      cursor = parent.parentId;
    }
    return chain;
  })();
  const favoriteSet = new Set(favoriteIds);
  const favoritePages = favoriteIds.flatMap(id => pages.filter(page => page.id === id));
  const recentPages = recentIds.flatMap(id => pages.filter(page => page.id === id)).slice(0, 5);
  const homePages = [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
  const editorReadOnly = readOnly || currentLocked || !canWrite;
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
    onFavorite: (id: string) => { void toggleFavorite(id); },
    onMove: (id: string) => {
      void openPage(id).then(opened => {
        if (!opened) return;
        setMoveTarget(docsRef.current.get(id)?.parentId ?? ''); setDialog('move');
      });
    },
    onTrash: (id: string) => { void openPage(id).then(opened => { if (opened) setDialog('delete'); }); },
  };
  const pageMenuItems: (MenuItem | 'divider')[] = current ? [
    { key: 'mode', label: readOnly ? '切换为编辑' : '切换为阅读', icon: 'focus', disabled: !canWrite, onSelect: () => setReadOnly(!readOnly) },
    { key: 'attach', label: '添加图片或附件', icon: 'image', disabled: editorReadOnly, onSelect: () => attachmentInputRef.current?.click() },
    { key: 'source', label: 'Markdown 源码', icon: 'code', onSelect: openSource },
    { key: 'download', label: '下载页面', icon: 'download', onSelect: exportCurrent },
    { key: 'folder-zip', label: '导出已保存的页面与子页面 ZIP', icon: 'download', disabled: folderExporting, onSelect: () => void exportFolder() },
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
        onHistory={() => setDialog('history')} disabled={currentLocked} pageMenuItems={pageMenuItems} />}
      {!activeId && <header className="nb-topbar">
        <button className="icon-button nb-sidebar-toggle" aria-label="切换导航" onClick={toggleSidebar}><Icon name="sidebar" size={17} /></button>
        <nav className="nb-crumbs" aria-label="页面位置"><strong>工作台</strong></nav></header>}
      {actionStorageError && <NoticeBar tone="danger" alert>{actionStorageError}<button onClick={() => location.reload()}>重新读取</button></NoticeBar>}
      {pendingActions.map(pending => <NoticeBar tone="warn" key={pending.key}>
        {pending.title || '未命名页面'}：{pending.operation === 'trash' ? '删除' : '恢复'}结果待确认，相关页面暂停自动保存。
        <button disabled={pageActionBusy} onClick={() => void performPageAction(pending)}>重试同一操作</button>
      </NoticeBar>)}
      {pendingCreates.map(pending => <NoticeBar tone="warn" key={pending.key}>有一笔尚未确认的页面创建：{pending.body.title || '未命名页面'}。
        <button disabled={createBusy} onClick={() => void performCreate(pending)}>重试同一笔创建</button>
        <button onClick={() => download('待创建页面-原始数据', JSON.stringify(pending.body.content, null, 2), 'application/json', '.json')}>下载原始数据</button>
        <button disabled={createBusy} onClick={() => { if (!confirm('确定放弃这笔待确认创建吗？如果服务端已经提交，页面仍会保留在目录中。')) return;
          void localDrafts.removeCreate(pending.key).then(() => {
            untrackPendingCreate(pending.key); void reloadTree(session);
          }).catch(() => setNotice('无法清除本机待创建记录。'));
        }}>放弃记录</button>
      </NoticeBar>)}
      {noteWrites.pending.map(item => <NoticeBar tone="warn" key={item.key}>
        {item.write.kind === 'quick' ? `${item.write.body.date} 的快速记录待确认。` : '有一笔笔记创建操作待确认。'}
        <button disabled={noteWrites.busy || !canWrite} onClick={() => void retryNoteWrite(item)}>重试同一笔提交</button>
        {item.write.kind === 'quick' && item.conflict && <button disabled={noteWrites.busy || !canWrite}
          onClick={() => void retryNoteWrite(item, true)}>按最新修订重试</button>}
        {item.write.kind === 'quick' && <button onClick={() => {
          if (item.write.kind === 'quick') download('待提交快速记录', item.write.body.text, 'text/plain', '.txt');
        }}>下载文字</button>}
        <button disabled={noteWrites.busy} onClick={() => {
          if (confirm('确定移除此本机待提交记录吗？服务端已确认的内容会保留。')) void noteWrites.dismiss(item).catch(error => setNotice(message(error)));
        }}>移除记录</button>
      </NoticeBar>)}
      {pendingUploads.filter(item => item.pageId === activeId).map(pending => <NoticeBar tone="warn" key={pending.id}>
        {pending.file.name || '附件'} 上传结果尚未确认，原文件仍在本机。
        <button onClick={() => void retryUpload(pending)}>用同一 ID 重试上传</button>
        <button onClick={() => setPendingUploads(previous => previous.filter(item => item.id !== pending.id))}>放弃重试</button>
      </NoticeBar>)}
      {reauth && <NoticeBar tone="danger" alert>登录已失效，继续输入会保留本机草稿。
        <button onClick={() => setShowReauthForm(true)}>重新登录</button>
        {current && <button onClick={exportCurrent}>下载当前内容</button>}</NoticeBar>}
      {current && otherDraft && !draftsRef.current.has(current.id) && <NoticeBar tone="info">
        发现此前会话或其他标签留下的本机草稿，当前页面未自动覆盖。
        <button onClick={recoverOtherDraft}>检查并恢复草稿</button>
      </NoticeBar>}
      <main className="nb-scroll">
        {activeId ? loadingPage ? <div className="nb-home" role="status">正在读取页面…</div>
          : conflict ? <section className="nb-conflict-card" role="alert">
            <h1>此页面已在其他地方更新</h1>
            <p>另一个标签页或设备保存了新版本。你的修改尚未覆盖它。</p>
            <div className="nb-conflict-actions">
              <button className="nb-btn nb-btn-primary" disabled={createBusy} onClick={() => void createPage(conflict.server.parentId,
                `${conflict.draft.title || '未命名页面'}（冲突副本）`, conflict.draft.content, conflict.draft)}>另存为副本</button>
              <button className="nb-btn" onClick={exportCurrent}>下载我的内容</button>
            </div>
            <details><summary>{conflictMarkdown === null ? '查看本机原始数据' : '查看本机 Markdown'}</summary>
              <pre>{conflictMarkdown ?? JSON.stringify(conflict.draft.content, null, 2)}</pre></details>
          </section> : current ? <>
            <PageHeader icon={current.icon} cover={current.cover} editable={!editorReadOnly}
              onIcon={icon => setIcon(current.id, icon)} onCover={cover => setCover(current.id, cover)}
              title={readOnly || !canWrite ? <h1 className="nb-doc-title-static" data-nbase-find-title>{title || '未命名页面'}</h1>
                : <input className="nb-doc-title page-title" data-nbase-find-title aria-label="页面标题" value={title} disabled={currentLocked}
                  onChange={event => changeTitle(event.target.value)} placeholder="未命名页面" />} />
            <div className="nb-doc-body">
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
                workspaceId={workspace?.id} onUploadFiles={uploadFiles} />
                : <div role="alert" className="nbase-unsupported"><h2>暂不能打开此格式版本</h2>
                  <p>原始数据仍保留在服务端。请先下载副本，等待兼容升级。</p>
                  <button className="nb-btn" onClick={exportCurrent}>下载原始 JSON</button></div>}
              {workspace && <PageBacklinks key={current.id} workspaceId={workspace.id} pageId={current.id} revision={current.revision}
                onOpen={link => openBacklink(link, current.id)} />}
            </div>
            <Toc outline={editorSnapshot?.outline ?? []} onJump={id => editorRef.current?.jumpToHeading(id)} />
          </> : <section className="nb-home" role="alert">页面暂时无法打开。{saveStatus.text}</section>
          : pages.length ? <section className="nb-home">
            <div className="nb-home-eyebrow">{workspace?.name}</div>
            <h1>最近编辑</h1>
            <div className="nb-home-list">{homePages.map(page => <button className="nb-home-row" key={page.id} onClick={() => void openPage(page.id)}>
              <PageIcon page={page} size={20} /><span>
                <strong>{page.title || '未命名页面'}</strong>
                <small>{ancestorsOf(page.id)} · {relativeTime(page.updatedAt)}</small>
              </span></button>)}</div>
            <div style={{ marginTop: 22 }}><button className="nb-btn nb-btn-primary" disabled={createBusy || !canWrite} onClick={() => openNewNote(null)}><Icon name="plus" size={15} /> 新建页面</button></div>
          </section>
          : treeLoading ? <section className="nb-home" role="status">正在加载目录…</section>
          : <section className="nb-empty"><div>
            <div className="nb-empty-emoji">📝</div>
            <h1>开始写第一篇页面</h1>
            <p>页面可以层层嵌套，组织你的笔记、计划和资料。</p>
            <div className="nb-empty-actions">
              <button className="nb-btn nb-btn-primary" disabled={createBusy || !canWrite} onClick={() => openNewNote(null)}>新建页面</button>
              <button className="nb-btn" disabled={!canWrite} onClick={() => fileRef.current?.click()}>导入 Markdown</button>
            </div>
          </div></section>}
      </main>
    </section>
    <input ref={fileRef} type="file" accept=".md,text/markdown" className="visually-hidden" aria-label="选择 Markdown 文件"
      onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
    <input ref={attachmentInputRef} type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.zip,.txt,.md" multiple
      className="visually-hidden" aria-label="选择图片或附件"
      onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = '';
        void uploadFiles(files).then(uploaded => editorRef.current?.insertAttachments(uploaded)); }} />
    {notice && <Toast text={notice} onClose={() => setNotice('')} />}
    {reauth && showReauthForm && <div className="nb-auth" style={{ position: 'fixed', inset: 0, zIndex: 90 }}><div>
      <Login title="重新登录以继续保存" onLogin={login} error={authError} busy={authBusy} />
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
    {dialog === 'delete' && current && <Modal title="移入回收站" onClose={() => setDialog(null)}>
      <p className="dialog-description">将“{title || '未命名页面'}”及 {subtreeIds(current.id).length - 1} 篇子页面移入回收站。操作前会先保存当前更改；尚未处理的本机草稿会阻止删除。</p>
      <p className="dialog-description">历史、附件与页面 ID 保留，暂不自动清理。</p>
      <div className="dialog-actions"><button className="nb-btn" onClick={() => setDialog(null)}>取消</button>
        <button className="nb-btn nb-btn-primary" disabled={pageActionBusy} onClick={() => void beginPageAction('trash', current.id, current.revision, title)}>
          {pageActionBusy ? '正在处理…' : '确认移入回收站'}</button></div></Modal>}
    {dialog === 'move' && current && <Modal title="移动页面" onClose={() => setDialog(null)}>
      <label className="field-label" htmlFor="persistent-move-target">移动到</label>
      <select id="persistent-move-target" className="select-field" value={moveTarget} onChange={event => setMoveTarget(event.target.value)}>
        <option value="">个人空间（根目录）</option>{pages.filter(page => page.id !== current.id).map(page =>
          <option key={page.id} value={page.id}>{page.title || '未命名页面'}</option>)}</select>
      <div className="dialog-actions"><button className="nb-btn" onClick={() => setDialog(null)}>取消</button>
        <button className="nb-btn nb-btn-primary" onClick={() => void movePage()}>移动并保存</button></div></Modal>}
    {dialog === 'folder-import' && workspace && canWrite && <FolderImportDialog userId={session.user.id} workspaceId={workspace.id}
      csrfToken={session.csrfToken} pages={pages} defaultParentId={activeId} parseMarkdown={parseMarkdownImport}
      resolveTagIds={names => resolveImportTags(workspace.id, session.csrfToken, names)}
      onOpenPage={id => { setDialog(null); void openPage(id); }}
      onImported={() => { void reloadTree(session); void refreshTags().catch(() => undefined); }} onClose={() => setDialog(null)} />}
    {dialog === 'import' && pendingImport && <Modal title="导入 Markdown" onClose={() => { if (!importResolving) setDialog(null); }}>
      <p className="dialog-description">创建页面「{pendingImport.title || '未命名页面'}」。</p>
      {pendingImport.parsed.tagNames.length > 0 && <p>标签 {pendingImport.parsed.tagNames.join('、')}</p>}
      {pendingImport.parsed.warnings.length > 0 && <div className="import-warning"><strong>转换提示</strong><ul>
        {pendingImport.parsed.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      {noteDialogError && <p role="alert">{noteDialogError}</p>}
      <details className="import-preview"><summary>查看原始文本</summary><pre>{pendingImport.markdown}</pre></details>
      <div className="dialog-actions"><button className="nb-btn" disabled={importResolving} onClick={() => setDialog(null)}>取消</button>
        <button className="nb-btn" onClick={() => download(`${pendingImport.title}-原始文件`, pendingImport.markdown)}>下载原文</button>
        <button className="nb-btn nb-btn-primary" disabled={createBusy || importResolving} onClick={() => void completeImport()}>转换并创建</button></div></Modal>}
  </div>;
}
