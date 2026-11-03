import type { PageSummary } from '@nbase/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPageTree, pageClient } from './client';

const page = (id: string): PageSummary => ({
  id, workspaceId: 'workspace', parentId: null, title: `页面 ${id}`, revision: '1',
  createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z',
});

afterEach(() => { vi.restoreAllMocks(); });

describe('loadPageTree', () => {
  it('returns the single-request page list unchanged', async () => {
    const pages = [page('a'), page('b')];
    vi.spyOn(pageClient, 'tree').mockResolvedValue({ pages, truncated: false });
    await expect(loadPageTree('workspace')).resolves.toEqual(pages);
  });

  it('rejects a truncated tree instead of silently dropping pages', async () => {
    vi.spyOn(pageClient, 'tree').mockResolvedValue({ pages: [page('a')], truncated: true });
    await expect(loadPageTree('workspace')).rejects.toMatchObject({ code: 'PAGE_LIMIT_EXCEEDED' });
  });

  it('rejects duplicated page ids', async () => {
    vi.spyOn(pageClient, 'tree').mockResolvedValue({ pages: [page('a'), page('a')], truncated: false });
    await expect(loadPageTree('workspace')).rejects.toMatchObject({ code: 'PAGE_TREE_INVALID' });
  });
});
