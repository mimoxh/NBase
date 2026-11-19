import { useMemo, type ReactNode } from 'react';
import type { PageSummary } from '@nbase/contracts';
import { Icon, type IconName } from '../components/Icon';
import { Menu, type MenuItem } from './Menu';
import { PageTree, type TreeRowActions } from './PageTree';

export interface SidebarProps {
  workspaceName: string;
  loginName: string;
  /** Account menu's first row; defaults to `已登录 · {loginName}`. */
  accountLabel?: string;
  onLogout: () => void;
  onSettings: () => void;
  onSearch: () => void;
  onTrash: () => void;
  /** Rows under search in the main navigation. */
  noteActions?: ReactNode;
  /** Extra footer buttons (see `SidebarTool`), placed before trash and settings. */
  toolActions?: ReactNode;
  treeControls?: ReactNode;
  /** Shows the "+" create menu; members without write access get none. */
  canCreate?: boolean;
  onNewPage: () => void;
  onNewDatabase?: () => void;
  onNewWhiteboard?: () => void;
  onImport?: () => void;
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

export function SidebarTool({ icon, label, disabled, onClick }: { icon: IconName; label: string; disabled?: boolean; onClick: () => void }) {
  return <button className="nb-foot-btn" title={label} disabled={disabled} onClick={onClick}>
    <Icon name={icon} size={16} /><span>{label}</span></button>;
}

export function Sidebar(props: SidebarProps) {
  const accountItems: (MenuItem | 'divider')[] = [
    { key: 'account', label: props.accountLabel ?? `已登录 · ${props.loginName}`, icon: 'check', disabled: true, onSelect: () => undefined },
    'divider',
    { key: 'settings', label: '设置', icon: 'settings', onSelect: props.onSettings },
    { key: 'logout', label: '退出登录', icon: 'logout', onSelect: props.onLogout },
  ];
  const imports: MenuItem[] = [
    ...(props.onImport ? [{ key: 'import', label: '导入 Markdown', icon: 'upload' as const, onSelect: props.onImport }] : []),
    ...(props.onImportFolder ? [{ key: 'import-folder', label: '导入 Markdown 文件夹', icon: 'folder' as const, onSelect: props.onImportFolder }] : []),
  ];
  const createItems: (MenuItem | 'divider')[] = [
    { key: 'page', label: '新建页面', icon: 'page', disabled: props.createBusy, onSelect: props.onNewPage },
    ...(props.onNewDatabase ? [{ key: 'database', label: '新建数据库', icon: 'table' as const, disabled: props.createBusy, onSelect: props.onNewDatabase }] : []),
    ...(props.onNewWhiteboard ? [{ key: 'whiteboard', label: '新建白板', icon: 'focus' as const, disabled: props.createBusy, onSelect: props.onNewWhiteboard }] : []),
    ...(imports.length ? ['divider' as const, ...imports] : []),
  ];
  const sections = useMemo(() => ({
    favorites: props.favoritePages, recent: props.recentPages,
  }), [props.favoritePages, props.recentPages]);
  return <>
    {props.open && <button className="nb-scrim" aria-label="收起导航" onClick={props.onClose} />}
    <aside className={`nb-sidebar ${props.open ? 'nb-sidebar-open' : ''}`} aria-label="工作台导航">
      <div className="nb-ws">
        <Menu className="nb-ws-menu" label="工作区菜单" align="start" items={accountItems}
          trigger={<span className="nb-ws-btn">
            <span className="nb-avatar">{props.workspaceName.slice(0, 1) || 'N'}</span>
            <span className="nb-ws-name">{props.workspaceName}</span><Icon name="chevron-down" size={14} /></span>} />
        {props.canCreate !== false && <Menu className="nb-create" label="新建" align="end" items={createItems}
          trigger={<Icon name="plus" size={16} />} />}
      </div>
      <nav className="nb-nav">
        <button className="nb-nav-row" onClick={props.onSearch}><Icon name="search" size={15} /><span>搜索</span><kbd>Ctrl K</kbd></button>
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
        {props.toolActions}
        <SidebarTool icon="trash" label="回收站" onClick={props.onTrash} />
        <SidebarTool icon="settings" label="设置" onClick={props.onSettings} />
      </div>
    </aside>
  </>;
}
