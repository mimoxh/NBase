import { createContext, useContext } from 'react';
import type { DatabaseRow } from '@nbase/contracts';

/**
 * What a `tags` column needs: the workspace's tags for names and choices, and a way to change
 * the tags of a row page. The values are the page's own tags, the same ones shown on the page.
 */
export interface DatabaseTagHost {
  tags: readonly { id: string; name: string }[];
  /** Absent where tags are shown but changed elsewhere, such as the panel of an open row page. */
  setRowTags?: ((row: DatabaseRow, tagIds: string[]) => void) | undefined;
}

export const DatabaseTagsContext = createContext<DatabaseTagHost | null>(null);

export function useDatabaseTags(): DatabaseTagHost | null { return useContext(DatabaseTagsContext); }

export function tagNames(host: DatabaseTagHost | null, row: DatabaseRow): string[] {
  const names = new Map(host?.tags.map(tag => [tag.id, tag.name]));
  return (row.tagIds ?? []).flatMap(id => { const name = names.get(id); return name ? [name] : []; });
}
