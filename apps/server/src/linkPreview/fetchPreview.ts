import type { LinkPreview } from '@nbase/contracts';
import { decodeText, charsetOf, GuardedFetchError, guardedGet, guardedTarget, isBlockedAddress } from '../net/guardedFetch.js';

export { isBlockedAddress };

export class LinkPreviewError extends Error {
  constructor(public readonly code: 'URL_INVALID' | 'URL_BLOCKED' | 'FETCH_FAILED' | 'NOT_HTML') { super(code); }
}

const maxBytes = 512 * 1024;
const timeoutMs = 6000;
const maxRedirects = 3;

const previewError = (error: unknown) => {
  if (error instanceof LinkPreviewError) return error;
  if (error instanceof GuardedFetchError) {
    if (error.code === 'REJECTED') return new LinkPreviewError('NOT_HTML');
    if (error.code === 'URL_INVALID' || error.code === 'URL_BLOCKED') return new LinkPreviewError(error.code);
  }
  return new LinkPreviewError('FETCH_FAILED');
};

export function previewTarget(raw: unknown): URL {
  try { return guardedTarget(raw); } catch (error) { throw previewError(error); }
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
  const url = previewTarget(raw);
  try {
    // A page's <head> sits at its start, so a long page is cut rather than refused.
    const response = await guardedGet(url, {
      headers: { 'User-Agent': 'NBase-LinkPreview/1.0', Accept: 'text/html,application/xhtml+xml;q=0.9' },
      timeoutMs, maxBytes, maxRedirects, oversize: 'truncate',
      inspect: (_status, headers) => {
        if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(headers['content-type'] ?? '')) throw new GuardedFetchError('REJECTED');
      },
    });
    return parsePreviewHtml(decodeText(response.body, charsetOf(response.headers['content-type'])), response.url);
  } catch (error) { throw previewError(error); }
}
