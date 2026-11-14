import type { StoredDocumentContent } from './pages.js';

/**
 * A whiteboard page stores its board next to an empty document body, so every consumer of
 * StoredDocumentContent keeps working and the page reuses revisions, history, trash and drafts.
 * Viewport, selection and tool state are view state and never part of the content.
 */
export const whiteboardLimits = {
  maxElements: 5000,
  /** Same budget as document bodies; counted over the whole content JSON in UTF-8. */
  maxBytes: 1024 * 1024,
  maxText: 10_000,
  maxName: 200,
  maxLabel: 255,
  /** Flat x,y pairs per stroke. */
  maxPenNumbers: 8000,
  maxCoordinate: 10_000_000,
  maxSize: 1_000_000,
  maxStrokeWidth: 64,
  minFontSize: 4,
  maxFontSize: 400,
} as const;

export const whiteboardShapeKinds = ['rect', 'roundRect', 'ellipse', 'diamond', 'triangle'] as const;
export type WhiteboardShapeKind = typeof whiteboardShapeKinds[number];
export const whiteboardStrokeStyles = ['solid', 'dashed', 'dotted'] as const;
export type WhiteboardStrokeStyle = typeof whiteboardStrokeStyles[number];
export const whiteboardTextAligns = ['left', 'center', 'right'] as const;
export type WhiteboardTextAlign = typeof whiteboardTextAligns[number];
export const whiteboardConnectorModes = ['straight', 'elbow', 'curve'] as const;
export type WhiteboardConnectorMode = typeof whiteboardConnectorModes[number];
export const whiteboardArrowheads = ['none', 'arrow', 'triangle', 'dot', 'diamond'] as const;
export type WhiteboardArrowhead = typeof whiteboardArrowheads[number];

interface BoxElement {
  /** Client-generated UUID; a persistent identity that connectors and mind-map children refer to. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Radians, clockwise, around the box centre. */
  angle: number;
  locked?: boolean;
  groupId?: string;
}

export interface WhiteboardShape extends BoxElement {
  type: 'shape';
  shape: WhiteboardShapeKind;
  /** `#rrggbb`, `#rrggbbaa` or `transparent`; stored for the light theme and adapted when drawn dark. */
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeStyle: WhiteboardStrokeStyle;
  text: string;
  textColor: string;
  fontSize: number;
  textAlign: WhiteboardTextAlign;
  /** Present on mind-map nodes: the parent node id, or null on the root. */
  mindParentId?: string | null;
}

export interface WhiteboardText extends BoxElement {
  type: 'text';
  text: string;
  color: string;
  fontSize: number;
  textAlign: WhiteboardTextAlign;
  bold?: boolean;
}

export interface WhiteboardNote extends BoxElement {
  type: 'note';
  text: string;
  /** Paper colour. */
  color: string;
  fontSize: number;
  textAlign: WhiteboardTextAlign;
}

export interface WhiteboardFrame extends BoxElement {
  type: 'frame';
  name: string;
}

export interface WhiteboardImage extends BoxElement {
  type: 'image';
  attachmentId: string;
  fileName: string;
  mediaType: string;
}

/** A reference card to a page by stable id; the label is the title seen when the card was placed. */
export interface WhiteboardCard extends BoxElement {
  type: 'card';
  pageId: string;
  label: string;
  /** Absent: a title chip. `preview`: the page itself, shown live inside the box and editable in place. */
  view?: 'preview';
}

/** A live view of a database; rows and schema stay in the database, the board stores ids only. */
export interface WhiteboardDatabase extends BoxElement {
  type: 'database';
  databaseId: string;
  /** Absent shows the first view of the database. */
  viewId?: string;
}

export interface WhiteboardPen extends BoxElement {
  type: 'pen';
  /** Flat x,y pairs relative to the element's top-left corner at its stored size. */
  points: number[];
  color: string;
  strokeWidth: number;
  highlighter?: boolean;
}

export interface WhiteboardConnectorEnd {
  /** Last resolved position; authoritative when unbound, a fallback when bound. */
  x: number;
  y: number;
  /** Attachment to another element at a normalised point of its box (0..1 on both axes). */
  bind?: { elementId: string; ax: number; ay: number };
}

export interface WhiteboardConnector {
  id: string;
  type: 'connector';
  mode: WhiteboardConnectorMode;
  source: WhiteboardConnectorEnd;
  target: WhiteboardConnectorEnd;
  stroke: string;
  strokeWidth: number;
  strokeStyle: WhiteboardStrokeStyle;
  startArrow: WhiteboardArrowhead;
  endArrow: WhiteboardArrowhead;
  text: string;
  locked?: boolean;
  groupId?: string;
}

export type WhiteboardBoxElement = WhiteboardShape | WhiteboardText | WhiteboardNote | WhiteboardFrame
  | WhiteboardImage | WhiteboardCard | WhiteboardDatabase | WhiteboardPen;
export type WhiteboardElement = WhiteboardBoxElement | WhiteboardConnector;
export type WhiteboardElementType = WhiteboardElement['type'];

export interface WhiteboardBoard {
  /** Array order is z-order, back to front. */
  elements: WhiteboardElement[];
}

export interface WhiteboardContent extends StoredDocumentContent {
  schemaVersion: 1;
  board: WhiteboardBoard;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const colorPattern = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const controlChars = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const lineBreaks = new RegExp(`[\\n\\r${String.fromCharCode(0x2028, 0x2029)}]`);

const boxKeys = ['id', 'type', 'x', 'y', 'w', 'h', 'angle', 'locked', 'groupId'];
const allowedKeys: Record<WhiteboardElementType, ReadonlySet<string>> = {
  shape: new Set([...boxKeys, 'shape', 'fill', 'stroke', 'strokeWidth', 'strokeStyle', 'text', 'textColor', 'fontSize', 'textAlign', 'mindParentId']),
  text: new Set([...boxKeys, 'text', 'color', 'fontSize', 'textAlign', 'bold']),
  note: new Set([...boxKeys, 'text', 'color', 'fontSize', 'textAlign']),
  frame: new Set([...boxKeys, 'name']),
  image: new Set([...boxKeys, 'attachmentId', 'fileName', 'mediaType']),
  card: new Set([...boxKeys, 'pageId', 'label', 'view']),
  database: new Set([...boxKeys, 'databaseId', 'viewId']),
  pen: new Set([...boxKeys, 'points', 'color', 'strokeWidth', 'highlighter']),
  connector: new Set(['id', 'type', 'mode', 'source', 'target', 'stroke', 'strokeWidth', 'strokeStyle', 'startArrow', 'endArrow', 'text', 'locked', 'groupId']),
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const coordinate = (value: unknown) => finite(value, -whiteboardLimits.maxCoordinate, whiteboardLimits.maxCoordinate);
const uuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const color = (value: unknown) => typeof value === 'string' && (value === 'transparent' || colorPattern.test(value));
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !controlChars.test(value);
const oneOf = (list: readonly string[], value: unknown) => typeof value === 'string' && list.includes(value);
const optionalFlag = (value: unknown) => value === undefined || typeof value === 'boolean';

export function isWhiteboardColor(value: unknown): value is string { return color(value); }

function endProblem(end: unknown): string | null {
  if (!record(end) || Object.keys(end).some(key => !['x', 'y', 'bind'].includes(key))) return 'connector end';
  if (!coordinate(end.x) || !coordinate(end.y)) return 'connector end position';
  if (end.bind === undefined) return null;
  const bind = end.bind;
  if (!record(bind) || Object.keys(bind).some(key => !['elementId', 'ax', 'ay'].includes(key))
    || !uuid(bind.elementId) || !finite(bind.ax, 0, 1) || !finite(bind.ay, 0, 1)) return 'connector binding';
  return null;
}

function elementProblem(el: unknown): string | null {
  if (!record(el)) return 'element';
  const type = el.type;
  if (typeof type !== 'string' || !Object.hasOwn(allowedKeys, type)) return 'element type';
  const allowed = allowedKeys[type as WhiteboardElementType];
  for (const key of Object.keys(el)) if (forbiddenKeys.has(key) || !allowed.has(key)) return `${type} key`;
  if (!uuid(el.id)) return 'element id';
  if (!optionalFlag(el.locked) || (el.groupId !== undefined && !uuid(el.groupId))) return `${type} flags`;
  if (type === 'connector') {
    if (!oneOf(whiteboardConnectorModes, el.mode) || !color(el.stroke) || !finite(el.strokeWidth, 0.5, whiteboardLimits.maxStrokeWidth)
      || !oneOf(whiteboardStrokeStyles, el.strokeStyle) || !oneOf(whiteboardArrowheads, el.startArrow)
      || !oneOf(whiteboardArrowheads, el.endArrow) || !text(el.text, whiteboardLimits.maxLabel)) return 'connector';
    return endProblem(el.source) ?? endProblem(el.target);
  }
  if (!coordinate(el.x) || !coordinate(el.y) || !finite(el.w, 0, whiteboardLimits.maxSize)
    || !finite(el.h, 0, whiteboardLimits.maxSize) || !finite(el.angle, -1000, 1000)) return `${type} box`;
  const fontOk = () => finite(el.fontSize, whiteboardLimits.minFontSize, whiteboardLimits.maxFontSize)
    && oneOf(whiteboardTextAligns, el.textAlign) && text(el.text, whiteboardLimits.maxText);
  switch (type as WhiteboardBoxElement['type']) {
    case 'shape':
      return oneOf(whiteboardShapeKinds, el.shape) && color(el.fill) && color(el.stroke) && color(el.textColor)
        && finite(el.strokeWidth, 0, whiteboardLimits.maxStrokeWidth) && oneOf(whiteboardStrokeStyles, el.strokeStyle) && fontOk()
        && (el.mindParentId === undefined || el.mindParentId === null || uuid(el.mindParentId)) ? null : 'shape';
    case 'text': return color(el.color) && fontOk() && optionalFlag(el.bold) ? null : 'text';
    case 'note': return color(el.color) && fontOk() ? null : 'note';
    case 'frame': return text(el.name, whiteboardLimits.maxName) ? null : 'frame';
    case 'image':
      return uuid(el.attachmentId) && typeof el.fileName === 'string' && el.fileName.length >= 1 && el.fileName.length <= 180
        && typeof el.mediaType === 'string' && el.mediaType.startsWith('image/') && el.mediaType.length <= 100 ? null : 'image';
    case 'card':
      return uuid(el.pageId) && text(el.label, whiteboardLimits.maxLabel) && !lineBreaks.test(el.label)
        && (el.view === undefined || el.view === 'preview') ? null : 'card';
    case 'database':
      return uuid(el.databaseId) && (el.viewId === undefined || uuid(el.viewId)) ? null : 'database';
    case 'pen': {
      const points = el.points;
      if (!Array.isArray(points) || points.length < 2 || points.length % 2 !== 0
        || points.length > whiteboardLimits.maxPenNumbers) return 'pen points';
      for (const value of points) if (!coordinate(value)) return 'pen points';
      return color(el.color) && finite(el.strokeWidth, 0.5, whiteboardLimits.maxStrokeWidth) && optionalFlag(el.highlighter) ? null : 'pen';
    }
  }
}

/** The document half of a whiteboard page stays an empty body: a root with at most one empty paragraph. */
function emptyBody(editorState: unknown): boolean {
  if (!record(editorState) || !record(editorState.root)) return false;
  const root = editorState.root;
  if (root.type !== 'root' || root.version !== 1 || !Array.isArray(root.children) || root.children.length > 1) return false;
  const only: unknown = root.children[0];
  return only === undefined || (record(only) && only.type === 'paragraph' && only.version === 1
    && Array.isArray(only.children) && only.children.length === 0);
}

export function emptyWhiteboardEditorState(): StoredDocumentContent['editorState'] {
  return { root: { children: [{ children: [], direction: null, format: '', indent: 0, type: 'paragraph', version: 1,
    textFormat: 0, textStyle: '' }], direction: null, format: '', indent: 0, type: 'root', version: 1 } };
}

export function whiteboardContent(elements: WhiteboardElement[]): WhiteboardContent {
  return { schemaVersion: 1, editorState: emptyWhiteboardEditorState(), board: { elements } };
}

/** Shape test only; storage additionally requires whiteboardContentProblem to return null. */
export function isWhiteboardContent(value: unknown): value is WhiteboardContent {
  return record(value) && Object.hasOwn(value, 'board');
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}

export function whiteboardContentBytes(value: unknown): number {
  try { return utf8Length(JSON.stringify(value)); } catch { return Number.POSITIVE_INFINITY; }
}

/** Returns null when the value is storable whiteboard content, otherwise a short reason for logs and tests. */
export function whiteboardContentProblem(value: unknown): string | null {
  if (!record(value)) return 'content';
  if (value.schemaVersion !== 1) return 'schemaVersion';
  if (Object.keys(value).some(key => !['schemaVersion', 'editorState', 'board'].includes(key))) return 'content key';
  if (!emptyBody(value.editorState)) return 'document body';
  const board = value.board;
  if (!record(board) || Object.keys(board).some(key => key !== 'elements')) return 'board';
  const elements = board.elements;
  if (!Array.isArray(elements) || elements.length > whiteboardLimits.maxElements) return 'elements';
  if (whiteboardContentBytes(value) > whiteboardLimits.maxBytes) return 'size';
  const types = new Map<string, string>();
  for (const el of elements) {
    const problem = elementProblem(el);
    if (problem) return problem;
    const { id, type } = el as WhiteboardElement;
    if (types.has(id)) return 'duplicate id';
    types.set(id, type);
  }
  const mindParents = new Map<string, string | null>();
  for (const el of elements as WhiteboardElement[]) {
    if (el.type === 'connector') {
      for (const end of [el.source, el.target]) {
        const target = end.bind && types.get(end.bind.elementId);
        if (end.bind && (!target || target === 'connector')) return 'connector target';
      }
    } else if (el.type === 'shape' && el.mindParentId !== undefined) {
      if (el.mindParentId !== null && types.get(el.mindParentId) !== 'shape') return 'mind parent';
      mindParents.set(el.id, el.mindParentId);
    }
  }
  for (const [id, parent] of mindParents) {
    if (parent !== null && !mindParents.has(parent)) return 'mind parent';
    let cursor: string | null = parent;
    for (let steps = 0; cursor !== null; steps += 1) {
      if (cursor === id || steps > mindParents.size) return 'mind cycle';
      cursor = mindParents.get(cursor) ?? null;
    }
  }
  return null;
}

const squash = (value: string) => value.replace(/\s+/gu, ' ').trim();

/** Everything a reader can see as text on the board, in z-order, for search and previews. */
export function whiteboardSearchText(board: WhiteboardBoard): string {
  const parts: string[] = [];
  for (const el of board.elements) {
    const value = el.type === 'frame' ? el.name : el.type === 'card' ? el.label : el.type === 'image' ? el.fileName
      : el.type === 'pen' || el.type === 'database' ? '' : el.text;
    const clean = squash(value);
    if (clean) parts.push(clean);
  }
  return parts.join(' ');
}

export interface WhiteboardPageReference { targetPageId: string; occurrence: number; snippet: string }

/** Page cards and database views in z-order; `occurrence` counts them, mirroring page references in documents. */
export function whiteboardPageReferences(board: WhiteboardBoard): WhiteboardPageReference[] {
  const result: WhiteboardPageReference[] = [];
  for (const el of board.elements) {
    if (el.type === 'card') result.push({ targetPageId: el.pageId, occurrence: result.length, snippet: squash(el.label) || '白板引用卡片' });
    else if (el.type === 'database') result.push({ targetPageId: el.databaseId, occurrence: result.length, snippet: '白板中的数据库视图' });
  }
  return result;
}

/** A whiteboard shown inside a document. It stores only the page id; the board stays in its own page. */
export interface SerializedWhiteboardView {
  type: 'whiteboard-view';
  version: 1;
  pageId: string;
  /** Block height in CSS pixels; absent uses the default. */
  height?: number;
}

export const whiteboardViewHeight = { min: 240, max: 1600, initial: 460 } as const;

export function isSerializedWhiteboardView(value: unknown): value is SerializedWhiteboardView {
  if (!record(value) || Object.keys(value).some(key => !['type', 'version', 'pageId', 'height', '$'].includes(key))) return false;
  return value.type === 'whiteboard-view' && value.version === 1 && uuid(value.pageId)
    && (value.height === undefined || (Number.isInteger(value.height)
      && finite(value.height, whiteboardViewHeight.min, whiteboardViewHeight.max)));
}

export function whiteboardAttachments(board: WhiteboardBoard): { id: string; fileName: string; mediaType: string }[] {
  return board.elements.flatMap(el => el.type === 'image' ? [{ id: el.attachmentId, fileName: el.fileName, mediaType: el.mediaType }] : []);
}
