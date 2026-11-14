import { expect, it } from 'vitest';
import { filterSlashCommands } from './SlashCommandPlugin';

const keys = (query: string, inTable = false, canUpload = false) =>
  filterSlashCommands(query, inTable, canUpload).map(command => command.key);

it('offers upload commands only where the host can pick files', () => {
  expect(keys('图片', false, true)).toEqual(['image']);
  expect(keys('upload', false, true)).toEqual(['attachment']);
  expect(keys('图片')).toEqual([]);
  expect(keys('附件')).toEqual([]);
  expect(keys('', false, true)).toEqual(expect.arrayContaining(['image', 'attachment']));
});

it('keeps upload commands available in table cells, like the page menu', () => {
  expect(keys('img', true, true)).toEqual(['image']);
});

it('matches static pinyin aliases and initials for Chinese command names', () => {
  expect(keys('biaoti').slice(0, 3)).toEqual(['h1', 'h2', 'h3']);
  expect(keys('bt2')).toEqual(['h2']);
  expect(keys('dmk')).toEqual(['code']);
  expect(keys('fgx')).toEqual(['hr']);
  expect(keys('db')).not.toContain('check');
  expect(keys('tupian', false, true)).toEqual(['image']);
  expect(keys('lianjie')).toEqual(['link']);
  expect(keys('链接')[0]).toBe('link');
});

it('keeps link, divider and table reachable from the slash menu', () => {
  expect(keys('')).toEqual(expect.arrayContaining(['link', 'hr', 'table']));
  expect(keys('lj', true)).toEqual(['link']);
});