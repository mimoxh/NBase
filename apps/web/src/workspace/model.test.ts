import { describe, expect, it } from 'vitest';
import { initialWorkspace } from './fixtures';
import { ancestors, canMove, descendants, workspaceReducer } from './model';

describe('confirmed subpage tree', () => {
  it('keeps page identity and descendants when moving and renaming a page', () => {
    const start = initialWorkspace();
    expect(ancestors(start.pages, 'writing').map(page => page.id)).toEqual(['welcome']);
    const moved = workspaceReducer(start, { type: 'move', id: 'welcome', parentId: 'notes' });
    const renamed = workspaceReducer(moved, { type: 'rename', id: 'welcome', title: '新的标题' });
    expect(renamed.pages.find(page => page.id === 'welcome')).toMatchObject({ parentId: 'notes', title: '新的标题' });
    expect(renamed.pages.find(page => page.id === 'writing')?.parentId).toBe('welcome');
    expect(ancestors(renamed.pages, 'writing').map(page => page.id)).toEqual(['notes', 'welcome']);
  });

  it('rejects self, descendant, deleted and missing move targets', () => {
    const start = initialWorkspace();
    expect(descendants(start.pages, 'welcome')).toEqual(new Set(['welcome', 'writing', 'markdown']));
    for (const target of ['welcome', 'writing', 'markdown', 'old', 'missing']) {
      expect(canMove(start.pages, 'welcome', target)).toBe(false);
      expect(workspaceReducer(start, { type: 'move', id: 'welcome', parentId: target })).toBe(start);
    }
    expect(canMove(start.pages, 'welcome', null)).toBe(true);
  });

  it('restores a deleted subtree without reviving a child deleted independently earlier', () => {
    const start = initialWorkspace();
    const deletedChild = workspaceReducer(start, { type: 'delete', id: 'writing' });
    const deletedParent = workspaceReducer(deletedChild, { type: 'delete', id: 'welcome' });
    const restored = workspaceReducer(deletedParent, { type: 'restore', id: 'welcome' });
    expect(restored.pages.find(page => page.id === 'welcome')?.deleted).toBe(false);
    expect(restored.pages.find(page => page.id === 'markdown')?.deleted).toBe(false);
    expect(restored.pages.find(page => page.id === 'writing')?.deleted).toBe(true);
  });

  it('stores page icon and cover through appearance actions', () => {
    const start = initialWorkspace();
    const withIcon = workspaceReducer(start, { type: 'icon', id: 'welcome', icon: '📌' });
    expect(withIcon.pages.find(page => page.id === 'welcome')).toMatchObject({ icon: '📌', dirty: true });
    const withCover = workspaceReducer(withIcon, { type: 'cover', id: 'welcome', cover: 'rose' });
    expect(withCover.pages.find(page => page.id === 'welcome')?.cover).toBe('rose');
    const cleared = workspaceReducer(withCover, { type: 'icon', id: 'welcome', icon: null });
    expect(cleared.pages.find(page => page.id === 'welcome')?.icon).toBeNull();
    expect(cleared.pages.find(page => page.id === 'welcome')?.cover).toBe('rose');
  });

  it('returns a child to the root if its parent remains in the trash', () => {
    const deleted = workspaceReducer(initialWorkspace(), { type: 'delete', id: 'welcome' });
    const restored = workspaceReducer(deleted, { type: 'restore', id: 'writing' });
    expect(restored.pages.find(page => page.id === 'writing')).toMatchObject({ parentId: null, deleted: false, id: 'writing' });
    expect(restored.pages.find(page => page.id === 'welcome')?.deleted).toBe(true);
    expect(restored.pages.find(page => page.id === 'markdown')?.deleted).toBe(true);
  });
});
