import { davResponseLimit } from '../caldav/client.js';
import { GuardedFetchError, guardedRequest } from '../../net/guardedFetch.js';
import type { HttpTransport } from '../remote.js';

/**
 * Hosts the server talks to for Google and Microsoft accounts. accounts.google.com is only opened in the browser.
 * These are fixed names, not user input, so there is no private-address check: a local proxy may resolve them to
 * 198.18.0.0/15. Only https on the default port.
 */
export const oauthHosts: ReadonlySet<string> = new Set(['oauth2.googleapis.com', 'www.googleapis.com', 'apidata.googleusercontent.com',
  'login.microsoftonline.com', 'graph.microsoft.com']);

const timeoutMs = 30000;

/** Checks a provider URL, the first and every redirect target; anything else is URL_BLOCKED. */
export function oauthTarget(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new GuardedFetchError('URL_INVALID'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443') || !oauthHosts.has(host)) {
    throw new GuardedFetchError('URL_BLOCKED');
  }
  return url;
}

/**
 * The transport of provider requests: allowlisted hosts only, redirects (when asked for, at most five) only
 * to allowlisted hosts, 30 seconds and 10 MB per request. Callers log the host at most.
 */
export function providerTransport(target: (raw: string) => URL = oauthTarget): HttpTransport {
  return async request => {
    const response = await guardedRequest(request.url, {
      method: request.method, headers: request.headers, ...(request.body !== undefined ? { body: request.body } : {}),
      timeoutMs, maxBytes: davResponseLimit, oversize: 'error', maxRedirects: request.followRedirects ? 5 : 0,
      acceptStatus: 'all', target, addresses: 'any',
    });
    return { status: response.status, url: response.url, headers: response.headers, body: response.body };
  };
}
