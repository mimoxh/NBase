import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { mergeRegister } from '@lexical/utils';
import {
  $applyNodeReplacement, $createParagraphNode, $getNodeByKey, $getRoot, $getSelection, $isRangeSelection, COMMAND_PRIORITY_LOW,
  DecoratorNode, KEY_BACKSPACE_COMMAND, KEY_DELETE_COMMAND,
} from 'lexical';
import type { LexicalEditor, LexicalNode, NodeKey, SerializedLexicalNode, Spread } from 'lexical';
import { attachmentPresentationOf, attachmentPreviewKind, isAttachmentPresentation, type AttachmentAlign, type AttachmentMetadata, type AttachmentPresentation } from '@nbase/contracts';
import { ImageControls, ImageLightbox, ResizeHandle } from './AttachmentImageControls';

export const AttachmentWorkspaceContext = createContext<string | null>(null);

export type SerializedAttachmentNode = Spread<{
  attachmentId: string;
  alt: string;
  fileName: string;
  mediaType: string;
  width?: number;
  align?: AttachmentAlign;
  caption?: string;
}, SerializedLexicalNode>;

function attachmentUrl(workspaceId: string, id: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(id)}/content`;
}

function failureText(status: number): string {
  if (status === 401) return '登录已失效，图片暂时无法读取。';
  if (status === 404) return '图片文件已不存在。';
  if (status === 503) return '图片文件缺失或损坏。';
  return '图片暂时无法加载。';
}

function AttachmentView({ nodeKey, id, alt, fileName, mediaType, presentation }: {
  nodeKey: NodeKey; id: string; alt: string; fileName: string; mediaType: string; presentation: AttachmentPresentation;
}) {
  const workspaceId = useContext(AttachmentWorkspaceContext);
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [isSelected, setSelected, clearSelected] = useLexicalNodeSelection(nodeKey);
  const [active, setActive] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const frame = useRef<HTMLSpanElement>(null);
  const image = mediaType.startsWith('image/');
  const [source, setSource] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!image || !workspaceId) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setFailure('');
    void fetch(attachmentUrl(workspaceId, id), {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(failureText(response.status));
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    }).catch(error => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : '图片暂时无法加载。');
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, image, workspaceId]);

  useEffect(() => {
    if (!active) return;
    // The panel outlives the node selection, which moves when its caption input takes focus.
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node && frame.current?.contains(event.target))) setActive(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [active]);

  useEffect(() => {
    if (!isSelected) return;
    const remove = (event: KeyboardEvent) => {
      event.preventDefault();
      $getNodeByKey(nodeKey)?.remove();
      return true;
    };
    return mergeRegister(
      editor.registerCommand(KEY_DELETE_COMMAND, remove, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_BACKSPACE_COMMAND, remove, COMMAND_PRIORITY_LOW),
    );
  }, [editor, isSelected, nodeKey]);

  const present = (next: AttachmentPresentation) => editor.update(() => {
    const node = $getNodeByKey(nodeKey);
    if ($isAttachmentNode(node)) node.setPresentation(next);
  });
  const closeZoom = useCallback(() => setZoomed(false), []);

  const download = async () => {
    if (!workspaceId || busy) return;
    setBusy(true); setFailure('');
    try {
      const response = await fetch(`${attachmentUrl(workspaceId, id)}?download=1`, {
        credentials: 'same-origin', cache: 'no-store',
      });
      if (!response.ok) throw new Error(failureText(response.status).replace('图片', '附件'));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setFailure(error instanceof Error ? error.message : '附件下载失败。'); }
    finally { setBusy(false); }
  };

  if (!workspaceId) return <span className="nbase-attachment-error">附件仅在服务端工作台中可读取。</span>;
  const controls = active && editable && image;
  return <span ref={frame} className={`nbase-attachment ${image ? 'is-image' : 'is-file'}${controls ? ' is-active' : ''}`} contentEditable={false}>
    {image && (source && !failure ? <span className="nbase-image-frame">
      <img src={source} alt={alt || fileName} onError={() => setFailure('图片文件无法显示。')}
        onClick={() => {
          if (!editable) { setZoomed(true); return; }
          clearSelected();
          setSelected(true);
          setActive(true);
        }} onDoubleClick={() => setZoomed(true)} />
      {controls && <ResizeHandle target={() => editor.getElementByKey(nodeKey)} column={() => editor.getRootElement()}
        onResize={width => present({ ...presentation, width })} />}
    </span> : !failure && <span className="nbase-attachment-loading">正在加载图片…</span>)}
    {image && presentation.caption && <span className="nbase-attachment-caption">{presentation.caption}</span>}
    {controls && <ImageControls value={presentation} onChange={present} onZoom={() => setZoomed(true)} />}
    {zoomed && source && <ImageLightbox source={source} alt={alt || fileName} onClose={closeZoom} />}
    {!image && <span className="nbase-attachment-name">附件：{fileName}</span>}
    <MediaPreview kind={attachmentPreviewKind(mediaType)} url={attachmentUrl(workspaceId, id)} fileName={fileName} />
    {failure && <span className="nbase-attachment-error" role="status">{failure}</span>}
    <button type="button" className="nbase-attachment-download" disabled={busy} onClick={() => void download()}>
      {busy ? '正在下载…' : `下载${image ? '图片' : '附件'}`}
    </button>
  </span>;
}

/** Audio, video and PDF stream from the same authorized URL; the browser sends the session cookie and byte ranges. */
function MediaPreview({ kind, url, fileName }: { kind: ReturnType<typeof attachmentPreviewKind>; url: string; fileName: string }) {
  const [open, setOpen] = useState(kind !== 'pdf');
  if (kind === 'audio') return <audio className="nbase-attachment-media" controls preload="metadata" src={url} aria-label={fileName} />;
  if (kind === 'video') return <video className="nbase-attachment-media is-video" controls preload="metadata" src={url} aria-label={fileName} />;
  if (kind !== 'pdf') return null;
  // A PDF viewer is heavy, so it loads only when asked for.
  return open ? <iframe className="nbase-attachment-pdf" src={url} title={fileName} loading="lazy" />
    : <button type="button" className="nbase-attachment-download" onClick={() => setOpen(true)}>预览 PDF</button>;
}

function applyPresentation(element: HTMLElement, { width, align }: AttachmentPresentation): void {
  element.style.width = width === undefined ? '' : width + '%';
  element.style.display = '';
  if (width === undefined) delete element.dataset.sized; else element.dataset.sized = '';
  if (align === undefined) delete element.dataset.align; else element.dataset.align = align;
}

function escapeMarkdown(text: string): string { return text.replace(/[\\\[\]]/g, '\\$&'); }

export class AttachmentNode extends DecoratorNode<ReactNode> {
  __attachmentId: string;
  __alt: string;
  __fileName: string;
  __mediaType: string;
  __presentation: AttachmentPresentation;

  static getType(): string { return 'attachment'; }
  static clone(node: AttachmentNode): AttachmentNode {
    return new AttachmentNode(node.__attachmentId, node.__alt, node.__fileName, node.__mediaType, node.__presentation, node.__key);
  }
  constructor(id: string, alt: string, fileName: string, mediaType: string, presentation: AttachmentPresentation = {}, key?: NodeKey) {
    super(key);
    this.__presentation = presentation;
    this.__attachmentId = id;
    this.__alt = alt;
    this.__fileName = fileName;
    this.__mediaType = mediaType;
  }
  static importJSON(value: SerializedAttachmentNode): AttachmentNode {
    const presentation = attachmentPresentationOf(value);
    return $createAttachmentNode(value.attachmentId, value.alt, value.fileName, value.mediaType,
      isAttachmentPresentation(presentation) ? presentation : {});
  }
  exportJSON(): SerializedAttachmentNode {
    const latest = this.getLatest();
    const presentation = attachmentPresentationOf(latest.__presentation);
    // The settings are optional keys on version 1; source editing refuses any other node version.
    return { type: 'attachment', version: 1,
      attachmentId: latest.__attachmentId, alt: latest.__alt,
      fileName: latest.__fileName, mediaType: latest.__mediaType, ...presentation };
  }
  getPresentation(): AttachmentPresentation { return this.getLatest().__presentation; }
  setPresentation(presentation: AttachmentPresentation): void {
    this.getWritable().__presentation = attachmentPresentationOf(presentation);
  }
  createDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'nbase-attachment-node';
    element.dataset.fileName = this.__fileName;
    element.dataset.alt = this.__alt;
    applyPresentation(element, this.__presentation);
    return element;
  }
  updateDOM(_previous: AttachmentNode, element: HTMLElement): false {
    applyPresentation(element, this.__presentation);
    return false;
  }
  isInline(): true { return true; }
  getTextContent(): string { return this.getLatest().__fileName; }
  decorate(_editor: LexicalEditor): ReactNode {
    return <AttachmentView nodeKey={this.getKey()} id={this.__attachmentId} alt={this.__alt}
      fileName={this.__fileName} mediaType={this.__mediaType} presentation={this.__presentation} />;
  }
  getMarkdown(): string {
    const value = this.getLatest();
    const label = escapeMarkdown(value.__mediaType.startsWith('image/') ? value.__alt || value.__fileName : value.__fileName);
    return `${value.__mediaType.startsWith('image/') ? '!' : ''}[${label}](nbase-attachment:${value.__attachmentId})`;
  }
}

export function $createAttachmentNode(id: string, alt: string, fileName: string, mediaType: string,
  presentation: AttachmentPresentation = {}): AttachmentNode {
  return $applyNodeReplacement(new AttachmentNode(id, alt, fileName, mediaType, presentation));
}

export function $isAttachmentNode(node: LexicalNode | null | undefined): node is AttachmentNode {
  return node instanceof AttachmentNode;
}

export function $createAttachmentNodeFromMetadata(metadata: AttachmentMetadata): AttachmentNode {
  return $createAttachmentNode(metadata.id, metadata.mediaType.startsWith('image/') ? metadata.fileName : '',
    metadata.fileName, metadata.mediaType);
}

/** Insert at the live selection, or append a paragraph if focus moved away during upload. */
export function $insertAttachments(metadata: AttachmentMetadata[]): void {
  const nodes = metadata.map($createAttachmentNodeFromMetadata);
  const selection = $getSelection();
  if ($isRangeSelection(selection)) selection.insertNodes(nodes);
  else $getRoot().append($createParagraphNode().append(...nodes));
}
