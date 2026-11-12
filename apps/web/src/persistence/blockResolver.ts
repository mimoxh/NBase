import { blockTextFromContent } from '../editor/blockAnchors';
import { pageClient } from './client';

const ttlMs = 30_000;
const cache = new Map<string, { at: number; content: Promise<unknown> }>();

/** Several references to one page share a single read, kept briefly so typing does not refetch. */
export function resolveBlockText(workspaceId: string, pageId: string, blockId: string): Promise<string | null> {
  const key = workspaceId + ':' + pageId;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > ttlMs) {
    entry = { at: Date.now(), content: pageClient.get(workspaceId, pageId).then(page => page.content.editorState.root) };
    entry.content.catch(() => cache.delete(key));
    cache.set(key, entry);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return entry.content.then(root => blockTextFromContent(root, blockId), () => null);
}
