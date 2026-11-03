import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { isDefiniteUpdateRejection, releaseRejectedMutation } from './savePolicy';
import type { LocalPageDraft } from './drafts';

describe('update retry policy', () => {
  it('releases a rejected mutation so corrected content can use a new ID', () => {
    expect(isDefiniteUpdateRejection(new ApiError(422, 'CONTENT_INVALID'))).toBe(true);
    expect(isDefiniteUpdateRejection(new ApiError(409, 'MUTATION_CONFLICT'))).toBe(true);
    expect(isDefiniteUpdateRejection(new ApiError(401, 'AUTH_EXPIRED'))).toBe(true);
  });

  it('keeps the same mutation while its commit outcome is unknown or a revision needs resolution', () => {
    expect(isDefiniteUpdateRejection(new ApiError(0, 'TIMEOUT'))).toBe(false);
    expect(isDefiniteUpdateRejection(new ApiError(0, 'NETWORK_UNAVAILABLE'))).toBe(false);
    expect(isDefiniteUpdateRejection(new ApiError(408, 'TIMEOUT'))).toBe(false);
    expect(isDefiniteUpdateRejection(new ApiError(503, 'SERVICE_UNAVAILABLE'))).toBe(false);
    expect(isDefiniteUpdateRejection(new ApiError(409, 'REVISION_CONFLICT'))).toBe(false);
  });

  it('removes only the rejected payload and retains a newer edit', () => {
    const draft: LocalPageDraft = {
      key: 'draft-a', pageId: 'page-a', userId: 'owner', workspaceId: 'personal',
      title: '已修正标题', content: { schemaVersion: 1, editorState: { root: { text: '已修正正文' } } },
      markdown: '已修正正文', baseRevision: '2', sequence: 4, updatedAt: '2026-10-26T00:00:00Z',
      pending: { clientMutationId: 'rejected', expectedRevision: '2', title: '旧标题' },
    };
    expect(releaseRejectedMutation(draft, 'other')).toBeNull();
    expect(releaseRejectedMutation(draft, 'rejected')).toEqual({ ...draft, pending: undefined });
    expect(releaseRejectedMutation(draft, 'rejected')?.pending).toBeUndefined();
  });
});
