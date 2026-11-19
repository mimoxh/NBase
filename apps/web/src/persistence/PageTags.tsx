import { useState } from 'react';
import { pageTagLimit, tagNameLimit, type PageSummary, type WorkspaceTag } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ApiError, tagClient } from './client';
import './pageTags.css';

export function matchesAllTags(page: PageSummary, tagIds: string[]): boolean {
  return tagIds.every(id => page.tagIds?.includes(id));
}

/** Keep ancestors for navigation through the filtered tree. */
export function filterPageTree(pages: PageSummary[], tagIds: string[]): PageSummary[] {
  if (!tagIds.length) return pages;
  const byId = new Map(pages.map(page => [page.id, page]));
  const visible = new Set<string>();
  for (const page of pages) {
    if (!matchesAllTags(page, tagIds)) continue;
    let node: PageSummary | undefined = page;
    while (node && !visible.has(node.id)) {
      visible.add(node.id);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
  }
  return pages.filter(page => visible.has(page.id));
}

interface TagSelection { tags: WorkspaceTag[]; value: string[]; onChange: (ids: string[]) => void }

function TagChoices({ tags, value, onChange, showCount, disabled }: TagSelection & { showCount?: boolean; disabled?: boolean }) {
  if (!tags.length) return <p className="nbase-tag-hint">此工作区还没有标签。</p>;
  return <div className="nbase-tag-choices">{tags.map(tag => {
    const selected = value.includes(tag.id);
    return <label key={tag.id} className={selected ? 'selected' : undefined}>
      <input type="checkbox" checked={selected} disabled={disabled || (!selected && value.length >= pageTagLimit)}
        onChange={() => onChange(selected ? value.filter(id => id !== tag.id) : [...value, tag.id])} />
      <span>{tag.name}</span>{showCount && <small>{tag.pageCount}</small>}
    </label>;
  })}</div>;
}

export function TagFilter(props: TagSelection) {
  if (!props.tags.length) return null;
  const count = props.value.length;
  return <details className={`nbase-tag-filter${count ? ' active' : ''}`}>
    <summary>
      <Icon name="tag" size={14} /><span className="nbase-tag-filter-label">标签筛选</span>
      {count > 0 && <span className="nbase-tag-filter-count" aria-label={`已选 ${count} 个标签`}>{count}</span>}
      <span className="nbase-tag-filter-caret"><Icon name="chevron" size={12} /></span>
    </summary>
    <div className="nbase-tag-filter-body">
      <div className="nbase-tag-filter-head">
        <span>同时包含所选标签</span>
        {count > 0 && <button type="button" aria-label="清除标签筛选" onClick={() => props.onChange([])}>清除</button>}
      </div>
      <TagChoices {...props} showCount />
    </div>
  </details>;
}
type Mutation = { clientMutationId: string } & (
  | { type: 'create'; name: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'remove'; id: string }
);

export function TagManagerDialog({ tags, workspaceId, csrfToken, onChanged, onClose, onAuthError }: {
  tags: WorkspaceTag[];
  workspaceId: string;
  csrfToken: string;
  onChanged: () => void | Promise<void>;
  onClose: () => void;
  onAuthError: () => void;
}) {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<WorkspaceTag | null>(null);
  const [removing, setRemoving] = useState<WorkspaceTag | null>(null);
  const [pending, setPending] = useState<Mutation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const validName = Boolean(name.trim()) && [...name.trim().normalize('NFC')].length <= tagNameLimit;

  const submit = async (mutation: Mutation) => {
    if (busy) return;
    setBusy(true); setError(''); setPending(mutation);
    try {
      if (mutation.type === 'create') {
        await tagClient.create(workspaceId, { clientMutationId: mutation.clientMutationId, name: mutation.name }, csrfToken);
      } else if (mutation.type === 'rename') {
        await tagClient.rename(workspaceId, mutation.id, { clientMutationId: mutation.clientMutationId, name: mutation.name }, csrfToken);
      } else {
        await tagClient.remove(workspaceId, mutation.id, mutation.clientMutationId, csrfToken);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) setPending(null);
      if (cause instanceof ApiError && cause.status === 401) onAuthError();
      setError(cause instanceof ApiError && cause.code === 'TAG_NAME_CONFLICT' ? '已有同名标签。'
        : cause instanceof ApiError && cause.code === 'INVALID_REQUEST' ? '请输入有效的标签名称。'
          : cause instanceof ApiError && cause.status === 404 ? '标签已不存在，请刷新后重试。'
            : '暂时无法确认标签操作，请重试。');
      setBusy(false);
      return;
    }
    setPending(null); setRenaming(null); setRemoving(null); setName('');
    try { await onChanged(); }
    catch { setError('标签已更新，列表刷新失败。'); }
    finally { setBusy(false); }
  };

  const locked = busy || Boolean(pending);
  return <Modal title="管理标签" onClose={onClose}>
    <form className="nbase-tag-manager-form" onSubmit={event => {
      event.preventDefault();
      if (locked || !validName) return;
      const clientMutationId = crypto.randomUUID();
      void submit(renaming ? { type: 'rename', id: renaming.id, name, clientMutationId } : { type: 'create', name, clientMutationId });
    }}>
      <label>标签名称<input value={name} onChange={event => setName(event.target.value)} disabled={locked} /></label>
      <button type="submit" className="nb-btn nb-btn-primary" disabled={locked || !validName}>{renaming ? '保存名称' : '创建标签'}</button>
      {renaming && <button type="button" className="nb-btn" disabled={locked} onClick={() => { setRenaming(null); setName(''); }}>取消改名</button>}
    </form>
    {error && <p role="alert">{error}</p>}
    {pending && !busy && <button type="button" className="nb-btn" onClick={() => void submit(pending)}>重试标签操作</button>}
    {!tags.length && <p className="nbase-tag-hint">此工作区还没有标签。</p>}
    {tags.length > 0 && <ul className="nbase-tag-manager-list">{tags.map(tag => <li key={tag.id}>
      <span><strong>{tag.name}</strong> <small>{tag.pageCount} 篇活动页面</small></span>
      <button type="button" className="nb-btn" aria-label={`重命名标签 ${tag.name}`} disabled={locked}
        onClick={() => { setRenaming(tag); setRemoving(null); setName(tag.name); setError(''); }}>重命名</button>
      <button type="button" className="nb-btn" aria-label={`删除标签 ${tag.name}`} disabled={locked}
        onClick={() => { setRemoving(tag); setError(''); }}>删除</button>
    </li>)}</ul>}
    {removing && <div>
      <p>删除「{removing.name}」会解除它与所有页面的关联。</p>
      <button type="button" className="nb-btn" disabled={locked}
        onClick={() => void submit({ type: 'remove', id: removing.id, clientMutationId: crypto.randomUUID() })}>确认删除标签</button>
      <button type="button" className="nb-btn nb-btn-quiet" disabled={locked} onClick={() => setRemoving(null)}>取消</button>
    </div>}
  </Modal>;
}
