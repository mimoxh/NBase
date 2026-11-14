import { HEADING, LINK, type ElementTransformer, type TextMatchTransformer } from '@lexical/markdown';
import { $createTextNode } from 'lexical';
import {
  attachmentPresentationOf, isMarkdownFrontMatter, markdownFrontMatterKey, quickCaptureMarker, type AttachmentPresentation,
} from '@nbase/contracts';
import { markdownFromContent, parseMarkdownImport, readMarkdownFrontMatter, isSafeLinkUrl, withMarkdownTransformers } from './markdown';
import { markdownLines, maskMarkdownInlineLiterals, resolveMarkdownReferences } from './markdownReferences';
import { $createAttachmentNode, AttachmentNode } from './nodes/AttachmentNode';
import { normalizeCodeBlockLanguage } from './codeLanguages';
import type { DocumentContent } from './types';

type JsonNode = Record<string, unknown> & { type: string; version: number; children?: JsonNode[]; $?: Record<string, unknown> };
type Attachment = JsonNode & AttachmentPresentation & { attachmentId: string; fileName: string; mediaType: string; alt: string };

export interface SourceEditPreparation { source: string; diagnostics: string[]; canApply: boolean }
export interface SourceEditResult { content: DocumentContent | null; diagnostics: string[] }

const maxContentBytes = 1024 * 1024;
// Markdown escaping can expand an otherwise valid stored document.
const maxSourceBytes = maxContentBytes * 2;
export const quickCaptureSourceMarker = '<!-- nbase-quick-capture -->';
const captureToken = '\ue000NBASE_SOURCE_CAPTURE\ue001';
const attachmentPattern = /(?<!(?<!\\)(?:\\\\)*\\)(!?)\[((?:\\.|[^\]\\\r\n])*)\]\(nbase-attachment:([^)\s]+)\)/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const elementDefaults: Record<string, unknown> = { direction: null, format: '', indent: 0, textFormat: 0, textStyle: '' };
const textDefaults: Record<string, unknown> = { detail: 0, format: 0, mode: 'normal', style: '' };
const elementTypes = new Set(['root', 'paragraph', 'heading', 'quote', 'callout', 'toggle', 'list', 'listitem', 'code', 'link', 'autolink', 'table', 'tablerow', 'tablecell', 'footnote-definition']);
const textTypes = new Set(['text', 'code-highlight', 'tab', 'image-reference']);

function unique(diagnostics: string[]): string[] { return [...new Set(diagnostics)]; }
function rootOf(content: DocumentContent): JsonNode { return content.editorState.root as unknown as JsonNode; }

function boundedContent(content: DocumentContent): string[] {
  try {
    if (content.schemaVersion !== 1 || rootOf(content).type !== 'root'
      || !Array.isArray(rootOf(content).children)) return ['原始正文结构无效，请保留原始 JSON。'];
    if (new TextEncoder().encode(JSON.stringify(content)).byteLength > maxContentBytes) return ['正文超过 1 MiB 存储限制。'];
    let nodes = 0;
    const visit = (node: JsonNode, depth: number): boolean => {
      if (!node || typeof node !== 'object' || depth > 64 || ++nodes > 20_000
        || typeof node.type !== 'string' || node.version !== 1) return false;
      return node.children === undefined || (Array.isArray(node.children) && node.children.every(child => visit(child, depth + 1)));
    };
    return visit(rootOf(content), 0) ? [] : ['正文节点超过限制或结构无效。'];
  } catch { return ['原始正文结构无效，请保留原始 JSON。']; }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
}

function codeSource(children: JsonNode[]): string | null {
  let source = '';
  const allowed = new Set(['type', 'version', 'text', 'detail', 'format', 'mode', 'style', 'highlightType']);
  for (const child of children) {
    if (Object.keys(child).some(key => !allowed.has(key) || (child.type === 'linebreak' && !['type', 'version'].includes(key))
      || (key === 'highlightType' && child.type !== 'code-highlight'))) return null;
    if (child.type === 'linebreak') source += '\n';
    else if (['text', 'code-highlight', 'tab'].includes(child.type) && typeof child.text === 'string'
      && (child.format === undefined || child.format === 0) && !child.style
      && (child.mode === undefined || child.mode === 'normal')
      && (child.detail === undefined || child.detail === 0 || (child.type === 'tab' && child.detail === 2))) source += child.text;
    else return null;
  }
  return source;
}

/** Keep every serialized property unless it is an explicit Lexical default.
 * Only syntax-colour tokens and adjacent identically formatted text are merged.
 */
function semanticNode(node: JsonNode): Record<string, unknown> {
  const defaults = textTypes.has(node.type) ? textDefaults : elementTypes.has(node.type) ? elementDefaults : {};
  const properties = Object.fromEntries(Object.entries(node).filter(([key, value]) => {
    if (key === 'children') return false;
    if (Object.hasOwn(defaults, key) && defaults[key] === value) return false;
    if (['link', 'autolink'].includes(node.type) && ['rel', 'target', 'title'].includes(key) && value === null) return false;
    if (node.type === 'tablecell' && key === 'backgroundColor' && value === null) return false;
    if (key === '$' && value && typeof value === 'object' && Object.keys(value).length === 0) return false;
    if (['colSpan', 'rowSpan'].includes(key) && node.type === 'tablecell' && value === 1) return false;
    if (key === 'start' && node.type === 'list' && value === 1) return false;
    return true;
  }));
  if (node.type === 'code' && typeof properties.language === 'string') properties.language = normalizeCodeBlockLanguage(properties.language);
  if (node.children) {
    const source = node.type === 'code' ? codeSource(node.children) : null;
    if (source !== null) properties.children = [{ type: 'source', text: source }];
    else {
      const children: Record<string, unknown>[] = [];
      for (const child of node.children) {
        const current = semanticNode(child);
        const previous = children.at(-1);
        if (current.type === 'text' && previous?.type === 'text'
          && JSON.stringify(stable({ ...current, text: '' })) === JSON.stringify(stable({ ...previous, text: '' }))) {
          previous.text = String(previous.text) + String(current.text);
        } else children.push(current);
      }
      properties.children = children;
    }
  }
  return properties;
}

function signature(node: JsonNode): string { return JSON.stringify(stable(semanticNode(node))); }
function isOrdinaryEmptyParagraph(node: JsonNode): boolean {
  return node.type === 'paragraph' && Array.isArray(node.children) && node.children.length === 0
    && signature(node) === signature({ type: 'paragraph', version: 1, children: [] });
}
function withoutCapture(node: JsonNode): JsonNode {
  const state = { ...node.$ };
  delete state[quickCaptureMarker];
  return { ...node, $: state };
}

function context(original: DocumentContent) {
  const diagnostics: string[] = [];
  const attachments = new Map<string, Attachment[]>();
  let capture: JsonNode | undefined;
  const root = rootOf(original);
  const trailingParagraphs: JsonNode[] = [];
  for (let index = root.children!.length - 1; index >= 0; index--) {
    const node = root.children![index]!;
    if (!isOrdinaryEmptyParagraph(node)) break;
    trailingParagraphs.push(node);
  }
  trailingParagraphs.reverse();
  if (root.$ && (Object.keys(root.$).some(key => key !== markdownFrontMatterKey)
    || (Object.hasOwn(root.$, markdownFrontMatterKey) && !isMarkdownFrontMatter(root.$[markdownFrontMatterKey])))) {
    diagnostics.push('正文含无法安全保全的根元数据。');
  }
  const visit = (node: JsonNode, depth: number) => {
    if (node.$ && Object.hasOwn(node.$, quickCaptureMarker)) {
      if (capture || depth !== 1 || node.type !== 'heading' || node.$[quickCaptureMarker] !== true) {
        diagnostics.push('随手记标记必须属于唯一顶层标题。');
      } else capture = node;
    }
    if (node.type === 'attachment') {
      if (typeof node.attachmentId !== 'string' || !uuid.test(node.attachmentId)
        || typeof node.alt !== 'string' || typeof node.fileName !== 'string' || typeof node.mediaType !== 'string') {
        diagnostics.push('原始正文附件信息无效。');
      } else {
        const key = node.attachmentId.toLowerCase();
        const previous = attachments.get(key) ?? [];
        if (previous.some(item => item.fileName !== node.fileName || item.mediaType !== node.mediaType)) diagnostics.push('同一附件 ID 的原始元数据不一致。');
        previous.push(node as Attachment);
        attachments.set(key, previous);
      }
    }
    node.children?.forEach(child => visit(child, depth + 1));
  };
  visit(root, 0);
  if (capture && root.children!.filter(node => node.type === 'heading'
    && signature(withoutCapture(node)) === signature(withoutCapture(capture!))).length !== 1) {
    diagnostics.push('随手记标题存在同名同格式项，无法唯一保全标记。');
  }

  const attachment: TextMatchTransformer = {
    type: 'text-match', dependencies: [AttachmentNode],
    importRegExp: attachmentPattern, regExp: /(?!)x/,
    export: node => node instanceof AttachmentNode ? node.getMarkdown() : null,
    replace(node, match) {
      const id = match[3]!.toLowerCase();
      const known = attachments.get(id);
      const label = match[2]!.replace(/\\([!-/:-@[-`{-~])/g, '$1');
      const reference = known?.find(item => (item.mediaType.startsWith('image/') ? item.alt || item.fileName : item.fileName) === label) ?? known?.[0];
      if (!reference) {
        diagnostics.push('源码包含原正文以外的附件 ID，已阻止应用。');
        node.replace($createTextNode(match[0]));
        return;
      }
      const image = reference.mediaType.startsWith('image/');
      if (image !== Boolean(match[1]) || (!image && label !== reference.fileName) || label.length > 500) {
        diagnostics.push('附件类型或显示文字无法安全转换，请保留原附件写法。');
        node.replace($createTextNode(match[0]));
        return;
      }
      const alt = image && label !== (reference.alt || reference.fileName) ? label : reference.alt;
      node.replace($createAttachmentNode(reference.attachmentId, alt, reference.fileName, reference.mediaType, attachmentPresentationOf(reference)));
    },
  };
  // Other headings fall through, so aligned or indented ones still get their `<div>` wrapper.
  const captureHeading: ElementTransformer = { ...HEADING, export(node, ...args) {
    if ((node.exportJSON() as unknown as JsonNode).$?.[quickCaptureMarker] !== true) return null;
    const rendered = HEADING.export?.(node, ...args) ?? null;
    return rendered === null ? null : quickCaptureSourceMarker + '\n' + rendered;
  } };
  return { diagnostics, attachments, capture, trailingParagraphs, transforms: withMarkdownTransformers([attachment, captureHeading]) };
}

function parseBody(source: string, original: DocumentContent, data: ReturnType<typeof context>): SourceEditResult {
  const start = data.diagnostics.length;
  if (source.length > maxSourceBytes || new TextEncoder().encode(source).byteLength > maxSourceBytes) {
    return { content: null, diagnostics: ['源码超过 2 MiB 转换限制，输入仍可复制。'] };
  }
  if (source.includes(captureToken)) return { content: null, diagnostics: ['源码包含内部保留标识。'] };
  const frontMatter = readMarkdownFrontMatter(source);
  if (frontMatter.body !== source || frontMatter.preservedAsSource) {
    return { content: null, diagnostics: ['源码编辑只接受正文，请通过页面设置修改元数据。'] };
  }
  const lines = markdownLines(source);
  const markers = lines.flatMap((line, index) => line.prose?.trim() === quickCaptureSourceMarker ? [index] : []);
  if (markers.length !== (data.capture ? 1 : 0)) return { content: null, diagnostics: ['随手记源码标记缺失、重复或未经原正文授权。'] };
  const raw = lines.map(line => line.raw);
  if (data.capture) {
    const index = markers[0]!;
    const line = lines[index]!;
    const next = lines[index + 1];
    if (line.prefix || !next || next.prefix || !/^ {0,3}#{1,6}[ \t]+/.test(next.prose ?? '')) {
      return { content: null, diagnostics: ['随手记源码标记必须紧邻顶层标题，不能移入引用或代码。'] };
    }
    raw[index] = '';
    raw[index + 1] = raw[index + 1]!.replace(/^( {0,3}#{1,6}[ \t]+)/, '$1' + captureToken);
  }
  const body = raw.join('\n');
  // Inspect resolved links before the normal importer can turn an unsupported
  // protocol into literal text. Fences and inline code remain literal.
  const resolved = resolveMarkdownReferences(body);
  const sections = [resolved.body, ...resolved.footnotes.map(note => note.markdown)];
  const prose = sections.flatMap(section => markdownLines(section).flatMap(line =>
    line.prose === null ? [] : [maskMarkdownInlineLiterals(line.prose)])).join('\n');
  for (const match of prose.matchAll(new RegExp('(?<!(?<!\\\\)(?:\\\\\\\\)*\\\\)' + LINK.importRegExp!.source, 'g'))) {
    const rawUrl = match[2] ?? match[3] ?? '';
    const decoded = rawUrl.replace(/\\([!-/:-@[-`{-~])/g, '$1');
    const relativeAngle = match[2] !== undefined && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(decoded.trim());
    const url = relativeAngle ? decoded.replace(/ /g, '%20') : decoded;
    if (url.startsWith('nbase-attachment:')) {
      if (!new RegExp('^(?:' + attachmentPattern.source + ')$', 'i').test(match[0])) {
        data.diagnostics.push('附件引用含不支持的标题或目标写法，请保留原附件语法。');
      }
    } else if (!isSafeLinkUrl(url)) {
      data.diagnostics.push('源码包含不能安全导入的链接，已阻止有损转换。');
    }
  }
  const parsed = parseMarkdownImport(body, data.transforms, { preserveFootnotePosition: true });
  if (parsed.preservedAsSource) return { content: null, diagnostics: ['输入无法作为结构化正文导入。', ...parsed.warnings] };
  const content = parsed.content;
  const root = rootOf(content);
  if (data.capture) {
    const targets = root.children!.filter(node => node.type === 'heading'
      && node.children?.[0]?.type === 'text' && String(node.children[0].text).startsWith(captureToken));
    if (targets.length !== 1) return { content: null, diagnostics: ['随手记标记无法唯一定位顶层标题。'] };
    const target = targets[0]!;
    const first = target.children![0]!;
    first.text = String(first.text).slice(captureToken.length);
    if (first.text === '') target.children!.shift();
    if (signature(target) !== signature(withoutCapture(data.capture))
      || root.children!.filter(node => node.type === 'heading' && signature(node) === signature(target)).length !== 1) {
      return { content: null, diagnostics: ['随手记标记移动到了其他标题，或受保护标题已改变，请保留原标记与标题。'] };
    }
    target.$ = { ...data.capture.$ };
  }
  const originalState = rootOf(original).$;
  if (originalState) root.$ = structuredClone(originalState);
  if (data.trailingParagraphs.length) {
    // Lexical keeps an empty paragraph after an inserted table as a cursor exit.
    // Markdown omits it, so retain the original ordinary empty suffix verbatim.
    // Formatted paragraphs and unknown attributes still fail the full comparison.
    while (root.children!.length && isOrdinaryEmptyParagraph(root.children!.at(-1)!)) root.children!.pop();
    root.children!.push(...structuredClone(data.trailingParagraphs));
  }
  const diagnostics = unique([...data.diagnostics.slice(start), ...boundedContent(content)]);
  return { content: diagnostics.length ? null : content, diagnostics };
}

function fallbackSource(content: DocumentContent): string {
  try { return JSON.stringify(content, null, 2); } catch { return '原始正文无法序列化，请保留原始数据。'; }
}

export function prepareSourceEdit(content: DocumentContent): SourceEditPreparation {
  let source = fallbackSource(content);
  const invalid = boundedContent(content);
  if (invalid.length) return { source, diagnostics: invalid, canApply: false };
  try {
    const data = context(content);
    source = markdownFromContent(content, data.transforms);
    if (data.diagnostics.length) return { source, diagnostics: unique(data.diagnostics), canApply: false };
    const parsed = parseBody(source, content, data);
    const diagnostics = parsed.content && signature(rootOf(parsed.content)) === signature(rootOf(content)) ? []
      : [...parsed.diagnostics, '原始正文含 Markdown 不能完整表达的结构或属性，已阻止源码应用。'];
    return { source, diagnostics: unique(diagnostics), canApply: diagnostics.length === 0 };
  } catch {
    return { source, diagnostics: ['原始正文含无法导出的节点或结构，请保留源码与原始 JSON。'], canApply: false };
  }
}

export function parseSourceEdit(source: string, original: DocumentContent): SourceEditResult {
  const preparation = prepareSourceEdit(original);
  if (!preparation.canApply) return { content: null, diagnostics: preparation.diagnostics };
  try {
    const data = context(original);
    const parsed = parseBody(source, original, data);
    if (!parsed.content) return parsed;
    const candidateSource = markdownFromContent(parsed.content, data.transforms);
    const roundtrip = parseBody(candidateSource, original, data);
    if (!roundtrip.content || signature(rootOf(parsed.content)) !== signature(rootOf(roundtrip.content))) {
      return { content: null, diagnostics: unique([...roundtrip.diagnostics, '输入转换结果无法再次完整往返，已保留输入并阻止应用。']) };
    }
    return parsed;
  } catch {
    return { content: null, diagnostics: ['源码转换失败，原正文与输入均应保留。'] };
  }
}
