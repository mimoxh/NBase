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
