import assert from 'node:assert/strict';
import test from 'node:test';
import { pinyinBodyUnitLimit, pinyinSlots, pinyinVector } from '../src/search/pinyin-index.js';
import { parseSearchQuery, searchTerms, termParses, termTsQuery } from '../src/search/query.js';
import { pinyinSpan, termWindow, type LexemePositions } from '../src/search/highlight.js';

function lexemes(vector: string): LexemePositions {
  return new Map(vector.split(' ').filter(Boolean).map(entry => {
    const [lexeme, list] = entry.split(':');
    return [lexeme!, new Set(list!.split(',').map(Number))];
  }));
}

test('pinyin slots give each Han character one position and each other run one separator', () => {
  const slots = pinyinSlots('NBase 项目计划，v2', 100);
  assert.deepEqual(slots.map(slot => [slot.start, slot.end]), [[0, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 13]]);
  assert.deepEqual(slots[1]!.readings.slice(0, 1), ['xiang']);
  assert.equal(pinyinVector('NBase 项目', 100), 'xiang:2 mu:3');
  assert.equal(pinyinVector('only latin text', 100), '');
});

test('pinyin keys use word readings first and keep common alternatives for polyphonic characters', () => {
  const bank = lexemes(pinyinVector('银行行业', 100));
  assert.deepEqual([...bank.get('hang')!], [2, 3]);
  assert.ok(bank.get('xing')?.has(2));
  const city = lexemes(pinyinVector('重庆', 100));
  assert.ok(city.get('chong')?.has(1));
  assert.ok(city.get('zhong')?.has(1));
});

test('body pinyin is bounded to the documented prefix and per-lexeme position limit', () => {
  const vector = lexemes(pinyinVector('的'.repeat(pinyinBodyUnitLimit + 500), pinyinBodyUnitLimit));
  assert.equal(vector.get('de')!.size, 255);
  assert.ok(Math.max(...vector.get('de')!) <= pinyinBodyUnitLimit);
});

test('queries split on spaces and Chinese words, keeping mixed pieces whole', () => {
  assert.deepEqual(searchTerms('项目计划'), ['项目', '计划']);
  assert.deepEqual(searchTerms('项目jihua  NBase'), ['项目jihua', 'NBase']);
  assert.deepEqual(searchTerms('a a A b c d e f g h i j'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  const parsed = parseSearchQuery('项目 计划');
  assert.equal(parsed.compact, '项目计划');
  assert.equal(parsed.near, '项目.{0,24}计划');
  assert.equal(parseSearchQuery('50% off').near, '50\\%.{0,24}off');
});

test('pinyin terms parse full spellings, initials and Han characters into safe tsquery text', () => {
  assert.equal(termTsQuery({ text: 'xmjh', parses: termParses('xmjh') }), '(x:* <-> m:* <-> j:* <-> h:*)');
  assert.match(termTsQuery({ text: 'xiangmujihua', parses: termParses('xiangmujihua') })!, /^\(xiang <-> mu <-> ji <-> hua:\*\)/);
  assert.match(termTsQuery({ text: '项目jihua', parses: termParses('项目jihua') })!, /^\(xiang <-> mu <-> ji <-> hua:\*\)/);
  assert.equal(termParses('项目').length, 0, 'pure Chinese stays literal');
  assert.equal(termParses('hua').length, 0, 'one syllable is too vague for pinyin matching');
  assert.equal(termParses("x'y%z").length, 0);
  assert.equal(termParses('v2').length, 0);
  for (const query of ["a' | b", 'xi&an', "zhang'san"]) {
    const text = termTsQuery({ text: query, parses: termParses(query) });
    assert.ok(text === null || /^[a-z:*<>()| -]+$/.test(text), text ?? '');
  }
});

test('pinyin matches map back to the Chinese characters for highlighting', () => {
  const body = '会议纪要：我们讨论了项目计划的范围。';
  const query = parseSearchQuery('xiangmu jihua');
  const span = pinyinSpan(body, 'body', [query.joined!, ...query.terms], lexemes(pinyinVector(body, 100)));
  assert.deepEqual(span, { at: 10, text: '项目计划' });
  const initials = parseSearchQuery('xmjh');
  assert.equal(pinyinSpan(body, 'body', initials.terms, lexemes(pinyinVector(body, 100)))?.text, '项目计划');
});

test('term windows prefer the closest stretch containing every term', () => {
  const text = '计划在前面。很多无关文字。项目和计划在一起';
  assert.deepEqual(termWindow(text, ['项目', '计划']), { at: 13, term: '项目' });
  assert.equal(termWindow(text, ['缺失']), null);
});
