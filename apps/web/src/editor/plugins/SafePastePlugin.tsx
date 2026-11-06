import { useEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $addUpdateTag, $getNodeByKey, $getSelection, $insertNodes, $isRangeSelection, $setSelection,
  CLICK_COMMAND, COMMAND_PRIORITY_CRITICAL, DROP_COMMAND, HISTORY_PUSH_TAG, PASTE_COMMAND,
} from 'lexical';
import type { BaseSelection } from 'lexical';
import { $generateNodesFromDOM } from '@lexical/html';
import { $generateNodesFromSerializedNodes } from '@lexical/clipboard';
import type { BaseSerializedNode } from '@lexical/clipboard';
import { LinkNode } from '@lexical/link';
import { $getTableCellNodeFromLexicalNode, $isTableSelection } from '@lexical/table';
import { mergeRegister } from '@lexical/utils';
import { isSafeLinkUrl } from '../markdown';
import { $insertAttachments } from '../nodes/AttachmentNode';
import { calloutTitleMaxLength, isCalloutKind, isCalloutTitle, isFootnoteId, isStoredMermaidSource, pageIdFromReferenceUrl, quickCaptureMarker, type AttachmentMetadata } from '@nbase/contracts';
import { isPageReferenceLabel } from '../nodes/PageReferenceNode';
import { Modal } from '../../components/Modal';
import { $applyTablePaste, $isCurrentTablePaste, $previewTablePaste, $tablePasteTarget, parseTsv } from '../tableEditing';
import type { TablePasteTarget } from '../tableEditing';

const knownNodeTypes = new Set(['paragraph', 'heading', 'quote', 'callout', 'list', 'listitem', 'code', 'code-highlight', 'link', 'autolink', 'table', 'tablerow', 'tablecell', 'horizontalrule', 'image-reference', 'attachment', 'equation', 'page-reference', 'footnote-reference', 'footnote-definition', 'mermaid', 'text', 'linebreak', 'tab']);
function safeInternalNodes(nodes: unknown, insideTable = false, depth = 0, insideLinkOrCode = false): nodes is BaseSerializedNode[] {
  return depth < 64 && Array.isArray(nodes) && nodes.every((node: unknown) => {
    if (!node || typeof node !== 'object') return false;
    const value = node as Record<string, unknown>;
    if (typeof value.type !== 'string' || !knownNodeTypes.has(value.type)) return false;
    if ((value.type === 'link' || value.type === 'autolink') && (typeof value.url !== 'string' || !isSafeLinkUrl(value.url))) return false;
    if (value.type === 'table' && insideTable) return false;
    if (value.type === 'callout' && (insideTable || !isCalloutKind(value.kind) || !isCalloutTitle(value.title)
      || !Array.isArray(value.children))) return false;
    if (value.type === 'tablecell' && (Number(value.colSpan ?? 1) !== 1 || Number(value.rowSpan ?? 1) !== 1)) return false;
    if (value.type === 'equation' && (typeof value.equation !== 'string' || value.equation.length > 10_000
      || typeof value.inline !== 'boolean')) return false;
    if (value.type === 'mermaid' && (insideTable || insideLinkOrCode || !isStoredMermaidSource(value.source) || value.children !== undefined)) return false;
    if (value.type === 'page-reference' && (insideLinkOrCode || typeof value.targetPageId !== 'string'
      || pageIdFromReferenceUrl('/?page=' + value.targetPageId) !== value.targetPageId
      || !isPageReferenceLabel(value.label) || value.children !== undefined)) return false;
    if ((value.type === 'footnote-reference' || value.type === 'footnote-definition') && !isFootnoteId(value.footnoteId)) return false;
    if (value.type === 'footnote-reference' && (insideLinkOrCode || value.children !== undefined)) return false;
    if (value.type === 'footnote-definition' && (depth !== 0 || insideTable || insideLinkOrCode || !Array.isArray(value.children))) return false;
    if (value.type === 'attachment' && (typeof value.attachmentId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.attachmentId)
      || typeof value.fileName !== 'string' || value.fileName.length > 180
      || typeof value.mediaType !== 'string' || typeof value.alt !== 'string')) return false;
    return value.children === undefined || safeInternalNodes(value.children, insideTable || value.type === 'table', depth + 1,
      insideLinkOrCode || value.type === 'link' || value.type === 'autolink' || value.type === 'code');
  });
}

function readableInternalText(nodes: unknown, depth = 0): string {
  if (depth >= 64 || !Array.isArray(nodes)) return '';
  return nodes.map((node: unknown) => {
    if (!node || typeof node !== 'object') return '';
    const value = node as Record<string, unknown>;
    const visibleText = value.type === 'page-reference' ? value.label
      : value.type === 'footnote-reference' && isFootnoteId(value.footnoteId) ? '[^' + value.footnoteId + ']' : value.type === 'mermaid' ? value.source : value.text;
    const text = typeof visibleText === 'string' ? visibleText.slice(0, 100_000) : '';
    const children = readableInternalText(value.children, depth + 1);
    const line = ['paragraph', 'heading', 'quote', 'listitem', 'tablerow', 'mermaid'].includes(String(value.type)) ? '\n' : '';
    const title = value.type === 'callout' && typeof value.title === 'string'
      ? value.title.slice(0, calloutTitleMaxLength) + '\n' : '';
    return title + text + children + line;
  }).join('').slice(0, 100_000);
}

/** The quick-capture heading's role belongs to its original document. */
function clearCaptureMarkers(nodes: BaseSerializedNode[]): void {
  for (const node of nodes) {
    const { $, children } = node as BaseSerializedNode & { $?: Record<string, unknown>; children?: BaseSerializedNode[] };
    if ($ && typeof $ === 'object' && !Array.isArray($)) delete $[quickCaptureMarker];
    if (children) clearCaptureMarkers(children);
  }
}

type Props = {
  onNotice?: ((message: string) => void) | undefined;
  onUploadFiles?: ((files: File[]) => Promise<AttachmentMetadata[]>) | undefined;
};
const blockTags = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'TABLE', 'UL', 'OL']);
function readableText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  const element = node as Element;
  if (element.tagName === 'BR') return '\n';
  const text = Array.from(node.childNodes, readableText).join('');
  if (element.tagName === 'TD' || element.tagName === 'TH') return `${text}\t`;
  return blockTags.has(element.tagName) ? `${text}\n` : text;
}

/** Prepare an inert document before Lexical's HTML importer sees it. */
export function preparePastedHtml(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const warnings: string[] = [];
  const blocked = document.querySelectorAll('script,style,iframe,object,embed,link,meta,base');
  if (blocked.length) warnings.push('已移除剪贴板中的可执行或外部嵌入内容。');
  blocked.forEach((element) => element.remove());
  const media = document.querySelectorAll('img,video,audio,canvas,svg');
  if (media.length) warnings.push('图片和媒体暂不上传；已保留可读说明及安全的图片地址。');
  media.forEach((element) => {
    const alt = element.getAttribute('alt') || element.getAttribute('aria-label') || element.textContent || '媒体';
    const src = element.getAttribute('src') || '';
    element.replaceWith(document.createTextNode(`[${alt}${src && isSafeLinkUrl(src) ? `：${src}` : ''}]`));
  });
  let unsafeLink = false;
  document.querySelectorAll('a').forEach((element) => {
    if (!isSafeLinkUrl(element.getAttribute('href') || '')) {
      unsafeLink = true;
      element.replaceWith(...Array.from(element.childNodes));
    } else {
      element.setAttribute('rel', 'noopener noreferrer');
    }
  });
  if (unsafeLink) warnings.push('已移除不安全链接，保留链接文字。');
  for (const element of document.querySelectorAll('*')) {
    const originalStyle = element.getAttribute('style') || '';
    const safeStyles = originalStyle.split(';').filter((rule) => /^\s*(font-weight\s*:\s*(bold|[5-9]00)|font-style\s*:\s*italic|text-decoration(?:-line)?\s*:\s*(underline|line-through))\s*$/i.test(rule));
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith('on') || ['srcdoc', 'style', 'id', 'contenteditable'].includes(attribute.name)) element.removeAttribute(attribute.name);
    }
    if (safeStyles.length) element.setAttribute('style', safeStyles.join(';'));
  }
  const plainOnly = Boolean(document.querySelector('table table,td[colspan]:not([colspan="1"]),th[colspan]:not([colspan="1"]),td[rowspan]:not([rowspan="1"]),th[rowspan]:not([rowspan="1"]),details,math,form,input,textarea,select'));
  if (plainOnly) warnings.push('嵌套或合并表格、复杂块暂不支持；已按阅读顺序粘贴为文本，请核对格式。');
  const plainText = readableText(document.body).replace(/\t\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { document, warnings, plainOnly, plainText };
}

type TablePaste = {
  target: TablePasteTarget;
  preview: NonNullable<ReturnType<typeof $previewTablePaste>>;
  data: string[][];
  text: string;
  selection: BaseSelection;
  error?: string;
};

function $pasteMatrixAsText(selection: BaseSelection, text: string): boolean {
  if (!$isRangeSelection(selection) && !$isTableSelection(selection)) return false;
  if (!$getNodeByKey(selection.anchor.key) || !$getNodeByKey(selection.focus.key)) return false;
  $addUpdateTag(HISTORY_PUSH_TAG);
  if ($isRangeSelection(selection)) {
    $setSelection(selection);
    selection.insertRawText(text);
  } else {
    const cell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
    if (!cell) return false;
    cell.selectEnd().insertRawText(text);
  }
  return true;
}

export function SafePastePlugin({ onNotice, onUploadFiles }: Props) {
  const [editor] = useLexicalComposerContext();
  const [tablePaste, setTablePaste] = useState<TablePaste | null>(null);
  const completeTablePaste = (plain: boolean) => {
    if (!tablePaste || !editor.isEditable()) return;
    const { target, preview, data, selection, text } = tablePaste;
    editor.update(() => {
      const result = plain ? ($isCurrentTablePaste(target, data, preview) && $pasteMatrixAsText(selection.clone(), text)
        ? 'applied' : 'changed')
        : $applyTablePaste(target, data, preview);
      if (result === 'limit') {
        setTablePaste(current => current && { ...current, error: '表格会超出文档大小限制，可选择保留纯文本。' });
        return;
      }
      setTablePaste(null);
      if (result === 'changed') onNotice?.('粘贴位置已变化，请重新粘贴。');
    });
  };
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const upload = useRef(onUploadFiles);
  upload.current = onUploadFiles;
  useEffect(() => {
    let mounted = true;
    const startUpload = (files: File[]) => {
      if (!upload.current) return;
      void upload.current(files).then(attachments => {
        if (mounted && editor.isEditable() && attachments.length) {
          editor.update(() => $insertAttachments(attachments));
        }
      }).catch(() => { if (mounted) notice.current?.('附件上传失败，原文件未修改，请重试。'); });
    };
    const unregister = mergeRegister(
    editor.registerEditableListener(editable => { if (!editable) setTablePaste(null); }),
    editor.registerNodeTransform(LinkNode, (node) => {
      if (!isSafeLinkUrl(node.getURL())) {
        for (const child of node.getChildren()) node.insertBefore(child);
        node.remove();
      }
    }),
    editor.registerCommand(CLICK_COMMAND, (event) => {
      const target = event.target instanceof Element ? event.target.closest('a') : null;
      if (target && !isSafeLinkUrl(target.getAttribute('href') || '')) { event.preventDefault(); notice.current?.('此链接不安全，已阻止打开。'); return true; }
      return false;
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(PASTE_COMMAND, (event) => {
      if (!editor.isEditable()) { event?.preventDefault(); return true; }
      if (!event || !('clipboardData' in event) || !event.clipboardData) return false;
      const clipboard = event.clipboardData;
      const html = clipboard.getData('text/html');
      const internal = clipboard.getData('application/x-lexical-editor');
      const files = Array.from(clipboard.files);
      const text = clipboard.getData('text/plain');
      const selection = $getSelection();
      const target = $tablePasteTarget(selection);
      const clipboardTable = !internal && files.length === 0 && target && /<table[\s>]/i.test(html)
        ? preparePastedHtml(html) : null;
      const fromTable = Boolean(clipboardTable && !clipboardTable.plainOnly && clipboardTable.document.querySelector('table'));
      const matrix = target && !internal && files.length === 0 && (!html || fromTable) ? parseTsv(text, fromTable) : null;
      if (matrix && target && selection) {
        event.preventDefault();
        if ('warning' in matrix) {
          $pasteMatrixAsText(selection, text);
          notice.current?.(matrix.warning);
        } else {
          const preview = $previewTablePaste(target, matrix.rows);
          if (preview?.confirm) {
            setTablePaste({ target, preview, data: matrix.rows, selection: selection.clone(), text });
          } else {
            const result = preview ? $applyTablePaste(target, matrix.rows, preview) : 'changed';
            if (result !== 'applied') {
              $pasteMatrixAsText(selection, text);
              notice.current?.(result === 'limit' ? '表格会超出文档大小限制，已按纯文本粘贴。'
                : '无法安全扩展当前表格，已按纯文本粘贴。');
            }
          }
        }
        return true;
      }
      if (!html && !internal && files.length === 0) return false;
      event.preventDefault();
      if (!selection) return true;
      if (files.length && upload.current) {
        queueMicrotask(() => startUpload(files));
        notice.current?.('正在上传剪贴板附件；完成后会插入当前页面。');
        return true;
      }
      const warnings: string[] = [];
      if (internal && files.length === 0) {
        try {
          const payload: unknown = JSON.parse(internal);
          if (payload && typeof payload === 'object' && 'namespace' in payload && payload.namespace === 'nbase-document' && 'nodes' in payload) {
            const insideTable = $isTableSelection(selection) || ($isRangeSelection(selection) && Boolean($getTableCellNodeFromLexicalNode(selection.anchor.getNode())));
            if (safeInternalNodes(payload.nodes, insideTable)) {
              clearCaptureMarkers(payload.nodes);
              $insertNodes($generateNodesFromSerializedNodes(payload.nodes));
              return true;
            }
            warnings.push('内部剪贴板包含不支持或不安全的结构，已改用可读内容。');
          } else warnings.push('剪贴板结构不属于本编辑器，已改用可读内容。');
        } catch { warnings.push('剪贴板结构无法读取，已改用可读内容。'); }
      }
      let inserted = false;
      let plainText = text;
      if (!plainText && internal) {
        try {
          const payload: unknown = JSON.parse(internal);
          if (payload && typeof payload === 'object' && 'nodes' in payload) plainText = readableInternalText(payload.nodes);
        } catch { /* A malformed internal payload has no text to recover. */ }
      }
      if (html) {
        const prepared = clipboardTable ?? preparePastedHtml(html);
        warnings.push(...prepared.warnings);
        const insideTable = $isTableSelection(selection) || ($isRangeSelection(selection) && Boolean($getTableCellNodeFromLexicalNode(selection.anchor.getNode())));
        const containsTable = Boolean(prepared.document.querySelector('table'));
        if (insideTable && containsTable) warnings.push('为避免嵌套表格，已在当前单元格粘贴为文本。');
        if (!prepared.plainOnly && !(insideTable && containsTable)) {
          try {
            const nodes = $generateNodesFromDOM(editor, prepared.document);
            if (nodes.length) { $insertNodes(nodes); inserted = true; }
            else if (prepared.plainText) { selection.insertText(prepared.plainText); inserted = true; }
            plainText = '';
          } catch {
            plainText = prepared.plainText;
            warnings.push('此富文本格式无法完整读取，已保留可读文本。');
          }
        } else plainText = prepared.plainText;
      }
      if (files.length) {
        warnings.push('附件暂不上传；已保留文件名，原文件仍需另行保存。');
        plainText += `${plainText ? '\n' : ''}${files.map((file) => `[附件未上传：${file.name || '剪贴板图片'}]`).join('\n')}`;
      }
      if (plainText) {
        const currentSelection = $getSelection();
        if ($isRangeSelection(currentSelection)) { currentSelection.insertRawText(plainText); inserted = true; }
        else if (currentSelection) { currentSelection.insertText(plainText); inserted = true; }
      }
      if (!inserted && warnings.length) warnings.push('剪贴板没有可读取的文本，请改用纯文本粘贴。');
      if (warnings.length) notice.current?.(warnings.join(' '));
      return true;
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(DROP_COMMAND, (event) => {
      if (event.dataTransfer?.files.length) {
        event.preventDefault();
        if (upload.current) {
          const files = Array.from(event.dataTransfer.files);
          queueMicrotask(() => startUpload(files));
          notice.current?.('正在上传拖入的附件；完成后会插入当前页面。');
        } else notice.current?.('附件上传尚未开放，请保留原文件；可复制文件名或说明到正文。');
        return true;
      }
      return false;
    }, COMMAND_PRIORITY_CRITICAL),
    );
    return () => { mounted = false; unregister(); };
  }, [editor]);
  if (!tablePaste) return null;
  const { target, preview, data, error } = tablePaste;
  const close = () => setTablePaste(null);
  return <Modal title={target.kind === 'paragraph' ? '将剪贴板转换为表格' : '扩展当前表格'} onClose={close}>
    <p className="dialog-description">剪贴板包含 {data.length} 行 × {data[0]!.length} 列文本。</p>
    {target.kind === 'table' && <p className="dialog-description">
      从第 {preview.row + 1} 行第 {preview.column + 1} 列开始覆盖，表格将扩展为 {preview.rows} 行 × {preview.columns} 列。
    </p>}
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions">
      <button className="nb-btn" type="button" onClick={close}>取消</button>
      <button className="nb-btn" type="button" onClick={() => completeTablePaste(true)}>粘贴为文本</button>
      <button className="nb-btn nb-btn-primary" type="button" disabled={Boolean(error)} onClick={() => completeTablePaste(false)}>
        {target.kind === 'paragraph' ? '创建表格' : '扩展并粘贴'}
      </button>
    </div>
  </Modal>;
}
