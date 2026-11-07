import { expect, it } from 'vitest';
import { blockStyleForKey } from './ShortcutsPlugin';

const key = (code: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ code, altKey: true, ctrlKey: true, metaKey: false, shiftKey: false, ...extra });

it('maps Ctrl or Cmd with Alt and a digit to block styles', () => {
  expect(blockStyleForKey(key('Digit0'))).toBe('paragraph');
  expect(blockStyleForKey(key('Digit3'))).toBe('h3');
  expect(blockStyleForKey(key('Digit8', { ctrlKey: false, metaKey: true }))).toBe('code');
});

it('ignores other combinations', () => {
  expect(blockStyleForKey(key('Digit9'))).toBeNull();
  expect(blockStyleForKey(key('Digit1', { altKey: false }))).toBeNull();
  expect(blockStyleForKey(key('Digit1', { ctrlKey: false }))).toBeNull();
  expect(blockStyleForKey(key('Digit1', { shiftKey: true }))).toBeNull();
});
