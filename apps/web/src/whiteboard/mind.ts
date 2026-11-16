import type { WhiteboardShape } from '@nbase/contracts';
import { expandRect, pointInRect, unionRects, type Box, type Point } from './geometry';
import { createShape, fitText, indexElements, mindDescendants, mindRootOf, mindVisibility, palette, textPadding, type El, type Elements,
  type Index } from './model';
import { textBlockSize, type Measure } from './text';

/**
 * Mind maps are ordinary shapes linked by `mindParentId`; edges are drawn from that link rather
 * than stored. Branches grow to the right of the root, or to its left when the first-level node
 * says so, and the tree is laid out again after every change. Sibling order is array order.
 */
export const horizontalGap = 56;
const verticalGap = 14;
/** Dragging a node this far outside its map makes it a map of its own. */
const detachDistance = 140;

export type MindSide = 'left' | 'right';
export type MindLayout = 'right' | 'left' | 'both';

export const isMindNode = (el: El | undefined): el is WhiteboardShape => el?.type === 'shape' && el.mindParentId !== undefined;

function childrenOf(elements: Elements): Map<string, WhiteboardShape[]> {
  const map = new Map<string, WhiteboardShape[]>();
  for (const el of elements) {
    if (!isMindNode(el) || !el.mindParentId) continue;
    const list = map.get(el.mindParentId);
    if (list) list.push(el); else map.set(el.mindParentId, [el]);
  }
  return map;
}

export const mindChildren = (elements: Elements, parentId: string): WhiteboardShape[] =>
  elements.filter((el): el is WhiteboardShape => isMindNode(el) && el.mindParentId === parentId);

/** Which side of its root a node's branch grows on. */
export function mindSideOf(node: WhiteboardShape, index: Index): MindSide {
  let cursor = node;
  for (let steps = 0; cursor.mindParentId && steps < 10_000; steps += 1) {
    const parent = index.get(cursor.mindParentId);
    if (!isMindNode(parent)) break;
    if (parent.mindParentId === null) return cursor.mindSide === 'left' ? 'left' : 'right';
    cursor = parent;
  }
  return 'right';
}

export function mindLayoutOf(elements: Elements, rootId: string): MindLayout {
  const kids = mindChildren(elements, rootId);
  const left = kids.filter(kid => kid.mindSide === 'left').length;
  return !left ? 'right' : left === kids.length ? 'left' : 'both';
}

/** Where an edge leaves the parent and enters the child; decided by their positions so it also holds mid-drag. */
export function mindEdgeEnds(parent: Box, child: Box): { from: Point; to: Point } {
  const left = child.x + child.w / 2 < parent.x + parent.w / 2;
  return { from: { x: left ? parent.x : parent.x + parent.w, y: parent.y + parent.h / 2 },
    to: { x: left ? child.x + child.w : child.x, y: child.y + child.h / 2 } };
}

/** Reposition every descendant of the root; the root itself stays where the user put it. */
export function layoutMind(elements: Elements, rootId: string): El[] {
  const children = childrenOf(elements);
  const root = elements.find(el => el.id === rootId);
  if (!isMindNode(root)) return elements as El[];
  const kidsOf = (node: WhiteboardShape, depth: number) => depth > 200 || node.mindCollapsed ? [] : children.get(node.id) ?? [];
  const heights = new Map<string, number>();
  const span = (kids: WhiteboardShape[]) => kids.reduce((sum, kid) => sum + heights.get(kid.id)!, 0) + Math.max(0, kids.length - 1) * verticalGap;
  const measureTree = (node: WhiteboardShape, depth: number): number => {
    const kids = kidsOf(node, depth);
    for (const kid of kids) measureTree(kid, depth + 1);
    const height = Math.max(node.h, span(kids));
    heights.set(node.id, height);
    return height;
  };
  measureTree(root, 0);
  const placed = new Map<string, { x: number; y: number }>();
  const placeKids = (node: WhiteboardShape, kids: WhiteboardShape[], x: number, centerY: number, side: MindSide, depth: number) => {
    let cursor = centerY - span(kids) / 2;
    for (const kid of kids) {
      const height = heights.get(kid.id)!;
      const kidX = side === 'right' ? x + node.w + horizontalGap : x - horizontalGap - kid.w;
      placed.set(kid.id, { x: kidX, y: cursor + height / 2 - kid.h / 2 });
      placeKids(kid, kidsOf(kid, depth + 1), kidX, cursor + height / 2, side, depth + 1);
      cursor += height + verticalGap;
    }
  };
  placed.set(root.id, { x: root.x, y: root.y });
  const first = kidsOf(root, 0), centerY = root.y + root.h / 2;
  placeKids(root, first.filter(kid => kid.mindSide !== 'left'), root.x, centerY, 'right', 0);
  placeKids(root, first.filter(kid => kid.mindSide === 'left'), root.x, centerY, 'left', 0);
  let changed = false;
  const next = elements.map(el => {
    const position = placed.get(el.id);
    if (!position || !isMindNode(el) || (Math.abs(el.x - position.x) < 0.01 && Math.abs(el.y - position.y) < 0.01 && el.angle === 0)) return el;
    changed = true;
    return { ...el, x: position.x, y: position.y, angle: 0 };
  });
  return changed ? next : elements as El[];
}

/** Lay out every mind map that contains one of the given nodes. */
export function layoutMindsOf(elements: Elements, ids: Iterable<string>): El[] {
  const index = indexElements(elements);
  const roots = new Set<string>();
  for (const id of ids) { const el = index.get(id); const root = el && mindRootOf(el, index); if (root) roots.add(root.id); }
  let next = elements as El[];
  for (const root of roots) next = layoutMind(next, root);
  return next;
}

export function mindNodeSize(text: string, fontSize: number, measure: Measure, bold = false): { w: number; h: number } {
  const block = textBlockSize(text || '　', 240, fontSize, bold, measure);
  return { w: Math.max(72, Math.ceil(block.width) + textPadding * 2 + 12), h: Math.max(36, block.height + textPadding * 2) };
}

/** Resize a node to its text; mind nodes hug their label instead of keeping a user-set box. */
export function fitMindNode(node: WhiteboardShape, measure: Measure): WhiteboardShape {
  const size = mindNodeSize(node.text, node.fontSize, measure, Boolean(node.bold));
  return size.w === node.w && size.h === node.h ? node : { ...node, ...size, y: node.y + (node.h - size.h) / 2 };
}

const branchColors = [palette.blue, palette.green, palette.orange, palette.purple, palette.teal, palette.pink, palette.red];

export function createMindRoot(id: string, x: number, y: number, text: string, measure: Measure): WhiteboardShape {
  const base = createShape(id, { x, y, w: 0, h: 0 }, { shape: 'roundRect', fill: palette.blue, stroke: palette.blue });
  const node: WhiteboardShape = { ...base, text, textColor: '#ffffff', fontSize: 18, mindParentId: null };
  const size = mindNodeSize(text, node.fontSize, measure);
  return { ...node, ...size, x: x - size.w / 2, y: y - size.h / 2 };
}

function without<K extends 'mindSide' | 'mindCollapsed'>(node: WhiteboardShape, key: K): WhiteboardShape {
  if (node[key] === undefined) return node;
  const next = { ...node };
  delete next[key];
  return next;
}

/** Add a child under `parentId`, after `afterId` among its siblings when given. Returns the laid-out board. */
export function addMindChild(elements: Elements, parentId: string, id: string, measure: Measure, afterId?: string): El[] {
  const index = indexElements(elements);
  const parent = index.get(parentId);
  if (!isMindNode(parent)) return elements as El[];
  const root = mindRootOf(parent, index)!;
  const siblings = mindChildren(elements, parentId);
  // First-level branches each take a colour; deeper nodes inherit their branch's.
  const stroke = parent.id === root.id ? branchColors[siblings.length % branchColors.length]! : parent.stroke;
  const base = createShape(id, { x: parent.x + parent.w + horizontalGap, y: parent.y, w: 0, h: 0 },
    { shape: 'roundRect', fill: '#ffffff', stroke, strokeWidth: 2 });
  let side: MindSide = 'right';
  if (parent.id === root.id) {
    const after = afterId ? siblings.find(sibling => sibling.id === afterId) : undefined;
    const left = siblings.filter(sibling => sibling.mindSide === 'left').length;
    // A new sibling stays beside the one it was added after; otherwise the emptier side of a two-sided map gets it.
    side = after ? (after.mindSide === 'left' ? 'left' : 'right') : left && left * 2 < siblings.length + 1 ? 'left' : left === siblings.length && left ? 'left' : 'right';
  }
  const node = fitText({ ...base, ...mindNodeSize('', 15, measure), fontSize: 15, mindParentId: parentId, ...(side === 'left' ? { mindSide: 'left' as const } : {}) },
    measure) as WhiteboardShape;
  // Array order is sibling order, so insert right after the reference sibling's subtree.
  const anchor = afterId && index.has(afterId) ? afterId : siblings.at(-1)?.id ?? parentId;
  const subtree = mindDescendants(elements, [anchor]);
  let at = -1;
  elements.forEach((el, i) => { if (subtree.has(el.id)) at = i; });
  // A new child must be visible, so a collapsed parent opens.
  const opened = parent.mindCollapsed ? elements.map(el => el.id === parentId ? without(parent, 'mindCollapsed') : el) : elements;
  return layoutMind([...opened.slice(0, at + 1), node, ...opened.slice(at + 1)], root.id);
}

/** Hide or show everything under a node. Nodes without children cannot collapse. */
export function setMindCollapsed(elements: Elements, id: string, collapsed: boolean): El[] {
  const index = indexElements(elements);
  const node = index.get(id);
  if (!isMindNode(node) || Boolean(node.mindCollapsed) === collapsed) return elements as El[];
  if (collapsed && !mindChildren(elements, id).length) return elements as El[];
  const next = elements.map(el => el.id === id ? (collapsed ? { ...node, mindCollapsed: true } : without(node, 'mindCollapsed')) : el);
  return layoutMind(next, mindRootOf(node, index)!.id);
}

/** Send the root's branches to the right, to the left, or half to each side. */
export function setMindLayout(elements: Elements, rootId: string, layout: MindLayout): El[] {
  const kids = mindChildren(elements, rootId);
  const leftFrom = layout === 'right' ? kids.length : layout === 'left' ? 0 : Math.ceil(kids.length / 2);
  const left = new Set(kids.slice(leftFrom).map(kid => kid.id));
  const next = elements.map(el => {
    if (!isMindNode(el) || el.mindParentId !== rootId || (el.mindSide === 'left') === left.has(el.id)) return el;
    return left.has(el.id) ? { ...el, mindSide: 'left' as const } : without(el, 'mindSide');
  });
  return layoutMind(next, rootId);
}

export interface MindDrop {
  /** The new parent, or null to make the node the root of its own map. */
  parentId: string | null;
  /** Sibling to land in front of or behind; with neither the node goes last. */
  beforeId?: string;
  afterId?: string;
  /** Only read when the new parent is a root. */
  side: MindSide;
}

/** Move a node, with its branch, under another parent or to another place among its siblings. */
export function moveMindNode(elements: Elements, id: string, drop: MindDrop): El[] {
  const index = indexElements(elements);
  const node = index.get(id);
  if (!isMindNode(node)) return elements as El[];
  const oldRoot = mindRootOf(node, index)!;
  const bare = without(node, 'mindSide');
  if (drop.parentId === null) {
    if (node.mindParentId === null) return elements as El[];
    const detached = elements.map(el => el.id === id ? { ...bare, mindParentId: null } : el);
    return layoutMind(layoutMind(detached, oldRoot.id), id);
  }
  const parent = index.get(drop.parentId);
  if (!isMindNode(parent) || mindDescendants(elements, [id]).has(parent.id)) return elements as El[];
  const newRoot = mindRootOf(parent, index)!;
  const moved: WhiteboardShape = { ...bare, mindParentId: parent.id, ...(parent.mindParentId === null && drop.side === 'left' ? { mindSide: 'left' as const } : {}) };
  const rest = elements.filter(el => el.id !== id).map(el => {
    if (el.id === parent.id) return without(parent, 'mindCollapsed');
    // A root that becomes a branch stops giving its children sides.
    if (node.mindParentId === null && isMindNode(el) && el.mindParentId === id) return without(el, 'mindSide');
    return el;
  });
  const position = (ref: string | undefined) => ref ? rest.findIndex(el => el.id === ref) : -1;
  let at = position(drop.beforeId);
  if (at < 0) {
    at = position(drop.afterId);
    if (at < 0) rest.forEach((el, i) => { if (el.id === parent.id || (isMindNode(el) && el.mindParentId === parent.id)) at = i; });
    at += 1;
  }
  const placed = [...rest.slice(0, at), moved, ...rest.slice(at)];
  // Dropped back where it came from: nothing to save.
  const siblings = (list: Elements) => list.filter(el => isMindNode(el) && el.mindParentId === parent.id).map(el => el.id).join();
  if (moved.mindParentId === node.mindParentId && moved.mindSide === node.mindSide && !parent.mindCollapsed && siblings(placed) === siblings(elements)) return elements as El[];
  let next = layoutMind(placed, newRoot.id);
  if (oldRoot.id !== newRoot.id && oldRoot.id !== id) next = layoutMind(next, oldRoot.id);
  return next;
}

export interface MindDropHint extends MindDrop {
  /** The node that would become the parent, to highlight it. */
  box: WhiteboardShape | null;
  /** Where the node would land among its siblings. */
  line: { from: Point; to: Point } | null;
}

/**
 * What dropping a dragged node at `pointer` means: on another node it becomes that node's last
 * child, far outside the map it becomes a map of its own, anywhere else it stays with its parent
 * and takes the place among its siblings that matches the pointer's height. `elements` is the
 * board as it was before the drag.
 */
export function mindDropTarget(elements: Elements, index: Index, id: string, pointer: Point, tolerance = 6): MindDropHint | null {
  const node = index.get(id);
  if (!isMindNode(node) || !node.mindParentId) return null;
  const parent = index.get(node.mindParentId);
  if (!isMindNode(parent)) return null;
  const subtree = mindDescendants(elements, [id]);
  const { hidden } = mindVisibility(elements);
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i]!;
    if (!isMindNode(el) || el.locked || subtree.has(el.id) || hidden.has(el.id) || !pointInRect(pointer, el, tolerance)) continue;
    const side = el.mindParentId === null ? (pointer.x < el.x + el.w / 2 ? 'left' : 'right') : mindSideOf(el, index);
    return { parentId: el.id, side, box: el, line: null };
  }
  const root = mindRootOf(node, index)!;
  const others: Box[] = [];
  for (const other of mindDescendants(elements, [root.id])) {
    const el = index.get(other);
    if (isMindNode(el) && !subtree.has(other) && !hidden.has(other)) others.push(el);
  }
  const area = unionRects(others);
  if (!area || !pointInRect(pointer, expandRect(area, detachDistance))) return { parentId: null, side: 'right', box: null, line: null };
  const underRoot = parent.mindParentId === null;
  const side: MindSide = underRoot ? (pointer.x < parent.x + parent.w / 2 ? 'left' : 'right') : mindSideOf(node, index);
  const siblings = mindChildren(elements, parent.id).filter(sibling => sibling.id !== id && (!underRoot || (sibling.mindSide === 'left') === (side === 'left')));
  const nextAt = siblings.findIndex(sibling => sibling.y + sibling.h / 2 > pointer.y);
  const next = nextAt < 0 ? undefined : siblings[nextAt], previous = nextAt < 0 ? siblings.at(-1) : siblings[nextAt - 1];
  const y = next && previous ? (previous.y + previous.h + next.y) / 2 : next ? next.y - verticalGap / 2
    : previous ? previous.y + previous.h + verticalGap / 2 : parent.y + parent.h / 2;
  const x = side === 'right' ? parent.x + parent.w + horizontalGap : parent.x - horizontalGap - 64;
  return { parentId: parent.id, ...(next ? { beforeId: next.id } : previous ? { afterId: previous.id } : {}), side, box: null,
    line: { from: { x, y }, to: { x: x + 64, y } } };
}

export const mindToggleRadius = 9;

/** Centre of the collapse / expand button, just outside the node on the side its children grow. */
export function mindTogglePoint(node: WhiteboardShape, side: MindSide): Point {
  return { x: side === 'left' ? node.x - 12 : node.x + node.w + 12, y: node.y + node.h / 2 };
}

/** The side a node's own children are on; a root with only left branches counts as left. */
export function mindChildSide(node: WhiteboardShape, elements: Elements, index: Index): MindSide {
  if (node.mindParentId !== null) return mindSideOf(node, index);
  return mindLayoutOf(elements, node.id) === 'left' ? 'left' : 'right';
}
