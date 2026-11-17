import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Outbound requests to user-supplied addresses. Only http and https on their default ports reach public
 * addresses: every name is resolved once, all of its addresses are checked, the connection is pinned to a
 * checked address so DNS rebinding cannot swap it, and every redirect is checked again.
 */
export class GuardedFetchError extends Error {
  constructor(public readonly code: 'URL_INVALID' | 'URL_BLOCKED' | 'FETCH_FAILED' | 'TOO_LARGE' | 'REJECTED') { super(code); }
}

/** Every address a request may not reach: loopback, private, link-local, CGNAT, multicast, reserved. */
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

/** An http(s) URL on the default port and without credentials. */
export function guardedTarget(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2000) throw new GuardedFetchError('URL_INVALID');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new GuardedFetchError('URL_INVALID'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new GuardedFetchError('URL_INVALID');
  // Only the default web ports, so a request cannot probe other services on a public host.
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new GuardedFetchError('URL_BLOCKED');
  return url;
}

/** Like `guardedTarget`, but any port is allowed; for CalDAV with NBASE_CALDAV_PRIVATE=allow. */
export function anyPortTarget(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2000) throw new GuardedFetchError('URL_INVALID');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new GuardedFetchError('URL_INVALID'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new GuardedFetchError('URL_INVALID');
  return url;
}

type Pinned = { address: string; family: 4 | 6 };

/**
 * Which addresses a request may reach. `public`: public addresses only. `private`: any address, but plain
 * http only toward loopback and private addresses, since requests may carry a password. `any`: no address check,
 * for fixed provider hosts that the `target` check allows by name (a local proxy may resolve them to 198.18.0.0/15).
 */
export type AddressPolicy = 'public' | 'private' | 'any';

/** Resolves once and pins the connection to the checked address, so DNS rebinding cannot swap it. */
async function resolveTarget(url: URL, policy: AddressPolicy): Promise<Pinned> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => { throw new GuardedFetchError('FETCH_FAILED'); });
  if (!addresses.length) throw new GuardedFetchError('URL_BLOCKED');
  if (policy === 'any') return addresses[0] as Pinned;
  if (policy === 'public') {
    if (addresses.some(item => isBlockedAddress(item.address))) throw new GuardedFetchError('URL_BLOCKED');
  } else if (url.protocol === 'http:' && addresses.some(item => !isBlockedAddress(item.address))) {
    throw new GuardedFetchError('URL_BLOCKED');
  }
  return addresses[0] as Pinned;
}

function send(url: URL, pinned: Pinned, method: string, headers: Record<string, string>, body: Buffer | undefined,
  signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, signal,
      headers: { ...headers, 'Accept-Encoding': 'identity', ...(body ? { 'Content-Length': String(body.length) } : {}) },
      // With autoSelectFamily (the default since Node 20) the lookup is asked for all addresses and must answer with a list.
      lookup: (_host, options, callback) => options.all
        ? (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, [pinned])
        : callback(null, pinned.address, pinned.family),
    }, resolve);
    request.on('error', reject);
    request.end(body);
  });
}

async function readBody(response: IncomingMessage, maxBytes: number, oversize: 'truncate' | 'error'): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > maxBytes) {
      response.destroy();
      if (oversize === 'error') throw new GuardedFetchError('TOO_LARGE');
      chunks.push(part.subarray(0, part.length - (size - maxBytes)));
      break;
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

export interface GuardedFetchOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** What happens past `maxBytes`: keep the start, or fail with TOO_LARGE. */
  oversize: 'truncate' | 'error';
  /** Statuses outside 2xx that are answers rather than failures, such as 304; 'all' returns every final status. */
  acceptStatus?: number[] | 'all';
  /** Checks a final response before its body is read; throw a GuardedFetchError (usually REJECTED) to stop. */
  inspect?: (status: number, headers: IncomingHttpHeaders) => void;
  /** Checks every URL, the first and each redirect target; defaults to `guardedTarget`. */
  target?: (raw: string) => URL;
  /** Defaults to 'public'. */
  addresses?: AddressPolicy;
  /**
   * Whether a redirect from the first URL may be followed with the same headers; when it returns false the
   * request fails with FETCH_FAILED. Requests that carry credentials use `sameSiteRedirect`.
   */
  redirectAllowed?: (from: URL, to: URL) => boolean;
}

export interface GuardedRequestOptions extends GuardedFetchOptions {
  method: string;
  body?: string | Buffer;
}

export interface GuardedResponse { url: URL; status: number; headers: IncomingHttpHeaders; body: Buffer }

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

/**
 * Host names a redirect may lead to while keeping credentials: the same host, or a host in the domain the
 * original host belongs to once its leftmost label is removed, when that leaves at least two labels
 * (`caldav.icloud.com` to `p52-caldav.icloud.com`).
 */
export function sameSiteRedirect(from: URL, to: URL): boolean {
  const a = from.hostname.toLowerCase().replace(/\.$/, '');
  const b = to.hostname.toLowerCase().replace(/\.$/, '');
  if (a === b) return true;
  if (isIP(a.replace(/^\[|\]$/g, '')) || isIP(b.replace(/^\[|\]$/g, ''))) return false;
  const labels = a.split('.');
  if (labels.length < 3) return false;
  const parent = labels.slice(1).join('.');
  return b.endsWith(`.${parent}`);
}

/**
 * Any method with an optional body. GET follows every redirect as GET; other methods re-issue the same
 * method and body on 301, 302, 307 and 308, and fail on 303. With `maxRedirects: 0` a redirect is returned
 * as the answer when `acceptStatus` takes it, and fails otherwise.
 */
export async function guardedRequest(start: URL, options: GuardedRequestOptions): Promise<GuardedResponse> {
  const check = options.target ?? guardedTarget;
  const first = check(start.toString());
  let url = first;
  const method = options.method.toUpperCase();
  const body = options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, 'utf8');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const accepted = (status: number) => options.acceptStatus === 'all' || (options.acceptStatus?.includes(status) ?? false);
  try {
    for (let redirect = 0; ; redirect++) {
      const response = await send(url, await resolveTarget(url, options.addresses ?? 'public'), method, options.headers,
        body, controller.signal)
        .catch(error => { throw error instanceof GuardedFetchError ? error : new GuardedFetchError('FETCH_FAILED'); });
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      const follows = method === 'GET' ? status >= 300 && status < 400 && status !== 304 : redirectStatuses.has(status) && status !== 303;
      if (location && follows && (options.maxRedirects > 0 || !accepted(status))) {
        response.destroy();
        if (redirect >= options.maxRedirects) throw new GuardedFetchError('FETCH_FAILED');
        // Each hop is checked again, so a public page cannot redirect into the internal network.
        const next = check(new URL(location, url).toString());
        if (options.redirectAllowed && !options.redirectAllowed(first, next)) throw new GuardedFetchError('FETCH_FAILED');
        url = next;
        continue;
      }
      if (method !== 'GET' && status === 303 && !accepted(status)) {
        response.destroy();
        throw new GuardedFetchError('FETCH_FAILED');
      }
      if ((status < 200 || status >= 300) && !accepted(status)) {
        response.destroy();
        throw new GuardedFetchError('FETCH_FAILED');
      }
      try { options.inspect?.(status, response.headers); } catch (error) { response.destroy(); throw error; }
      const readable = options.acceptStatus === 'all' ? status !== 204 && status !== 304 && method !== 'HEAD' : status >= 200 && status < 300;
      const content = readable ? await readBody(response, options.maxBytes, options.oversize) : Buffer.alloc(0);
      if (!content.length) response.destroy();
      return { url, status, headers: response.headers, body: content };
    }
  } catch (error) {
    throw error instanceof GuardedFetchError ? error : new GuardedFetchError('FETCH_FAILED');
  } finally { clearTimeout(timer); }
}

export function guardedGet(start: URL, options: GuardedFetchOptions): Promise<GuardedResponse> {
  return guardedRequest(start, { ...options, method: 'GET' });
}
/** Charset named by a Content-Type header, when there is one. */
export function charsetOf(contentType: string | undefined): string | undefined {
  return /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
}

export function decodeText(body: Buffer, charset: string | undefined): string {
  try { return new TextDecoder(charset ?? 'utf-8').decode(body); } catch { return body.toString('utf8'); }
}
