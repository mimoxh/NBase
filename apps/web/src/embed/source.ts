import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PageKind, StoredDocumentContent } from '@nbase/contracts';
import type { DocumentEditorProps, EditorSnapshot } from '../editor/types';

/**
 * Pages shown inside another page: a whiteboard in a document, a document on a whiteboard.
 * The views depend on this interface only; the persistent workspace routes writes through
 * the page saver (local draft first, revision check, receipts) and the demo keeps them in memory.
 * This module is imported statically by the editor and the workspaces, so it stays small.
 */

export type EmbedSaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

export interface EmbeddedPage {
  id: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  content: StoredDocumentContent;
}

export interface EmbedPageChoice { id: string; title: string; icon: string | null; kind?: PageKind | undefined }

export interface EmbeddedPages {
  canWrite: boolean;
  /** Pages of the workspace, for pickers and titles. */
  pages: readonly EmbedPageChoice[];
  /** The latest content, including this tab's unsaved edits; null when the page is gone. */
  load(pageId: string): Promise<EmbeddedPage | null>;
  save(pageId: string, title: string, snapshot: EditorSnapshot): void;
  state(pageId: string): EmbedSaveState;
  subscribe(pageId: string, listener: () => void): () => void;
  openPage(pageId: string): void;
  /** Creates a whiteboard next to the current page and returns its id, or null when it was not created. */
  createWhiteboard?: (() => Promise<string | null>) | undefined;
  /** What a document edited on a whiteboard needs from the host: page links, databases, uploads. */
  editor?: Pick<DocumentEditorProps, 'pageReferences' | 'databases' | 'workspaceId' | 'onUploadFiles' | 'onLinkPreview' | 'resolveBlock'> | undefined;
  imageUrl(attachmentId: string): string | null;
  uploadImages?: ((files: File[]) => Promise<{ id: string; fileName: string; mediaType: string }[]>) | undefined;
  notice(text: string): void;
}

/** Save states by page, shared between the saver that reports them and the embeds that show them. */
export class EmbedStates {
  private readonly states = new Map<string, EmbedSaveState>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get(pageId: string): EmbedSaveState { return this.states.get(pageId) ?? 'idle'; }

  set(pageId: string, state: EmbedSaveState): void {
    if (this.get(pageId) === state && state !== 'saved') return;
    this.states.set(pageId, state);
    for (const listener of [...this.listeners.get(pageId) ?? []]) listener();
  }

  subscribe(pageId: string, listener: () => void): () => void {
    const set = this.listeners.get(pageId) ?? new Set();
    set.add(listener);
    this.listeners.set(pageId, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(pageId); };
  }
}

const EmbeddedPagesContext = createContext<EmbeddedPages | null>(null);

export function EmbeddedPagesProvider({ value, children }: { value: EmbeddedPages | null | undefined; children: ReactNode }) {
  return createElement(EmbeddedPagesContext.Provider, { value: value ?? null }, children);
}

export function useEmbeddedPages(): EmbeddedPages | null { return useContext(EmbeddedPagesContext); }

/** Page ids from the open page down to the embed being rendered. */
const EmbedPathContext = createContext<readonly string[]>([]);

/** The open page plus three levels of embeds render live; deeper ones are links. */
export const maxEmbedDepth = 4;

export function EmbedPathProvider({ pageId, children }: { pageId: string; children: ReactNode }) {
  const parent = useContext(EmbedPathContext);
  const id = pageId.toLowerCase();
  const path = useMemo(() => parent.at(-1) === id ? parent : [...parent, id], [parent, id]);
  return createElement(EmbedPathContext.Provider, { value: path }, children);
}

/** True when showing the page here would repeat an ancestor or nest too deep. */
export function useEmbedBlocked(pageId: string): boolean {
  const path = useContext(EmbedPathContext);
  return path.includes(pageId.toLowerCase()) || path.length >= maxEmbedDepth;
}

/** One editable view per page and tab: a second view of the same page would overwrite the first. */
const writers = new Map<string, symbol>();
const writerListeners = new Set<() => void>();

function useEmbedWriter(pageId: string, wanted: boolean): boolean {
  const token = useRef(Symbol('embed')).current;
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    if (!wanted) { setOwner(false); return; }
    const claim = () => {
      if (!writers.has(pageId)) writers.set(pageId, token);
      setOwner(writers.get(pageId) === token);
    };
    claim();
    writerListeners.add(claim);
    return () => {
      writerListeners.delete(claim);
      if (writers.get(pageId) === token) { writers.delete(pageId); for (const listener of [...writerListeners]) listener(); }
    };
  }, [pageId, wanted, token]);
  return owner;
}

export interface EmbeddedPageView {
  status: 'loading' | 'ready' | 'missing' | 'error';
  page: EmbeddedPage | null;
  /** Changes when the content was read again; use it as a key so the view starts from the new content. */
  epoch: number;
  saveState: EmbedSaveState;
  /** False for viewers and for every view of a page after the first. */
  writable: boolean;
  reload(): void;
}

export function useEmbeddedPage(pageId: string, wantWrite = true): EmbeddedPageView {
  const embeds = useEmbeddedPages();
  const available = Boolean(embeds);
  const [loaded, setLoaded] = useState<{ status: EmbeddedPageView['status']; page: EmbeddedPage | null; epoch: number }>(
    { status: 'loading', page: null, epoch: 0 });
  const [saveState, setSaveState] = useState<EmbedSaveState>(() => embeds?.state(pageId) ?? 'idle');
  const [request, setRequest] = useState(0);
  const owner = useEmbedWriter(pageId, wantWrite && Boolean(embeds?.canWrite));
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  useEffect(() => {
    if (!embeds) { setLoaded(previous => ({ status: 'missing', page: null, epoch: previous.epoch })); return; }
    let active = true;
    void embeds.load(pageId).then(page => {
      if (active) setLoaded(previous => ({ status: page ? 'ready' : 'missing', page, epoch: previous.epoch + 1 }));
    }).catch(() => {
      if (active) setLoaded(previous => previous.page ? previous : { status: 'error', page: null, epoch: previous.epoch });
    });
    return () => { active = false; };
    // `embeds` changes identity with the page list; the load only depends on which page is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, request, available]);

  useEffect(() => {
    if (!embeds) return;
    setSaveState(embeds.state(pageId));
    return embeds.subscribe(pageId, () => {
      const next = embeds.state(pageId);
      setSaveState(next);
      // Views that do not own the page follow what the owner saved.
      if (next === 'saved' && !ownerRef.current) setRequest(value => value + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, available]);

  return { ...loaded, saveState, writable: owner && saveState !== 'conflict',
    reload: () => setRequest(value => value + 1) };
}

export const embedStateLabel: Record<EmbedSaveState, string> = {
  idle: '', saving: '保存中…', saved: '已保存', conflict: '有冲突 · 请打开页面处理', error: '未保存 · 稍后重试',
};
