import { memo, useMemo, useState, type ReactNode } from 'react';
import type { PageSummary } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Menu } from './Menu';

export interface TreeRowActions {
  onOpen: (id: string) => void;
  onAddChild: (id: string) => void;
  onFavorite: (id: string) => void;
  onMove: (id: string) => void;
  onTrash: (id: string) => void;
}

export function PageIcon({ page, size = 17 }: { page: { icon: string | null }; size?: number }) {
  return <span className="nb-page-icon" aria-hidden="true">{page.icon ?? '📄'}</span>;
}

/** Memoized tree; callbacks stay stable from the workspace. */
export const PageTree = memo(function PageTree({ pages, activeId, favorites, actions }: {
  pages: PageSummary[];
  activeId: string | null;
  favorites: ReadonlySet<string>;
  actions: TreeRowActions;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const childrenByParent = useMemo(() => {
    const groups = new Map<string | null, PageSummary[]>();
    for (const page of pages) {
      const siblings = groups.get(page.parentId);
      if (siblings) siblings.push(page);
      else groups.set(page.parentId, [page]);
    }
    return groups;
  }, [pages]);
  const branch = (parentId: string | null, depth: number): ReactNode => (childrenByParent.get(parentId) ?? []).map(page => {
    const hasChildren = childrenByParent.has(page.id);
    const favorite = favorites.has(page.id);
    return <div key={page.id}>
      <div className={`nb-tree-row ${activeId === page.id ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 15 }}>
        {hasChildren ? <button className={`nb-tree-toggle ${collapsed.has(page.id) ? '' : 'expanded'}`}
          aria-label={`${collapsed.has(page.id) ? '展开' : '收起'} ${page.title || '未命名页面'}`}
          aria-expanded={!collapsed.has(page.id)} onClick={() => setCollapsed(previous => {
            const next = new Set(previous); if (next.has(page.id)) next.delete(page.id); else next.add(page.id); return next;
          })}><Icon name="chevron" size={13} /></button> : <span className="nb-tree-spacer" />}
        <button className="nb-tree-page" aria-current={activeId === page.id ? 'page' : undefined}
          onClick={() => actions.onOpen(page.id)}>
          <PageIcon page={page} /><span className="nb-tree-title">{page.title || '未命名页面'}</span>
          {favorite && <Icon name="star-filled" size={11} />}
        </button>
        <span className="nb-tree-actions">
          <button className="nb-tree-act" aria-label={`在「${page.title || '未命名页面'}」下新建子页面`}
            onClick={() => actions.onAddChild(page.id)}><Icon name="plus" size={14} /></button>
          <Menu label={`「${page.title || '未命名页面'}」页面操作`} align="end"
            trigger={<Icon name="more" size={14} />} items={[
              { key: 'fav', label: favorite ? '取消收藏' : '收藏', icon: 'star', onSelect: () => actions.onFavorite(page.id) },
              { key: 'child', label: '添加子页面', icon: 'plus', onSelect: () => actions.onAddChild(page.id) },
              { key: 'move', label: '移动到…', icon: 'folder', onSelect: () => actions.onMove(page.id) },
              'divider',
              { key: 'trash', label: '移入回收站', icon: 'trash', danger: true, onSelect: () => actions.onTrash(page.id) },
            ]} />
        </span>
      </div>
      {hasChildren && !collapsed.has(page.id) && branch(page.id, depth + 1)}
    </div>;
  });
  return <div className="nb-tree">{branch(null, 0)}</div>;
});
