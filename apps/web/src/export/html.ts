import katex from 'katex';
import { isCalloutKind, pageIdFromReferenceUrl, parseTextStyle, textColorHex, type StoredDocumentContent } from '@nbase/contracts';
import { isSafeLinkUrl } from '../editor/markdown';
import { calloutLabels } from '../editor/nodes/CalloutNode';
import { HTML_EXPORT_CSS } from './htmlStyles';
import type { ExportFile, ExportResources } from './resources';
import { extensionFor } from './zip';
import {
  blockAlign, childrenOf, codeText, hasFormat, indexFootnotes, int, isRowHeader, rootOf, str, tableLayout, TEXT_FORMAT, typeOf,
  visibleText, type FootnoteIndex, type SerializedNode,
} from './tree';

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const attr = escapeHtml;

export interface HtmlContext {
  /** `single`: one file, images as data: URIs. `package`: index.html beside assets/. */
  mode: 'single' | 'package';
  resources: ExportResources;
  footnotes: FootnoteIndex;
  footnoteNumber: Map<string, number>;
  referenceCount: Map<string, number>;
  diagrams: number;
  render: (node: SerializedNode) => string;
  children: (node: SerializedNode) => string;
}
export type HtmlRenderer = (node: SerializedNode, context: HtmlContext) => string;

const renderers = new Map<string, HtmlRenderer>();
/** Adds or replaces the HTML renderer for one serialized node type. */
export function registerHtmlRenderer(type: string, renderer: HtmlRenderer): void { renderers.set(type, renderer); }

export const assetPath = (file: Pick<ExportFile, 'id' | 'mediaType' | 'fileName'>) => `assets/${file.id}${extensionFor(file.mediaType, file.fileName)}`;

const alignStyle = (node: SerializedNode) => {
  const align = blockAlign(node);
  const indent = Math.min(Math.max(int(node.indent, 0), 0), 10);
  const rules = [align && `text-align:${align}`, indent && `margin-left:${indent * 2}em`].filter(Boolean);
  return rules.length ? ` style="${rules.join(';')}"` : '';
};
const inlineOrBreak = (html: string) => html || '<br>';

function safeHref(url: string): string | null {
  return isSafeLinkUrl(url) ? url.trim() : null;
}

function textRun(node: SerializedNode): string {
  let html = escapeHtml(str(node.text));
  if (!html) return '';
  if (hasFormat(node, TEXT_FORMAT.code)) html = `<code>${html}</code>`;
  if (hasFormat(node, TEXT_FORMAT.highlight)) html = `<mark>${html}</mark>`;
  if (hasFormat(node, TEXT_FORMAT.subscript)) html = `<sub>${html}</sub>`;
  if (hasFormat(node, TEXT_FORMAT.superscript)) html = `<sup>${html}</sup>`;
  if (hasFormat(node, TEXT_FORMAT.underline)) html = `<u>${html}</u>`;
  if (hasFormat(node, TEXT_FORMAT.strikethrough)) html = `<s>${html}</s>`;
  if (hasFormat(node, TEXT_FORMAT.italic)) html = `<em>${html}</em>`;
  if (hasFormat(node, TEXT_FORMAT.bold)) html = `<strong>${html}</strong>`;
  const { color, background } = parseTextStyle(str(node.style));
  // Palette ids only: the stored style can never inject arbitrary CSS into the export.
  const rules = [color && `color:var(--nb-c-${color},${textColorHex[color].text})`,
    background && `background-color:var(--nb-bg-${background},${textColorHex[background].background})`].filter(Boolean);
  return rules.length ? `<span style="${rules.join(';')}">${html}</span>` : html;
}

function equation(node: SerializedNode): string {
  const source = str(node.equation);
  const inline = node.inline !== false;
  try {
    // MathML keeps the file self-contained: no KaTeX stylesheet or font files are needed.
    const math = katex.renderToString(source, { throwOnError: true, trust: false, output: 'mathml', maxExpand: 1000, maxSize: 50, strict: 'ignore', displayMode: !inline });
    return `<span class="nb-math${inline ? '' : ' nb-math-block'}">${math}</span>`;
  } catch { return `<code class="nb-math-source${inline ? '' : ' nb-math-block'}">${escapeHtml(inline ? `$${source}$` : `$$${source}$$`)}</code>`; }
}

function listItems(list: SerializedNode, context: HtmlContext): string {
  const check = str(list.listType) === 'check';
  const items: string[] = [];
  for (const item of childrenOf(list)) {
    if (typeOf(item) !== 'listitem') { items.push(`<li>${context.render(item)}</li>`); continue; }
    const kids = childrenOf(item);
    // Lexical nests a list as a sibling item that only holds the sublist; HTML nests it in the previous item.
    if (kids.length && kids.every(child => typeOf(child) === 'list')) {
      const nested = kids.map(context.render).join('');
      if (items.length) items[items.length - 1] = items[items.length - 1]!.replace(/<\/li>$/, `${nested}</li>`);
      else items.push(`<li class="nb-nested">${nested}</li>`);
      continue;
    }
    const body = context.children(item);
    items.push(check
      ? `<li class="nb-task"${alignStyle(item)}><input type="checkbox" disabled${item.checked === true ? ' checked' : ''}> <span>${body}</span></li>`
      : `<li${alignStyle(item)}>${body}</li>`);
  }
  return items.join('');
}

function attachment(node: SerializedNode, context: HtmlContext): string {
  const id = str(node.attachmentId).toLowerCase();
  const fileName = str(node.fileName, '附件');
  const mediaType = str(node.mediaType);
  const file = context.resources.files.get(id);
  const alt = str(node.alt) || fileName;
  if (mediaType.startsWith('image/')) {
    if (!file) return `<span class="nb-placeholder">图片：${escapeHtml(alt)}（未包含在导出中）</span>`;
    const src = context.mode === 'single' ? `data:${file.mediaType};base64,${file.base64 ?? ''}` : assetPath(file);
    const width = int(node.width, 0);
    const align = ['left', 'center', 'right'].includes(str(node.align)) ? str(node.align) : 'left';
    const caption = str(node.caption);
    const size = file.size ? ` width="${file.size.width}" height="${file.size.height}"` : '';
    return `<span class="nb-figure nb-align-${align}" role="figure"${width >= 10 && width <= 100 ? ` style="width:${width}%"` : ''}>`
      + `<img src="${attr(src)}" alt="${attr(alt)}"${size}>${caption ? `<span class="nb-caption">${escapeHtml(caption)}</span>` : ''}</span>`;
  }
  if (!file || context.mode === 'single') return `<span class="nb-file">附件：${escapeHtml(fileName)}${context.mode === 'single' ? '（单文件 HTML 不含附件）' : '（未包含在导出中）'}</span>`;
  const href = attr(assetPath(file));
  if (mediaType.startsWith('audio/')) return `<span class="nb-media"><audio controls preload="none" src="${href}"></audio><a href="${href}">${escapeHtml(fileName)}</a></span>`;
  if (mediaType.startsWith('video/')) return `<span class="nb-media"><video controls preload="none" src="${href}"></video><a href="${href}">${escapeHtml(fileName)}</a></span>`;
  return `<a class="nb-file" href="${href}">附件：${escapeHtml(fileName)}</a>`;
}

function table(node: SerializedNode, context: HtmlContext): string {
  const layout = tableLayout(node);
  const widths = layout.colWidths;
  const colgroup = widths ? `<colgroup>${widths.map(width => `<col style="width:${Math.round(width)}px">`).join('')}</colgroup>` : '';
  const headRow = layout.rows.length > 1 && layout.rows[0]!.length > 0 && layout.rows[0]!.every(cell => isRowHeader(cell.cell) && cell.rowSpan === 1);
  const row = (cells: typeof layout.rows[number]) => `<tr>${cells.map(item => {
    const tag = item.header ? 'th' : 'td';
    const span = (item.colSpan > 1 ? ` colspan="${item.colSpan}"` : '') + (item.rowSpan > 1 ? ` rowspan="${item.rowSpan}"` : '');
    const scope = item.header ? ` scope="${isRowHeader(item.cell) ? 'col' : 'row'}"` : '';
    return `<${tag}${span}${scope}>${context.children(item.cell)}</${tag}>`;
  }).join('')}</tr>`;
  const body = layout.rows.slice(headRow ? 1 : 0).map(row).join('');
  return `<div class="nb-table"><table>${colgroup}${headRow ? `<thead>${row(layout.rows[0]!)}</thead>` : ''}<tbody>${body}</tbody></table></div>`;
}

function footnoteReference(node: SerializedNode, context: HtmlContext): string {
  const id = str(node.footnoteId);
  const number = context.footnoteNumber.get(id);
  if (!number || !context.footnotes.definitions.has(id)) return `<sup class="nb-fnref">[${escapeHtml(id)}]</sup>`;
  const count = (context.referenceCount.get(id) ?? 0) + 1;
  context.referenceCount.set(id, count);
  return `<sup class="nb-fnref"><a href="#fn-${number}" id="fnref-${number}${count > 1 ? `-${count}` : ''}">${escapeHtml(id)}</a></sup>`;
}

function footnoteSection(context: HtmlContext): string {
  const entries = context.footnotes.order.filter(id => context.footnotes.definitions.has(id)).map(id => {
    const number = context.footnoteNumber.get(id)!;
    const count = context.referenceCount.get(id) ?? 0;
    const back = Array.from({ length: count }, (_, index) =>
      ` <a class="nb-fnback" href="#fnref-${number}${index ? `-${index + 1}` : ''}" aria-label="返回正文">↩</a>`).join('');
    return `<li id="fn-${number}"><span class="nb-fnlabel">${escapeHtml(id)}</span><div>${context.children(context.footnotes.definitions.get(id)!)}${back}</div></li>`;
  });
  return entries.length ? `<section class="nb-footnotes" aria-label="脚注"><hr><ol>${entries.join('')}</ol></section>` : '';
}

const builtins: Record<string, HtmlRenderer> = {
  root: (node, c) => c.children(node),
  paragraph: (node, c) => `<p${alignStyle(node)}>${inlineOrBreak(c.children(node))}</p>`,
  heading: (node, c) => {
    const tag = /^h[1-6]$/.test(str(node.tag)) ? str(node.tag) : 'h2';
    return `<${tag}${alignStyle(node)}>${c.children(node)}</${tag}>`;
  },
  quote: (node, c) => `<blockquote${alignStyle(node)}>${c.children(node)}</blockquote>`,
  callout: (node, c) => {
    const kind = isCalloutKind(node.kind) ? node.kind : 'NOTE';
    const title = str(node.title);
    return `<aside class="nb-callout nb-callout-${kind.toLowerCase()}" role="note"><p class="nb-callout-label">${escapeHtml(calloutLabels[kind])}${title ? ` · ${escapeHtml(title)}` : ''}</p>${c.children(node)}</aside>`;
  },
  toggle: (node, c) => {
    const [summary, ...body] = childrenOf(node);
    return `<details open><summary>${summary ? c.children(summary) : ''}</summary><div class="nb-toggle-body">${body.map(c.render).join('')}</div></details>`;
  },
  list: (node, c) => {
    const type = str(node.listType);
    const start = int(node.start, 1);
    if (type === 'number') return `<ol${start !== 1 ? ` start="${start}"` : ''}>${listItems(node, c)}</ol>`;
    return `<ul${type === 'check' ? ' class="nb-tasks"' : ''}>${listItems(node, c)}</ul>`;
  },
  listitem: (node, c) => `<li>${c.children(node)}</li>`,
  code: (node, c) => {
    const language = str(node.language);
    const source = codeText(node);
    const highlighted = language ? c.resources.highlight?.(source, language) ?? null : null;
    return `<pre class="nb-code"${language ? ` data-language="${attr(language)}"` : ''}><code${language ? ` class="language-${attr(language.replace(/[^\w-]/g, ''))}"` : ''}>${highlighted ?? escapeHtml(source)}</code></pre>`;
  },
  text: node => textRun(node),
  'code-highlight': node => textRun(node),
  linebreak: () => '<br>',
  tab: () => '<span class="nb-tab">\t</span>',
  horizontalrule: () => '<hr>',
  link: (node, c) => {
    const url = str(node.url);
    const page = pageIdFromReferenceUrl(url.trim());
    if (page) return `<span class="nb-page-ref" data-nbase-page="${attr(page)}">${c.children(node)}</span>`;
    const href = safeHref(url);
    const title = str(node.title);
    return href ? `<a href="${attr(href)}"${title ? ` title="${attr(title)}"` : ''} rel="noopener noreferrer">${c.children(node)}</a>` : c.children(node);
  },
  'image-reference': node => {
    const alt = str(node.alt) || '无描述';
    const url = /\]\(\s*<?([^\s>)]+)/.exec(str(node.markdown))?.[1] ?? '';
    const href = url && /^https?:/i.test(url) ? safeHref(url) : null;
    return `<span class="nb-placeholder">外部图片：${escapeHtml(alt)}${href ? `（<a href="${attr(href)}" rel="noopener noreferrer">查看原图</a>）` : '（未加载）'}</span>`;
  },
  attachment,
  equation: node => equation(node),
  'page-reference': (node, c) => {
    const id = str(node.targetPageId).toLowerCase();
    const label = str(node.label) || c.resources.pageTitle?.(id) || '页面';
    return `<span class="nb-page-ref" data-nbase-page="${attr(id)}">${escapeHtml(label)}</span>`;
  },
  'footnote-reference': footnoteReference,
  // Definitions are collected into the footnote section at the end.
  'footnote-definition': () => '',
  mermaid: (node, c) => {
    const source = str(node.source);
    const rendered = c.resources.mermaid.get(source);
    if (rendered) {
      const index = ++c.diagrams;
      // Every render shares one element id; scope each diagram's internal styles to itself.
      return `<div class="nb-mermaid" role="img" aria-label="Mermaid 图表">${rendered.svg.replaceAll('nbase-diagram', `nbase-diagram-${index}`)}</div>`;
    }
    return `<pre class="nb-code" data-language="mermaid"><code class="language-mermaid">${escapeHtml(source)}</code></pre>`;
  },
  'database-view': (node, c) => {
    const title = c.resources.pageTitle?.(str(node.databaseId).toLowerCase());
    return `<div class="nb-placeholder nb-block-placeholder"><strong>数据库视图${title ? `：${escapeHtml(title)}` : ''}</strong><br>导出不包含数据库行，请在 NBase 中查看或导出该数据库。</div>`;
  },
  table,
  tablerow: (node, c) => `<tr>${c.children(node)}</tr>`,
  tablecell: (node, c) => `<td>${c.children(node)}</td>`,
  bookmark: node => {
    const url = str(node.url);
    const href = safeHref(url);
    const title = str(node.title) || url;
    const description = str(node.description);
    const site = str(node.siteName);
    const inner = `<strong>${escapeHtml(title)}</strong>${description ? `<span>${escapeHtml(description)}</span>` : ''}<small>${escapeHtml([site, url].filter(Boolean).join(' · '))}</small>`;
    return href ? `<a class="nb-bookmark" href="${attr(href)}" rel="noopener noreferrer">${inner}</a>` : `<div class="nb-bookmark">${inner}</div>`;
  },
  'block-reference': node => `<span class="nb-block-ref">${escapeHtml(visibleText(node) || str(node.blockId) || '块引用')}</span>`,
};
for (const [type, renderer] of Object.entries(builtins)) registerHtmlRenderer(type, renderer);

function fallback(node: SerializedNode, context: HtmlContext): string {
  const kids = childrenOf(node);
  const type = attr(typeOf(node) || 'unknown');
  if (kids.length) return `<div class="nb-unknown" data-nbase-type="${type}">${kids.map(context.render).join('')}</div>`;
  const text = visibleText(node);
  return text ? `<span class="nb-unknown" data-nbase-type="${type}">${escapeHtml(text)}</span>` : '';
}

export interface HtmlPage { title: string; content: StoredDocumentContent }

/** Renders the page body and document shell. Resources must be loaded already. */
export function renderHtmlDocument({ title, content }: HtmlPage, resources: ExportResources, mode: HtmlContext['mode']): string {
  const root = rootOf(content);
  const footnotes = indexFootnotes(root);
  const context: HtmlContext = {
    mode, resources, footnotes, diagrams: 0, referenceCount: new Map(),
    footnoteNumber: new Map(footnotes.order.map((id, index) => [id, index + 1])),
    render: node => {
      const renderer = renderers.get(typeOf(node));
      try { return renderer ? renderer(node, context) : fallback(node, context); }
      catch { const text = visibleText(node); return text ? `<span class="nb-unknown">${escapeHtml(text)}</span>` : ''; }
    },
    children: node => childrenOf(node).map(context.render).join(''),
  };
  const body = context.render(root);
  const name = title.trim() || '未命名页面';
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'">\n`
    + '<meta name="generator" content="NBase">\n'
    + `<title>${escapeHtml(name)}</title>\n<style>${HTML_EXPORT_CSS}</style>\n</head>\n<body>\n<article class="nb-page">\n`
    + `<h1 class="nb-title">${escapeHtml(name)}</h1>\n${body}\n${footnoteSection(context)}\n</article>\n</body>\n</html>\n`;
}
