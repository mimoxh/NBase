// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createContentFromMarkdown } from '../editor/markdown';
import { newTemplateWrite, sameTemplateWrite, templateWriteKey } from './templateWrites';

const scope = { userId: '账号', workspaceId: '工作区' };
const content = () => createContentFromMarkdown('独有模板正文');

it('isolates template operations by account, workspace and immutable operation ID', () => {
  const key = templateWriteKey(scope, 'operation');
  expect(templateWriteKey({ ...scope, userId: '其他' }, 'operation')).not.toBe(key);
  expect(templateWriteKey({ ...scope, workspaceId: '其他' }, 'operation')).not.toBe(key);
  expect(templateWriteKey(scope, 'other-operation')).not.toBe(key);
  expect(templateWriteKey({ userId: 'a:b', workspaceId: 'c' }, 'd')).not.toBe(templateWriteKey({ userId: 'a', workspaceId: 'b:c' }, 'd'));
});

it('captures the exact request and original body before network writes', () => {
  const snapshot = { name: '模板', content: content() };
  const operation = { kind: 'save' as const, id: 'existing',
    body: { clientMutationId: 'operation', expectedRevision: '7', ...snapshot } };
  const record = newTemplateWrite(scope, operation, snapshot);
  operation.body.name = '后来改名'; snapshot.content.editorState.root.children = [];
  expect(record.operation).toMatchObject({ id: 'existing', body: { name: '模板', expectedRevision: '7', clientMutationId: 'operation' } });
  expect(JSON.stringify(record.snapshot.content)).toContain('独有模板正文');
  expect(record.state).toBe('pending');
});

it('requires the full captured version before cleanup and rejects poisoned cross-account pointers', () => {
  const snapshot = { name: '模板', content: content() };
  const original = newTemplateWrite(scope, { kind: 'save', id: null, body: { clientMutationId: 'operation', ...snapshot } }, snapshot);
  expect(sameTemplateWrite(structuredClone(original), original)).toBe(true);
  expect(sameTemplateWrite(undefined, original)).toBe(false);
  for (const change of [
    { version: 'new-version' }, { userId: '其他' }, { workspaceId: '其他' }, { state: 'rejected' as const },
    { snapshot: { ...snapshot, name: '更新的正文' } },
    { operation: { kind: 'save' as const, id: null, body: { ...snapshot, clientMutationId: 'other-operation' } } },
  ]) expect(sameTemplateWrite({ ...original, ...change }, original)).toBe(false);
  const foreign = { ...original, userId: '其他', key: templateWriteKey({ ...scope, userId: '其他' }, 'operation') };
  expect(sameTemplateWrite(foreign, { ...foreign, userId: scope.userId })).toBe(false);
});
