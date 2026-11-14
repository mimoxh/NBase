import { whiteboardLimits, type WhiteboardCard, type WhiteboardConnectorEnd, type WhiteboardDatabase, type WhiteboardImage, type WhiteboardNote, type WhiteboardShape,
  type WhiteboardText } from '@nbase/contracts';
import { aabb, boundsOfPoints, centerOf, distance, expandRect, normalizeRect, pointInRect, rectsIntersect, round, simplifyStroke, snapRect,
  toLocal, unionRects, type Box, type Point, type Rect, type SnapGuide } from './geometry';
import { addMindChild, createMindRoot, fitMindNode, isMindNode, layoutMindsOf } from './mind';
import { align, anchorPoint, applyStyle, boundsOfIds, cloneElements, connectorPath, createConnector, createShape, distribute, elementAt,
  elementBounds, elementText, embedDefaultSize, isEmbedElement, fitText, handlePoint, handles, hitTest, isBox, mindRootOf, movingSet, reorder, removeElements, resizeBox, rotateElements,
  scaleElements, setGroup, setLocked, translate, withBox, withGroups, type Alignment, type BoxEl, type Connector, type El, type Handle,
  type OrderMove, type StylePatch } from './model';
import { emptyOverlay, handleSize, rotateHandlePoint, toScreen, toWorldPoint, type Overlay } from './render/canvas';
import { BoardStore, type Tool } from './store';
import { textBlockSize, type Measure } from './text';

export interface ControllerHost {
  measure: Measure;
  newId: () => string;
  openPage: (pageId: string) => void;
  contextMenu: (screen: Point, targetId: string | null) => void;
  notice: (text: string) => void;
}

export interface PointerInput {
  x: number; y: number; button: number; pointerId: number; pointerType: string;
  shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean;
}

type Gesture =
  | { kind: 'pan'; last: Point }
  | { kind: 'pinch' ; start: { distance: number; center: Point; zoom: number; view: Point } }
  | { kind: 'marquee'; origin: Point; additive: ReadonlySet<string> | null }
  | { kind: 'move'; origin: Point; ids: Set<string>; moved: boolean; bounds: Rect | null; candidates: Rect[] }
  | { kind: 'resize'; handle: Handle; box: Box; ids: Set<string>; single: BoxEl | null }
  | { kind: 'rotate'; center: Point; start: number; box: Box; ids: Set<string> }
  | { kind: 'create'; tool: 'shape' | 'frame'; origin: Point; id: string; created: boolean }
  | { kind: 'connector'; id: string; origin: Point; sourceId: string | null }
  | { kind: 'endpoint'; id: string; which: 'source' | 'target' }
  | { kind: 'pen'; points: Point[] }
  | { kind: 'eraser'; points: Point[]; hits: Set<string> };

export type EditFinish = 'none' | 'sibling' | 'child';

const anchorSlots: [number, number][] = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
const snapCandidateLimit = 400;
const textMinWidth = 24;

/**
 * Turns pointer and keyboard input into board operations. All changes go through the store:
 * previews while a gesture runs and a single commit when it ends.
 */
export class Controller {
  private gesture: Gesture | null = null;
  private pointers = new Map<number, Point>();
  private spaceDown = false;
  private lastPointer: Point | null = null;
  private hoverId: string | null = null;
  /** Text elements whose width the user set; the others hug their longest line. */
  private fixedWidth = new Set<string>();

  constructor(readonly store: BoardStore, private readonly host: ControllerHost) {}

  get panning() { return this.gesture?.kind === 'pan' || this.spaceDown; }
  get pointer(): Point | null { return this.lastPointer; }

  private world(p: Point) { return toWorldPoint(p, this.store.view); }
  private tolerance(pixels = 5) { return pixels / this.store.view.zoom; }
  private get elements() { return this.store.elements; }
  private get index() { return this.store.index; }

  // ── Overlay ──

  /** Box that the transform handles act on, or null when the selection cannot be transformed. */
  transformBox(): { box: Box; single: BoxEl | null; ids: Set<string>; handles: boolean; rotate: boolean; locked: boolean } | null {
    const selected = [...this.store.selection].map(id => this.index.get(id)).filter((el): el is El => Boolean(el));
    const boxes = selected.filter(isBox);
    if (!boxes.length) return null;
    const locked = selected.every(el => el.locked);
    if (selected.length === 1 && boxes.length === 1) {
      const el = boxes[0]!;
      const mind = isMindNode(el);
      return { box: el, single: el, ids: new Set([el.id]), handles: !mind, rotate: !mind && el.type !== 'frame', locked };
    }
    const bounds = boundsOfIds(selected.map(el => el.id), this.index)!;
    return { box: { ...bounds, angle: 0 }, single: null, ids: new Set(selected.filter(el => !el.locked).map(el => el.id)),
      handles: true, rotate: !boxes.some(el => el.type === 'frame'), locked };
  }

  refreshOverlay(extra: Partial<Overlay> = {}) {
    const transform = this.store.editingId ? null : this.transformBox();
    const outlines: Box[] = [];
    const connectorEnds: Point[] = [];
    if (this.store.selection.size > 1 || transform === null) {
      for (const id of this.store.selection) {
        const el = this.index.get(id);
        if (el && isBox(el)) outlines.push(el);
      }
    }
    if (this.store.selection.size === 1 && !this.store.editingId) {
      const el = this.index.get([...this.store.selection][0]!);
      if (el?.type === 'connector') {
        const path = connectorPath(el, this.index).points;
        if (!el.locked && !this.store.readOnly) connectorEnds.push(path[0]!, path.at(-1)!);
      }
    }
    const hover = this.hoverId && !this.store.selection.has(this.hoverId) ? this.index.get(this.hoverId) : undefined;
    this.store.setOverlay({ ...emptyOverlay, outlines, connectorEnds,
      transform: transform && { box: transform.box, handles: transform.handles && !this.store.readOnly, rotate: transform.rotate && !this.store.readOnly, locked: transform.locked },
      hover: hover && isBox(hover) ? hover : null, ...extra });
  }

  // ── Hit testing on chrome ──

  private handleAt(screen: Point): Handle | 'rotate' | null {
    const t = this.transformBox();
    if (!t || t.locked || this.store.readOnly) return null;
    const view = this.store.view;
    if (t.rotate && distance(screen, rotateHandlePoint(t.box, view)) <= 9) return 'rotate';
    if (!t.handles) return null;
    // Small boxes only offer corner handles so their edges stay grabbable.
    const tiny = t.box.w * view.zoom < 28 || t.box.h * view.zoom < 28;
    for (const handle of handles) {
      if (tiny && handle.length === 1) continue;
      const p = toScreen(handlePoint(t.box, handle), view);
      if (Math.abs(p.x - screen.x) <= handleSize && Math.abs(p.y - screen.y) <= handleSize) return handle;
    }
    return null;
  }

  cursorAt(screen: Point): string {
    if (this.panning) return this.gesture?.kind === 'pan' ? 'grabbing' : 'grab';
    const tool = this.store.tool;
    if (tool === 'hand') return 'grab';
    if (tool === 'pen' || tool === 'highlighter' || tool === 'shape' || tool === 'frame' || tool === 'connector' || tool === 'mind' || tool === 'note') return 'crosshair';
    if (tool === 'text') return 'text';
    if (tool === 'eraser') return 'cell';
    const handle = this.handleAt(screen);
    if (handle === 'rotate') return 'grab';
    if (handle) {
      const angle = (this.transformBox()?.box.angle ?? 0) * 180 / Math.PI;
      const base = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }[handle] + angle;
      const cursors = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
      return cursors[Math.round((((base % 180) + 180) % 180) / 45) % 4]!;
    }
    if (this.endpointAt(screen)) return 'move';
    const hit = this.hit(this.world(screen));
    if (hit?.type === 'card') return 'pointer';
    return hit && !hit.locked && !this.store.readOnly ? 'move' : 'default';
  }

  private hit(world: Point): El | null {
    return elementAt(this.elements, world, this.tolerance(), this.index);
  }

  private endpointAt(screen: Point): 'source' | 'target' | null {
    if (this.store.selection.size !== 1 || this.store.readOnly) return null;
    const el = this.index.get([...this.store.selection][0]!);
    if (el?.type !== 'connector' || el.locked) return null;
    const path = connectorPath(el, this.index).points;
    if (distance(toScreen(path[0]!, this.store.view), screen) <= 9) return 'source';
    if (distance(toScreen(path.at(-1)!, this.store.view), screen) <= 9) return 'target';
    return null;
  }

  // ── Connector binding ──

  /** Element and anchor a connector end would bind to at this world point. */
  private bindingAt(world: Point, exclude: ReadonlySet<string>): { end: WhiteboardConnectorEnd; box: BoxEl | null; anchor: Point | null } {
    const target = elementAt(this.elements, world, this.tolerance(8), this.index, el => isBox(el) && !exclude.has(el.id));
    const free = { end: { x: round(world.x), y: round(world.y) }, box: null, anchor: null };
    if (!target || !isBox(target)) return free;
    for (const [ax, ay] of anchorSlots) {
      const point = anchorPoint(target, ax, ay);
      if (distance(point, world) <= this.tolerance(14)) return { end: { ...point, bind: { elementId: target.id, ax, ay } }, box: target, anchor: point };
    }
    return { end: { x: world.x, y: world.y, bind: { elementId: target.id, ax: 0.5, ay: 0.5 } }, box: target, anchor: null };
  }

  private anchorOverlay(box: BoxEl | null, active: Point | null): Overlay['anchors'] {
    return box ? { box, points: anchorSlots.map(([ax, ay]) => anchorPoint(box, ax, ay)), active } : null;
  }

  // ── Pointer events ──

  pointerDown(input: PointerInput) {
    const screen = { x: input.x, y: input.y };
    this.pointers.set(input.pointerId, screen);
    this.lastPointer = screen;
    if (this.store.editingId) this.finishEditing();
    if (this.store.activeEmbedId) this.deactivateEmbed();
    if (input.pointerType === 'touch' && this.pointers.size === 2) {
      // A second finger turns whatever started into a pinch.
      if (this.gesture && this.gesture.kind !== 'pan') this.store.cancel();
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      this.gesture = { kind: 'pinch', start: { distance: Math.max(1, distance(a, b)), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        zoom: this.store.view.zoom, view: { x: this.store.view.x, y: this.store.view.y } } };
      return;
    }
    if (this.gesture) return;
    const world = this.world(screen);
    const tool = this.store.tool;
    if (input.button === 1 || this.spaceDown || tool === 'hand' || (input.button === 0 && tool === 'select' && input.pointerType === 'touch' && !this.hit(world))) {
      this.gesture = { kind: 'pan', last: screen };
      return;
    }
    if (input.button !== 0) return;
    if (this.store.readOnly && tool !== 'select') return;
    switch (tool) {
      case 'select': return this.downSelect(input, screen, world);
      case 'shape': case 'frame':
        this.store.begin();
        this.gesture = { kind: 'create', tool, origin: world, id: this.host.newId(), created: false };
        return;
      case 'text': return this.createText(world);
      case 'note': return this.createNote(world);
      case 'mind': return this.createMind(world);
      case 'connector': return this.startConnector(world);
      case 'pen': case 'highlighter':
        this.gesture = { kind: 'pen', points: [world] };
        this.refreshOverlay({ draft: this.draft([world]) });
        return;
      case 'eraser':
        this.store.begin();
        this.gesture = { kind: 'eraser', points: [world], hits: new Set() };
        this.erase(world, world);
        return;
    }
  }

  private draft(points: Point[]): Overlay['draft'] {
    const highlighter = this.store.tool === 'highlighter';
    const style = this.store.style;
    return { points, color: highlighter ? style.highlighterColor : style.penColor, width: highlighter ? style.highlighterWidth : style.penWidth, highlighter };
  }

  private downSelect(input: PointerInput, screen: Point, world: Point) {
    const handle = this.handleAt(screen);
    const transform = this.transformBox();
    if (handle && transform) {
      this.store.begin();
      if (handle === 'rotate') {
        const center = centerOf(transform.box);
        this.gesture = { kind: 'rotate', center, start: Math.atan2(world.y - center.y, world.x - center.x), box: transform.box, ids: movingSet(this.elements, transform.ids, this.index) };
      } else {
        this.gesture = { kind: 'resize', handle, box: transform.box, ids: transform.single ? new Set([transform.single.id]) : movingSet(this.elements, transform.ids, this.index), single: transform.single };
      }
      return;
    }
    const endpoint = this.endpointAt(screen);
    if (endpoint) {
      this.store.begin();
      this.gesture = { kind: 'endpoint', id: [...this.store.selection][0]!, which: endpoint };
      return;
    }
    // Inside the current multi-selection box, a drag moves the selection even between elements.
    let hit = this.hit(world);
    if (!hit && transform && this.store.selection.size > 1 && pointInRect(world, transform.box)) hit = this.index.get([...this.store.selection][0]!) ?? null;
    if (!hit) {
      this.gesture = { kind: 'marquee', origin: world, additive: input.shiftKey ? this.store.selection : null };
      if (!input.shiftKey) this.store.select([]);
      this.refreshOverlay();
      return;
    }
    const unit = withGroups(this.elements, new Set([hit.id]));
    if (input.shiftKey) {
      const next = new Set(this.store.selection);
      const remove = [...unit].every(id => next.has(id));
      for (const id of unit) { if (remove) next.delete(id); else next.add(id); }
      this.store.select(next);
    } else if (!this.store.selection.has(hit.id)) this.store.select(unit);
    this.refreshOverlay();
    if (this.store.readOnly) return;
    let ids = movingSet(this.elements, new Set([...this.store.selection].filter(id => !this.index.get(id)?.locked)), this.index);
    if (!ids.size) return;
    this.store.begin();
    if (input.altKey) ids = this.duplicateForDrag(ids);
    const bounds = boundsOfIds(ids, this.index);
    this.gesture = { kind: 'move', origin: world, ids, moved: false, bounds, candidates: this.snapCandidates(ids) };
  }

  /** Alt-drag: leave the originals in place and drag fresh copies. */
  private duplicateForDrag(ids: Set<string>): Set<string> {
    const source = this.elements.filter(el => ids.has(el.id));
    const copies = cloneElements(source, this.index, { x: 0, y: 0 }, this.host.newId);
    this.store.preview([...this.elements, ...copies]);
    const next = new Set(copies.map(el => el.id));
    this.store.select(next);
    return next;
  }

  private snapCandidates(moving: ReadonlySet<string>): Rect[] {
    const view = this.store.view;
    const visible = expandRect({ x: view.x, y: view.y, w: this.store.size.width / view.zoom, h: this.store.size.height / view.zoom }, 200 / view.zoom);
    const rects: Rect[] = [];
    for (const el of this.elements) {
      if (moving.has(el.id) || el.type === 'connector' || el.type === 'pen') continue;
      const rect = aabb(el);
      if (rectsIntersect(visible, rect)) rects.push(rect);
      if (rects.length >= snapCandidateLimit) break;
    }
    return rects;
  }

  pointerMove(input: PointerInput) {
    const screen = { x: input.x, y: input.y };
    const previous = this.pointers.get(input.pointerId);
    if (previous) this.pointers.set(input.pointerId, screen);
    this.lastPointer = screen;
    const world = this.world(screen);
    const gesture = this.gesture;
    if (!gesture) return this.hover(world);
    switch (gesture.kind) {
      case 'pan':
        this.store.panBy(screen.x - gesture.last.x, screen.y - gesture.last.y);
        gesture.last = screen;
        return;
      case 'pinch': {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()] as [Point, Point];
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const zoom = gesture.start.zoom * distance(a, b) / gesture.start.distance;
        const anchor = { x: gesture.start.center.x / gesture.start.zoom + gesture.start.view.x, y: gesture.start.center.y / gesture.start.zoom + gesture.start.view.y };
        this.store.setView({ x: anchor.x - center.x / zoom, y: anchor.y - center.y / zoom, zoom });
        return;
      }
      case 'marquee': {
        const rect = normalizeRect(gesture.origin, world);
        const touched = this.elements.filter(el => {
          const b = elementBounds(el, this.index);
          // Frames are selected only when fully enclosed, everything else when touched.
          return el.type === 'frame' ? b.x >= rect.x && b.y >= rect.y && b.x + b.w <= rect.x + rect.w && b.y + b.h <= rect.y + rect.h : rectsIntersect(rect, b);
        }).map(el => el.id);
        this.store.select(withGroups(this.elements, new Set([...(gesture.additive ?? []), ...touched])));
        this.refreshOverlay({ marquee: rect });
        return;
      }
      case 'move': return this.moveSelection(gesture, world, input);
      case 'resize': return this.resize(gesture, world, input);
      case 'rotate': {
        let delta = Math.atan2(world.y - gesture.center.y, world.x - gesture.center.x) - gesture.start;
        if (input.shiftKey) {
          const step = Math.PI / 12;
          delta = Math.round((gesture.box.angle + delta) / step) * step - gesture.box.angle;
        }
        const base = this.baseElements();
        this.store.preview(rotateElements(base, gesture.ids, gesture.center, delta));
        const box = { ...gesture.box, angle: gesture.box.angle + delta };
        this.refreshOverlay(gesture.ids.size > 1 || this.store.selection.size > 1 ? { transform: { box, handles: false, rotate: true, locked: false } } : {});
        return;
      }
      case 'create': {
        const rect = normalizeRect(gesture.origin, input.shiftKey ? this.square(gesture.origin, world) : world);
        if (!gesture.created && rect.w * this.store.view.zoom < 4 && rect.h * this.store.view.zoom < 4) return;
        gesture.created = true;
        const el = gesture.tool === 'frame' ? this.frame(gesture.id, rect) : createShape(gesture.id, rect, this.store.style);
        const base = this.baseElements();
        this.store.preview(gesture.tool === 'frame' ? [el, ...base] : [...base, el]);
        this.store.select([gesture.id]);
        this.refreshOverlay();
        return;
      }
      case 'connector': case 'endpoint': return this.dragConnectorEnd(gesture, world);
      case 'pen': {
        const last = gesture.points.at(-1)!;
        if (distance(last, world) * this.store.view.zoom >= 1.5) gesture.points.push(world);
        this.refreshOverlay({ draft: this.draft(gesture.points) });
        return;
      }
      case 'eraser': {
        const last = gesture.points.at(-1)!;
        gesture.points.push(world);
        if (gesture.points.length > 40) gesture.points.shift();
        this.erase(last, world);
        return;
      }
    }
  }

  private square(origin: Point, world: Point): Point {
    const size = Math.max(Math.abs(world.x - origin.x), Math.abs(world.y - origin.y));
    return { x: origin.x + Math.sign(world.x - origin.x || 1) * size, y: origin.y + Math.sign(world.y - origin.y || 1) * size };
  }

  private frame(id: string, rect: Rect): El {
    const count = this.elements.filter(el => el.type === 'frame').length;
    return { id, type: 'frame', x: rect.x, y: rect.y, w: rect.w, h: rect.h, angle: 0, name: `框架 ${count + 1}` };
  }

  private baseElements(): El[] { return this.store.base; }

  private hover(world: Point) {
    const tool = this.store.tool;
    if (tool === 'connector') {
      const binding = this.bindingAt(world, new Set());
      this.refreshOverlay({ anchors: this.anchorOverlay(binding.box, binding.anchor) });
      return;
    }
    if (tool !== 'select') { if (this.store.overlay !== emptyOverlay && !this.store.selection.size) this.store.setOverlay(emptyOverlay); return; }
    const hit = this.hit(world);
    const id = hit?.id ?? null;
    if (id !== this.hoverId) { this.hoverId = id; this.refreshOverlay(); }
  }

  private moveSelection(gesture: Extract<Gesture, { kind: 'move' }>, world: Point, input: PointerInput) {
    let dx = world.x - gesture.origin.x, dy = world.y - gesture.origin.y;
    if (!gesture.moved && Math.hypot(dx, dy) * this.store.view.zoom < 3) return;
    gesture.moved = true;
    if (input.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    let guides: SnapGuide[] = [];
    if (gesture.bounds && !(input.ctrlKey || input.metaKey)) {
      const moved = { ...gesture.bounds, x: gesture.bounds.x + dx, y: gesture.bounds.y + dy };
      const snap = snapRect(moved, gesture.candidates, this.tolerance(6));
      dx += snap.dx; dy += snap.dy; guides = snap.guides;
    }
    this.store.preview(translate(this.baseElements(), gesture.ids, dx, dy));
    this.refreshOverlay({ guides });
  }

  private resize(gesture: Extract<Gesture, { kind: 'resize' }>, world: Point, input: PointerInput) {
    const single = gesture.single;
    const keepRatio = input.shiftKey !== (single?.type === 'image' || (single?.type === 'text' && gesture.handle.length === 2));
    const box = resizeBox(gesture.box, gesture.handle, world, keepRatio, input.altKey);
    const base = this.baseElements();
    if (!single) {
      this.store.preview(scaleElements(base, gesture.ids, gesture.box, box));
      this.refreshOverlay();
      return;
    }
    let next: BoxEl = withBox(single, box);
    const measure = this.host.measure;
    if (next.type === 'text') {
      if (gesture.handle.length === 2) {
        // Corner drags scale the type; edge drags change the wrapping width.
        const fontSize = Math.min(whiteboardLimits.maxFontSize, Math.max(whiteboardLimits.minFontSize, round(single.type === 'text' ? single.fontSize * box.w / Math.max(1, gesture.box.w) : 16, 1)));
        next = { ...next, fontSize };
      } else this.fixedWidth.add(next.id);
      next = fitText({ ...next, w: Math.max(textMinWidth, next.w) }, measure);
    } else if (next.type === 'note' || next.type === 'shape') {
      const fitted = fitText({ ...next, h: 0 }, measure);
      if (fitted.h > next.h) next = { ...next, h: fitted.h };
    }
    this.store.preview(base.map(el => el.id === single.id ? next : el));
    this.refreshOverlay();
  }

  private startConnector(world: Point) {
    const binding = this.bindingAt(world, new Set());
    const style = this.store.style;
    const connector = createConnector(this.host.newId(), binding.end, { x: world.x, y: world.y }, { mode: style.connectorMode, stroke: style.stroke,
      strokeWidth: style.strokeWidth, strokeStyle: style.strokeStyle, endArrow: style.endArrow });
    this.store.begin();
    this.store.preview([...this.elements, connector]);
    this.gesture = { kind: 'connector', id: connector.id, origin: world, sourceId: binding.box?.id ?? null };
  }

  private dragConnectorEnd(gesture: Extract<Gesture, { kind: 'connector' | 'endpoint' }>, world: Point) {
    const which = gesture.kind === 'connector' ? 'target' : gesture.which;
    const connector = this.index.get(gesture.id);
    if (connector?.type !== 'connector') return;
    const otherEnd = which === 'target' ? connector.source : connector.target;
    // Never bind both ends to the same element.
    const exclude = new Set([gesture.id, ...(otherEnd.bind ? [otherEnd.bind.elementId] : [])]);
    const binding = this.bindingAt(world, exclude);
    const next: Connector = { ...connector, [which]: binding.end };
    this.store.preview(this.elements.map(el => el.id === connector.id ? next : el));
    this.refreshOverlay({ anchors: this.anchorOverlay(binding.box, binding.anchor) });
  }

  private erase(from: Point, to: Point) {
    const gesture = this.gesture;
    if (gesture?.kind !== 'eraser') return;
    const steps = Math.max(1, Math.ceil(distance(from, to) / this.tolerance(4)));
    for (let i = 0; i <= steps; i += 1) {
      const p = { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps };
      for (const el of this.elements) {
        if (gesture.hits.has(el.id) || el.locked) continue;
        if (hitTest(el, p, this.tolerance(6), this.index)) gesture.hits.add(el.id);
      }
    }
    this.store.faded = new Set(gesture.hits);
    this.refreshOverlay({ eraser: gesture.points });
  }

  pointerUp(input: PointerInput) {
    this.pointers.delete(input.pointerId);
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === 'pinch') { if (this.pointers.size < 2) this.gesture = null; return; }
    this.gesture = null;
    const world = this.world({ x: input.x, y: input.y });
    switch (gesture.kind) {
      case 'pan': return;
      case 'marquee': this.refreshOverlay(); return;
      case 'move':
        if (!gesture.moved && !input.shiftKey && !input.altKey) {
          // A click without a drag narrows a multi-selection to the clicked unit.
          const hit = this.hit(world);
          if (hit && this.store.selection.size > 1) this.store.select(withGroups(this.elements, new Set([hit.id])));
        }
        this.store.commit();
        this.refreshOverlay();
        return;
      case 'resize': case 'rotate': case 'endpoint':
        this.store.commit();
        this.refreshOverlay();
        return;
      case 'create': {
        if (!gesture.created) {
          const rect = gesture.tool === 'frame' ? { x: world.x - 480, y: world.y - 270, w: 960, h: 540 } : { x: world.x - 60, y: world.y - 40, w: 120, h: 80 };
          const el = gesture.tool === 'frame' ? this.frame(gesture.id, rect) : createShape(gesture.id, rect, this.store.style);
          this.store.preview(gesture.tool === 'frame' ? [el, ...this.elements] : [...this.elements, el]);
        }
        this.store.commit();
        this.store.setTool('select');
        this.store.select([gesture.id]);
        this.refreshOverlay();
        return;
      }
      case 'connector': {
        const connector = this.index.get(gesture.id);
        const short = connector?.type === 'connector' && !connector.target.bind && distance(gesture.origin, world) * this.store.view.zoom < 10;
        if (!connector || short) { this.store.cancel(); this.refreshOverlay(); return; }
        this.store.commit();
        this.store.setTool('select');
        this.store.select([gesture.id]);
        this.refreshOverlay();
        return;
      }
      case 'pen': return this.finishStroke(gesture.points);
      case 'eraser': {
        const hits = gesture.hits;
        this.store.faded = new Set();
        if (hits.size) this.store.commit(removeElements(this.baseElements(), hits, this.index)); else this.store.cancel();
        this.refreshOverlay();
        return;
      }
    }
  }

  pointerCancel(input: PointerInput) {
    this.pointers.delete(input.pointerId);
    if (this.gesture && this.gesture.kind !== 'pan' && this.gesture.kind !== 'pinch') this.store.cancel();
    this.gesture = null;
    this.refreshOverlay();
  }

  private finishStroke(points: Point[]) {
    const highlighter = this.store.tool === 'highlighter';
    const style = this.store.style;
    const flat = simplifyStroke(points.flatMap(p => [p.x, p.y]), 0.6 / this.store.view.zoom);
    // Very long strokes are thinned evenly to stay within the stored point limit.
    const limit = whiteboardLimits.maxPenNumbers / 2;
    const pairs: Point[] = [];
    for (let i = 0; i < flat.length; i += 2) pairs.push({ x: flat[i]!, y: flat[i + 1]! });
    const kept = pairs.length > limit ? pairs.filter((_, i) => i % Math.ceil(pairs.length / limit) === 0) : pairs;
    const bounds = boundsOfPoints(kept);
    const el: El = { id: this.host.newId(), type: 'pen', x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, angle: 0,
      points: kept.flatMap(p => [round(p.x - bounds.x), round(p.y - bounds.y)]),
      color: highlighter ? style.highlighterColor : style.penColor, strokeWidth: highlighter ? style.highlighterWidth : style.penWidth,
      ...(highlighter ? { highlighter: true } : {}) };
    this.store.commit([...this.elements, el]);
    this.refreshOverlay();
  }

  // ── Creation helpers ──

  private createText(world: Point) {
    const id = this.host.newId();
    const el: WhiteboardText = { id, type: 'text', x: world.x, y: world.y - 12, w: textMinWidth, h: 22, angle: 0, text: '',
      color: this.store.style.stroke === '#ffffff' ? '#1f2328' : this.store.style.stroke, fontSize: 20, textAlign: 'left' };
    this.store.begin();
    this.store.preview([...this.elements, el]);
    this.store.setTool('select');
    this.startEditing(id);
  }

  private createNote(world: Point) {
    const id = this.host.newId();
    const el: WhiteboardNote = { id, type: 'note', x: world.x - 110, y: world.y - 60, w: 220, h: 120, angle: 0, text: '',
      color: this.store.style.noteColor, fontSize: 16, textAlign: 'left' };
    this.store.begin();
    this.store.preview([...this.elements, el]);
    this.store.setTool('select');
    this.startEditing(id);
  }

  private createMind(world: Point) {
    const root = createMindRoot(this.host.newId(), world.x, world.y, '中心主题', this.host.measure);
    this.store.commit([...this.elements, root]);
    this.store.setTool('select');
    this.store.select([root.id]);
    this.refreshOverlay();
  }

  /** Add a mind-map node next to the selected one and start typing into it. */
  addMindNode(relation: 'child' | 'sibling') {
    if (this.store.readOnly || this.store.selection.size !== 1) return false;
    const node = this.index.get([...this.store.selection][0]!);
    if (!isMindNode(node)) return false;
    const parentId = relation === 'sibling' && node.mindParentId ? node.mindParentId : node.id;
    const id = this.host.newId();
    this.store.begin();
    this.store.preview(addMindChild(this.elements, parentId, id, this.host.measure, relation === 'sibling' && node.mindParentId ? node.id : undefined));
    this.startEditing(id);
    return true;
  }

  // ── Text editing ──

  canEdit(el: El | undefined): boolean {
    return Boolean(el) && !this.store.readOnly && !el!.locked && el!.type !== 'image' && el!.type !== 'pen' && el!.type !== 'card' && el!.type !== 'database';
  }

  startEditing(id: string) {
    const el = this.index.get(id);
    if (!this.canEdit(el)) return;
    this.store.begin();
    if (el!.type === 'text') {
      const natural = textBlockSize(el!.text, Infinity, el!.fontSize, Boolean(el!.bold), this.host.measure).width + 2;
      if (el!.text && Math.abs(natural - el!.w) > 2 && el!.w > natural) this.fixedWidth.add(id);
    }
    this.store.editingId = id;
    this.store.select([id]);
    this.hoverId = null;
    this.refreshOverlay();
  }

  editingText(): string {
    const el = this.store.editingId ? this.index.get(this.store.editingId) : undefined;
    if (!el) return '';
    return elementText(el);
  }

  /** Apply typed text to the element being edited; saved immediately, undone as one step. */
  editText(value: string) {
    const id = this.store.editingId;
    const el = id ? this.index.get(id) : undefined;
    if (!el || !id) return;
    const limit = el.type === 'frame' ? whiteboardLimits.maxName : el.type === 'connector' ? whiteboardLimits.maxLabel : whiteboardLimits.maxText;
    // Control characters are rejected by the server; tabs become spaces.
    const text = value.replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit);
    let next: El;
    if (el.type === 'frame') next = { ...el, name: text.replace(/\n/g, ' ') };
    else if (el.type === 'connector') next = { ...el, text };
    else if (el.type === 'text') next = fitText({ ...el, text }, this.host.measure, !this.fixedWidth.has(id));
    else if (el.type === 'shape') next = el.mindParentId !== undefined ? fitMindNode({ ...el, text }, this.host.measure) : fitText({ ...el, text }, this.host.measure);
    else if (el.type === 'note') next = fitText({ ...el, text }, this.host.measure);
    else return;
    let elements = this.elements.map(item => item.id === id ? next : item);
    if (isMindNode(next)) elements = layoutMindsOf(elements, [id]);
    this.store.preview(elements);
    this.store.persistPreview();
    this.refreshOverlay();
  }

  finishEditing(then: EditFinish = 'none') {
    const id = this.store.editingId;
    if (!id) return;
    this.store.editingId = null;
    const el = this.index.get(id);
    let elements = this.elements;
    // Empty free text disappears, like any canvas editor.
    if (el?.type === 'text' && !el.text.trim()) { elements = removeElements(elements, new Set([id]), this.index); this.store.select([]); }
    this.store.commit(elements);
    this.refreshOverlay();
    if (then !== 'none' && el && isMindNode(el)) this.addMindNode(then === 'child' || !el.mindParentId ? 'child' : 'sibling');
  }

  openCard(id: string) {
    const el = this.index.get(id);
    if (el?.type === 'card') this.host.openPage(el.pageId);
    else if (el?.type === 'database') this.host.openPage(el.databaseId);
  }

  // ── Live pages and databases ──

  /** Hands pointer and keyboard input to a live page or database until it is deactivated. */
  activateEmbed(id: string) {
    if (!isEmbedElement(this.index.get(id))) return;
    if (this.store.editingId) this.finishEditing();
    this.store.activeEmbedId = id;
    this.store.select([id]);
    this.hoverId = null;
    this.refreshOverlay();
  }

  deactivateEmbed() {
    if (!this.store.activeEmbedId) return;
    this.store.activeEmbedId = null;
    this.refreshOverlay();
  }

  /** Switches a page card between the title chip and the live preview, giving the preview room to read. */
  setCardView(id: string, view: 'chip' | 'preview') {
    const el = this.index.get(id);
    if (el?.type !== 'card' || el.locked) return;
    const { view: _view, ...rest } = el;
    void _view;
    const next: WhiteboardCard = view === 'preview'
      ? { ...rest, view: 'preview', w: Math.max(el.w, embedDefaultSize.card.w), h: Math.max(el.h, embedDefaultSize.card.h) }
      : { ...rest, w: embedDefaultSize.chip.w, h: embedDefaultSize.chip.h };
    if (this.store.activeEmbedId === id) this.store.activeEmbedId = null;
    this.apply(this.elements.map(item => item.id === id ? next : item));
  }

  setDatabaseView(id: string, viewId: string) {
    const el = this.index.get(id);
    if (el?.type !== 'database' || el.viewId === viewId.toLowerCase()) return;
    this.apply(this.elements.map(item => item.id === id ? { ...el, viewId: viewId.toLowerCase() } : item));
  }

  setHeight(id: string, height: number) {
    const el = this.index.get(id);
    if (!el || !isBox(el) || el.locked) return;
    const h = round(Math.min(whiteboardLimits.maxSize, Math.max(120, height)));
    if (h !== el.h) this.apply(this.elements.map(item => item.id === id ? { ...el, h } : item));
  }

  databaseElement(page: { id: string }): WhiteboardDatabase {
    return { id: this.host.newId(), type: 'database', x: 0, y: 0, ...embedDefaultSize.database, angle: 0, databaseId: page.id.toLowerCase() };
  }

  doubleClick(screen: Point) {
    const world = this.world(screen);
    const hit = this.hit(world) ?? this.frameTitleAt(screen);
    if (hit && isEmbedElement(hit)) { this.activateEmbed(hit.id); return; }
    if (hit?.type === 'card') { this.host.openPage(hit.pageId); return; }
    if (this.store.readOnly) return;
    if (hit && this.canEdit(hit)) { this.startEditing(hit.id); return; }
    if (!hit && this.store.tool === 'select') this.createText(world);
  }

  private frameTitleAt(screen: Point): El | null {
    const view = this.store.view;
    for (let i = this.elements.length - 1; i >= 0; i -= 1) {
      const el = this.elements[i]!;
      if (el.type !== 'frame') continue;
      const p = toScreen({ x: el.x, y: el.y }, view);
      if (screen.x >= p.x && screen.x <= p.x + Math.max(60, el.w * view.zoom) && screen.y >= p.y - 20 && screen.y <= p.y) return el;
    }
    return null;
  }

  contextMenu(screen: Point) {
    const hit = this.hit(this.world(screen)) ?? this.frameTitleAt(screen);
    if (hit && !this.store.selection.has(hit.id)) this.store.select(withGroups(this.elements, new Set([hit.id])));
    if (!hit) this.store.select([]);
    this.refreshOverlay();
    this.host.contextMenu(screen, hit?.id ?? null);
  }

  // ── Wheel and keyboard ──

  wheel(screen: Point, deltaX: number, deltaY: number, deltaMode: number, zoomKey: boolean, shiftKey: boolean) {
    const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? this.store.size.height : 1;
    if (zoomKey) {
      this.store.zoomAt(screen, this.store.view.zoom * Math.exp(-deltaY * scale * 0.0025 * (deltaMode ? 1 : 1)));
    } else if (shiftKey && !deltaX) this.store.panBy(-deltaY * scale, 0);
    else this.store.panBy(-deltaX * scale, -deltaY * scale);
    this.refreshOverlay();
  }

  setSpace(down: boolean) { this.spaceDown = down; }

  /** Returns true when the key was handled. */
  keyDown(event: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean }): boolean {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const store = this.store;
    if (key === 'Escape') {
      if (this.gesture) { this.store.cancel(); this.gesture = null; }
      else if (store.tool !== 'select') store.setTool('select');
      else store.select([]);
      this.refreshOverlay();
      return true;
    }
    if (mod) {
      if (key === 'z') { if (event.shiftKey) store.redo(); else store.undo(); this.refreshOverlay(); return true; }
      if (key === 'y') { store.redo(); this.refreshOverlay(); return true; }
      if (key === 'a') { store.select(this.elements.map(el => el.id)); this.refreshOverlay(); return true; }
      if (key === 'd') { this.duplicate(); return true; }
      if (key === 'g') { if (event.shiftKey) this.ungroup(); else this.group(); return true; }
      if (key === 'l' && event.shiftKey) { this.toggleLock(); return true; }
      if (event.code === 'BracketRight') { this.order(event.shiftKey ? 'front' : 'forward'); return true; }
      if (event.code === 'BracketLeft') { this.order(event.shiftKey ? 'back' : 'backward'); return true; }
      if (key === '0') { store.resetZoom(); this.refreshOverlay(); return true; }
      if (key === '=' || key === '+') { store.zoomBy(1.25); this.refreshOverlay(); return true; }
      if (key === '-') { store.zoomBy(0.8); this.refreshOverlay(); return true; }
      return false;
    }
    if (event.shiftKey && event.code === 'Digit1') { store.zoomToFit(); this.refreshOverlay(); return true; }
    if (event.shiftKey && event.code === 'Digit2') { store.zoomToSelection(); this.refreshOverlay(); return true; }
    if (key === 'Delete' || key === 'Backspace') { this.deleteSelection(); return true; }
    if (key.startsWith('Arrow')) {
      const step = event.shiftKey ? 10 : 1;
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      this.nudge(dx, dy);
      return true;
    }
    if (key === 'Tab' && this.addMindNode('child')) return true;
    if (key === 'Enter' || key === 'F2') {
      if (store.selection.size !== 1) return false;
      const el = this.index.get([...store.selection][0]!);
      if (isEmbedElement(el)) { this.activateEmbed(el.id); return true; }
      if (el?.type === 'card') { this.host.openPage(el.pageId); return true; }
      if (key === 'Enter' && isMindNode(el) && this.addMindNode(el.mindParentId ? 'sibling' : 'child')) return true;
      if (this.canEdit(el)) { this.startEditing(el!.id); return true; }
      return false;
    }
    if (event.altKey || event.repeat) return false;
    const tools: Record<string, Tool> = { v: 'select', h: 'hand', s: 'shape', t: 'text', n: 'note', c: 'connector', p: 'pen', e: 'eraser', f: 'frame', m: 'mind' };
    const tool = key === 'p' && event.shiftKey ? 'highlighter' : tools[key];
    if (tool) { store.setTool(tool); this.refreshOverlay(); return true; }
    return false;
  }

  // ── Commands used by the chrome ──

  private editable(): Set<string> {
    return new Set([...this.store.selection].filter(id => { const el = this.index.get(id); return el && !el.locked; }));
  }

  private apply(next: El[]) { if (!this.store.readOnly) { this.store.commit(next); this.refreshOverlay(); } }

  deleteSelection() {
    const ids = this.editable();
    if (!ids.size || this.store.readOnly) return;
    // Removing a mind node keeps the rest of its map laid out.
    const roots = [...ids].map(id => { const el = this.index.get(id); return el ? mindRootOf(el, this.index)?.id : undefined; }).filter((id): id is string => Boolean(id) && !ids.has(id!));
    let next = removeElements(this.elements, ids, this.index);
    next = layoutMindsOf(next, roots);
    this.store.select([]);
    this.apply(next);
  }

  duplicate() {
    if (this.store.readOnly) return;
    const ids = movingSet(this.elements, this.store.selection, this.index);
    const source = this.elements.filter(el => ids.has(el.id));
    if (!source.length) return;
    const copies = this.pasteClones(source, { x: 24, y: 24 });
    this.apply([...this.elements, ...copies]);
    this.store.select(copies.map(el => el.id));
    this.refreshOverlay();
  }

  /** Fresh copies of elements; copied mind subtrees become their own maps rooted at the topmost copied node. */
  pasteClones(source: El[], offset: Point): El[] {
    const index = new Map(source.map(el => [el.id, el]));
    return cloneElements(source, index.size ? new Map([...this.index, ...index]) : this.index, offset, this.host.newId);
  }

  group() {
    const ids = this.editable();
    if (ids.size < 2) return;
    this.apply(setGroup(this.elements, ids, this.host.newId()));
  }

  ungroup() { this.apply(setGroup(this.elements, this.editable(), null)); }

  toggleLock() {
    const ids = new Set(this.store.selection);
    if (!ids.size) return;
    const locked = [...ids].every(id => this.index.get(id)?.locked);
    this.apply(setLocked(this.elements, ids, !locked));
  }

  order(move: OrderMove) { this.apply(reorder(this.elements, this.editable(), move)); }
  align(how: Alignment) { this.apply(align(this.elements, this.editable(), how, this.index)); }
  distribute(axis: 'x' | 'y') { this.apply(distribute(this.elements, this.editable(), axis, this.index)); }

  style(patch: StylePatch) {
    const ids = this.editable();
    let next = applyStyle(this.elements, ids, patch);
    // Size changes reflow text.
    if (patch.fontSize !== undefined || patch.bold !== undefined || patch.shape !== undefined) {
      next = next.map(el => ids.has(el.id) && isBox(el) ? (isMindNode(el) ? fitMindNode(el, this.host.measure) : fitText(el, this.host.measure, el.type === 'text' && !this.fixedWidth.has(el.id))) : el);
      next = layoutMindsOf(next, ids);
    }
    this.apply(next);
  }

  nudge(dx: number, dy: number) {
    const ids = movingSet(this.elements, this.editable(), this.index);
    if (!ids.size) return;
    this.apply(translate(this.elements, ids, dx, dy));
  }

  /** Insert elements centred on a point, select them and commit as one step. */
  insert(elements: El[], at: Point = this.store.center()) {
    if (this.store.readOnly || !elements.length) return;
    const index = new Map(elements.map(el => [el.id, el]));
    const bounds = boundsOfIds(elements.map(el => el.id), index) ?? { x: at.x, y: at.y, w: 0, h: 0 };
    const placed = translate(elements, new Set(elements.map(el => el.id)), at.x - bounds.x - bounds.w / 2, at.y - bounds.y - bounds.h / 2);
    const frames = placed.filter(el => el.type === 'frame'), rest = placed.filter(el => el.type !== 'frame');
    if (this.elements.length + placed.length > whiteboardLimits.maxElements) { this.host.notice(`白板最多容纳 ${whiteboardLimits.maxElements} 个元素。`); return; }
    this.store.setTool('select');
    this.apply([...frames, ...this.elements, ...rest]);
    this.store.select(placed.map(el => el.id));
    this.refreshOverlay();
  }

  imageElement(attachment: { id: string; fileName: string; mediaType: string }, size: { w: number; h: number }): WhiteboardImage {
    const scale = Math.min(1, 480 / Math.max(size.w, size.h, 1));
    return { id: this.host.newId(), type: 'image', x: 0, y: 0, w: round(Math.max(16, size.w * scale)), h: round(Math.max(16, size.h * scale)), angle: 0,
      attachmentId: attachment.id.toLowerCase(), fileName: attachment.fileName.slice(0, 180), mediaType: attachment.mediaType };
  }

  cardElement(page: { id: string; title: string }): WhiteboardCard {
    return { id: this.host.newId(), type: 'card', x: 0, y: 0, w: 260, h: 64, angle: 0, pageId: page.id.toLowerCase(),
      label: (page.title || '未命名页面').replace(/[\n\r\u2028\u2029]/g, ' ').slice(0, whiteboardLimits.maxLabel) };
  }

  textElement(text: string): WhiteboardText {
    const base: WhiteboardText = { id: this.host.newId(), type: 'text', x: 0, y: 0, w: 400, h: 20, angle: 0,
      text: text.slice(0, whiteboardLimits.maxText), color: '#1f2328', fontSize: 16, textAlign: 'left' };
    const natural = textBlockSize(base.text, Infinity, 16, false, this.host.measure).width + 2;
    return fitText({ ...base, w: Math.min(480, Math.max(textMinWidth, natural)) }, this.host.measure) as WhiteboardText;
  }

  /** Selected element ids plus the ids that travel with them, for copy and export. */
  selectionWithDependents(): Set<string> { return movingSet(this.elements, this.store.selection, this.index); }

  selectionBounds(): Rect | null { return boundsOfIds(this.store.selection, this.index); }
}

export function selectionKinds(store: BoardStore): Set<El['type']> {
  return new Set([...store.selection].map(id => store.index.get(id)?.type).filter((type): type is El['type'] => Boolean(type)));
}

export function unionOfBoxes(boxes: Box[]): Rect | null { return unionRects(boxes.map(aabb)); }
export { toLocal };
export type { WhiteboardShape };
