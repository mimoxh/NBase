import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $applyNodeReplacement, $getNodeByKey, createCommand, DecoratorNode } from 'lexical';
import type { DOMExportOutput, LexicalCommand, LexicalEditor, NodeKey, SerializedLexicalNode } from 'lexical';
import { isSerializedDatabaseView, pageReferenceUrl, type SerializedDatabaseView } from '@nbase/contracts';
import { LazyDatabaseView as DatabaseView } from '../../database/lazy';
import type { DatabaseDataSource } from '../../database/source';

/** Host-provided access to databases. Missing in read-only previews such as history and trash. */
export interface DatabaseEmbedding {
  source: DatabaseDataSource;
  /** Creates a new database under the current page and returns its id, or null when it was not created. */
  createDatabase?: () => Promise<string | null>;
  /** Databases that can be linked from this document. */
  databases?: readonly { id: string; title: string; icon: string | null }[];
}

const DatabaseEmbeddingContext = createContext<DatabaseEmbedding | null>(null);

export function DatabaseEmbeddingProvider({ value, children }: { value: DatabaseEmbedding | null | undefined; children: ReactNode }) {
  return <DatabaseEmbeddingContext.Provider value={value ?? null}>{children}</DatabaseEmbeddingContext.Provider>;
}

export function useDatabaseEmbedding() { return useContext(DatabaseEmbeddingContext); }

export const INSERT_DATABASE_VIEW_COMMAND: LexicalCommand<{ databaseId: string; viewId?: string | null }> =
  createCommand('INSERT_DATABASE_VIEW');
/** `new` creates a database first; `link` lets the person pick one. */
export const REQUEST_DATABASE_VIEW_COMMAND: LexicalCommand<'new' | 'link'> = createCommand('REQUEST_DATABASE_VIEW');

const markdownLabel = '数据库视图';

/** Markdown form: a link on its own line, so other tools still show where the data lives. */
export function databaseViewMarkdown(databaseId: string, viewId: string | null): string {
  return `[${markdownLabel}](${pageReferenceUrl(databaseId)}#nbase-database-view${viewId ? `=${viewId}` : ''})`;
}
export const databaseViewMarkdownPattern =
  /^\[数据库视图\]\(\/\?page=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})#nbase-database-view(?:=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\)\s*$/;

/**
 * Keys, input and clipboard events inside the block belong to its own fields. Lexical skips
 * events already marked as handled, and the events still reach React's own listeners.
 */
const isolatedEvents = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy',
  'compositionstart', 'compositionupdate', 'compositionend', 'dragstart', 'dragover', 'drop', 'click', 'mousedown'] as const;

const markHandled = (event: Event) => { (event as Event & { _lexicalHandled?: boolean })._lexicalHandled = true; };

function useIsolatedFromEditor() {
  const attached = useRef<HTMLElement | null>(null);
  const detach = () => {
    for (const name of isolatedEvents) attached.current?.removeEventListener(name, markHandled);
    attached.current = null;
  };
  useEffect(() => detach, []);
  return (element: HTMLElement | null) => {
    if (element === attached.current) return;
    detach();
    if (!element) return;
    for (const name of isolatedEvents) element.addEventListener(name, markHandled);
    attached.current = element;
  };
}

function DatabaseViewBlock({ editor, nodeKey, databaseId, viewId }: {
  editor: LexicalEditor; nodeKey: NodeKey; databaseId: string; viewId: string | null;
}) {
  const embedding = useDatabaseEmbedding();
  const editable = useLexicalEditable();
  const isolated = useIsolatedFromEditor();
  const source = useMemo(() => embedding ? { ...embedding.source, canWrite: embedding.source.canWrite && editable } : null,
    [embedding, editable]);
  if (!source) return <div className="nbase-database-placeholder" ref={isolated}>数据库视图（此处不显示数据）</div>;
  const rememberView = (next: string) => {
    if (!editable) return;
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isDatabaseViewNode(node) && node.getViewId() !== next) node.setViewId(next);
    });
  };
  const remove = () => editor.update(() => { $getNodeByKey(nodeKey)?.remove(); });
  return <div className="nbase-database-block" ref={isolated}>
    <DatabaseView source={source} databaseId={databaseId} viewId={viewId} compact onViewChange={rememberView}
      heading={<div className="nb-db-inline-head">
        <button type="button" className="nb-db-inline-title" onClick={() => source.openDatabase(databaseId)}>打开数据库 ↗</button>
        {editable && <button type="button" className="nb-btn nb-btn-quiet" onClick={remove}>从正文移除</button>}
      </div>} />
  </div>;
}

/**
 * A view of a database inside a document. It stores only the database and view ids; rows
 * and schema stay in the database, so edits here never change the document's revision.
 */
export class DatabaseViewNode extends DecoratorNode<ReactNode> {
  __databaseId: string;
  __viewId: string | null;

  static getType(): string { return 'database-view'; }
  static clone(node: DatabaseViewNode): DatabaseViewNode {
    return new DatabaseViewNode(node.__databaseId, node.__viewId, node.__key);
  }

  constructor(databaseId = '', viewId: string | null = null, key?: NodeKey) {
    super(key);
    this.__databaseId = databaseId;
    this.__viewId = viewId;
  }

  static importJSON(value: SerializedLexicalNode & Partial<SerializedDatabaseView>): DatabaseViewNode {
    const candidate = { type: value.type, version: value.version, databaseId: value.databaseId, viewId: value.viewId ?? null };
    if (!isSerializedDatabaseView(candidate)) throw new Error('无效的数据库视图。');
    return $createDatabaseViewNode(candidate.databaseId, candidate.viewId);
  }

  exportJSON(): SerializedDatabaseView {
    return { type: 'database-view', version: 1, databaseId: this.getDatabaseId(), viewId: this.getViewId() };
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'nbase-database-node';
    return element;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('a');
    element.href = pageReferenceUrl(this.getDatabaseId());
    element.textContent = markdownLabel;
    return { element };
  }

  updateDOM(): boolean { return false; }
  isInline(): boolean { return false; }
  getTextContent(): string { return ''; }
  getDatabaseId(): string { return this.getLatest().__databaseId; }
  getViewId(): string | null { return this.getLatest().__viewId; }
  setViewId(viewId: string | null): this { const node = this.getWritable(); node.__viewId = viewId; return node; }

  decorate(editor: LexicalEditor): ReactNode {
    return <DatabaseViewBlock editor={editor} nodeKey={this.getKey()} databaseId={this.getDatabaseId()} viewId={this.getViewId()} />;
  }
}

export function $createDatabaseViewNode(databaseId: string, viewId: string | null = null): DatabaseViewNode {
  return $applyNodeReplacement(new DatabaseViewNode(databaseId.toLowerCase(), viewId?.toLowerCase() ?? null));
}

export function $isDatabaseViewNode(node: unknown): node is DatabaseViewNode {
  return node instanceof DatabaseViewNode;
}
