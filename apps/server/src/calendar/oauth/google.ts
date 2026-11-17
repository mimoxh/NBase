import type { CalDavCalendarOption } from '@nbase/contracts';
import { CalDavClient, CalDavError, normalizeColor, type DavResponse } from '../caldav/client.js';
import { bearerTransport, type BearerAuth, type HttpTransport } from '../remote.js';
import { audienceIncludes, cleanClaim, errorOf, idTokenClaims, jsonObject, OAuthFlowFailure, postForm, staticAuth, tokenGrant,
  type OAuthIdentity, type TokenGrant } from './common.js';

/** Google accounts: authorization code with PKCE in the browser, events through Google's CalDAV API. */
export interface GoogleApp { clientId: string; clientSecret: string }

export const googleAuthorizeEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
export const googleTokenEndpoint = 'https://oauth2.googleapis.com/token';
export const googleCalendarScope = 'https://www.googleapis.com/auth/calendar';
export const googleScope = `openid email ${googleCalendarScope}`;
/** caldav_json.serverUrl of Google sources. */
export const googleServerUrl = 'https://apidata.googleusercontent.com/';
const calendarListUrl = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const issuers = new Set(['accounts.google.com', 'https://accounts.google.com']);

export function googleAuthorizeUrl(app: Pick<GoogleApp, 'clientId'>, params: { redirectUri: string; state: string; challenge: string;
  loginHint?: string | null }): string {
  const url = new URL(googleAuthorizeEndpoint);
  url.search = new URLSearchParams({ client_id: app.clientId, redirect_uri: params.redirectUri, response_type: 'code', scope: googleScope,
    access_type: 'offline', prompt: 'consent', state: params.state, code_challenge: params.challenge, code_challenge_method: 'S256',
    ...(params.loginHint ? { login_hint: params.loginHint } : {}) }).toString();
  return url.toString();
}

/** CalDAV collection of a Google calendar, as stored in caldav_json.calendarUrl. */
export function googleCalendarUrl(id: string): string {
  return `${googleServerUrl}caldav/v2/${encodeURIComponent(id)}/events/`;
}

/** `sub` and `email` of an id_token issued by Google for this client; null when it is not one. */
export function googleIdentity(idToken: string | null, clientId: string): OAuthIdentity | null {
  const claims = idToken ? idTokenClaims(idToken) : null;
  if (!claims || !audienceIncludes(claims, clientId) || typeof claims.iss !== 'string' || !issuers.has(claims.iss)) return null;
  const subject = cleanClaim(claims.sub, 255);
  return subject ? { subject, account: cleanClaim(claims.email, 320) } : null;
}

/** Exchanges the code from the callback. Failures are OAuthFlowFailure. */
export async function exchangeGoogleCode(transport: HttpTransport, app: GoogleApp, params: { code: string; verifier: string; redirectUri: string }):
Promise<{ grant: TokenGrant & { refreshToken: string }; identity: OAuthIdentity }> {
  let answer;
  try {
    answer = await postForm(transport, googleTokenEndpoint, { grant_type: 'authorization_code', code: params.code, client_id: app.clientId,
      client_secret: app.clientSecret, redirect_uri: params.redirectUri, code_verifier: params.verifier });
  } catch { throw new OAuthFlowFailure('FETCH_FAILED'); }
  const grant = answer.status === 200 ? tokenGrant(answer.data) : null;
  if (!grant) {
    if (answer.status >= 500) throw new OAuthFlowFailure('FETCH_FAILED');
    throw new OAuthFlowFailure(errorOf(answer) === 'access_denied' ? 'OAUTH_DENIED' : 'OAUTH_FAILED');
  }
  // The consent screen lets the user untick the calendar permission.
  if (grant.scope !== null && !grant.scope.split(/\s+/).includes(googleCalendarScope)) throw new OAuthFlowFailure('OAUTH_DENIED');
  const identity = googleIdentity(grant.idToken, app.clientId);
  if (!identity || !grant.refreshToken) throw new OAuthFlowFailure('OAUTH_FAILED');
  return { grant: { ...grant, refreshToken: grant.refreshToken }, identity };
}

/** A new access token. A revoked or expired grant, or a client Google no longer accepts, is AUTH_FAILED. */
export async function refreshGoogleToken(transport: HttpTransport, app: GoogleApp, refreshToken: string): Promise<TokenGrant> {
  const answer = await postForm(transport, googleTokenEndpoint, { grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: app.clientId, client_secret: app.clientSecret });
  const grant = answer.status === 200 ? tokenGrant(answer.data) : null;
  if (grant) return grant;
  if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(errorOf(answer) ?? '')) throw new CalDavError('AUTH_FAILED');
  throw new CalDavError('FETCH_FAILED');
}

/** Google answers 403 with one of these reasons when the project has not enabled the API. */
export function googleApiDisabled(response: Pick<DavResponse, 'status' | 'body'>): boolean {
  return response.status === 403 && /accessNotConfigured|SERVICE_DISABLED/.test(response.body.toString('utf8'));
}

/**
 * The API and the project number Google names in such an answer, from its message, ErrorInfo or activation link.
 * They tell a project without the API apart from a client that belongs to another project.
 */
export function googleDisabledApi(body: Buffer): Record<string, string> {
  const text = body.toString('utf8');
  const service = /\b(?:caldav|calendar-json)\.googleapis\.com\b/.exec(text)?.[0];
  const project = /\bprojects?(?:\/|=|\s+)(\d{1,20})\b/.exec(text)?.[1];
  return { ...(service ? { service } : {}), ...(project ? { project } : {}) };
}

function disabledError(response: Pick<DavResponse, 'body'>): CalDavError {
  return new CalDavError('API_DISABLED', googleDisabledApi(response.body));
}

interface GoogleCalendarEntry { id?: unknown; summary?: unknown; summaryOverride?: unknown; backgroundColor?: unknown; accessRole?: unknown;
  deleted?: unknown; primary?: unknown }

/**
 * The account's calendars from the Calendar API's calendarList, with the CalDAV address of each; `primary`
 * is the address of the primary calendar when listed. Free/busy-only calendars have no events to sync.
 */
export async function listGoogleCalendars(transport: HttpTransport, auth: BearerAuth): Promise<{ calendars: CalDavCalendarOption[];
  primary: string | null }> {
  const send = bearerTransport(transport, auth);
  const calendars: CalDavCalendarOption[] = [];
  let primary: string | null = null;
  let pageToken: string | null = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(calendarListUrl);
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let response: DavResponse;
    try {
      response = await send({ method: 'GET', url, followRedirects: false, headers: { Accept: 'application/json', 'User-Agent': 'NBase-Calendar/1.0' } });
    } catch (error) {
      if (error instanceof CalDavError) throw error;
      throw new CalDavError('FETCH_FAILED');
    }
    if (response.status === 401) throw new CalDavError('AUTH_FAILED');
    if (googleApiDisabled(response)) throw disabledError(response);
    if (response.status < 200 || response.status >= 300) throw new CalDavError('FETCH_FAILED');
    const data = jsonObject(response.body);
    if (!data) throw new CalDavError('FETCH_FAILED');
    for (const item of (Array.isArray(data.items) ? data.items : []) as GoogleCalendarEntry[]) {
      if (typeof item !== 'object' || item === null || typeof item.id !== 'string' || !item.id || item.deleted === true) continue;
      if (item.accessRole === 'freeBusyReader') continue;
      const name = [...(cleanClaim(item.summaryOverride, 1000) ?? cleanClaim(item.summary, 1000) ?? '日历')].slice(0, 100).join('');
      const calendarUrl = googleCalendarUrl(item.id);
      if (calendars.some(known => known.url === calendarUrl)) continue;
      calendars.push({ url: calendarUrl, name, color: typeof item.backgroundColor === 'string' ? normalizeColor(item.backgroundColor) : null,
        writable: item.accessRole === 'owner' || item.accessRole === 'writer' });
      if (item.primary === true) primary = calendarUrl;
    }
    pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null;
    if (!pageToken) break;
  }
  return { calendars, primary };
}

/**
 * Google's CalDAV API: bearer tokens instead of Basic, no `If-None-Match` on new events (Google refuses it; new
 * addresses are fresh UUIDs), and a disabled API reported as API_DISABLED.
 */
export function googleCalDavClient(transport: HttpTransport, auth: BearerAuth): CalDavClient {
  return new CalDavClient(bearerTransport(transport, auth), null, false, { createCondition: false,
    inspect: response => { if (googleApiDisabled(response)) throw disabledError(response); } });
}

/** Reads one calendar once, so a project without the CalDAV API fails the flow instead of the first sync. */
export async function probeGoogleCalDav(transport: HttpTransport, accessToken: string, calendarUrl: string): Promise<void> {
  try { await googleCalDavClient(transport, staticAuth(accessToken)).calendarState(new URL(calendarUrl)); } catch (error) {
    if (error instanceof CalDavError && error.code === 'API_DISABLED') throw new OAuthFlowFailure('API_DISABLED', error.detail);
    // Other failures show up on the source's first sync, where they can be retried.
  }
}
