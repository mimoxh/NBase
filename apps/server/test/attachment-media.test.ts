import assert from 'node:assert/strict';
import test from 'node:test';
import { AttachmentError, identifyFile } from '../src/attachments/repository.js';
import { parseRange } from '../src/attachments/routes.js';

const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map(part =>
  typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part)));

test('identifies audio and video from their bytes, not their names', () => {
  assert.equal(identifyFile(bytes([0, 0, 0, 0x20], 'ftypisom'), 'a.mp4').mediaType, 'video/mp4');
  assert.equal(identifyFile(bytes([0, 0, 0, 0x20], 'ftypM4A '), 'a.m4a').mediaType, 'audio/mp4');
  assert.equal(identifyFile(bytes([0x1a, 0x45, 0xdf, 0xa3], 'xxxxwebmxxxx'), 'a.webm').mediaType, 'video/webm');
  assert.equal(identifyFile(bytes('OggS', [0, 2]), 'a.ogg').mediaType, 'audio/ogg');
  assert.equal(identifyFile(bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '), 'a.wav').mediaType, 'audio/wav');
  assert.equal(identifyFile(bytes('ID3', [4, 0, 0]), 'a.mp3').mediaType, 'audio/mpeg');
  assert.equal(identifyFile(bytes([0xff, 0xfb, 0x90, 0x00]), 'a.mp3').mediaType, 'audio/mpeg');
  assert.throws(() => identifyFile(bytes('<html><script>'), 'a.mp3'),
    (error: unknown) => error instanceof AttachmentError && error.statusCode === 415);
});

test('parses single byte ranges and rejects unsatisfiable ones', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid');
  assert.equal(parseRange('bytes=5-2', 1000), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-9', 1000), null);
  assert.equal(parseRange(undefined, 1000), null);
});
