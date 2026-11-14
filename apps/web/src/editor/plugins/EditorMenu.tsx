import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import './editorMenu.css';

export type EditorMenuItem = {
  key: string;
  label: string;
  disabled?: boolean;
  /** Tooltip, e.g. why an item is disabled. */
  hint?: string | undefined;
  checked?: boolean;
  danger?: boolean;
  onSelect?: () => void;
  children?: EditorMenuEntry[];
};
export type EditorMenuEntry = EditorMenuItem | 'divider';

type Props = {
  label: string;
  x: number;
  y: number;
  items: EditorMenuEntry[];
  /** Element the menu is portaled into; it supplies the theme variables. */
  host: Element;
  /** `restoreFocus` is true when the user dismissed the menu from the keyboard. */
  onClose: (restoreFocus: boolean) => void;
};

const margin = 8;

function place(element: HTMLElement, x: number, y: number, flipFrom?: DOMRect): CSSProperties {
  const { width, height } = element.getBoundingClientRect();
  let left = x;
  if (left + width > window.innerWidth - margin) left = flipFrom ? flipFrom.left - width - 2 : window.innerWidth - width - margin;
  let top = y;
  if (top + height > window.innerHeight - margin) top = flipFrom ? window.innerHeight - height - margin : y - height;
  return { left: Math.max(margin, left), top: Math.max(margin, top) };
}

function itemElement(list: HTMLElement | null, key: string): HTMLElement | undefined {
  return list ? [...list.querySelectorAll<HTMLElement>('[data-menu-key]')].find(element => element.dataset.menuKey === key) : undefined;
}

/** Focuses a menu item, scrolling only the menu's own list when it is taller than the viewport. */
function focusItem(element: HTMLElement | undefined) {
  if (!element) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: 'nearest' });
}

function focusable(list: HTMLElement | null): HTMLButtonElement[] {
  return list ? [...list.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')] : [];
}

function preferred(options: HTMLButtonElement[]): HTMLButtonElement | undefined {
  return options.find(option => option.getAttribute('aria-checked') === 'true') ?? options[0];
}

/** A fixed-position menu at a point, with one level of submenus; keyboard and pointer operable. */
export function EditorMenu({ label, x, y, items, host, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [rootStyle, setRootStyle] = useState<CSSProperties | null>(null);
  const [open, setOpen] = useState<{ key: string; focus: boolean } | null>(null);
  const [subStyle, setSubStyle] = useState<CSSProperties | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const parent = open ? items.find((item): item is EditorMenuItem => item !== 'divider' && item.key === open.key) : undefined;

  useLayoutEffect(() => {
    if (!rootRef.current) return;
    setRootStyle(place(rootRef.current, x, y));
  }, [x, y]);

  // Focus only once the menu is placed: browsers refuse focus inside a `visibility: hidden` element.
  const rootPlaced = rootStyle !== null;
  useLayoutEffect(() => {
    if (rootPlaced) focusItem(preferred(focusable(rootRef.current)));
  }, [rootPlaced, x, y]);

  useLayoutEffect(() => {
    setSubStyle(null);
    if (!open || !subRef.current || !rootRef.current) return;
    const anchor = itemElement(rootRef.current, open.key);
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setSubStyle(place(subRef.current, rect.right + 2, rect.top - 4, rect));
  }, [open]);

  useLayoutEffect(() => {
    if (!subStyle || !open?.focus) return;
    focusItem(preferred(focusable(subRef.current)));
  }, [subStyle]);

  useEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Node
      && (rootRef.current?.contains(target) || subRef.current?.contains(target));
    const pointer = (event: MouseEvent) => { if (!inside(event.target)) closeRef.current(false); };
    const scroll = (event: Event) => { if (!inside(event.target)) closeRef.current(false); };
    const dismiss = () => closeRef.current(false);
    document.addEventListener('mousedown', pointer, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('mousedown', pointer, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, []);

  const choose = (item: EditorMenuItem) => {
    if (item.disabled) return;
    if (item.children) { setOpen(current => current?.key === item.key ? null : { key: item.key, focus: true }); return; }
    closeRef.current(false);
    item.onSelect?.();
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>, inSub: boolean) => {
    const list = event.currentTarget;
    const options = focusable(list);
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : options.length - 1;
      focusItem(options[(index + step) % options.length]);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusItem(options[event.key === 'Home' ? 0 : options.length - 1]);
    } else if (event.key === 'ArrowRight' && !inSub) {
      const key = (document.activeElement as HTMLElement | null)?.dataset.menuKey;
      const item = items.find((entry): entry is EditorMenuItem => entry !== 'divider' && entry.key === key);
      if (item?.children && !item.disabled) { event.preventDefault(); setOpen({ key: item.key, focus: true }); }
    } else if ((event.key === 'ArrowLeft' || event.key === 'Escape') && inSub) {
      event.preventDefault();
      event.stopPropagation();
      const key = open?.key;
      setOpen(null);
      if (key) focusItem(itemElement(rootRef.current, key));
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
    }
  };

  const render = (entries: EditorMenuEntry[], inSub: boolean) => entries.map((item, index) => item === 'divider'
    ? <div key={`divider-${index}`} className="nbase-menu-divider" role="separator" />
    : <button key={item.key} type="button" data-menu-key={item.key} disabled={item.disabled} title={item.hint}
      role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked}
      aria-haspopup={item.children ? 'menu' : undefined} aria-expanded={item.children ? open?.key === item.key : undefined}
      className={`nbase-menu-item${item.danger ? ' is-danger' : ''}${open?.key === item.key ? ' is-open' : ''}`}
      onMouseDown={event => event.preventDefault()}
      onMouseEnter={() => { if (!inSub) setOpen(item.children && !item.disabled ? { key: item.key, focus: false } : null); }}
      onClick={() => choose(item)}>
      <span className="nbase-menu-check" aria-hidden="true">{item.checked ? '✓' : ''}</span>
      <span className="nbase-menu-label">{item.label}</span>
      {item.children && <span className="nbase-menu-arrow" aria-hidden="true">›</span>}
    </button>);

  return createPortal(<>
    <div ref={rootRef} className="nbase-menu" role="menu" aria-label={label}
      style={rootStyle ?? { left: x, top: y, visibility: 'hidden' }}
      onContextMenu={event => event.preventDefault()} onKeyDown={event => keyDown(event, false)}>
      {render(items, false)}
    </div>
    {parent?.children && <div ref={subRef} className="nbase-menu nbase-submenu" role="menu" aria-label={parent.label}
      style={subStyle ?? { left: 0, top: 0, visibility: 'hidden' }}
      onContextMenu={event => event.preventDefault()} onKeyDown={event => keyDown(event, true)}>
      {render(parent.children, true)}
    </div>}
  </>, host);
}
