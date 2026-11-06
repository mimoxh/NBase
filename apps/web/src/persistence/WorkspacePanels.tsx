import type { PageDocument, PageSummary } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { PageIcon } from '../shell/PageTree';
import { relativeTime } from '../shell/Topbar';
import type { LocalPageDraft } from './drafts';
import { ancestorPath } from './pageTreePaths';

export function ConflictCard({ conflict, conflictMarkdown, createBusy, onSaveCopy, onDownload }: {
  conflict: { server: PageDocument; draft: LocalPageDraft }; conflictMarkdown: string | null; createBusy: boolean;
  onSaveCopy: () => void; onDownload: () => void;
}) {
  return <section className="nb-conflict-card" role="alert">
    <h1>此页面已在其他地方更新</h1>
    <p>另一个标签页或设备保存了新版本。你的修改尚未覆盖它。</p>
    <div className="nb-conflict-actions">
      <button className="nb-btn nb-btn-primary" disabled={createBusy} onClick={onSaveCopy}>另存为副本</button>
      <button className="nb-btn" onClick={onDownload}>下载我的内容</button>
    </div>
    <details><summary>{conflictMarkdown === null ? '查看本机原始数据' : '查看本机 Markdown'}</summary>
      <pre>{conflictMarkdown ?? JSON.stringify(conflict.draft.content, null, 2)}</pre></details>
  </section>;
}

export function HomePanel({ workspaceName, pages, homePages, createBusy, canWrite, onOpen, onNew }: {
  workspaceName: string | undefined; pages: PageSummary[]; homePages: PageSummary[]; createBusy: boolean; canWrite: boolean;
  onOpen: (pageId: string) => void; onNew: () => void;
}) {
  return <section className="nb-home">
    <div className="nb-home-eyebrow">{workspaceName}</div>
    <h1>最近编辑</h1>
    <div className="nb-home-list">{homePages.map(page => <button className="nb-home-row" key={page.id} onClick={() => onOpen(page.id)}>
      <PageIcon page={page} size={20} /><span>
        <strong>{page.title || '未命名页面'}</strong>
        <small>{ancestorPath(pages, page.id)} · {relativeTime(page.updatedAt)}</small>
      </span></button>)}</div>
    <div style={{ marginTop: 22 }}><button className="nb-btn nb-btn-primary" disabled={createBusy || !canWrite} onClick={onNew}><Icon name="plus" size={15} /> 新建页面</button></div>
  </section>;
}

export function EmptyPanel({ createBusy, canWrite, onNew, onImport }: {
  createBusy: boolean; canWrite: boolean; onNew: () => void; onImport: () => void;
}) {
  return <section className="nb-empty"><div>
    <div className="nb-empty-emoji">📝</div>
    <h1>开始写第一篇页面</h1>
    <p>页面可以层层嵌套，组织你的笔记、计划和资料。</p>
    <div className="nb-empty-actions">
      <button className="nb-btn nb-btn-primary" disabled={createBusy || !canWrite} onClick={onNew}>新建页面</button>
      <button className="nb-btn" disabled={!canWrite} onClick={onImport}>导入 Markdown</button>
    </div>
  </div></section>;
}
