import type { WhiteboardArrowhead, WhiteboardConnectorMode, WhiteboardShapeKind, WhiteboardStrokeStyle } from '@nbase/contracts';
import { clamp, expandRect, type Point, type Rect } from './geometry';
import { History } from './history';
import { boundsOfIds, indexElements, noteColors, normalizeForSave, palette, type El } from './model';
import { emptyOverlay, type Background, type Overlay, type View } from './render/canvas';

export type Tool = 'select' | 'hand' | 'shape' | 'text' | 'note' | 'connector' | 'pen' | 'highlighter' | 'eraser' | 'frame' | 'mind';

export interface ToolStyle {
  shape: WhiteboardShapeKind; fill: string; stroke: string; strokeWidth: number; strokeStyle: WhiteboardStrokeStyle;
  noteColor: string; penColor: string; penWidth: number; highlighterColor: string; highlighterWidth: number;
  connectorMode: WhiteboardConnectorMode; endArrow: WhiteboardArrowhead;
}

export const defaultToolStyle: ToolStyle = {
  shape: 'rect', fill: '#ffffff', stroke: palette.ink, strokeWidth: 2, strokeStyle: 'solid', noteColor: noteColors[0]!,
  penColor: palette.ink, penWidth: 3, highlighterColor: '#ffe066', highlighterWidth: 18, connectorMode: 'elbow', endArrow: 'arrow',
};

export const minZoom = 0.05;
export const maxZoom = 8;

const emptySelection: ReadonlySet<string> = new Set();

/** Same elements in the same order; elements are immutable, so identity is equality. */
export function sameElements(a: readonly El[], b: readonly El[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Board state shared by the controller, the renderer and the React chrome. Write paths:
 * `preview` (during a gesture, nothing persisted), `commit` (one undo step from the gesture's start,
 * persisted) and `persistPreview` (typing: saved per keystroke, still one undo step when the edit ends).
 * View, selection and tool are never persisted.
 */
export class BoardStore {
  elements: El[];
  index: Map<string, El>;
  selection: ReadonlySet<string> = emptySelection;
  view: View = { x: 0, y: 0, zoom: 1 };
  size = { width: 0, height: 0 };
  tool: Tool = 'select';
  style: ToolStyle = { ...defaultToolStyle };
  editingId: string | null = null;
  /** The live page or database on the board that currently takes pointer and keyboard input. */
  activeEmbedId: string | null = null;
  background: Background = 'dots';
  minimap = false;
  overlay: Overlay = emptyOverlay;
  faded: ReadonlySet<string> = emptySelection;
  readOnly: boolean;
  /** Bumps on every change; React reads it through useSyncExternalStore. */
  version = 0;
  /** Bumps only when elements change, for consumers that ignore view changes. */
  contentVersion = 0;
  readonly history = new History<El[]>(200);
  private listeners = new Set<() => void>();
  private gestureBase: El[] | null = null;
  /** What the host last received (or loaded), so no-op commits never produce a save. */
  private persisted: El[];

  constructor(elements: El[], readOnly: boolean, private readonly onContent: (elements: El[]) => void) {
    this.elements = elements;
    this.persisted = elements;
    this.index = indexElements(elements);
    this.readOnly = readOnly;
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  emit() { this.version += 1; for (const listener of this.listeners) listener(); }

  private setElements(next: El[]) {
    if (next === this.elements) return;
    this.elements = next;
    this.index = indexElements(next);
    this.contentVersion += 1;
    // Drop selected ids that no longer exist.
    if ([...this.selection].some(id => !this.index.has(id))) this.selection = new Set([...this.selection].filter(id => this.index.has(id)));
    if (this.editingId && !this.index.has(this.editingId)) this.editingId = null;
    if (this.activeEmbedId && !this.index.has(this.activeEmbedId)) this.activeEmbedId = null;
  }

  /** Start a gesture: later previews and the commit are measured against this state. */
  begin() { if (!this.gestureBase) this.gestureBase = this.elements; }
  get inGesture() { return this.gestureBase !== null; }
  /** The state the running gesture started from, or the current state between gestures. */
  get base(): El[] { return this.gestureBase ?? this.elements; }

  preview(next: El[]) { this.setElements(next); this.emit(); }

  /** Persist the current or given elements as one undo step from the gesture base (or the current state). */
  commit(next: El[] = this.elements) {
    const base = this.gestureBase ?? this.elements;
    this.gestureBase = null;
    if (this.readOnly) { this.setElements(base); this.emit(); return; }
    if (sameElements(next, base)) {
      this.setElements(base);
      this.emit();
      // Live typing may have saved an intermediate state; bring the saved copy back to this one.
      if (!sameElements(base, this.persisted)) this.persist(base);
      return;
    }
    const normalized = normalizeForSave(next);
    this.history.push(base);
    this.setElements(normalized);
    this.emit();
    this.persist(normalized);
  }

  private persist(elements: El[]) {
    this.persisted = elements;
    this.onContent(elements);
  }

  /** Save the in-gesture state (text typing) without ending the gesture or adding undo steps. */
  persistPreview() {
    if (this.readOnly || sameElements(this.elements, this.persisted)) return;
    this.persist(normalizeForSave(this.elements));
  }

  /** Abandon the gesture and restore its starting state. */
  cancel() {
    if (this.gestureBase) this.setElements(this.gestureBase);
    this.gestureBase = null;
    this.overlay = emptyOverlay; this.faded = emptySelection;
    this.emit();
  }

  undo() { this.travel(this.history.undo(this.elements)); }
  redo() { this.travel(this.history.redo(this.elements)); }
  private travel(state: El[] | null) {
    if (!state || this.readOnly) return;
    this.editingId = null; this.activeEmbedId = null; this.gestureBase = null;
    this.setElements(state);
    this.emit();
    this.persist(state);
  }

  select(ids: Iterable<string>) {
    const next = new Set(ids);
    if (next.size === this.selection.size && [...next].every(id => this.selection.has(id))) return;
    this.selection = next.size ? next : emptySelection;
    this.emit();
  }

  setTool(tool: Tool) {
    if (this.readOnly && tool !== 'select' && tool !== 'hand') return;
    this.tool = tool;
    if (tool !== 'select') this.selection = emptySelection;
    this.overlay = emptyOverlay;
    this.emit();
  }

  setStyle(patch: Partial<ToolStyle>) { this.style = { ...this.style, ...patch }; this.emit(); }
  setOverlay(overlay: Overlay) { this.overlay = overlay; this.emit(); }

  // ── View ──

  setView(view: View) {
    this.view = { x: view.x, y: view.y, zoom: clamp(view.zoom, minZoom, maxZoom) };
    this.emit();
  }

  /** Zoom keeping the screen point under the cursor fixed. */
  zoomAt(screen: Point, zoom: number) {
    const next = clamp(zoom, minZoom, maxZoom);
    const world = { x: screen.x / this.view.zoom + this.view.x, y: screen.y / this.view.zoom + this.view.y };
    this.setView({ x: world.x - screen.x / next, y: world.y - screen.y / next, zoom: next });
  }

  zoomBy(factor: number) { this.zoomAt({ x: this.size.width / 2, y: this.size.height / 2 }, this.view.zoom * factor); }

  panBy(dx: number, dy: number) { this.setView({ ...this.view, x: this.view.x - dx / this.view.zoom, y: this.view.y - dy / this.view.zoom }); }

  viewFor(rect: Rect, padding = 48, max = 2): View {
    const { width, height } = this.size;
    const w = Math.max(rect.w, 1), h = Math.max(rect.h, 1);
    const zoom = clamp(Math.min((width - padding * 2) / w, (height - padding * 2) / h), minZoom, max);
    return { zoom, x: rect.x + w / 2 - width / 2 / zoom, y: rect.y + h / 2 - height / 2 / zoom };
  }

  fitTo(rect: Rect | null, padding = 48, max = 2) { if (rect) this.setView(this.viewFor(rect, padding, max)); }

  zoomToFit() {
    const bounds = boundsOfIds(this.elements.map(el => el.id), this.index);
    if (bounds) this.fitTo(expandRect(bounds, 0), 64, 1);
    else this.setView({ x: -this.size.width / 2, y: -this.size.height / 2, zoom: 1 });
  }

  zoomToSelection() { this.fitTo(boundsOfIds(this.selection, this.index), 80, 2); }

  resetZoom() { this.zoomAt({ x: this.size.width / 2, y: this.size.height / 2 }, 1); }

  /** World point at the centre of the viewport. */
  center(): Point { return { x: this.view.x + this.size.width / 2 / this.view.zoom, y: this.view.y + this.size.height / 2 / this.view.zoom }; }
}
