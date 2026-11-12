import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent } from 'react';
import { bounds, createSimulation, nodeAt, reheat, settle, stepSimulation, type Point, type Simulation } from './layout';
import { labelZoom, nodeColor, nodeRadius, nodeTitle, truncateLabel, type GraphColorMode, type GraphView } from './model';

export interface GraphCanvasHandle { fit: () => void; zoomBy: (factor: number) => void }

interface Props {
  view: GraphView;
  colorMode: GraphColorMode;
  selectedId: string | null;
  /** The page the graph is about (open page or local-mode centre); drawn in the accent colour. */
  currentId: string | null;
  label: string;
  compact?: boolean;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
}

const minZoom = 0.04, maxZoom = 4, labelCap = 320, arrowEdgeCap = 1500;
const fallback = { text: '#1f2328', muted: '#656d76', faint: '#9aa0a6', line: '#d0d4da', accent: '#3e63dd', bg: '#ffffff' };
type Colors = typeof fallback;

function readColors(element: Element): Colors {
  const style = getComputedStyle(element);
  const pick = (name: string, otherwise: string) => style.getPropertyValue(name).trim() || otherwise;
  return { text: pick('--nb-text', fallback.text), muted: pick('--nb-muted', fallback.muted), faint: pick('--nb-faint', fallback.faint),
    line: pick('--nb-quote-line', fallback.line), accent: pick('--nb-accent', fallback.accent), bg: pick('--nb-bg', fallback.bg) };
}

const radiusScale = (zoom: number) => Math.max(0.55, Math.min(1.5, Math.sqrt(zoom)));
const edgeWidth = (count: number) => count >= 4 ? 2.4 : count >= 2 ? 1.6 : 1;

/**
 * Canvas renderer and pointer handling. Everything that changes per frame lives in refs; React only
 * re-renders when the view or the selection changes. The frame loop runs while the simulation is
 * warm or the pointer is dragging, and stops otherwise.
 */
export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props); propsRef.current = props;
  const state = useRef({
    sim: null as Simulation | null, view: props.view, positions: new Map<string, Point>(), order: [] as number[],
    zoom: 1, x: 0, y: 0, width: 0, height: 0, dpr: 1, userMoved: false, hover: -1, frame: 0, onScreen: true,
    colors: fallback, font: '12px sans-serif',
    drag: null as null | { kind: 'node' | 'pan'; index: number; startX: number; startY: number; moved: boolean; pointerId: number },
    pointers: new Map<number, Point>(), pinch: null as null | { distance: number; zoom: number },
  }).current;

  const fitNow = () => {
    const sim = state.sim, box = sim && bounds(sim);
    if (!sim || !box || !state.width || !state.height) return;
    const pad = propsRef.current.compact ? 34 : 60;
    const width = Math.max(box.maxX - box.minX, 1), height = Math.max(box.maxY - box.minY, 1);
    const zoom = Math.max(minZoom, Math.min(sim.count < 2 ? 1.2 : 1.8,
      (state.width - pad * 2) / width, (state.height - pad * 2) / height));
    state.zoom = zoom;
    state.x = state.width / 2 - (box.minX + box.maxX) / 2 * zoom;
    state.y = state.height / 2 - (box.minY + box.maxY) / 2 * zoom;
  };

  const draw = () => {
    const canvas = canvasRef.current, sim = state.sim, context = canvas?.getContext('2d');
    if (!canvas || !context || !sim || !state.width) return;
    const { view, zoom, x: tx, y: ty, width, height, colors } = state, { selectedId, currentId, colorMode } = propsRef.current;
    const scale = radiusScale(zoom);
    context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const selected = selectedId ? view.index.get(selectedId) ?? -1 : -1;
    const current = currentId ? view.index.get(currentId) ?? -1 : -1;
    const centre = state.hover >= 0 ? state.hover : selected;
    const lit = new Uint8Array(sim.count);
    if (centre >= 0 && centre < sim.count) { lit[centre] = 1; for (const other of view.neighbors[centre] ?? []) lit[other] = 1; }
    // Only hovering dims the rest; a selection just marks its own links.
    const dimmed = state.hover >= 0;
    const px = (index: number) => sim.x[index]! * zoom + tx, py = (index: number) => sim.y[index]! * zoom + ty;
    const outside = (ax: number, ay: number, bx: number, by: number) =>
      (ax < 0 && bx < 0) || (ax > width && bx > width) || (ay < 0 && by < 0) || (ay > height && by > height);

    // Edges: one pass sorts visible segments into style buckets, so thousands of lines cost six strokes.
    const isLit = (link: { source: number; target: number }) => centre >= 0 && (link.source === centre || link.target === centre);
    const buckets: number[][] = [[], [], [], [], [], []];
    for (const link of view.links) {
      const ax = px(link.source), ay = py(link.source), bx = px(link.target), by = py(link.target);
      if (outside(ax, ay, bx, by)) continue;
      const tree = link.kind === 'tree', weight = edgeWidth(link.forward + link.backward);
      buckets[isLit(link) ? (tree ? 4 : 5) : tree ? 0 : weight === 1 ? 1 : weight === 1.6 ? 2 : 3]!.push(ax, ay, bx, by);
    }
    const stroke = (bucket: number, style: string, lineWidth: number, alpha: number, dash: number[]) => {
      const points = buckets[bucket]!;
      if (!points.length) return;
      context.beginPath();
      for (let i = 0; i < points.length; i += 4) { context.moveTo(points[i]!, points[i + 1]!); context.lineTo(points[i + 2]!, points[i + 3]!); }
      context.setLineDash(dash); context.globalAlpha = alpha; context.strokeStyle = style; context.lineWidth = lineWidth; context.stroke();
    };
    stroke(0, colors.faint, 1, dimmed ? 0.13 : 0.6, [3, 4]);
    [1, 1.6, 2.4].forEach((lineWidth, index) => stroke(index + 1, colors.line, lineWidth, dimmed ? 0.16 : 0.95, []));
    stroke(4, colors.accent, 1.2, 0.8, [3, 4]);
    stroke(5, colors.accent, 1.8, 0.95, []);
    context.setLineDash([]);
    const plainEdges = (buckets[1]!.length + buckets[2]!.length + buckets[3]!.length) / 4;

    // Direction: a small head at the referenced end; both ends when the pages link each other.
    const heads = (onlyLit: boolean, style: string, alpha: number) => {
      context.beginPath();
      const size = 5.5 * scale;
      for (const link of view.links) {
        if (link.kind !== 'link' || (onlyLit && !isLit(link))) continue;
        const ax = px(link.source), ay = py(link.source), bx = px(link.target), by = py(link.target);
        if (outside(ax, ay, bx, by)) continue;
        const length = Math.hypot(bx - ax, by - ay);
        if (length < size * 3) continue;
        const ux = (bx - ax) / length, uy = (by - ay) / length;
        const head = (tipX: number, tipY: number, dx: number, dy: number) => {
          context.moveTo(tipX, tipY);
          context.lineTo(tipX - dx * size - dy * size * 0.5, tipY - dy * size + dx * size * 0.5);
          context.lineTo(tipX - dx * size + dy * size * 0.5, tipY - dy * size - dx * size * 0.5);
          context.closePath();
        };
        if (link.forward > 0) { const r = nodeRadius(view.nodes[link.target]!.degree) * scale + 1.5; head(bx - ux * r, by - uy * r, ux, uy); }
        if (link.backward > 0) { const r = nodeRadius(view.nodes[link.source]!.degree) * scale + 1.5; head(ax + ux * r, ay + uy * r, -ux, -uy); }
      }
      context.globalAlpha = alpha; context.fillStyle = style; context.fill();
    };
    if (!dimmed && zoom >= 0.55 && plainEdges <= arrowEdgeCap) heads(false, colors.faint, 0.9);
    if (centre >= 0) heads(true, colors.accent, 1);

    // Nodes: grouped by fill so each colour is a single path.
    const fills = new Map<string, number[]>();
    for (let i = 0; i < sim.count; i++) {
      const node = view.nodes[i]!, cx = px(i), cy = py(i), radius = nodeRadius(node.degree) * scale;
      if (cx < -radius || cy < -radius || cx > width + radius || cy > height + radius) continue;
      const key = `${dimmed && !lit[i] ? 'd' : 'n'}${i === current ? colors.accent : nodeColor(node, colorMode) ?? colors.muted}`;
      const group = fills.get(key);
      if (group) group.push(i); else fills.set(key, [i]);
    }
    for (const [key, group] of fills) {
      context.globalAlpha = key[0] === 'd' ? 0.2 : 1; context.fillStyle = key.slice(1);
      context.beginPath();
      for (const i of group) {
        const node = view.nodes[i]!, cx = px(i), cy = py(i), radius = nodeRadius(node.degree) * scale;
        if (node.kind === 'database') context.rect(cx - radius * 0.9, cy - radius * 0.9, radius * 1.8, radius * 1.8);
        else { context.moveTo(cx + radius, cy); context.arc(cx, cy, radius, 0, Math.PI * 2); }
      }
      context.fill();
    }
    context.globalAlpha = 1; context.lineWidth = 2; context.strokeStyle = colors.accent;
    for (const i of new Set([selected, current, state.hover])) {
      if (i < 0 || i >= sim.count) continue;
      context.beginPath(); context.arc(px(i), py(i), nodeRadius(view.nodes[i]!.degree) * scale + 3.5, 0, Math.PI * 2); context.stroke();
    }

    // Labels: hubs appear first when zooming in; the hovered neighbourhood is always named.
    context.font = state.font; context.textAlign = 'center'; context.textBaseline = 'top';
    context.lineWidth = 3; context.lineJoin = 'round'; context.strokeStyle = colors.bg; context.fillStyle = colors.text;
    let labels = 0;
    // One label per coarse screen cell keeps dense areas readable.
    const taken = new Set<number>();
    for (const i of state.order) {
      if (labels >= labelCap) break;
      const node = view.nodes[i]!;
      const must = i === selected || i === current || i === state.hover;
      const forced = must || (dimmed && lit[i] === 1);
      const threshold = labelZoom(node.degree);
      if (!forced && (zoom < threshold || (dimmed && !lit[i]))) continue;
      const cx = px(i), cy = py(i);
      if (cx < -80 || cy < -20 || cx > width + 80 || cy > height + 20) continue;
      const cell = Math.floor(cx / 96) * 4096 + Math.floor(cy / 18);
      if (taken.has(cell) && !must) continue;
      taken.add(cell);
      context.globalAlpha = forced ? 1 : Math.min(1, (zoom - threshold) / 0.12 + 0.25);
      const text = truncateLabel(`${node.icon ? `${node.icon} ` : ''}${nodeTitle(node)}`);
      const top = cy + nodeRadius(node.degree) * scale + 5;
      context.strokeText(text, cx, top); context.fillText(text, cx, top);
      labels++;
    }
    context.globalAlpha = 1;
  };

  const schedule = () => {
    if (state.frame || typeof requestAnimationFrame !== 'function') return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      const sim = state.sim;
      if (!sim) return;
      // Hidden tabs and off-screen canvases do no work; they resume from the listeners below.
      const paused = document.hidden || !state.onScreen;
      let active = false;
      if (!paused) {
        const started = performance.now();
        let steps = 0;
        do { active = stepSimulation(sim); steps++; } while (active && steps < 4 && performance.now() - started < 7);
        if (active && !state.userMoved) fitNow();
      }
      draw();
      if (active) schedule();
    });
  };

  useImperativeHandle(ref, () => ({
    fit: () => { state.userMoved = false; fitNow(); schedule(); },
    zoomBy: factor => { zoomAt(state.width / 2, state.height / 2, state.zoom * factor); },
  }));

  const zoomAt = (cx: number, cy: number, next: number) => {
    const zoom = Math.max(minZoom, Math.min(maxZoom, next));
    state.x = cx - (cx - state.x) / state.zoom * zoom;
    state.y = cy - (cy - state.y) / state.zoom * zoom;
    state.zoom = zoom; state.userMoved = true;
    schedule();
  };

  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const hit = (point: Point, slack = 4): number => {
    const sim = state.sim;
    if (!sim) return -1;
    const scale = radiusScale(state.zoom);
    return nodeAt(sim, (point.x - state.x) / state.zoom, (point.y - state.y) / state.zoom,
      index => nodeRadius(state.view.nodes[index]!.degree) * scale / state.zoom, slack / state.zoom);
  };

  // Rebuild the simulation when the visible graph changes, starting from the remembered positions.
  useEffect(() => {
    const previous = state.sim, old = state.view;
    if (previous) for (let i = 0; i < previous.count; i++) state.positions.set(old.nodes[i]!.id, { x: previous.x[i]!, y: previous.y[i]! });
    const view = props.view;
    const sim = createSimulation(view.nodes.map(node => node.id),
      view.links.map(link => ({ source: link.source, target: link.target, weight: link.kind === 'tree' ? 1 : link.forward + link.backward })),
      state.positions);
    // Small graphs settle before the first paint, so the page-side graph never visibly jitters.
    if (sim.count <= 120) settle(sim, 300);
    state.sim = sim; state.view = view; state.hover = -1; state.drag = null;
    state.order = view.nodes.map((_, index) => index).sort((a, b) => view.nodes[b]!.degree - view.nodes[a]!.degree || a - b);
    if (!state.userMoved) fitNow();
    schedule();
  }, [props.view]);

  useEffect(() => { schedule(); }, [props.selectedId, props.currentId, props.colorMode]);

  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const restyle = () => {
      state.colors = readColors(canvas);
      state.font = `${props.compact ? 11 : 12}px ${getComputedStyle(canvas).fontFamily || 'sans-serif'}`;
      schedule();
    };
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (!rect.width || !rect.height) return;
      const first = !state.width;
      state.width = rect.width; state.height = rect.height; state.dpr = dpr;
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
      if (first || !state.userMoved) fitNow();
      draw();
    };
    restyle(); resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(wrap);
    const themeObserver = typeof MutationObserver === 'function' ? new MutationObserver(restyle) : null;
    themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const visibility = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      state.onScreen = entries.some(entry => entry.isIntersecting);
      if (state.onScreen) schedule();
    }) : null;
    visibility?.observe(canvas);
    const resume = () => { if (!document.hidden) schedule(); };
    document.addEventListener('visibilitychange', resume);
    // React registers wheel listeners as passive; zooming must be able to stop the page from scrolling.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = local(event);
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(point.x, point.y, state.zoom * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0016)));
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer?.disconnect(); themeObserver?.disconnect(); visibility?.disconnect();
      document.removeEventListener('visibilitychange', resume);
      canvas.removeEventListener('wheel', wheel);
      if (state.frame) cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, []);

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const point = local(event);
    state.pointers.set(event.pointerId, point);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic events have no capture. */ }
    if (state.pointers.size === 2) {
      const [a, b] = [...state.pointers.values()] as [Point, Point];
      if (state.drag?.kind === 'node' && state.sim) { state.sim.fixed[state.drag.index] = 0; state.sim.alphaTarget = 0; }
      state.drag = null;
      state.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: state.zoom };
      return;
    }
    const index = hit(point, event.pointerType === 'mouse' ? 4 : 12);
    state.drag = { kind: index >= 0 ? 'node' : 'pan', index, startX: point.x, startY: point.y, moved: false, pointerId: event.pointerId };
  };

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = local(event), sim = state.sim;
    const last = state.pointers.get(event.pointerId);
    if (last) state.pointers.set(event.pointerId, point);
    if (state.pinch && state.pointers.size === 2) {
      const [a, b] = [...state.pointers.values()] as [Point, Point];
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, state.pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / state.pinch.distance);
      return;
    }
    const drag = state.drag;
    if (drag && drag.pointerId === event.pointerId && last && sim) {
      if (!drag.moved && Math.hypot(point.x - drag.startX, point.y - drag.startY) < 4) return;
      drag.moved = true;
      if (drag.kind === 'node') {
        // Held nodes follow the pointer and keep the layout warm so neighbours adapt.
        sim.fixed[drag.index] = 1;
        sim.x[drag.index] = (point.x - state.x) / state.zoom; sim.y[drag.index] = (point.y - state.y) / state.zoom;
        sim.alphaTarget = 0.25; reheat(sim, 0.25); state.userMoved = true;
      } else { state.x += point.x - last.x; state.y += point.y - last.y; state.userMoved = true; }
      event.currentTarget.style.cursor = 'grabbing';
      schedule();
      return;
    }
    if (event.pointerType !== 'mouse') return;
    const hover = hit(point);
    if (hover !== state.hover) { state.hover = hover; event.currentTarget.style.cursor = hover >= 0 ? 'pointer' : 'grab'; schedule(); }
  };

  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    state.pointers.delete(event.pointerId);
    if (state.pinch) { if (state.pointers.size < 2) state.pinch = null; return; }
    const drag = state.drag, sim = state.sim;
    state.drag = null;
    if (!drag || drag.pointerId !== event.pointerId || !sim) return;
    if (drag.kind === 'node') { sim.fixed[drag.index] = 0; sim.alphaTarget = 0; }
    event.currentTarget.style.cursor = drag.kind === 'node' ? 'pointer' : 'grab';
    if (!drag.moved && event.type === 'pointerup') {
      propsRef.current.onSelect(drag.kind === 'node' ? state.view.nodes[drag.index]?.id ?? null : null);
    }
    schedule();
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const pan = (dx: number, dy: number) => { state.x += dx; state.y += dy; state.userMoved = true; schedule(); };
    const selected = propsRef.current.selectedId;
    if (event.key === 'Enter' && selected) propsRef.current.onOpen(selected);
    else if (event.key === '+' || event.key === '=') zoomAt(state.width / 2, state.height / 2, state.zoom * 1.25);
    else if (event.key === '-') zoomAt(state.width / 2, state.height / 2, state.zoom / 1.25);
    else if (event.key === '0') { state.userMoved = false; fitNow(); schedule(); }
    else if (event.key === 'ArrowLeft') pan(48, 0);
    else if (event.key === 'ArrowRight') pan(-48, 0);
    else if (event.key === 'ArrowUp') pan(0, 48);
    else if (event.key === 'ArrowDown') pan(0, -48);
    else return;
    event.preventDefault();
  };

  return <div ref={wrapRef} className="nb-graph-canvas">
    <canvas ref={canvasRef} tabIndex={0} role="application" aria-label={props.label}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
      onPointerLeave={() => { if (state.hover >= 0 && !state.drag) { state.hover = -1; schedule(); } }}
      onDoubleClick={event => { const index = hit(local(event)); if (index >= 0) props.onOpen(state.view.nodes[index]!.id); }}
      onKeyDown={keyDown} />
  </div>;
});
