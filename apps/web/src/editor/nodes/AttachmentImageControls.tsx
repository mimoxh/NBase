import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { attachmentCaptionMaxLength, attachmentWidthMax, attachmentWidthMin, isAttachmentCaption, type AttachmentAlign, type AttachmentPresentation } from '@nbase/contracts';

const sizes: [string, number | undefined][] = [['小', 33], ['中', 50], ['大', 75], ['全宽', 100], ['原始', undefined]];
const aligns: [string, AttachmentAlign | undefined][] = [['左', undefined], ['中', 'center'], ['右', 'right']];

export function ImageControls({ value, onChange, onZoom }: {
  value: AttachmentPresentation;
  onChange: (next: AttachmentPresentation) => void;
  onZoom: () => void;
}) {
  const commitCaption = (input: HTMLInputElement) => {
    const caption = input.value.trim();
    if (caption === (value.caption ?? '')) { input.value = caption; return; }
    if (caption && !isAttachmentCaption(caption)) { input.value = value.caption ?? ''; return; }
    const { caption: _old, ...rest } = value;
    onChange(caption ? { ...rest, caption } : rest);
  };
  const choice = <T,>(label: string, current: T, options: [string, T][], pick: (next: T) => void) =>
    <span className="nbase-image-choice" role="group" aria-label={label}>
      {options.map(([text, option]) => <button key={text} type="button" aria-pressed={current === option}
        className={current === option ? 'is-active' : ''} onClick={() => pick(option)}>{text}</button>)}
    </span>;
  const set = <K extends 'width' | 'align'>(key: K, next: AttachmentPresentation[K]) => {
    const { [key]: _old, ...rest } = value;
    onChange(next === undefined ? rest : { ...rest, [key]: next });
  };
  return <span className="nbase-image-controls" onKeyDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}>
    {choice('图片大小', value.width, sizes, next => set('width', next))}
    {choice('图片对齐', value.align === 'left' ? undefined : value.align, aligns, next => set('align', next))}
    <button type="button" onClick={onZoom}>放大</button>
    <input key={value.caption ?? ''} aria-label="图注" placeholder="添加图注" maxLength={attachmentCaptionMaxLength}
      defaultValue={value.caption ?? ''} onBlur={event => commitCaption(event.currentTarget)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) event.currentTarget.blur();
      }} />
  </span>;
}

/** Drag the corner to set the width as a share of the text column, snapped to 5%. */
export function ResizeHandle({ target, column, onResize }: {
  target: () => HTMLElement | null;
  column: () => HTMLElement | null;
  onResize: (width: number) => void;
}) {
  return <span className="nbase-image-resize" role="presentation" onPointerDown={event => {
    const element = target();
    const parent = column();
    if (!element || !parent) return;
    event.preventDefault();
    event.stopPropagation();
    const left = element.getBoundingClientRect().left;
    const total = parent.clientWidth || 1;
    let width: number | null = null;
    const onMove = (move: PointerEvent) => {
      const percent = Math.round((move.clientX - left) / total * 20) * 5;
      width = Math.max(attachmentWidthMin, Math.min(attachmentWidthMax, percent));
      element.style.width = width + '%';
      element.style.display = 'block';
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (width !== null) onResize(width);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }} />;
}

export function ImageLightbox({ source, alt, onClose }: { source: string; alt: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus(); };
  }, [onClose]);
  return createPortal(<div className="nbase-image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={onClose}>
    <button ref={close} type="button" aria-label="关闭预览" onClick={onClose}>×</button>
    <img src={source} alt={alt} onClick={event => event.stopPropagation()} />
  </div>, document.body);
}
