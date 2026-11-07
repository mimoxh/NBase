import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { AttachmentMetadata, AuthSessionResponse, PageDocument, StoredDocumentContent, WorkspaceTag } from '@nbase/contracts';
import { addMarkdownFrontMatter, markdownFromContent, parseMarkdownImport } from '../editor/markdown';
import type { DocumentContent, DocumentEditorHandle, EditorSnapshot } from '../editor/types';
import { exportAttachments, packagePage } from './attachmentExport';
import { withCaptionParagraphs } from './attachmentPresentation';
import { ApiError, attachmentClient, loadPageTree, pageClient, tagClient } from './client';
import type { LocalPageDraft } from './drafts';
import { download, downloadBlob } from './fileDownload';
import { packageFolderSubtree } from './folderExport';
import { resolveImportTags } from './importTags';
import { isAuthError, message } from './workspaceErrors';

export interface PendingImport { title: string; markdown: string; parsed: ReturnType<typeof parseMarkdownImport> }
export interface PendingUpload { id: string; pageId: string; file: File }

export interface PageTransferContext {
  session: AuthSessionResponse;
  workspace: AuthSessionResponse['workspaces'][number] | undefined;
  workspaceScope: string | null;
  liveScope: MutableRefObject<string | null>;
  current: PageDocument | null;
  title: string;
  conflict: { server: PageDocument; draft: LocalPageDraft } | null;
  conflictMarkdown: string | null;
  supported: boolean;
  tags: WorkspaceTag[];
  readOnly: boolean;
  currentLocked: boolean;
  canWrite: boolean;
  pendingImport: PendingImport | null;
  editorSnapshot: EditorSnapshot | null;
  editorRef: RefObject<DocumentEditorHandle | null>;
  activeIdRef: MutableRefObject<string | null>;
  draftsRef: MutableRefObject<Map<string, LocalPageDraft>>;
  uploadingRef: MutableRefObject<number>;
  folderExportingRef: MutableRefObject<boolean>;
  importResolvingRef: MutableRefObject<boolean>;
  createBusyRef: MutableRefObject<boolean>;
  setDialog: (dialog: 'import') => void;
  setNotice: (text: string) => void;
  setReauth: (value: boolean) => void;
  setNoteDialogError: (text: string) => void;
  setFolderExporting: (value: boolean) => void;
  setImportResolving: (value: boolean) => void;
  setPendingImport: (value: PendingImport | null) => void;
  setPendingUploads: Dispatch<SetStateAction<PendingUpload[]>>;
  settlePageBeforeWrite: (pageId: string) => Promise<void>;
  createPage: (parentId: string | null, title?: string, content?: StoredDocumentContent, resolvesDraft?: LocalPageDraft,
    tagIds?: string[], openResult?: boolean) => Promise<PageDocument | undefined>;
}

/** Page export, attachment upload and Markdown import for the page that is open now. */
export function createPageTransfers({ session, workspace, workspaceScope, liveScope, current, title, conflict, conflictMarkdown, supported,
  tags, readOnly, currentLocked, canWrite, pendingImport, editorSnapshot, editorRef, activeIdRef, draftsRef, uploadingRef,
  folderExportingRef, importResolvingRef, createBusyRef, setDialog, setNotice, setReauth, setNoteDialogError, setFolderExporting,
  setImportResolving, setPendingImport, setPendingUploads, settlePageBeforeWrite, createPage }: PageTransferContext) {
  const tagNamesFor = (ids: string[] | undefined) => tags.filter(tag => ids?.includes(tag.id)).map(tag => tag.name);
  const downloadPage = async (name: string, markdown: string, content: StoredDocumentContent, documentTitle: string, tagNames: string[]) => {
    try {
      const captioned = withCaptionParagraphs(content);
      const body = captioned === content ? markdown : markdownFromContent(captioned as Parameters<typeof markdownFromContent>[0]);
      const portable = addMarkdownFrontMatter(body, content, documentTitle, tagNames);
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

  return { exportCurrent, exportFolder, uploadFiles, retryUpload, importFile, completeImport };
}
