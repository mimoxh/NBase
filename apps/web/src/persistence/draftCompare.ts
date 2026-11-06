import type { PageDocument, StoredDocumentContent } from '@nbase/contracts';
import { normalizeDocumentContent } from '../editor/normalize';
import type { DocumentContent } from '../editor/types';
import type { LocalPageDraft } from './drafts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Code blocks compare in canonical text form so highlight tokens never register as edits. */
export function canonicalContent(content: StoredDocumentContent): string {
  return canonical(content.schemaVersion === 1 ? normalizeDocumentContent(content as DocumentContent) : content);
}

export function matchesServer(draft: LocalPageDraft, server: PageDocument): boolean {
  return draft.title === server.title && canonicalContent(draft.content) === canonicalContent(server.content);
}

export function contentMatchesServer(content: StoredDocumentContent, server: PageDocument | undefined): boolean {
  return !!server && canonicalContent(content) === canonicalContent(server.content);
}
