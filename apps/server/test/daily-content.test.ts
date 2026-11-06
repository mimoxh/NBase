import assert from 'node:assert/strict';
import test from 'node:test';
import { quickCaptureLimit, quickCaptureMarker } from '@nbase/contracts';
import {
  appendQuickCapture, blankDailyContent, normalizeNoteTimeZone, normalizeQuickCapture, noteDateAt, validNoteDate,
} from '../src/notes/dailyContent.js';

test('workspace date follows timezone boundaries and validates actual calendar dates', () => {
  const instant = new Date('2026-11-04T16:00:01.000Z');
  assert.equal(noteDateAt('Asia/Shanghai', instant), '2026-11-05');
  assert.equal(noteDateAt('America/Los_Angeles', instant), '2026-11-04');
  assert.equal(normalizeNoteTimeZone('Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(normalizeNoteTimeZone('+08:00'), null);
  assert.equal(normalizeNoteTimeZone('Unknown/TimeZone'), null);
  assert.equal(validNoteDate('2024-02-29'), true);
  assert.equal(validNoteDate('2026-02-29'), false);
  assert.equal(validNoteDate('0000-11-05'), false);
});

test('quick capture appends literal text before the next peer section and preserves a renamed marker', () => {
  const initial = appendQuickCapture(blankDailyContent(), '第一条');
  type Node = { type: string; version: number; tag?: string; text?: string; $?: Record<string, unknown>; children?: Node[] };
  const root = initial.editorState.root as Node;
  const children = root.children!;
  children[0]!.children![0]!.text = '改了标题';
  children.push({ type: 'heading', tag: 'h3', version: 1, children: [{ type: 'text', version: 1, text: '子节' }] });
  children.push({ type: 'heading', tag: 'h2', version: 1, children: [{ type: 'text', version: 1, text: '下一节' }] });
  const result = appendQuickCapture(initial, '**原样**\n\t下一行');
  const next = (result.editorState.root as Node).children!;
  assert.deepEqual(next[3]!.children!.map(node => [node.type, node.text]),
    [['text', '**原样**'], ['linebreak', undefined], ['tab', '\t'], ['text', '下一行']]);
  assert.equal(next[4]!.children![0]!.text, '下一节');
  assert.equal(next.filter(node => node.$?.[quickCaptureMarker]).length, 1);
  assert.equal(next[0]!.children![0]!.text, '改了标题');
  assert.equal(children.length, 4);
});

test('quick capture limits count Unicode code points and reject non-JSON controls', () => {
  assert.equal(normalizeQuickCapture(' 行\r\n\t原样 '), ' 行\n\t原样 ');
  assert.equal(normalizeQuickCapture('🧪'.repeat(quickCaptureLimit))?.length, quickCaptureLimit * 2);
  assert.equal(normalizeQuickCapture('🧪'.repeat(quickCaptureLimit + 1)), null);
  assert.equal(normalizeQuickCapture(' \t\r\n'), null);
  assert.equal(normalizeQuickCapture('错误\u0000文本'), null);
});
