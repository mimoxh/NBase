import { quickCaptureLimit, quickCaptureMarker, type StoredDocumentContent } from '@nbase/contracts';
import { validateDocumentContent } from '../pages/validate.js';

interface DocumentNode {
  type: string;
  tag?: string;
  children?: DocumentNode[];
  $?: Record<string, unknown>;
  [key: string]: unknown;
}

function element(type: string, children: DocumentNode[]): DocumentNode {
  return { type, version: 1, direction: null, format: '', indent: 0, children };
}

function textNode(text: string): DocumentNode {
  return { type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text };
}

export function blankDailyContent(): StoredDocumentContent {
  return { schemaVersion: 1, editorState: { root: element('root', [element('paragraph', [])]) } };
}

export function validNoteDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

export function normalizeNoteTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || !/^[a-z][a-z0-9/_+-]*$/i.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

export function noteDateAt(timeZone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'gregory', numberingSystem: 'latn',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value;
  return [part('year').padStart(4, '0'), part('month'), part('day')].join('-');
}

export function normalizeQuickCapture(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > quickCaptureLimit * 2) return null;
  const text = value.replace(/\r\n?/g, '\n');
  if (!text.trim() || [...text].length > quickCaptureLimit || /[\u0000-\u0008\u000b-\u001f\u007f\p{Surrogate}]/u.test(text)) return null;
  return text;
}

export function appendQuickCapture(content: StoredDocumentContent, text: string): StoredDocumentContent {
  validateDocumentContent(content);
  const root = content.editorState.root as DocumentNode & { children: DocumentNode[] };
  const children = [...root.children];
  let heading = children.findIndex(node => node.type === 'heading' && node.$?.[quickCaptureMarker] === true);
  if (heading === -1) {
    if (children.length === 1 && children[0]!.type === 'paragraph' && children[0]!.children?.length === 0) {
      children.length = 0;
    }
    heading = children.length;
    children.push({ ...element('heading', [textNode('随手记')]), tag: 'h2', $: { [quickCaptureMarker]: true } });
  }
  const level = Number(children[heading]!.tag!.slice(1));
  const next = children.findIndex((node, index) => index > heading && node.type === 'heading'
    && Number(node.tag!.slice(1)) <= level);
  const nodes = text.split(/(\n|\t)/).filter(Boolean).map(value => {
    if (value === '\n') return { type: 'linebreak', version: 1 };
    if (value === '\t') return { ...textNode(value), type: 'tab' };
    return textNode(value);
  });
  children.splice(next === -1 ? children.length : next, 0, element('paragraph', nodes));
  return validateDocumentContent({ ...content, editorState: { ...content.editorState, root: { ...root, children } } });
}
