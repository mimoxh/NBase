import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pageCoverIds, type PageCoverId } from '@nbase/contracts';
import { Icon } from '../components/Icon';

const emojis = ['📄', '📝', '📒', '📗', '📘', '📙', '📚', '🧭', '🛠', '🧪', '🐘', '💾', '🗄', '📦', '🔐', '⚙️',
  '🌱', '🌿', '🍀', '🌸', '🌙', '⭐', '🔥', '💡', '🎯', '🧩', '📌', '📎', '🖊', '✏️', '🗒', '📋',
  '🍳', '🍅', '☕', '🍜', '🧋', '🎂', '🍵', '🥗', '🏠', '🏢', '🚗', '✈️', '🚄', '🗺', '🏔', '⛺',
  '💪', '🧠', '❤️', '🎨', '🎵', '📷', '🎬', '⌚', '💰', '📈', '📊', '✅', '❌', '⚠️', '🚀', '🏁'];

function Popover({ label, children, onClose }: { label: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return <div className="nb-picker" role="dialog" aria-label={label} ref={ref}>{children}</div>;
}

export function EmojiPicker({ onPick, onRemove, onClose }: {
  onPick: (icon: string) => void; onRemove: () => void; onClose: () => void;
}) {
  return <Popover label="选择图标" onClose={onClose}>
    <div className="nb-emoji-grid">
      {emojis.map(emoji => <button key={emoji} aria-label={`图标 ${emoji}`} onClick={() => { onPick(emoji); onClose(); }}>{emoji}</button>)}
    </div>
    <button className="nb-btn nb-btn-quiet" onClick={() => { onRemove(); onClose(); }}>移除</button>
  </Popover>;
}

const coverNames: Record<PageCoverId, string> = {
  sage: '鼠尾草', ochre: '赭石', slate: '石板', rose: '蔷薇', sand: '沙色', sky: '天青',
};

export function CoverPicker({ onPick, onRemove, onClose }: {
  onPick: (cover: PageCoverId) => void; onRemove: () => void; onClose: () => void;
}) {
  return <Popover label="选择封面" onClose={onClose}>
    <div className="nb-cover-grid">
      {pageCoverIds.map(id => <button key={id} className={`nb-cover-swatch nb-cover-${id}`}
        aria-label={`封面 ${coverNames[id]}`} onClick={() => { onPick(id); onClose(); }} />)}
    </div>
    <button className="nb-btn nb-btn-quiet" onClick={() => { onRemove(); onClose(); }}>移除</button>
  </Popover>;
}

export interface PageHeaderProps {
  icon: string | null;
  cover: PageCoverId | null;
  title: ReactNode;
  editable: boolean;
  onIcon: (icon: string | null) => void;
  onCover: (cover: PageCoverId | null) => void;
}

export function PageHeader(props: PageHeaderProps) {
  const [picker, setPicker] = useState<'emoji' | 'cover' | null>(null);
  return <>
    {props.cover && <div className={`nb-cover nb-cover-${props.cover}`}>
      {props.editable && <button className="nb-cover-edit" onClick={() => setPicker('cover')}><Icon name="image" size={14} />更换封面</button>}
      {picker === 'cover' && <CoverPicker onPick={props.onCover} onRemove={() => props.onCover(null)} onClose={() => setPicker(null)} />}
    </div>}
    <div className="nb-doc-head document-heading">
      {props.editable && <div className="nb-ghost-actions">
        {!props.icon && <button onClick={() => setPicker('emoji')}><Icon name="smile" size={14} />添加图标</button>}
        {!props.cover && <button onClick={() => setPicker('cover')}><Icon name="image" size={14} />添加封面</button>}
      </div>}
      <div className="nb-doc-title-row">
        {props.icon
          ? <button className="nb-doc-icon" aria-label="更换页面图标" disabled={!props.editable} onClick={() => setPicker('emoji')}>{props.icon}</button>
          : null}
        {picker === 'emoji' && <EmojiPicker onPick={icon => props.onIcon(icon)} onRemove={() => props.onIcon(null)} onClose={() => setPicker(null)} />}
        {props.title}
      </div>
    </div>
  </>;
}
