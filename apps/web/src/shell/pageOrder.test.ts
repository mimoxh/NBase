import { describe, expect, it } from 'vitest';
import { isSelfOrAncestor, placePage, siblingStep } from './pageOrder';

const pages = [
  { id: 'a', parentId: null }, { id: 'a1', parentId: 'a' }, { id: 'a2', parentId: 'a' },
  { id: 'b', parentId: null }, { id: 'c', parentId: null },
];
const order = (list: { id: string }[]) => list.map(item => item.id).join(' ');
const siblings = (list: typeof pages, parentId: string | null) => order(list.filter(item => item.parentId === parentId));

describe('page placement', () => {
  it('reorders inside a parent', () => {
    expect(siblings(placePage(pages, 'c', { parentId: null, afterId: null }), null)).toBe('c a b');
    expect(siblings(placePage(pages, 'a', { parentId: null, afterId: 'b' }), null)).toBe('b a c');
    expect(siblings(placePage(pages, 'a1', { parentId: 'a', afterId: 'a2' }), 'a')).toBe('a2 a1');
  });

  it('moves under another parent', () => {
    const moved = placePage(pages, 'c', { parentId: 'a', afterId: 'a1' });
    expect(siblings(moved, 'a')).toBe('a1 c a2');
    expect(siblings(moved, null)).toBe('a b');
    expect(moved.find(item => item.id === 'c')?.parentId).toBe('a');
    expect(siblings(placePage(pages, 'c', { parentId: 'b', afterId: null }), 'b')).toBe('c');
  });

  it('steps among siblings and stops at both ends', () => {
    expect(siblingStep(pages, 'b', -1)).toEqual({ parentId: null, afterId: null });
    expect(siblingStep(pages, 'b', 1)).toEqual({ parentId: null, afterId: 'c' });
    expect(siblingStep(pages, 'c', -1)).toEqual({ parentId: null, afterId: 'a' });
    expect(siblingStep(pages, 'a', -1)).toBeNull();
    expect(siblingStep(pages, 'c', 1)).toBeNull();
    expect(siblingStep(pages, 'missing', 1)).toBeNull();
  });

  it('detects drops that would make a cycle', () => {
    expect(isSelfOrAncestor(pages, 'a', 'a')).toBe(true);
    expect(isSelfOrAncestor(pages, 'a', 'a1')).toBe(true);
    expect(isSelfOrAncestor(pages, 'a1', 'a')).toBe(false);
    expect(isSelfOrAncestor(pages, 'a', null)).toBe(false);
  });
});
