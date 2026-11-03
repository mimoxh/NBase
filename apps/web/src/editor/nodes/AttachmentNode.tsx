import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { $applyNodeReplacement, $createParagraphNode, $getRoot, $getSelection, $isRangeSelection, DecoratorNode } from 'lexical';
import type { LexicalEditor, NodeKey, SerializedLexicalNode, Spread } from 'lexical';
import type { AttachmentMetadata } from '@nbase/contracts';

export const AttachmentWorkspaceContext = createContext<string | null>(null);

export type SerializedAttachmentNode = Spread<{
  attachmentId: string;
  alt: string;
  fileName: string;
  mediaType: string;
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

function AttachmentView({ id, alt, fileName, mediaType }: {
  id: string; alt: string; fileName: string; mediaType: string;
}) {
  const workspaceId = useContext(AttachmentWorkspaceContext);
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
  return <span className={`nbase-attachment ${image ? 'is-image' : 'is-file'}`} contentEditable={false}>
    {image && (source && !failure ? <img src={source} alt={alt || fileName} onError={() => setFailure('图片文件无法显示。')} />
      : !failure && <span className="nbase-attachment-loading">正在加载图片…</span>)}
    {!image && <span className="nbase-attachment-name">附件：{fileName}</span>}
    {failure && <span className="nbase-attachment-error" role="status">{failure}</span>}
    <button type="button" className="nbase-attachment-download" disabled={busy} onClick={() => void download()}>
      {busy ? '正在下载…' : `下载${image ? '图片' : '附件'}`}
    </button>
  </span>;
}

function escapeMarkdown(text: string): string { return text.replace(/[\\\[\]]/g, '\\$&'); }

export class AttachmentNode extends DecoratorNode<ReactNode> {
  __attachmentId: string;
  __alt: string;
  __fileName: string;
  __mediaType: string;

  static getType(): string { return 'attachment'; }
  static clone(node: AttachmentNode): AttachmentNode {
    return new AttachmentNode(node.__attachmentId, node.__alt, node.__fileName, node.__mediaType, node.__key);
  }
  constructor(id: string, alt: string, fileName: string, mediaType: string, key?: NodeKey) {
    super(key);
    this.__attachmentId = id;
    this.__alt = alt;
    this.__fileName = fileName;
    this.__mediaType = mediaType;
  }
  static importJSON(value: SerializedAttachmentNode): AttachmentNode {
    return $createAttachmentNode(value.attachmentId, value.alt, value.fileName, value.mediaType);
  }
  exportJSON(): SerializedAttachmentNode {
    return { type: 'attachment', version: 1,
      attachmentId: this.getLatest().__attachmentId, alt: this.getLatest().__alt,
      fileName: this.getLatest().__fileName, mediaType: this.getLatest().__mediaType };
  }
  createDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'nbase-attachment-node';
    element.dataset.fileName = this.__fileName;
    element.dataset.alt = this.__alt;
    return element;
  }
  updateDOM(): false { return false; }
  isInline(): true { return true; }
  getTextContent(): string { return this.getLatest().__fileName; }
  decorate(_editor: LexicalEditor): ReactNode {
    return <AttachmentView id={this.__attachmentId} alt={this.__alt}
      fileName={this.__fileName} mediaType={this.__mediaType} />;
  }
  getMarkdown(): string {
    const value = this.getLatest();
    const label = escapeMarkdown(value.__mediaType.startsWith('image/') ? value.__alt || value.__fileName : value.__fileName);
    return `${value.__mediaType.startsWith('image/') ? '!' : ''}[${label}](nbase-attachment:${value.__attachmentId})`;
  }
}

export function $createAttachmentNode(id: string, alt: string, fileName: string, mediaType: string): AttachmentNode {
  return $applyNodeReplacement(new AttachmentNode(id, alt, fileName, mediaType));
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
