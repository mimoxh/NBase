import { isCalloutKind, parseTextStyle, textColorHex, type StoredDocumentContent } from '@nbase/contracts';
import { isSafeLinkUrl } from '../editor/markdown';
import { calloutLabels } from '../editor/nodes/CalloutNode';
import {
  BULLET_NUM, CONTENT_TWIPS, contentTypesXml, coreXml, documentXml, footnotesXml, LIST_INDENT, MEDIA_EXTENSIONS, numberingXml,
  packageRelsXml, PAGE, relationshipsXml, REL_TYPES, settingsXml, stylesXml, xmlAttr, xmlText,
} from './docxParts';
import type { ExportFile, ExportResources, RasterImage } from './resources';
import { utf8, zipEntries, type ZipEntry } from './zip';
import {
  blockAlign, childrenOf, codeText, hasFormat, indexFootnotes, INLINE_LEAVES, int, isRowHeader, rootOf, str, tableLayout, TEXT_FORMAT,
  typeOf, visibleText, type FootnoteIndex, type SerializedNode,
} from './tree';

export interface RunStyle {
  bold?: boolean; italic?: boolean; strike?: boolean; underline?: boolean; code?: boolean; highlight?: boolean;
  color?: string; shade?: string; vertAlign?: 'superscript' | 'subscript'; rStyle?: string;
}
/** Where a block sits: inherited paragraph style, box (callout), extra indent (toggle, nesting) and width budget. */
export interface BlockFrame {
  pStyle?: string | undefined; indent: number; border?: string | undefined; shade?: string | undefined; bold?: boolean | undefined;
  widthTwips: number; inFootnote?: boolean | undefined;
}
export interface DocxContext {
  resources: ExportResources;
  footnotes: FootnoteIndex;
  blocks: (nodes: SerializedNode[], frame: BlockFrame) => string;
  block: (node: SerializedNode, frame: BlockFrame) => string;
  inlines: (nodes: SerializedNode[], style: RunStyle, frame: BlockFrame) => string;
  inline: (node: SerializedNode, style: RunStyle, frame: BlockFrame) => string;
  paragraph: (runs: string, frame: BlockFrame, options?: ParagraphOptions) => string;
  run: (text: string, style: RunStyle) => string;
  hyperlink: (url: string) => string | null;
  image: (file: ExportFile | RasterImage & { mediaType: string; fileName: string }, widthPercent: number | null, frame: BlockFrame, alt: string) => string;
  footnote: (id: string, frame: BlockFrame) => string;
  ordered: (start: number, ilvl: number) => number;
}
export interface ParagraphOptions { pStyle?: string; align?: string | null; numbering?: { numId: number; ilvl: number }; ind?: { left: number; hanging?: number }; keepNext?: boolean; spacing?: string }
export interface DocxRenderer {
  block?: ((node: SerializedNode, context: DocxContext, frame: BlockFrame) => string) | undefined;
  inline?: ((node: SerializedNode, context: DocxContext, style: RunStyle, frame: BlockFrame) => string) | undefined;
}

const renderers = new Map<string, DocxRenderer>();
/** Adds or replaces the Word renderer for one serialized node type; a node used both ways may define both. */
export function registerDocxRenderer(type: string, renderer: DocxRenderer): void { renderers.set(type, renderer); }

const TWIP_EMU = 635;
const PX_EMU = 9525;
const hex = (value: string) => value.replace('#', '').toUpperCase();
const jc = (align: string | null | undefined) => align === 'justify' ? 'both' : align === 'center' || align === 'right' ? align : null;

function runProperties(style: RunStyle): string {
  // Schema order: rStyle, b, i, strike, color, highlight, u, shd, vertAlign.
  const parts = [
    style.rStyle || style.code ? `<w:rStyle w:val="${style.rStyle ?? 'CodeChar'}"/>` : '',
    style.bold ? '<w:b/><w:bCs/>' : '', style.italic ? '<w:i/><w:iCs/>' : '', style.strike ? '<w:strike/>' : '',
    style.color ? `<w:color w:val="${style.color}"/>` : '', style.highlight ? '<w:highlight w:val="yellow"/>' : '',
    style.underline ? '<w:u w:val="single"/>' : '', style.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${style.shade}"/>` : '',
    style.vertAlign ? `<w:vertAlign w:val="${style.vertAlign}"/>` : '',
  ].join('');
  return parts ? `<w:rPr>${parts}</w:rPr>` : '';
}

function run(text: string, style: RunStyle): string {
  if (!text) return '';
  const props = runProperties(style);
  const pieces = text.split(/(\n|\t)/).map(piece => piece === '\n' ? '<w:br/>' : piece === '\t' ? '<w:tab/>'
    : piece ? `<w:t xml:space="preserve">${xmlText(piece)}</w:t>` : '').join('');
  return pieces ? `<w:r>${props}${pieces}</w:r>` : '';
}

function textStyle(node: SerializedNode, base: RunStyle): RunStyle {
  const { color, background } = parseTextStyle(str(node.style));
  const style: RunStyle = { ...base };
  if (hasFormat(node, TEXT_FORMAT.bold)) style.bold = true;
  if (hasFormat(node, TEXT_FORMAT.italic)) style.italic = true;
  if (hasFormat(node, TEXT_FORMAT.strikethrough)) style.strike = true;
  if (hasFormat(node, TEXT_FORMAT.underline)) style.underline = true;
  if (hasFormat(node, TEXT_FORMAT.code)) style.code = true;
  if (hasFormat(node, TEXT_FORMAT.highlight)) style.highlight = true;
  if (hasFormat(node, TEXT_FORMAT.superscript)) style.vertAlign = 'superscript';
  if (hasFormat(node, TEXT_FORMAT.subscript)) style.vertAlign = 'subscript';
  if (color) style.color = hex(textColorHex[color].text);
  if (background) style.shade = hex(textColorHex[background].background);
  return style;
}

function paragraphXml(runs: string, frame: BlockFrame, options: ParagraphOptions = {}): string {
  const pStyle = options.pStyle ?? frame.pStyle;
  const box = frame.border ? `<w:pBdr>${['top', 'left', 'bottom', 'right'].map(side =>
    `<w:${side} w:val="single" w:sz="${side === 'left' ? 18 : 4}" w:space="6" w:color="${frame.border}"/>`).join('')}</w:pBdr>` : '';
  const ind = options.ind ?? (frame.indent ? { left: frame.indent } : null);
  const align = jc(options.align);
  // Schema order: pStyle, keepNext, numPr, pBdr, shd, spacing, ind, jc.
  const props = (pStyle ? `<w:pStyle w:val="${pStyle}"/>` : '') + (options.keepNext ? '<w:keepNext/>' : '')
    + (options.numbering ? `<w:numPr><w:ilvl w:val="${options.numbering.ilvl}"/><w:numId w:val="${options.numbering.numId}"/></w:numPr>` : '')
    + box + (frame.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${frame.shade}"/>` : '') + (options.spacing ?? '')
    + (ind ? `<w:ind w:left="${ind.left}"${ind.hanging ? ` w:hanging="${ind.hanging}"` : ''}/>` : '') + (align ? `<w:jc w:val="${align}"/>` : '');
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs}</w:p>`;
}

const isImageAttachment = (node: SerializedNode) => typeOf(node) === 'attachment' && str(node.mediaType).startsWith('image/');
const isInlineNode = (node: SerializedNode) => INLINE_LEAVES.has(typeOf(node)) && !(typeOf(node) === 'equation' && node.inline === false)
  || ['link', 'autolink'].includes(typeOf(node));

/** Inline content of one block; image attachments break out into their own aligned paragraph with caption. */
function inlineBlock(node: SerializedNode, context: DocxContext, frame: BlockFrame, options: ParagraphOptions, base: RunStyle = {}): string {
  const out: string[] = [];
  let pending: SerializedNode[] = [];
  const flush = (force: boolean) => {
    if (!pending.length && !force) return;
    out.push(context.paragraph(context.inlines(pending, frame.bold ? { ...base, bold: true } : base, frame), frame, options));
    pending = [];
  };
  const kids = childrenOf(node);
  for (const child of kids) {
    if (isImageAttachment(child) && context.resources.files.has(str(child.attachmentId).toLowerCase())) {
      flush(false);
      out.push(context.block(child, frame));
    } else pending.push(child);
  }
  flush(out.length === 0);
  return out.join('');
}

const calloutBorder = { NOTE: '6F8FB0', WARNING: 'D08A2C', IMPORTANT: '8B62C0' } as const;
/** Frame without the callout box, for blocks that bring their own (code). */
const plain = ({ border: _border, shade: _shade, ...rest }: BlockFrame): BlockFrame => rest;

const builtinsBlock: Record<string, DocxRenderer['block']> = {
  root: (node, c, frame) => c.blocks(childrenOf(node), frame),
  paragraph: (node, c, frame) => inlineBlock(node, c, frame, { align: blockAlign(node), ...(int(node.indent, 0) > 0 ? { ind: { left: frame.indent + int(node.indent, 0) * LIST_INDENT } } : {}) }),
  heading: (node, c, frame) => {
    const level = /^h([1-6])$/.exec(str(node.tag))?.[1] ?? '2';
    return inlineBlock(node, c, frame, { pStyle: `Heading${level}`, align: blockAlign(node) });
  },
  quote: (node, c, frame) => childrenOf(node).some(child => !isInlineNode(child))
    ? c.blocks(childrenOf(node), { ...frame, pStyle: 'Quote' }) : inlineBlock(node, c, { ...frame, pStyle: 'Quote' }, { align: blockAlign(node) }),
  callout: (node, c, frame) => {
    const kind = isCalloutKind(node.kind) ? node.kind : 'NOTE';
    const box: BlockFrame = { ...frame, border: calloutBorder[kind], shade: 'F6F6F3', widthTwips: frame.widthTwips - 240 };
    const title = str(node.title);
    return c.paragraph(c.run(calloutLabels[kind] + (title ? ` · ${title}` : ''), { bold: true, color: '5F6368' }), box, { keepNext: true })
      + c.blocks(childrenOf(node), box);
  },
  toggle: (node, c, frame) => {
    const [summary, ...body] = childrenOf(node);
    return (summary ? inlineBlock(summary, c, frame, { keepNext: true }, { bold: true }) : '')
      + c.blocks(body, { ...frame, indent: frame.indent + LIST_INDENT, widthTwips: frame.widthTwips - LIST_INDENT });
  },
  list: (node, c, frame) => list(node, c, frame, 0),
  code: (node, c, frame) => c.paragraph(c.run(codeText(node) || ' ', {}), plain(frame), { pStyle: 'Code' }),
  horizontalrule: (_node, _c, frame) => `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D5D7D0"/></w:pBdr>`
    + `${frame.indent ? `<w:ind w:left="${frame.indent}"/>` : ''}</w:pPr></w:p>`,
  table: (node, c, frame) => table(node, c, frame),
  attachment: (node, c, frame) => {
    const file = c.resources.files.get(str(node.attachmentId).toLowerCase());
    const caption = str(node.caption);
    if (!file || !file.mediaType.startsWith('image/') || !MEDIA_EXTENSIONS[file.mediaType]) return c.paragraph(c.inline(node, {}, frame), frame);
    const width = int(node.width, 0);
    return c.paragraph(c.image(file, width >= 10 && width <= 100 ? width : null, frame, str(node.alt) || file.fileName), frame,
      { align: str(node.align) === 'center' || str(node.align) === 'right' ? str(node.align) : null, keepNext: Boolean(caption) })
      + (caption ? c.paragraph(c.run(caption, {}), frame, { pStyle: 'Caption' }) : '');
  },
  equation: (node, c, frame) => c.paragraph(c.run(str(node.equation), { code: true }), frame, { align: 'center' }),
  mermaid: (node, c, frame) => {
    const source = str(node.source);
    const png = c.resources.mermaid.get(source)?.png;
    if (png) return c.paragraph(c.image({ ...png, mediaType: 'image/png', fileName: 'mermaid.png' }, null, frame, 'Mermaid 图表'), frame, { align: 'center' });
    return c.paragraph(c.run('Mermaid 图表源码', { bold: true, color: '6F7470' }), frame, { keepNext: true })
      + c.paragraph(c.run(source || ' ', {}), plain(frame), { pStyle: 'Code' });
  },
  'database-view': (node, c, frame) => {
    const title = c.resources.pageTitle?.(str(node.databaseId).toLowerCase());
    return c.paragraph(c.run(`数据库视图${title ? `：${title}` : ''}`, { bold: true }) + c.run('\n导出不包含数据库行，请在 NBase 中查看或导出该数据库。', { color: '6F7470' }),
      { ...frame, border: 'C8CBC4', shade: 'F6F6F3' });
  },
  'footnote-definition': (node, c, frame) => {
    const id = str(node.footnoteId);
    if (c.footnotes.referenced.has(id) && !frame.inFootnote) return '';
    // Unreferenced definitions stay where they were written, labelled, so their text is not lost.
    return c.paragraph(c.run(`脚注 ${id}`, { bold: true, color: '6F7470' }), frame, { keepNext: true }) + c.blocks(childrenOf(node), frame);
  },
  bookmark: (node, c, frame) => {
    const url = str(node.url);
    const box: BlockFrame = { ...frame, border: 'D5D7D0' };
    const relation = c.hyperlink(url);
    const title = c.run(str(node.title) || url, relation ? { bold: true, rStyle: 'Hyperlink' } : { bold: true });
    const description = str(node.description);
    const meta = [str(node.siteName), url].filter(Boolean).join(' · ');
    return c.paragraph(relation ? `<w:hyperlink r:id="${relation}" w:history="1">${title}</w:hyperlink>` : title, box, { keepNext: true })
      + (description ? c.paragraph(c.run(description, { color: '5F6368' }), box, { keepNext: true }) : '')
      + c.paragraph(c.run(meta, { color: '8A8D86' }), box);
  },
};

function list(node: SerializedNode, c: DocxContext, frame: BlockFrame, level: number): string {
  const type = str(node.listType);
  const ilvl = Math.min(level, 8);
  const numId = type === 'number' ? c.ordered(Math.max(int(node.start, 1), 0), ilvl) : BULLET_NUM;
  const left = frame.indent + LIST_INDENT * (ilvl + 1);
  return childrenOf(node).map(item => {
    if (typeOf(item) !== 'listitem') return c.block(item, frame);
    const nested = childrenOf(item).filter(child => typeOf(child) === 'list');
    const content = { ...item, children: childrenOf(item).filter(child => typeOf(child) !== 'list') };
    const blockKids = childrenOf(content).filter(child => !isInlineNode(child));
    const head = blockKids.length && blockKids.length === childrenOf(content).length ? null : content;
    const itemFrame: BlockFrame = { ...frame, pStyle: frame.pStyle ?? 'ListParagraph' };
    let xml = '';
    if (head && (childrenOf(head).length || !nested.length)) {
      if (type === 'check') {
        const box = c.run(item.checked === true ? '☑' : '☐', {}) + '<w:r><w:tab/></w:r>';
        xml += c.paragraph(box + c.inlines(childrenOf(head), {}, itemFrame), itemFrame,
          { ind: { left, hanging: LIST_INDENT }, align: blockAlign(item) });
      } else xml += inlineBlock(head, c, itemFrame, { numbering: { numId, ilvl }, ind: { left, hanging: LIST_INDENT }, align: blockAlign(item) });
    } else if (!head) xml += c.blocks(childrenOf(content), { ...frame, indent: left, widthTwips: frame.widthTwips - LIST_INDENT });
    for (const sub of nested) xml += list(sub, c, frame, level + 1);
    return xml;
  }).join('');
}

function table(node: SerializedNode, c: DocxContext, frame: BlockFrame): string {
  const layout = tableLayout(node);
  if (!layout.columns) return '';
  const available = Math.max(frame.widthTwips - frame.indent, 1800);
  const raw = layout.colWidths && layout.colWidths.length === layout.columns ? layout.colWidths.map(px => px * 15) : Array(layout.columns).fill(available / layout.columns) as number[];
  const total = raw.reduce((sum, value) => sum + value, 0);
  const scale = total > available ? available / total : 1;
  const grid = raw.map(value => Math.max(Math.round(value * scale), 240));
  const span = (col: number, count: number) => grid.slice(col, col + count).reduce((sum, value) => sum + value, 0);
  const headerRows = new Set(layout.rows.map((cells, index) => cells.length && cells.every(cell => isRowHeader(cell.cell)) ? index : -1).filter(index => index >= 0));
  const rows = layout.rows.map((_cells, r) => {
    let xml = '';
    for (let col = 0; col < layout.columns;) {
      const cell = layout.at(r, col);
      if (!cell) { xml += `<w:tc><w:tcPr><w:tcW w:w="${grid[col]}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`; col++; continue; }
      const width = span(cell.col, cell.colSpan);
      const props = `<w:tcW w:w="${width}" w:type="dxa"/>${cell.colSpan > 1 ? `<w:gridSpan w:val="${cell.colSpan}"/>` : ''}`
        + (cell.rowSpan > 1 || cell.row !== r ? `<w:vMerge${cell.row === r ? ' w:val="restart"' : ''}/>` : '')
        + (cell.header ? '<w:shd w:val="clear" w:color="auto" w:fill="F1F1EE"/>' : '');
      const inner = cell.row === r ? c.blocks(childrenOf(cell.cell), { indent: 0, widthTwips: width - 216, bold: cell.header, inFootnote: frame.inFootnote }) : '';
      // Every cell needs a paragraph, including the continuation of a vertical merge.
      xml += `<w:tc><w:tcPr>${props}</w:tcPr>${inner.endsWith('</w:p>') || inner.endsWith('<w:p/>') ? inner : inner + '<w:p/>'}</w:tc>`;
      col = cell.col + cell.colSpan;
    }
    return `<w:tr>${headerRows.has(r) && r === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${xml}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${span(0, layout.columns)}" w:type="dxa"/>`
    + `${frame.indent ? `<w:tblInd w:w="${frame.indent}" w:type="dxa"/>` : ''}<w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`
    + `<w:tblGrid>${grid.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`;
}

const builtinsInline: Record<string, DocxRenderer['inline']> = {
  text: (node, c, style) => c.run(str(node.text), textStyle(node, style)),
  'code-highlight': (node, c, style) => c.run(str(node.text), textStyle(node, style)),
  linebreak: () => '<w:r><w:br/></w:r>',
  tab: () => '<w:r><w:tab/></w:r>',
  link: (node, c, style, frame) => {
    const relation = c.hyperlink(str(node.url));
    const runs = c.inlines(childrenOf(node), relation ? { ...style, rStyle: 'Hyperlink' } : style, frame);
    return relation ? `<w:hyperlink r:id="${relation}" w:history="1">${runs}</w:hyperlink>` : runs;
  },
  'page-reference': (node, c, style) => c.run(str(node.label) || c.resources.pageTitle?.(str(node.targetPageId).toLowerCase()) || '页面', { ...style, color: '2F6F9F' }),
  'footnote-reference': (node, c, style, frame) => frame.inFootnote ? c.run(`[${str(node.footnoteId)}]`, { ...style, vertAlign: 'superscript' }) : c.footnote(str(node.footnoteId), frame),
  equation: (node, c, style) => c.run(str(node.equation), { ...style, code: true }),
  'image-reference': (node, c, style) => c.run(`[外部图片：${str(node.alt) || '无描述'}]`, { ...style, color: '8A8D86' }),
  attachment: (node, c, style, frame) => {
    const file = c.resources.files.get(str(node.attachmentId).toLowerCase());
    if (file && file.mediaType.startsWith('image/') && MEDIA_EXTENSIONS[file.mediaType]) {
      const width = int(node.width, 0);
      return c.image(file, width >= 10 && width <= 100 ? width : null, frame, str(node.alt) || file.fileName);
    }
    const kind = str(node.mediaType).startsWith('image/') ? '图片' : str(node.mediaType).startsWith('audio/') ? '音频'
      : str(node.mediaType).startsWith('video/') ? '视频' : '附件';
    return c.run(`[${kind}：${str(node.fileName) || str(node.alt) || '未命名'}]`, { ...style, color: '6F7470' });
  },
  'block-reference': (node, c, style) => c.run(visibleText(node) || '块引用', { ...style, color: '5F6368' }),
};
for (const type of new Set([...Object.keys(builtinsBlock), ...Object.keys(builtinsInline)]))
  registerDocxRenderer(type, { block: builtinsBlock[type], inline: builtinsInline[type] });

export interface DocxPage { title: string; content: StoredDocumentContent }

/** Builds the .docx package; resources must already be loaded. */
export function buildDocx({ title, content }: DocxPage, resources: ExportResources): Blob {
  const root = rootOf(content);
  const footnotes = indexFootnotes(root);
  const relations: { id: string; type: string; target: string; external?: boolean }[] = [
    { id: 'rId1', type: REL_TYPES.styles, target: 'styles.xml' }, { id: 'rId2', type: REL_TYPES.numbering, target: 'numbering.xml' },
    { id: 'rId3', type: REL_TYPES.footnotes, target: 'footnotes.xml' }, { id: 'rId4', type: REL_TYPES.settings, target: 'settings.xml' },
  ];
  const links = new Map<string, string>();
  const media: ZipEntry[] = [];
  const mediaRelations = new Map<object, string>();
  const extensions = new Set<string>();
  const ordered: { numId: number; ilvl: number; start: number }[] = [];
  const notes: string[] = [];
  let drawingId = 0;
  const relation = (type: string, target: string, external = false) => {
    const id = `rId${relations.length + 1}`;
    relations.push({ id, type, target, ...(external ? { external } : {}) });
    return id;
  };

  const context: DocxContext = {
    resources, footnotes,
    block: (node, frame) => {
      try {
        const renderer = renderers.get(typeOf(node));
        if (renderer?.block) return renderer.block(node, context, frame);
        if (renderer?.inline) return context.paragraph(renderer.inline(node, context, {}, frame), frame);
        const kids = childrenOf(node);
        if (kids.length) return kids.every(isInlineNode) ? context.paragraph(context.inlines(kids, {}, frame), frame) : context.blocks(kids, frame);
        const text = visibleText(node);
        return text ? context.paragraph(context.run(text, {}), frame) : '';
      } catch { const text = visibleText(node); return text ? context.paragraph(context.run(text, {}), frame) : ''; }
    },
    blocks: (nodes, frame) => {
      let xml = '';
      let group: SerializedNode[] = [];
      const flush = () => { if (group.length) xml += context.paragraph(context.inlines(group, {}, frame), frame); group = []; };
      for (const node of nodes) {
        if (isInlineNode(node) && typeOf(node) !== 'attachment') { group.push(node); continue; }
        flush();
        xml += context.block(node, frame);
      }
      flush();
      return xml;
    },
    inline: (node, style, frame) => {
      try {
        const renderer = renderers.get(typeOf(node));
        if (renderer?.inline) return renderer.inline(node, context, style, frame);
        const kids = childrenOf(node);
        if (kids.length) return context.inlines(kids, style, frame);
        return context.run(visibleText(node), style);
      } catch { return context.run(visibleText(node), style); }
    },
    inlines: (nodes, style, frame) => nodes.map(node => context.inline(node, style, frame)).join(''),
    paragraph: paragraphXml,
    run,
    hyperlink: url => {
      const value = url.trim();
      if (!isSafeLinkUrl(value) || !/^(?:https?|mailto):/i.test(value)) return null;
      let id = links.get(value);
      if (!id) { id = relation(REL_TYPES.hyperlink, value, true); links.set(value, id); }
      return id;
    },
    image: (file, widthPercent, frame, alt) => {
      const extension = MEDIA_EXTENSIONS[file.mediaType];
      if (!extension) return context.run(`[图片：${alt}]`, {});
      let id = mediaRelations.get(file);
      if (!id) {
        const name = `image${media.length + 1}.${extension}`;
        media.push({ name: `word/media/${name}`, bytes: file.bytes });
        extensions.add(extension);
        id = relation(REL_TYPES.image, `media/${name}`);
        mediaRelations.set(file, id);
      }
      const size = 'size' in file ? file.size : 'width' in file ? { width: file.width, height: file.height } : undefined;
      const column = Math.max(frame.widthTwips - frame.indent, 720) * TWIP_EMU;
      let cx = widthPercent ? column * widthPercent / 100 : size ? Math.min(size.width * PX_EMU, column) : column * 0.6;
      let cy = size ? cx * size.height / size.width : cx * 0.75;
      const maxHeight = (PAGE.height - PAGE.margin * 2 - 720) * TWIP_EMU;
      if (cy > maxHeight) { cx = cx * maxHeight / cy; cy = maxHeight; }
      cx = Math.max(Math.round(cx), PX_EMU); cy = Math.max(Math.round(cy), PX_EMU);
      const docPr = ++drawingId;
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
        + `<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPr}" name="图片 ${docPr}" descr="${xmlAttr(alt)}"/>`
        + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
        + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        + `<pic:nvPicPr><pic:cNvPr id="${docPr}" name="${xmlAttr(file.fileName)}"/><pic:cNvPicPr/></pic:nvPicPr>`
        + `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
        + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    },
    footnote: (id, frame) => {
      const definition = footnotes.definitions.get(id);
      if (!definition) return context.run(`[${id}]`, { vertAlign: 'superscript' });
      // Word footnotes have a single reference each, so a repeated reference repeats the note.
      const noteId = notes.length + 1;
      const noteFrame: BlockFrame = { indent: 0, widthTwips: frame.widthTwips, pStyle: 'FootnoteText', inFootnote: true };
      notes.push('');
      let body = context.blocks(childrenOf(definition), noteFrame) || context.paragraph('', noteFrame);
      const marker = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>';
      body = body.startsWith('<w:p>') ? body.replace(/^<w:p>(<w:pPr>.*?<\/w:pPr>)?/, (_match, props: string | undefined) => `<w:p>${props ?? ''}${marker}`)
        : context.paragraph(marker, noteFrame) + body;
      notes[noteId - 1] = `<w:footnote w:id="${noteId}">${body}</w:footnote>`;
      return `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${noteId}"/></w:r>`;
    },
    ordered: (start, ilvl) => {
      const numId = ordered.length + 2;
      ordered.push({ numId, ilvl, start });
      return numId;
    },
  };

  const frame: BlockFrame = { indent: 0, widthTwips: CONTENT_TWIPS };
  const name = title.trim() || '未命名页面';
  const body = paragraphXml(run(name, {}), frame, { pStyle: 'Title' }) + context.blocks(childrenOf(root), frame);
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', bytes: utf8(contentTypesXml(extensions)) },
    { name: '_rels/.rels', bytes: utf8(packageRelsXml()) },
    { name: 'docProps/core.xml', bytes: utf8(coreXml(name)) },
    { name: 'word/document.xml', bytes: utf8(documentXml(body)) },
    { name: 'word/styles.xml', bytes: utf8(stylesXml()) },
    { name: 'word/numbering.xml', bytes: utf8(numberingXml(ordered)) },
    { name: 'word/footnotes.xml', bytes: utf8(footnotesXml(notes)) },
    { name: 'word/settings.xml', bytes: utf8(settingsXml()) },
    { name: 'word/_rels/document.xml.rels', bytes: utf8(relationshipsXml(relations)) },
    ...media,
  ];
  const blob = zipEntries(entries);
  return new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
