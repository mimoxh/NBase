import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchLinkPreview, isBlockedAddress, LinkPreviewError, parsePreviewHtml, previewTarget } from '../src/linkPreview/fetchPreview.js';

test('blocks internal, loopback and mapped addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', 'not-an-ip']) assert.equal(isBlockedAddress(address), true, address);
  for (const address of ['93.184.216.34', '2606:4700:4700::1111']) assert.equal(isBlockedAddress(address), false, address);
});

test('accepts only http(s) on default ports without credentials', () => {
  assert.equal(previewTarget('https://example.com/a?b=1').hostname, 'example.com');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com', 'https://user:pw@example.com',
    'http://example.com:8080/', 'not a url', 42]) {
    assert.throws(() => previewTarget(url), (error: unknown) => error instanceof LinkPreviewError, String(url));
  }
});

test('refuses literal and resolved internal hosts before connecting', async () => {
  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://localhost/']) {
    await assert.rejects(fetchLinkPreview(url), (error: unknown) => error instanceof LinkPreviewError && error.code === 'URL_BLOCKED', url);
  }
});

test('reads Open Graph and title tags from the head only', () => {
  const url = new URL('https://www.example.com/post');
  const html = `<html><head><meta property="og:title" content="标题 &amp; 说明"><meta name='description' content='一段
    描述'><meta property="og:site_name" content="示例站"><title>备用</title></head><body><meta property="og:title" content="正文里的"></body>`;
  assert.deepEqual(parsePreviewHtml(html, url), { url: url.toString(), title: '标题 & 说明', description: '一段 描述', siteName: '示例站' });
  assert.deepEqual(parsePreviewHtml('<title> 仅标题 </title>', url),
    { url: url.toString(), title: '仅标题', description: '', siteName: 'example.com' });
});
