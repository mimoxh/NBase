import { memo, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { PageSummary } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Menu } from './Menu';
import { isSelfOrAncestor, siblingStep, type PagePlacement } from './pageOrder';

export interface TreeRowActions {
  onOpen: (id: string) => void;
  onAddChild: (id: string) => void;
  /** Creates a database under the page; absent where databases cannot be created. */
  onAddDatabase?: ((id: string) => void) | undefined;
  onFavorite: (id: string) => void;
  onMove: (id: string) => void;
  onTrash: (id: string) => void;
  /** Absent where the page order cannot be changed, such as for viewers. */
  onPlace?: ((id: string, placement: PagePlacement) => void) | undefined;
}

type DropZone = 'before' | 'inside' | 'after';

export function PageIcon({ page, size = 17 }: { page: { icon: string | null; kind?: string | undefined }; size?: number }) {
  return <span className="nb-page-icon" aria-hidden="true">{page.icon ?? (page.kind === 'database' ? '🗃️' : page.kind === 'whiteboard' ? '🎨' : '📄')}</span>;
}

/** Memoized tree; callbacks stay stable from the workspace. */
export const PageTree = memo(function PageTree({ pages, activeId, favorites, actions }: {
  pages: PageSummary[];
  activeId: string | null;
  favorites: ReadonlySet<string>;
  actions: TreeRowActions;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [drop, setDrop] = useState<{ id: string; zone: DropZone } | null>(null);
  const dragged = useRef<string | null>(null);
  const childrenByParent = useMemo(() => {
    const groups = new Map<string | null, PageSummary[]>();
    for (const page of pages) {
      const siblings = groups.get(page.parentId);
      if (siblings) siblings.push(page);
      else groups.set(page.parentId, [page]);
    }
    return groups;
  }, [pages]);
  const placementFor = (page: PageSummary, zone: DropZone): PagePlacement => {
    if (zone === 'after') return { parentId: page.parentId, afterId: page.id };
    if (zone === 'inside') return { parentId: page.id, afterId: childrenByParent.get(page.id)?.filter(item => item.id !== dragged.current).at(-1)?.id ?? null };
    const siblings = (childrenByParent.get(page.parentId) ?? []).filter(item => item.id !== dragged.current);
    return { parentId: page.parentId, afterId: siblings[siblings.findIndex(item => item.id === page.id) - 1]?.id ?? null };
  };
  const zoneAt = (event: DragEvent<HTMLElement>): DropZone => {
    const rect = event.currentTarget.getBoundingClientRect();
    const share = (event.clientY - rect.top) / (rect.height || 1);
    return share < .28 ? 'before' : share > .72 ? 'after' : 'inside';
  };
  const dropAllowed = (page: PageSummary, zone: DropZone) => {
    const id = dragged.current;
    // A database's children are its rows and whiteboards hold no pages; neither accepts drops.
    if (zone === 'inside' && (page.kind === 'database' || page.kind === 'whiteboard')) return false;
    return Boolean(id) && !isSelfOrAncestor(pages, id!, zone === 'inside' ? page.id : page.parentId) && id !== page.id;
  };
  const branch = (parentId: string | null, depth: number): ReactNode => (childrenByParent.get(parentId) ?? []).map(page => {
    const hasChildren = childrenByParent.has(page.id);
    const favorite = favorites.has(page.id);
    const onPlace = actions.onPlace;
    const up = onPlace && siblingStep(pages, page.id, -1);
    const down = onPlace && siblingStep(pages, page.id, 1);
    return <div key={page.id}>
      <div className={`nb-tree-row ${activeId === page.id ? 'selected' : ''} ${drop?.id === page.id ? 'drop-' + drop.zone : ''}`}
        style={{ paddingLeft: 8 + depth * 15 }} draggable={Boolean(onPlace)}
        onDragStart={event => {
          dragged.current = page.id;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('application/x-nbase-page', page.id);
        }}
        onDragEnd={() => { dragged.current = null; setDrop(null); }}
        onDragOver={event => {
          const zone = zoneAt(event);
          if (!dropAllowed(page, zone)) { setDrop(null); return; }
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDrop(previous => previous?.id === page.id && previous.zone === zone ? previous : { id: page.id, zone });
        }}
        onDragLeave={() => setDrop(previous => previous?.id === page.id ? null : previous)}
        onDrop={event => {
          const zone = zoneAt(event);
          const id = dragged.current;
          setDrop(null);
          if (!id || !onPlace || !dropAllowed(page, zone)) return;
          event.preventDefault();
          onPlace(id, placementFor(page, zone));
        }}>
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
          {page.kind !== 'database' && page.kind !== 'whiteboard' && <button className="nb-tree-act" aria-label={`在「${page.title || '未命名页面'}」下新建子页面`}
            onClick={() => actions.onAddChild(page.id)}><Icon name="plus" size={14} /></button>}
          <Menu label={`「${page.title || '未命名页面'}」页面操作`} align="end"
            trigger={<Icon name="more" size={14} />} items={[
              { key: 'fav', label: favorite ? '取消收藏' : '收藏', icon: 'star', onSelect: () => actions.onFavorite(page.id) },
              ...(page.kind !== 'database' && page.kind !== 'whiteboard' ? [{ key: 'child', label: '添加子页面', icon: 'plus' as const, onSelect: () => actions.onAddChild(page.id) },
                ...(actions.onAddDatabase ? [{ key: 'database', label: '添加数据库', icon: 'table' as const,
                  onSelect: () => actions.onAddDatabase?.(page.id) }] : [])] : []),
              { key: 'move', label: '移动到…', icon: 'folder', onSelect: () => actions.onMove(page.id) },
              ...(up ? [{ key: 'up', label: '上移', icon: 'chevron' as const, onSelect: () => onPlace?.(page.id, up) }] : []),
              ...(down ? [{ key: 'down', label: '下移', icon: 'chevron' as const, onSelect: () => onPlace?.(page.id, down) }] : []),
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
