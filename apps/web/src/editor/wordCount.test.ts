import { expect, it } from 'vitest';
import { countText } from './wordCount';

it('counts Chinese by character and English by word', () => {
  expect(countText('中文 two words')).toEqual({ words: 4, characters: 10, minutes: 1 });
  expect(countText("don't stop-gap 1.5")).toMatchObject({ words: 4 });
  expect(countText('，。！')).toEqual({ words: 0, characters: 3, minutes: 0 });
  expect(countText('')).toEqual({ words: 0, characters: 0, minutes: 0 });
});

it('estimates reading time', () => {
  expect(countText('字'.repeat(801)).minutes).toBe(3);
  expect(countText('word '.repeat(200)).minutes).toBe(1);
});
