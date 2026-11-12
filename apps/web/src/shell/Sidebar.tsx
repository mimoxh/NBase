import { useMemo, type ReactNode } from 'react';
import type { PageSummary } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Menu, type MenuItem } from './Menu';
import { PageTree, type TreeRowActions } from './PageTree';
import type { ThemePreference } from './theme';

export interface SidebarProps {
  workspaceName: string;
  loginName: string;
  /** Account menu's first row; defaults to `已登录 · {loginName}`. */
  accountLabel?: string;
  theme: ThemePreference;
  onTheme: (theme: ThemePreference) => void;
  onLogout: () => void;
  onSearch: () => void;
  onTrash: () => void;
  noteActions?: ReactNode;
  treeControls?: ReactNode;
  onNewPage: () => void;
  onNewDatabase?: () => void;
  onNewWhiteboard?: () => void;
  onImport: () => void;
  onImportFolder?: () => void;
  createBusy: boolean;
  pages: PageSummary[];
  activeId: string | null;
  favorites: ReadonlySet<string>;
  recentPages: PageSummary[];
  favoritePages: PageSummary[];
  treeLoading: boolean;
  treeError: string;
  onTreeRetry: () => void;
  treeActions: TreeRowActions;
  open: boolean;
  onClose: () => void;
}

export function Sidebar(props: SidebarProps) {
  const themeItems: (MenuItem | 'divider')[] = ([
    ['light', '浅色'], ['dark', '深色'], ['system', '跟随系统'],
  ] as [ThemePreference, string][]).map(([value, label]) => ({
    key: `theme-${value}`, icon: value === 'dark' ? 'moon' as const : 'sun' as const,
    label: `${label}${props.theme === value ? ' ✓' : ''}`, onSelect: () => props.onTheme(value),
  }));
  const accountItems: (MenuItem | 'divider')[] = [
    { key: 'account', label: props.accountLabel ?? `已登录 · ${props.loginName}`, icon: 'check', disabled: true, onSelect: () => undefined },
    'divider',
    ...themeItems,
    'divider',
    { key: 'logout', label: '退出登录', icon: 'logout', onSelect: props.onLogout },
  ];
  const sections = useMemo(() => ({
    favorites: props.favoritePages, recent: props.recentPages,
  }), [props.favoritePages, props.recentPages]);
  return <>
    {props.open && <button className="nb-scrim" aria-label="收起导航" onClick={props.onClose} />}
    <aside className={`nb-sidebar ${props.open ? 'nb-sidebar-open' : ''}`} aria-label="工作台导航">
      <Menu className="nb-ws" label="工作区菜单" align="start" items={accountItems}
        trigger={<span className="nb-ws-btn">
          <span className="nb-avatar">{props.workspaceName.slice(0, 1) || 'N'}</span>
          <span className="nb-ws-name">{props.workspaceName}</span><Icon name="chevron-down" size={14} /></span>} />
      <nav className="nb-nav">
        <button className="nb-nav-row" onClick={props.onSearch}><Icon name="search" size={15} /><span>搜索</span><kbd>Ctrl K</kbd></button>
        <button className="nb-nav-row" onClick={props.onTrash}><Icon name="trash" size={15} /><span>回收站</span></button>
        {props.noteActions}
      </nav>
      {sections.favorites.length > 0 && <div className="nb-section">
        <div className="nb-section-label">收藏</div>
        {sections.favorites.map(page => <button key={page.id} className={`nb-fav-row ${props.activeId === page.id ? 'selected' : ''}`}
          onClick={() => props.treeActions.onOpen(page.id)}>
          <span className="nb-page-icon">{page.icon ?? '📄'}</span><span className="nb-tree-title">{page.title || '未命名页面'}</span>
        </button>)}
      </div>}
      {sections.recent.length > 0 && <div className="nb-section">
        <div className="nb-section-label">最近</div>
        {sections.recent.map(page => <button key={page.id} className={`nb-fav-row ${props.activeId === page.id ? 'selected' : ''}`}
          onClick={() => props.treeActions.onOpen(page.id)}>
          <span className="nb-page-icon">{page.icon ?? '📄'}</span><span className="nb-tree-title">{page.title || '未命名页面'}</span>
        </button>)}
      </div>}
      <div className="nb-section nb-section-grow">
        <div className="nb-section-label">页面</div>
        {props.treeControls}
        {props.treeLoading && <p className="nb-tree-message">正在加载目录…</p>}
        {props.treeError && <p className="nb-tree-message" role="alert">{props.treeError}
          <button onClick={props.onTreeRetry}>重试</button></p>}
        <PageTree pages={props.pages} activeId={props.activeId} favorites={props.favorites} actions={props.treeActions} />
      </div>
      <div className="nb-sidebar-foot">
        <button className="nb-nav-row" disabled={props.createBusy} onClick={props.onNewPage}><Icon name="plus" size={15} /><span>新建页面</span></button>
        {props.onNewDatabase && <button className="nb-nav-row" disabled={props.createBusy} onClick={props.onNewDatabase}><Icon name="table" size={15} /><span>新建数据库</span></button>}
        {props.onNewWhiteboard && <button className="nb-nav-row" disabled={props.createBusy} onClick={props.onNewWhiteboard}><Icon name="focus" size={15} /><span>新建白板</span></button>}
        <button className="nb-nav-row" onClick={props.onImport}><Icon name="upload" size={15} /><span>导入 Markdown</span></button>
        {props.onImportFolder && <button className="nb-nav-row" onClick={props.onImportFolder}><Icon name="folder" size={15} /><span>导入 Markdown 文件夹</span></button>}
      </div>
    </aside>
  </>;
}
