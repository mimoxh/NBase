// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthSessionResponse, PageDocument } from '@nbase/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { PersistentWorkspace } from './PersistentWorkspace';
import { pageClient } from './client';
import { localDrafts, type LocalPageDraft } from './drafts';
import { createContentFromMarkdown } from '../editor/markdown';

vi.mock('../components/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <section role="dialog">{children}</section> }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps writing and export available when pending-action storage cannot be read', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const session: AuthSessionResponse = { user: { id: 'user', loginName: 'owner' },
    workspaces: [{ id: 'workspace', name: '我的空间', role: 'owner' }], csrfToken: 'csrf', expiresAt: '2099-01-01T00:00:00Z' };
  const page: PageDocument = { id: 'page', workspaceId: 'workspace', parentId: null, title: '故障样例', revision: '1',
    content: createContentFromMarkdown('已有正文'), createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z' };
  vi.spyOn(pageClient, 'session').mockResolvedValue(session);
  vi.spyOn(pageClient, 'list').mockImplementation(async (_workspace, parentId) => ({ pages: parentId ? [] : [page], nextCursor: null }));
  vi.spyOn(pageClient, 'get').mockResolvedValue(page);
  vi.spyOn(localDrafts, 'forScopeActions').mockRejectedValue(new Error('storage denied'));
  vi.spyOn(localDrafts, 'forScopeCreates').mockResolvedValue([]);
  vi.spyOn(localDrafts, 'forPage').mockResolvedValue([]);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PersistentWorkspace />));
    const open = [...host.querySelectorAll('button')].find(button => button.textContent === page.title)!;
    await act(async () => open.click());
    expect(host.textContent).toContain('网络保存已暂停');
    expect(host.querySelector('[aria-label="文档正文"]')?.getAttribute('contenteditable')).toBe('true');
    expect((host.querySelector('[aria-label="页面标题"]') as HTMLInputElement).disabled).toBe(false);
    expect((host.querySelector('[aria-label="下载页面"]') as HTMLButtonElement).disabled).toBe(false);
  } finally { await act(() => root.unmount()); host.remove(); }
});

it('refreshes the deletion subtree and refuses to delete a newly moved child with another tab draft', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const session: AuthSessionResponse = { user: { id: 'user', loginName: 'owner' },
    workspaces: [{ id: 'workspace', name: '我的空间', role: 'owner' }], csrfToken: 'csrf', expiresAt: '2099-01-01T00:00:00Z' };
  const parent: PageDocument = { id: 'parent', workspaceId: 'workspace', parentId: null, title: '父页', revision: '1',
    content: createContentFromMarkdown('父页正文'), createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z' };
  const child: PageDocument = { ...parent, id: 'child', title: '移动来的子页', content: createContentFromMarkdown('已保存的子页') };
  let moved = false;
  vi.spyOn(pageClient, 'session').mockResolvedValue(session);
  vi.spyOn(pageClient, 'list').mockImplementation(async (_workspace, parentId) => ({
    pages: moved ? parentId === null ? [parent] : parentId === parent.id ? [{ ...child, parentId: parent.id }] : []
      : parentId === null ? [parent, child] : [], nextCursor: null,
  }));
  vi.spyOn(pageClient, 'get').mockImplementation(async (_workspace, id) => id === child.id ? { ...child, parentId: parent.id } : parent);
  vi.spyOn(localDrafts, 'forScopeActions').mockResolvedValue([]);
  vi.spyOn(localDrafts, 'forScopeCreates').mockResolvedValue([]);
  vi.spyOn(localDrafts, 'forPage').mockResolvedValue([]);
  const otherDraft: LocalPageDraft = { key: 'other', pageId: child.id, workspaceId: 'workspace', userId: 'user', title: child.title,
    content: createContentFromMarkdown('另一标签尚未提交的子页正文'), markdown: '另一标签尚未提交的子页正文', baseRevision: '1', sequence: 1, updatedAt: '2026-10-27T00:01:00Z' };
  vi.spyOn(localDrafts, 'forPages').mockResolvedValue([otherDraft]);
  const putAction = vi.spyOn(localDrafts, 'putAction');
  const trash = vi.spyOn(pageClient, 'trash');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const clickText = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find(item => item.textContent === text)!;
    expect(button).toBeDefined(); await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<PersistentWorkspace />));
    await clickText(parent.title);
    moved = true;
    await clickText('移入回收站'); await clickText('确认移入回收站');
    expect(host.textContent).toContain('目录已变化');
    await clickText('移入回收站');
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('及 1 篇子页面');
    await clickText('确认移入回收站');
    expect(host.textContent).toContain('还有其他标签或会话的草稿');
    expect(trash).not.toHaveBeenCalled(); expect(putAction).not.toHaveBeenCalled();
  } finally { await act(() => root.unmount()); host.remove(); }
});
