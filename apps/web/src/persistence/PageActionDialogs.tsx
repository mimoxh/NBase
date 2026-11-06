import type { PageDocument, PageSummary } from '@nbase/contracts';
import { Modal } from '../components/Modal';
import { download } from './fileDownload';
import type { PendingImport } from './pageTransfers';

export function TrashPageDialog({ title, childCount, busy, onConfirm, onClose }: {
  title: string; childCount: number; busy: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return <Modal title="移入回收站" onClose={onClose}>
    <p className="dialog-description">将“{title || '未命名页面'}”及 {childCount} 篇子页面移入回收站。操作前会先保存当前更改；尚未处理的本机草稿会阻止删除。</p>
    <p className="dialog-description">历史、附件与页面 ID 保留，暂不自动清理。</p>
    <div className="dialog-actions"><button className="nb-btn" onClick={onClose}>取消</button>
      <button className="nb-btn nb-btn-primary" disabled={busy} onClick={onConfirm}>
        {busy ? '正在处理…' : '确认移入回收站'}</button></div></Modal>;
}

export function MovePageDialog({ current, pages, target, onTarget, onConfirm, onClose }: {
  current: PageDocument; pages: PageSummary[]; target: string; onTarget: (value: string) => void; onConfirm: () => void; onClose: () => void;
}) {
  return <Modal title="移动页面" onClose={onClose}>
    <label className="field-label" htmlFor="persistent-move-target">移动到</label>
    <select id="persistent-move-target" className="select-field" value={target} onChange={event => onTarget(event.target.value)}>
      <option value="">个人空间（根目录）</option>{pages.filter(page => page.id !== current.id).map(page =>
        <option key={page.id} value={page.id}>{page.title || '未命名页面'}</option>)}</select>
    <div className="dialog-actions"><button className="nb-btn" onClick={onClose}>取消</button>
      <button className="nb-btn nb-btn-primary" onClick={onConfirm}>移动并保存</button></div></Modal>;
}

export function ImportMarkdownDialog({ pendingImport, importResolving, createBusy, error, onConfirm, onClose }: {
  pendingImport: PendingImport; importResolving: boolean; createBusy: boolean; error: string; onConfirm: () => void; onClose: () => void;
}) {
  return <Modal title="导入 Markdown" onClose={() => { if (!importResolving) onClose(); }}>
    <p className="dialog-description">创建页面「{pendingImport.title || '未命名页面'}」。</p>
    {pendingImport.parsed.tagNames.length > 0 && <p>标签 {pendingImport.parsed.tagNames.join('、')}</p>}
    {pendingImport.parsed.warnings.length > 0 && <div className="import-warning"><strong>转换提示</strong><ul>
      {pendingImport.parsed.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    {error && <p role="alert">{error}</p>}
    <details className="import-preview"><summary>查看原始文本</summary><pre>{pendingImport.markdown}</pre></details>
    <div className="dialog-actions"><button className="nb-btn" disabled={importResolving} onClick={onClose}>取消</button>
      <button className="nb-btn" onClick={() => download(`${pendingImport.title}-原始文件`, pendingImport.markdown)}>下载原文</button>
      <button className="nb-btn nb-btn-primary" disabled={createBusy || importResolving} onClick={onConfirm}>转换并创建</button></div></Modal>;
}
