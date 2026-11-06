import type { PageDocument } from '@nbase/contracts';
import { expect, it } from 'vitest';
import { canonicalContent, contentMatchesServer, matchesServer } from './draftCompare';
import type { LocalPageDraft } from './drafts';

const unknownVersion = (body: unknown) => ({ schemaVersion: 2, body }) as unknown as PageDocument['content'];
const server = (title: string, content: PageDocument['content']): PageDocument => ({ id: 'page', workspaceId: 'workspace', parentId: null,
  title, revision: '1', icon: null, cover: null, createdAt: '', updatedAt: '', content });
const draft = (title: string, content: PageDocument['content']) => ({ title, content }) as LocalPageDraft;

it('ignores property order and undefined fields', () => {
  expect(canonicalContent(unknownVersion({ a: 1, b: undefined, c: [{ y: 1, x: 2 }] })))
    .toBe(canonicalContent(unknownVersion({ c: [{ x: 2, y: 1 }], a: 1 })));
});

it('still distinguishes real value and array order differences', () => {
  expect(canonicalContent(unknownVersion({ a: [1, 2] }))).not.toBe(canonicalContent(unknownVersion({ a: [2, 1] })));
  expect(canonicalContent(unknownVersion({ a: null }))).not.toBe(canonicalContent(unknownVersion({})));
});

it('requires both the title and the content to match the server', () => {
  const content = unknownVersion({ text: '正文' });
  expect(matchesServer(draft('标题', content), server('标题', content))).toBe(true);
  expect(matchesServer(draft('新标题', content), server('标题', content))).toBe(false);
  expect(matchesServer(draft('标题', unknownVersion({ text: '改过' })), server('标题', content))).toBe(false);
});

it('does not treat a missing server page as matching', () => {
  expect(contentMatchesServer(unknownVersion({}), undefined)).toBe(false);
});
