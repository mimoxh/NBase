import { ApiError } from './client';
import type { LocalPageDraft } from './drafts';

/** A completed client error cannot later produce a receipt for this rejected update. */
export function isDefiniteUpdateRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500
    && error.status !== 408 && error.code !== 'REVISION_CONFLICT';
}

/** Keep the latest edited content, but let its next save use a fresh mutation ID. */
export function releaseRejectedMutation(draft: LocalPageDraft, mutationId: string): LocalPageDraft | null {
  if (draft.pending?.clientMutationId !== mutationId) return null;
  const { pending: _pending, ...remaining } = draft;
  void _pending;
  return remaining;
}
