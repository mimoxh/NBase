import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { textColorIds, whiteboardLimits, type TextColorId } from '@nbase/contracts';
import type { Controller } from '../controller';
import { centerOf, type Rect } from '../geometry';
import { isMindNode } from '../mind';
import { connectorPath, notePadding, shapeTextBox, type El } from '../model';
import { connectorLabelPoint, toScreen, wrapped } from '../render/canvas';
import { noteInk, runColor, themed } from '../render/colors';
import type { Run, RunPatch } from '../runs';
import type { BoardStore } from '../store';
import { fontFamily, layoutText, lineHeightOf, type Measure } from '../text';
import { useBoard } from './Toolbar';

interface Placement { box: Rect; angle: number; area: Rect; fontSize: number; bold: boolean; align: 'left' | 'center' | 'right'; color: string; vertical: 'top' | 'middle'; autoWidth: boolean }

function placement(el: El, store: BoardStore, measure: Measure, dark: boolean): Placement | null {
  switch (el.type) {
    case 'text': return { box: el, angle: el.angle, area: { x: 0, y: 0, w: el.w, h: el.h }, fontSize: el.fontSize, bold: Boolean(el.bold), align: el.textAlign, color: themed(el.color, dark), vertical: 'top', autoWidth: true };
    case 'note': return { box: el, angle: el.angle, area: { x: notePadding, y: notePadding, w: el.w - notePadding * 2, h: el.h - notePadding * 2 }, fontSize: el.fontSize, bold: Boolean(el.bold), align: el.textAlign, color: noteInk(dark), vertical: 'top', autoWidth: false };
    case 'shape': return { box: el, angle: el.angle, area: shapeTextBox(el), fontSize: el.fontSize, bold: Boolean(el.bold), align: el.textAlign, color: themed(el.textColor, dark), vertical: 'middle', autoWidth: false };
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

// ── Styled editing surface ──────────────────────────────────────────────────
// Text that can carry styled runs is edited in a plain-text contenteditable whose spans mirror the
// runs, so what is typed looks like what the board draws. The DOM is rebuilt only when a style is
// applied, the editor opens or the zoom changes; typing never repaints it, which keeps IME input
// and the caret undisturbed.

/** The text a node shows; `<br>` is a line break. */
function rawText(root: Node): string {
  let out = '';
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += (child as Text).data;
      else if (child.nodeName === 'BR') out += '\n';
      else {
        if (child.nodeName === 'DIV' && out && !out.endsWith('\n')) out += '\n';
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/** A trailing `<br>` only makes an empty last line visible; it is not part of the text. */
const readText = (root: HTMLElement) => {
  const text = rawText(root);
  return text.endsWith('\n') && root.lastChild?.nodeName === 'BR' ? text.slice(0, -1) : text;
};

function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  try { range.setEnd(node, offset); } catch { return rawText(root).length; }
  return rawText(range.cloneContents()).length;
}

function selectionOffsets(root: HTMLElement): [number, number] | null {
  const selection = document.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  return [offsetOf(root, range.startContainer, range.startOffset), offsetOf(root, range.endContainer, range.endOffset)];
}

function positionAt(root: HTMLElement, target: number): [Node, number] {
  let count = 0;
  const visit = (node: Node): [Node, number] | null => {
    const children = [...node.childNodes];
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i]!;
      if (child.nodeType === Node.TEXT_NODE) {
        const length = (child as Text).data.length;
        if (target <= count + length) return [child, target - count];
        count += length;
      } else if (child.nodeName === 'BR') {
        if (target <= count) return [node, i];
        count += 1;
      } else {
        const found = visit(child);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(root) ?? [root, root.childNodes.length];
}

function select(root: HTMLElement, from: number, to: number) {
  const selection = document.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(...positionAt(root, from));
  range.setEnd(...positionAt(root, to));
  selection.removeAllRanges();
  selection.addRange(range);
}

function paint(root: HTMLElement, text: string, runs: readonly Run[] | undefined, zoom: number, dark: boolean) {
  root.replaceChildren();
  for (const run of runs?.length ? runs : text ? [{ text }] : []) {
    const span = document.createElement('span');
    span.textContent = run.text;
    if (run.bold !== undefined) span.style.fontWeight = run.bold ? '600' : '400';
    if (run.italic) span.style.fontStyle = 'italic';
    if (run.color) span.style.color = runColor(run.color, dark);
    if (run.fontSize) { span.style.fontSize = `${run.fontSize * zoom}px`; span.style.lineHeight = `${lineHeightOf(run.fontSize) * zoom}px`; }
    root.append(span);
  }
  if (!text || text.endsWith('\n')) root.append(document.createElement('br'));
}

const fontSizes = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80];
const colorNames: Record<TextColorId, string> = { gray: '灰色', brown: '棕色', orange: '橙色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色', pink: '粉色', red: '红色' };

/**
 * The DOM field that edits a board element in place. It mirrors the element's transform so the
 * caret sits where the text is drawn. Input during IME composition is applied only when it ends.
 */
export function TextEditor({ store, controller, measure }: { store: BoardStore; controller: Controller; measure: Measure }) {
  useBoard(store, s => s.editingId ? s.version : -1);
  const plainRef = useRef<HTMLTextAreaElement>(null);
  const richRef = useRef<HTMLDivElement>(null);
  const painted = useRef<{ id: string; zoom: number; dark: boolean } | null>(null);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [colors, setColors] = useState(false);
  const id = store.editingId;
  const el = id ? store.index.get(id) : undefined;
  const source = el ? controller.editingSource() : null;
  const styled = Boolean(source?.styled);
  const dark = document.documentElement.dataset.theme === 'dark';
  const zoom = store.view.zoom;

  useEffect(() => {
    const input = plainRef.current;
    if (!input || !id) return;
    input.value = controller.editingText();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    if (input.value) input.select();
  }, [id, controller, styled]);
  useLayoutEffect(() => {
    const input = plainRef.current;
    if (input) { input.style.height = '0px'; input.style.height = `${input.scrollHeight}px`; }
    const rich = richRef.current;
    const now = controller.editingSource();
    if (!rich || !id || !now?.styled) { painted.current = null; return; }
    const last = painted.current;
    if (last?.id === id && last.zoom === zoom && last.dark === dark) return;
    const keep = last?.id === id ? selectionOffsets(rich) : null;
    paint(rich, now.text, now.runs, zoom, dark);
    painted.current = { id, zoom, dark };
    if (keep) { select(rich, ...keep); return; }
    rich.focus({ preventScroll: true });
    select(rich, now.text ? 0 : 0, now.text.length);
    setRange([0, now.text.length]);
  });
  useEffect(() => {
    if (!styled) return;
    const track = () => { const rich = richRef.current; const at = rich && selectionOffsets(rich); if (at) setRange(at); };
    document.addEventListener('selectionchange', track);
    return () => document.removeEventListener('selectionchange', track);
  }, [styled]);
  useEffect(() => setColors(false), [id]);

  if (!el || !id || !source) return null;
  const place = placement(el, store, measure, dark);
  if (!place) return null;
  const topLeft = toScreen({ x: place.box.x, y: place.box.y }, store.view);
  const textHeight = styled ? Math.max(lineHeightOf(place.fontSize), layoutText(source, place.area.w, measure).height)
    : wrapped(controller.editingText() || ' ', place.area.w, place.fontSize, place.bold, measure).length * lineHeightOf(place.fontSize);
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
    const board = refocus ? (plainRef.current ?? richRef.current)?.closest<HTMLElement>('.wb-root') : null;
    controller.finishEditing(then);
    if (board && !store.editingId) board.focus({ preventScroll: true });
  };
  const mind = isMindNode(el);
  const single = el.type === 'frame' || el.type === 'connector' || mind;

  const applyTyped = (rich: HTMLDivElement) => {
    const typed = readText(rich);
    controller.editText(typed);
    const kept = controller.editingText();
    if (kept !== typed) {
      // The text was cut to the limit or cleaned of characters the board does not store.
      const at = selectionOffsets(rich);
      const now = controller.editingSource()!;
      paint(rich, now.text, now.runs, zoom, dark);
      const end = Math.min(at?.[1] ?? kept.length, kept.length);
      select(rich, end, end);
    } else if (typed.endsWith('\n') && rich.lastChild?.nodeName !== 'BR') rich.append(document.createElement('br'));
  };
  /** Style the selection, or the whole text when nothing is selected. */
  const style = (patch: RunPatch) => {
    const rich = richRef.current;
    if (!rich) return;
    const at = selectionOffsets(rich) ?? range;
    const [from, to] = at[0] === at[1] ? [0, source.text.length] : [Math.min(...at), Math.max(...at)];
    if (from === to) return;
    controller.styleText(from, to, patch);
    const now = controller.editingSource()!;
    paint(rich, now.text, now.runs, zoom, dark);
    select(rich, at[0], at[1]);
    setRange([at[0], at[1]]);
  };
  const [from, to] = range[0] === range[1] ? [0, source.text.length] : [Math.min(...range), Math.max(...range)];
  const shared = styled ? controller.editingStyle(from, to) : {};
  const bold = shared.bold ?? Boolean(source.bold);
  const italic = shared.italic ?? false;
  const size = shared.fontSize ?? source.fontSize;
  const step = (direction: 1 | -1) => {
    const next = direction > 0 ? fontSizes.find(value => value > size) ?? whiteboardLimits.maxFontSize : [...fontSizes].reverse().find(value => value < size) ?? whiteboardLimits.minFontSize;
    style({ fontSize: next });
  };
  const keep = (event: React.SyntheticEvent) => { event.preventDefault(); event.stopPropagation(); };
  const keyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    // Enter that confirms an IME candidate must never end the edit.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); finish(); return; }
    if (event.key === 'Tab') { event.preventDefault(); if (mind) finish('child'); return; }
    if (styled && (event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'b' || event.key === 'B' || event.key === 'i' || event.key === 'I')) {
      event.preventDefault();
      if (event.key.toLowerCase() === 'b') style({ bold: !bold }); else style({ italic: italic ? null : true });
      return;
    }
    if (event.key === 'Enter') {
      if ((single && !event.shiftKey) || event.ctrlKey || event.metaKey) { event.preventDefault(); finish(mind && !event.ctrlKey && !event.metaKey ? 'sibling' : 'none'); return; }
      if (styled) { event.preventDefault(); document.execCommand('insertText', false, '\n'); }
    }
  };
  const common = {
    spellCheck: false, 'aria-label': '编辑文字',
    onBlur: () => { if (store.editingId === id) finish('none', false); },
    onPaste: (event: React.ClipboardEvent) => event.stopPropagation(),
    onCopy: (event: React.ClipboardEvent) => event.stopPropagation(),
    onCut: (event: React.ClipboardEvent) => event.stopPropagation(),
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
  };
  const bar = styled ? (() => {
    const top = Math.max(8, Math.min(topLeft.y, toScreen({ x: place.box.x, y: place.box.y + place.box.h }, store.view).y) - 44);
    return <div className="wb-text-bar" style={{ left: Math.max(8, Math.min(topLeft.x, store.size.width - 240)), top }} role="toolbar" aria-label="文字样式"
      onPointerDown={keep} onMouseDown={keep}>
      <button type="button" className={`wb-text-btn${bold ? ' on' : ''}`} aria-pressed={bold} title="加粗 (Ctrl+B)" onClick={() => style({ bold: !bold })}><b>B</b></button>
      <button type="button" className={`wb-text-btn${italic ? ' on' : ''}`} aria-pressed={italic} title="斜体 (Ctrl+I)" onClick={() => style({ italic: italic ? null : true })}><i>I</i></button>
      <span className="wb-text-sep" />
      <button type="button" className="wb-text-btn" title="减小字号" onClick={() => step(-1)}>A−</button>
      <span className="wb-text-size" aria-label="字号">{Math.round(size)}</span>
      <button type="button" className="wb-text-btn" title="增大字号" onClick={() => step(1)}>A+</button>
      <span className="wb-text-sep" />
      <span className="wb-text-colors">
        <button type="button" className="wb-text-btn" title="文字颜色" aria-expanded={colors} onClick={() => setColors(open => !open)}>
          <span className="wb-tc" style={{ '--wb-swatch': shared.color ? runColor(shared.color, dark) : place.color } as CSSProperties}>A</span>
        </button>
        {colors && <span className="wb-pop wb-text-pop wb-swatches">
          <button type="button" className={`wb-swatch none${!shared.color ? ' on' : ''}`} title="默认颜色" aria-label="默认颜色" onClick={() => { style({ color: null }); setColors(false); }} />
          {textColorIds.map(color => <button key={color} type="button" className={`wb-swatch${shared.color === color ? ' on' : ''}`} title={colorNames[color]} aria-label={colorNames[color]}
            style={{ '--wb-swatch': runColor(color, dark) } as CSSProperties} onClick={() => { style({ color }); setColors(false); }} />)}
        </span>}
      </span>
      <span className="wb-text-hint">{range[0] === range[1] ? '作用于全部文字' : '作用于选中文字'}</span>
    </div>;
  })() : null;
  return <>
    <div className="wb-editor" style={wrapper}>
      {styled
        ? <div ref={richRef} className="wb-editor-field wb-editor-rich" style={field} contentEditable="plaintext-only" suppressContentEditableWarning role="textbox" aria-multiline={!single} {...common}
            onInput={event => { if (!(event.nativeEvent as InputEvent).isComposing) applyTyped(event.currentTarget); }}
            onCompositionEnd={event => applyTyped(event.currentTarget)}
            onKeyDown={keyDown} />
        : <textarea ref={plainRef} className="wb-editor-field" style={field} {...common}
            onInput={event => { if (!(event.nativeEvent as InputEvent).isComposing) controller.editText(event.currentTarget.value); }}
            onCompositionEnd={event => controller.editText(event.currentTarget.value)}
            onKeyDown={keyDown} />}
    </div>
    {bar}
  </>;
}
