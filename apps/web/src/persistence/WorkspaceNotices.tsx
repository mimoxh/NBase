import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { PageDocument } from '@nbase/contracts';
import { NoticeBar } from '../shell/NoticeBar';
import { localDrafts, type LocalPageDraft, type LocalPendingAction, type LocalPendingCreate, type LocalPendingNoteWrite } from './drafts';
import { download } from './fileDownload';
import type { PendingUpload } from './pageTransfers';
import { message } from './workspaceErrors';

export interface WorkspaceNoticesProps {
  activeId: string | null;
  actionStorageError: string;
  pendingActions: LocalPendingAction[];
  pageActionBusy: boolean;
  performPageAction: (pending: LocalPendingAction) => Promise<void>;
  pendingCreates: LocalPendingCreate[];
  createBusy: boolean;
  performCreate: (pending: LocalPendingCreate) => Promise<unknown>;
  untrackPendingCreate: (key: string) => void;
  reloadWorkspaceTree: () => void;
  noteWrites: { pending: LocalPendingNoteWrite[]; busy: boolean; dismiss: (item: LocalPendingNoteWrite) => Promise<unknown> };
  canWrite: boolean;
  retryNoteWrite: (item: LocalPendingNoteWrite, rebase?: boolean) => Promise<void>;
  pendingUploads: PendingUpload[];
  retryUpload: (pending: PendingUpload) => Promise<void>;
  setPendingUploads: Dispatch<SetStateAction<PendingUpload[]>>;
  reauth: boolean;
  setShowReauthForm: (value: boolean) => void;
  current: PageDocument | null;
  exportCurrent: () => void;
  otherDraft: LocalPageDraft | null;
  draftsRef: MutableRefObject<Map<string, LocalPageDraft>>;
  recoverOtherDraft: () => void;
  setNotice: (text: string) => void;
}

export function WorkspaceNotices({ activeId, actionStorageError, pendingActions, pageActionBusy, performPageAction, pendingCreates, createBusy,
  performCreate, untrackPendingCreate, reloadWorkspaceTree, noteWrites, canWrite, retryNoteWrite, pendingUploads, retryUpload, setPendingUploads,
  reauth, setShowReauthForm, current, exportCurrent, otherDraft, draftsRef, recoverOtherDraft, setNotice }: WorkspaceNoticesProps) {
  return <>
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
          untrackPendingCreate(pending.key); reloadWorkspaceTree();
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
  </>;
}
