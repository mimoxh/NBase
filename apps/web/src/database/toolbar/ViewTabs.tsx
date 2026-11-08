import { useState } from 'react';
import { databaseViewLimit, type DatabaseView as View } from '@nbase/contracts';
import { Icon } from '../../components/Icon';
import { Popover } from '../../components/Popover';

export function ViewTabs({ views, view, canWrite, open, onOpen, onClose, onSelect, onAdd, onRename, onDelete }: {
  views: View[]; view: View; canWrite: boolean; open: boolean; onOpen: () => void; onClose: () => void;
  onSelect: (id: string) => void; onAdd: () => void; onRename: (id: string, name: string) => void; onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  return <div className="nb-db-views" role="tablist" aria-label="视图">
    {views.map(item => renaming === item.id
      ? <input key={item.id} className="nb-db-input nb-db-view-input" autoFocus defaultValue={item.name} aria-label="视图名称" maxLength={100}
        onBlur={event => { const name = event.target.value.trim(); setRenaming(null);
          if (name && name !== item.name) onRename(item.id, name); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); if (event.key === 'Escape') setRenaming(null); }} />
      : <button key={item.id} role="tab" aria-selected={item.id === view.id} className={`nb-db-view-tab ${item.id === view.id ? 'active' : ''}`}
        onClick={() => onSelect(item.id)} onDoubleClick={() => canWrite && setRenaming(item.id)}>
        <Icon name="table" size={13} />{item.name}</button>)}
    {canWrite && <span className="nb-db-anchor">
      <button className="nb-db-tool" aria-label="视图设置" onClick={onOpen}><Icon name="more" size={14} /></button>
      {open && <Popover label="视图设置" className="nb-db-pop" onClose={onClose}>
        <div className="nb-db-menu">
          <button onClick={() => { setRenaming(view.id); onClose(); }}>重命名当前视图</button>
          <button disabled={views.length >= databaseViewLimit} onClick={() => { onAdd(); onClose(); }}>新建表格视图</button>
          <button className="danger" disabled={views.length <= 1} onClick={() => { onDelete(); onClose(); }}>删除当前视图</button>
        </div>
      </Popover>}
    </span>}
  </div>;
}
