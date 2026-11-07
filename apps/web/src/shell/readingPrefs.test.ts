import { expect, it, vi } from 'vitest';
import { parseReadingPrefs, readingMenuItems } from './readingPrefs';

it('reads stored preferences and falls back on anything unexpected', () => {
  expect(parseReadingPrefs('{"focus":true,"wide":false,"size":"large"}')).toEqual({ focus: true, wide: false, size: 'large' });
  expect(parseReadingPrefs('{"size":"huge","focus":"yes"}')).toEqual({ focus: false, wide: false, size: 'normal' });
  expect(parseReadingPrefs('not json')).toEqual({ focus: false, wide: false, size: 'normal' });
  expect(parseReadingPrefs(null)).toEqual({ focus: false, wide: false, size: 'normal' });
});

it('toggles settings and cycles the text size', () => {
  const update = vi.fn();
  const items = readingMenuItems({ focus: true, wide: false, size: 'large' }, update);
  expect(items.map(item => item.label)).toEqual(['退出专注模式', '全宽页面', '正文字号：大', '打印或存为 PDF']);
  items[0]!.onSelect();
  items[1]!.onSelect();
  items[2]!.onSelect();
  expect(update.mock.calls.map(call => call[0])).toEqual([{ focus: false }, { wide: true }, { size: 'small' }]);
});
