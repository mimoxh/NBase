import { describe, expect, it } from 'vitest';
import { draftVersion, sameDraftVersion, type LocalPageDraft } from './drafts';

const makeDraft = (): LocalPageDraft => ({
  key: 'owner:personal:page:tab-a', userId: 'owner', workspaceId: 'personal', pageId: 'page',
  title: '草稿', content: { schemaVersion: 1, editorState: { root: { text: '旧正文' } } },
  markdown: '旧正文', baseRevision: '2', sequence: 3, updatedAt: '2026-10-26T00:00:00.000Z',
  pending: { clientMutationId: 'mutation-a', expectedRevision: '2', title: '草稿' },
});

describe('conditional draft cleanup', () => {
  it('matches only the exact source version adopted before saving or duplicating', () => {
    const original = makeDraft();
    const source = draftVersion(original);
    expect(sameDraftVersion(original, source)).toBe(true);
    expect(sameDraftVersion({ ...original, key: 'owner:personal:page:tab-b' }, source)).toBe(false);
    expect(sameDraftVersion({ ...original, sequence: 4 }, source)).toBe(false);
    expect(sameDraftVersion({ ...original, updatedAt: '2026-10-26T00:00:01.000Z' }, source)).toBe(false);
    expect(sameDraftVersion({ ...original, content: {
      schemaVersion: 1, editorState: { root: { text: '新正文' } },
    } }, source)).toBe(false);
    expect(sameDraftVersion({ ...original, pending: {
      clientMutationId: 'mutation-b', expectedRevision: '2', title: '草稿',
    } }, source)).toBe(false);
  });
});
