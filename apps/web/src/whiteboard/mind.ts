import type { WhiteboardShape } from '@nbase/contracts';
import { createShape, fitText, indexElements, mindDescendants, mindRootOf, palette, textPadding, type El, type Elements } from './model';
import { textBlockSize, type Measure } from './text';

/**
 * Mind maps are ordinary shapes linked by `mindParentId`; edges are drawn from that link rather
 * than stored. The tree grows to the right of its root and is laid out again after every change.
 */
const horizontalGap = 56;
const verticalGap = 14;

export const isMindNode = (el: El | undefined): el is WhiteboardShape => el?.type === 'shape' && el.mindParentId !== undefined;

function childrenOf(elements: Elements): Map<string, WhiteboardShape[]> {
  const map = new Map<string, WhiteboardShape[]>();
  for (const el of elements) {
    if (!isMindNode(el) || !el.mindParentId) continue;
    map.set(el.mindParentId, [...(map.get(el.mindParentId) ?? []), el]);
  }
  return map;
}

/** Reposition every descendant of the root; the root itself stays where the user put it. */
export function layoutMind(elements: Elements, rootId: string): El[] {
  const children = childrenOf(elements);
  const root = elements.find(el => el.id === rootId);
  if (!isMindNode(root)) return elements as El[];
  const heights = new Map<string, number>();
  const measureTree = (node: WhiteboardShape, depth: number): number => {
    const kids = depth > 200 ? [] : children.get(node.id) ?? [];
    const own = kids.reduce((sum, kid) => sum + measureTree(kid, depth + 1), 0) + Math.max(0, kids.length - 1) * verticalGap;
    const height = Math.max(node.h, own);
    heights.set(node.id, height);
    return height;
  };
  measureTree(root, 0);
  const placed = new Map<string, { x: number; y: number }>();
  const place = (node: WhiteboardShape, x: number, centerY: number, depth: number) => {
    placed.set(node.id, { x, y: centerY - node.h / 2 });
    const kids = depth > 200 ? [] : children.get(node.id) ?? [];
    const total = kids.reduce((sum, kid) => sum + heights.get(kid.id)!, 0) + Math.max(0, kids.length - 1) * verticalGap;
    let cursor = centerY - total / 2;
    for (const kid of kids) {
      const height = heights.get(kid.id)!;
      place(kid, x + node.w + horizontalGap, cursor + height / 2, depth + 1);
      cursor += height + verticalGap;
    }
  };
  place(root, root.x, root.y + root.h / 2, 0);
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

export function mindNodeSize(text: string, fontSize: number, measure: Measure): { w: number; h: number } {
  const block = textBlockSize(text || '　', 240, fontSize, false, measure);
  return { w: Math.max(72, Math.ceil(block.width) + textPadding * 2 + 12), h: Math.max(36, block.height + textPadding * 2) };
}

/** Resize a node to its text; mind nodes hug their label instead of keeping a user-set box. */
export function fitMindNode(node: WhiteboardShape, measure: Measure): WhiteboardShape {
  const size = mindNodeSize(node.text, node.fontSize, measure);
  return size.w === node.w && size.h === node.h ? node : { ...node, ...size, y: node.y + (node.h - size.h) / 2 };
}

const branchColors = [palette.blue, palette.green, palette.orange, palette.purple, palette.teal, palette.pink, palette.red];

export function createMindRoot(id: string, x: number, y: number, text: string, measure: Measure): WhiteboardShape {
  const base = createShape(id, { x, y, w: 0, h: 0 }, { shape: 'roundRect', fill: palette.blue, stroke: palette.blue });
  const node: WhiteboardShape = { ...base, text, textColor: '#ffffff', fontSize: 18, mindParentId: null };
  const size = mindNodeSize(text, node.fontSize, measure);
  return { ...node, ...size, x: x - size.w / 2, y: y - size.h / 2 };
}

/** Add a child under `parentId`, after `afterId` among its siblings when given. Returns the laid-out board. */
export function addMindChild(elements: Elements, parentId: string, id: string, measure: Measure, afterId?: string): El[] {
  const index = indexElements(elements);
  const parent = index.get(parentId);
  if (!isMindNode(parent)) return elements as El[];
  const root = mindRootOf(parent, index)!;
  const siblings = elements.filter(el => isMindNode(el) && el.mindParentId === parentId);
  // First-level branches each take a colour; deeper nodes inherit their branch's.
  const stroke = parent.id === root.id ? branchColors[siblings.length % branchColors.length]! : parent.stroke;
  const base = createShape(id, { x: parent.x + parent.w + horizontalGap, y: parent.y, w: 0, h: 0 },
    { shape: 'roundRect', fill: '#ffffff', stroke, strokeWidth: 2 });
  const node = fitText({ ...base, ...mindNodeSize('', 15, measure), fontSize: 15, mindParentId: parentId }, measure) as WhiteboardShape;
  // Array order is sibling order, so insert right after the reference sibling's subtree.
  const anchor = afterId && index.has(afterId) ? afterId : siblings.at(-1)?.id ?? parentId;
  const subtree = mindDescendants(elements, [anchor === parentId ? parentId : anchor]);
  let at = -1;
  elements.forEach((el, i) => { if (subtree.has(el.id) && (anchor !== parentId || el.id === parentId || true)) at = Math.max(at, i); });
  const next = [...elements.slice(0, at + 1), node, ...elements.slice(at + 1)];
  return layoutMind(next, root.id);
}
