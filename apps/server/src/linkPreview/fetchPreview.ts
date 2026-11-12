import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LinkPreview } from '@nbase/contracts';

export class LinkPreviewError extends Error {
  constructor(public readonly code: 'URL_INVALID' | 'URL_BLOCKED' | 'FETCH_FAILED' | 'NOT_HTML') { super(code); }
}

const maxBytes = 512 * 1024;
const timeoutMs = 6000;
const maxRedirects = 3;

/** Every address a preview may not reach: loopback, private, link-local, CGNAT, multicast, reserved. */
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(network, prefix, 'ipv6');

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  // BlockList also matches IPv4 against IPv4-mapped IPv6 rules, so mapped addresses are unwrapped here instead.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isBlockedAddress(mapped);
  if (/^::ffff:/i.test(address)) return true;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function previewTarget(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2000) throw new LinkPreviewError('URL_INVALID');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new LinkPreviewError('URL_INVALID'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new LinkPreviewError('URL_INVALID');
  // Only the default web ports, so a preview cannot probe other services on a public host.
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new LinkPreviewError('URL_BLOCKED');
  return url;
}

/** Resolves once and pins the connection to the checked address, so DNS rebinding cannot swap it. */
async function resolvePublic(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => { throw new LinkPreviewError('FETCH_FAILED'); });
  if (!addresses.length || addresses.some(item => isBlockedAddress(item.address))) throw new LinkPreviewError('URL_BLOCKED');
  return addresses[0] as { address: string; family: 4 | 6 };
}

function get(url: URL, pinned: { address: string; family: 4 | 6 }, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', signal,
      headers: { 'User-Agent': 'NBase-LinkPreview/1.0', Accept: 'text/html,application/xhtml+xml;q=0.9', 'Accept-Encoding': 'identity' },
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
    }, resolve);
    request.on('error', reject);
    request.end();
  });
}

async function readBody(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const part = chunk as Buffer;
    size += part.length;
    // A page's <head> sits at its start; stop reading once enough is in hand.
    if (size > maxBytes) { chunks.push(part.subarray(0, part.length - (size - maxBytes))); response.destroy(); break; }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

const clean = (value: string | undefined, limit: number) => value === undefined ? ''
  : decode(value).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);

/** Reads title, description and site name from the document head; nothing else is kept. */
export function parsePreviewHtml(html: string, url: URL): LinkPreview {
  const head = html.slice(0, maxBytes).split(/<\/head\s*>/i)[0] ?? '';
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attribute = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    const key = attribute('property') ?? attribute('name');
    const content = attribute('content');
    const name = (key?.[1] ?? key?.[2] ?? key?.[3])?.toLowerCase();
    if (name && content && !meta.has(name)) meta.set(name, content[1] ?? content[2] ?? content[3] ?? '');
  }
  const title = clean(meta.get('og:title') ?? meta.get('twitter:title') ?? /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1], 300);
  return {
    url: url.toString(),
    title: title || url.hostname,
    description: clean(meta.get('og:description') ?? meta.get('description') ?? meta.get('twitter:description'), 1000),
    siteName: clean(meta.get('og:site_name'), 120) || url.hostname.replace(/^www\./, ''),
  };
}

export async function fetchLinkPreview(raw: unknown): Promise<LinkPreview> {
  let url = previewTarget(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirect = 0; ; redirect++) {
      const response = await get(url, await resolvePublic(url.hostname), controller.signal)
        .catch(error => { throw error instanceof LinkPreviewError ? error : new LinkPreviewError('FETCH_FAILED'); });
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy();
        if (redirect >= maxRedirects) throw new LinkPreviewError('FETCH_FAILED');
        // Each hop is checked again, so a public page cannot redirect into the internal network.
        url = previewTarget(new URL(response.headers.location, url).toString());
        continue;
      }
      if (status < 200 || status >= 300) { response.destroy(); throw new LinkPreviewError('FETCH_FAILED'); }
      if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers['content-type'] ?? '')) {
        response.destroy();
        throw new LinkPreviewError('NOT_HTML');
      }
      const charset = /charset=["']?([\w-]+)/i.exec(response.headers['content-type'] ?? '')?.[1];
      const body = await readBody(response);
      let html: string;
      try { html = new TextDecoder(charset ?? 'utf-8').decode(body); } catch { html = body.toString('utf8'); }
      return parsePreviewHtml(html, url);
    }
  } catch (error) {
    if (error instanceof LinkPreviewError) throw error;
    throw new LinkPreviewError('FETCH_FAILED');
  } finally { clearTimeout(timer); }
}
