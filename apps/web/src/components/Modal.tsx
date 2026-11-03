import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { const dialog = ref.current; const focus = document.activeElement; dialog?.showModal(); return () => { dialog?.close(); if (focus instanceof HTMLElement && focus.isConnected) focus.focus(); }; }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-label={title} onCancel={event => { event.preventDefault(); closeRef.current(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭对话框" onClick={onClose}><Icon name="close" /></button></div>{children}
  </dialog>;
}
