import type { PageVersionSummary } from '@nbase/contracts';
import { expect, it } from 'vitest';
import { groupHistory } from './historyGroups';

const now = new Date(2026, 10, 17, 18, 0);
const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).toISOString();
let revision = 100;
const version = (savedAt: string, extra: Partial<PageVersionSummary> = {}): PageVersionSummary => ({
  revision: String(revision--), title: '页', savedAt, operation: 'update', deleted: false, label: null, note: null, ...extra,
});
const shape = (versions: PageVersionSummary[]) => groupHistory(versions, now)
  .map(day => [day.label, day.entries.map(entry => [entry.version.revision, entry.hidden.map(item => item.revision)])]);

it('folds close saves into the newest one and keeps a gap, a name or another operation apart', () => {
  revision = 100;
  const list = [
    version(at(17, 17, 50)), version(at(17, 17, 48)), version(at(17, 17, 44)),
    version(at(17, 17, 30)), version(at(17, 17, 29)),
    version(at(17, 17, 28), { label: '定稿' }), version(at(17, 17, 27)),
    version(at(17, 17, 26), { operation: 'restore-version' }), version(at(17, 17, 25)),
  ];
  expect(shape(list)).toEqual([['今天', [
    ['100', ['99', '98']], ['97', ['96']], ['95', []], ['94', []], ['93', []], ['92', []],
  ]]]);
});

it('measures the gap between neighbours, not from the newest save of the run', () => {
  revision = 50;
  const list = [version(at(17, 10, 20)), version(at(17, 10, 16)), version(at(17, 10, 12)), version(at(17, 10, 8))];
  expect(shape(list)).toEqual([['今天', [['50', ['49', '48', '47']]]]]);
});

it('starts a new run on another day and labels days', () => {
  revision = 20;
  const list = [version(at(17, 0, 2)), version(at(16, 23, 59)), version(at(16, 23, 58)), version(at(3, 9, 0)),
    version(new Date(2025, 11, 31, 9, 0).toISOString())];
  expect(shape(list)).toEqual([
    ['今天', [['20', []]]], ['昨天', [['19', ['18']]]], ['11月3日', [['17', []]]], ['2025年12月31日', [['16', []]]],
  ]);
});
