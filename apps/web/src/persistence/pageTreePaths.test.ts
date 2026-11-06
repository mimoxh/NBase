import type { PageSummary } from '@nbase/contracts';
import { expect, it } from 'vitest';
import { ancestorChain, ancestorPath, subtreeIds } from './pageTreePaths';

const page = (id: string, parentId: string | null, title = id): PageSummary => ({ id, workspaceId: 'workspace', parentId, title,
  revision: '1', icon: null, cover: null, createdAt: '', updatedAt: '' });

it('collects a subtree regardless of list order and leaves siblings out', () => {
  const pages = [page('grandchild', 'child'), page('sibling', null), page('child', 'root'), page('root', null)];
  expect(subtreeIds(pages, 'root').sort()).toEqual(['child', 'grandchild', 'root']);
  expect(subtreeIds(pages, 'sibling')).toEqual(['sibling']);
});

it('lists ancestors from the root down and stops at a missing parent', () => {
  const pages = [page('root', null), page('child', 'root'), page('leaf', 'child'), page('orphan', 'gone')];
  expect(ancestorChain(pages, 'child').map(item => item.id)).toEqual(['root', 'child']);
  expect(ancestorChain(pages, 'gone')).toEqual([]);
  expect(ancestorChain(pages, null)).toEqual([]);
});

it('does not loop on a cyclic parent link', () => {
  const pages = [page('a', 'b'), page('b', 'a')];
  expect(ancestorChain(pages, 'a').map(item => item.id)).toEqual(['b', 'a']);
});

it('formats the path with untitled pages and falls back at the root', () => {
  const pages = [page('root', null, ''), page('child', 'root', '子页'), page('leaf', 'child')];
  expect(ancestorPath(pages, 'leaf')).toBe('未命名页面 / 子页');
  expect(ancestorPath(pages, 'root')).toBe('个人空间');
});
