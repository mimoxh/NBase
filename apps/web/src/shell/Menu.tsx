import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon';

export interface MenuItem {
  key: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** Accessible dropdown: Esc/outside click closes, arrows move, Enter selects. */
export function Menu({ label, trigger, items, align = 'start', className = '' }: {
  label: string;
  trigger: ReactNode;
  items: (MenuItem | 'divider')[];
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const enabled = items.filter((item): item is MenuItem => item !== 'divider' && !item.disabled);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key, true); };
  }, [open]);
  const choose = (item: MenuItem) => { setOpen(false); item.onSelect(); };
  return <div className={`nb-menu ${className}`} ref={rootRef}>
    <button className="nb-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={label}
      onClick={() => { setOpen(!open); setActive(0); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(0); }
      }}>
      {trigger}
    </button>
    {open && <div className={`nb-menu-list nb-menu-${align}`} role="menu" aria-label={label}>
      {items.map((item, index) => item === 'divider'
        ? <div className="nb-menu-divider" key={`d${index}`} />
        : <button key={item.key} role="menuitem" disabled={item.disabled}
          className={`nb-menu-item ${item.danger ? 'nb-menu-danger' : ''} ${enabled.indexOf(item) === active ? 'nb-menu-active' : ''}`}
          onMouseEnter={() => setActive(enabled.indexOf(item))}
          onClick={() => choose(item)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(active + 1, enabled.length - 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(active - 1, 0)); }
            if (event.key === 'Enter') { event.preventDefault(); choose(item); }
          }}>
          {item.icon && <Icon name={item.icon} size={15} />}<span>{item.label}</span>
        </button>)}
    </div>}
  </div>;
}
