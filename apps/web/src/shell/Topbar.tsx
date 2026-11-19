import type { PageSummary } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Menu, type MenuItem } from './Menu';
import { SavePill } from './SavePill';
import type { SaveStatus } from './saveTone';

export function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return '刚刚编辑';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚编辑';
  if (minutes < 60) return `${minutes} 分钟前编辑`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前编辑`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前编辑`;
  return new Date(iso).toLocaleDateString();
}

export interface TopbarProps {
  status: SaveStatus;
  hasDraft: boolean;
  onRetrySave: () => void;
  onDownload: () => void;
  breadcrumbs: PageSummary[];
  currentTitle: string;
  updatedAt: string | null;
  favorite: boolean;
  onFavorite: () => void;
  onSidebarToggle: () => void;
  onOpenBreadcrumb: (id: string | null) => void;
  readOnly: boolean;
  onToggleReadOnly: () => void;
  onHistory: () => void;
  disabled: boolean;
  pageMenuItems: (MenuItem | 'divider')[];
  hideHistory?: boolean;
  demo?: boolean;
  /** Account that saved the shown revision. */
  editedBy?: string | null;
  /** Other members with this page open. */
  presence?: { userId: string; loginName: string; editing: boolean }[];
  /** Opens the comment panel; absent where pages cannot be commented on. */
  onComments?: () => void;
  commentsOpen?: boolean;
  commentCount?: number;
}

export function Topbar(props: TopbarProps) {
  return <header className="nb-topbar">
    <button className="icon-button nb-sidebar-toggle" aria-label="切换导航" onClick={props.onSidebarToggle}>
      <Icon name="sidebar" size={17} /></button>
    <nav className="nb-crumbs" aria-label="页面位置">
      <button onClick={() => props.onOpenBreadcrumb(null)}>个人空间</button>
      {props.breadcrumbs.map(page => <span key={page.id} className="nb-crumb">
        <span className="nb-crumb-sep">/</span>
        <button onClick={() => props.onOpenBreadcrumb(page.id)}>
          {page.icon && <span className="nb-crumb-icon">{page.icon}</span>}{page.title || '未命名页面'}</button>
      </span>)}
      <span className="nb-crumb"><span className="nb-crumb-sep">/</span>
        <strong>{props.currentTitle || '未命名页面'}</strong></span>
    </nav>
    {props.updatedAt && <span className="nb-edited">{relativeTime(props.updatedAt)}{props.editedBy ? ` · ${props.editedBy}` : ''}</span>}
    <div className="nb-top-actions">
      {Boolean(props.presence?.length) && <ul className="nb-presence" aria-label="正在查看此页的成员">
        {props.presence!.slice(0, 4).map(member => <li key={member.userId} className={member.editing ? 'nb-presence-editing' : ''}
          title={`${member.loginName} ${member.editing ? '正在编辑' : '正在查看'}`}>
          <span aria-hidden="true">{[...member.loginName][0]?.toUpperCase() ?? '?'}</span>
          <span className="visually-hidden">{member.loginName} {member.editing ? '正在编辑' : '正在查看'}</span></li>)}
        {props.presence!.length > 4 && <li title={props.presence!.slice(4).map(member => member.loginName).join('、')}>+{props.presence!.length - 4}</li>}
      </ul>}
      <SavePill status={props.status} hasDraft={props.hasDraft} onRetry={props.onRetrySave} onDownload={props.onDownload} demo={Boolean(props.demo)} />
      <button className={`icon-button nb-star ${props.favorite ? 'nb-star-on' : ''}`}
        aria-label={props.favorite ? '取消收藏' : '收藏'} aria-pressed={props.favorite}
        disabled={props.disabled} onClick={props.onFavorite}>
        <Icon name={props.favorite ? 'star-filled' : 'star'} size={17} /></button>
      {props.onComments && <button className={`icon-button nb-comment-toggle ${props.commentsOpen ? 'is-active' : ''}`} aria-label="评论"
        title="评论" aria-pressed={Boolean(props.commentsOpen)} onClick={props.onComments}>
        <Icon name="comment" size={17} />{Boolean(props.commentCount) && <span className="nb-comment-count">{props.commentCount}</span>}</button>}
      {!props.hideHistory && <button className="icon-button" aria-label="历史版本" title="历史版本" onClick={props.onHistory}>
        <Icon name="history" size={17} /></button>}
      <Menu label="页面操作" align="end" trigger={<Icon name="more" size={17} />} items={props.pageMenuItems} />
    </div>
  </header>;
}
