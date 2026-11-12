import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { Controller } from '../controller';
import { centerOf, type Rect } from '../geometry';
import { isMindNode } from '../mind';
import { connectorPath, notePadding, shapeTextBox, type El } from '../model';
import { connectorLabelPoint, toScreen, wrapped } from '../render/canvas';
import { noteInk, themed } from '../render/colors';
import type { BoardStore } from '../store';
import { fontFamily, lineHeightOf, type Measure } from '../text';
import { useBoard } from './Toolbar';

interface Placement { box: Rect; angle: number; area: Rect; fontSize: number; bold: boolean; align: 'left' | 'center' | 'right'; color: string; vertical: 'top' | 'middle'; autoWidth: boolean }

function placement(el: El, store: BoardStore, measure: Measure): Placement | null {
  const dark = document.documentElement.dataset.theme === 'dark';
  switch (el.type) {
    case 'text': return { box: el, angle: el.angle, area: { x: 0, y: 0, w: el.w, h: el.h }, fontSize: el.fontSize, bold: Boolean(el.bold), align: el.textAlign, color: themed(el.color, dark), vertical: 'top', autoWidth: true };
    case 'note': return { box: el, angle: el.angle, area: { x: notePadding, y: notePadding, w: el.w - notePadding * 2, h: el.h - notePadding * 2 }, fontSize: el.fontSize, bold: false, align: el.textAlign, color: noteInk(dark), vertical: 'top', autoWidth: false };
    case 'shape': return { box: el, angle: el.angle, area: shapeTextBox(el), fontSize: el.fontSize, bold: false, align: el.textAlign, color: themed(el.textColor, dark), vertical: 'middle', autoWidth: false };
    case 'frame': {
      // Frame titles are a constant screen size, so the editor is laid out in world units divided by zoom.
      const z = store.view.zoom;
      return { box: { x: el.x, y: el.y - 22 / z, w: Math.max(el.w, 160 / z), h: 20 / z }, angle: 0, area: { x: 0, y: 0, w: Math.max(el.w, 160 / z), h: 20 / z }, fontSize: 12 / z, bold: true, align: 'left', color: 'var(--nb-text)', vertical: 'top', autoWidth: false };
    }
    case 'connector': {
      const at = connectorLabelPoint(connectorPath(el, store.index));
      const w = Math.max(80, ...el.text.split('\n').map(line => measure(line, 14, false) + 24));
      const h = lineHeightOf(14) * Math.max(1, el.text.split('\n').length) + 4;
      return { box: { x: at.x - w / 2, y: at.y - h / 2, w, h }, angle: 0, area: { x: 0, y: 0, w, h }, fontSize: 14, bold: false, align: 'center', color: themed('#1f2328', dark), vertical: 'middle', autoWidth: false };
    }
    default: return null;
  }
}

/**
 * The DOM textarea that edits a board element in place. It mirrors the element's transform so the
 * caret sits where the text is drawn. Input during IME composition is applied only when it ends.
 */
export function TextEditor({ store, controller, measure }: { store: BoardStore; controller: Controller; measure: Measure }) {
  useBoard(store);
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = store.editingId;
  const el = id ? store.index.get(id) : undefined;
  useEffect(() => {
    const input = ref.current;
    if (!input || !id) return;
    input.value = controller.editingText();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    if (input.value) input.select();
  }, [id, controller]);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${input.scrollHeight}px`;
  });
  if (!el || !id) return null;
  const place = placement(el, store, measure);
  if (!place) return null;
  const zoom = store.view.zoom;
  const topLeft = toScreen({ x: place.box.x, y: place.box.y }, store.view);
  const lines = wrapped(controller.editingText() || ' ', place.area.w, place.fontSize, place.bold, measure).length;
  const textHeight = lines * lineHeightOf(place.fontSize);
  const offsetY = place.vertical === 'middle' ? Math.max(0, (place.area.h - textHeight) / 2) : 0;
  const center = centerOf(place.box);
  const wrapper: CSSProperties = {
    left: topLeft.x, top: topLeft.y, width: place.box.w * zoom, height: place.box.h * zoom,
    transform: place.angle ? `rotate(${place.angle}rad)` : undefined,
    transformOrigin: `${(center.x - place.box.x) * zoom}px ${(center.y - place.box.y) * zoom}px`,
  };
  const field: CSSProperties = {
    left: place.area.x * zoom, top: (place.area.y + offsetY) * zoom,
    width: (place.area.w + (place.autoWidth ? place.fontSize * 2 : 0)) * zoom,
    font: `${place.bold ? '600 ' : ''}${place.fontSize * zoom}px ${fontFamily}`, lineHeight: `${lineHeightOf(place.fontSize) * zoom}px`,
    color: place.color, textAlign: place.align, whiteSpace: place.autoWidth ? 'pre' : 'pre-wrap',
  };
  const finish = (then: 'none' | 'sibling' | 'child' = 'none', refocus = true) => {
    // Keyboard finishes hand focus back to the board so shortcuts keep working; a blur went elsewhere on purpose.
    const board = refocus ? ref.current?.closest<HTMLElement>('.wb-root') : null;
    controller.finishEditing(then);
    if (board && !store.editingId) board.focus({ preventScroll: true });
  };
  const mind = isMindNode(el);
  return <div className="wb-editor" style={wrapper}>
    <textarea ref={ref} className="wb-editor-field" style={field} spellCheck={false} aria-label="编辑文字"
      onInput={event => { if (!(event.nativeEvent as InputEvent).isComposing) controller.editText(event.currentTarget.value); }}
      onCompositionEnd={event => controller.editText(event.currentTarget.value)}
      onBlur={() => { if (store.editingId === id) finish('none', false); }}
      onPaste={event => event.stopPropagation()}
      onCopy={event => event.stopPropagation()}
      onCut={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        // Enter that confirms an IME candidate must never end the edit.
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); finish(); return; }
        if (event.key === 'Tab') { event.preventDefault(); if (mind) finish('child'); return; }
        if (event.key === 'Enter') {
          const single = el.type === 'frame' || el.type === 'connector' || mind;
          if ((single && !event.shiftKey) || event.ctrlKey || event.metaKey) { event.preventDefault(); finish(mind && !event.ctrlKey && !event.metaKey ? 'sibling' : 'none'); }
        }
      }} />
  </div>;
}
