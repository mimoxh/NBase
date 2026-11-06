import { pageTagLimit, tagNameKey, type WorkspaceTag } from '@nbase/contracts';
import { ApiError, tagClient } from './client';

export async function resolveImportTags(workspaceId: string, csrfToken: string, names: readonly string[]): Promise<string[]> {
  const wanted = new Map(names.map(name => [tagNameKey(name), name.trim().normalize('NFC')]));
  if (!wanted.size) return [];
  if (wanted.size > pageTagLimit) throw new Error(`每页最多 ${pageTagLimit} 个标签。`);
  const ids = new Map<string, string>();
  const remember = (tags: WorkspaceTag[]) => tags.forEach(tag => ids.set(tagNameKey(tag.name), tag.id));
  remember((await tagClient.list(workspaceId)).tags);
  for (const [key, name] of wanted) {
    if (ids.has(key)) continue;
    try {
      const tag = await tagClient.create(workspaceId, { clientMutationId: crypto.randomUUID(), name }, csrfToken);
      ids.set(key, tag.id);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'TAG_NAME_CONFLICT') throw error;
      remember((await tagClient.list(workspaceId)).tags);
      if (!ids.has(key)) throw error;
    }
  }
  return [...wanted.keys()].map(key => ids.get(key)!);
}
