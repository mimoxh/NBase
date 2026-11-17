import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { CalDavClient, CalDavError, type DavRequest, type DavResponse } from '../src/calendar/caldav/client.js';
import { OAuthFlowFailure, pkcePair } from '../src/calendar/oauth/common.js';
import { exchangeGoogleCode, googleAuthorizeUrl, googleCalDavClient, googleCalendarUrl, googleDisabledApi, googleIdentity,
  listGoogleCalendars, refreshGoogleToken } from '../src/calendar/oauth/google.js';
import { microsoftIdentity, pollDeviceToken, refreshMicrosoftToken, requestDeviceCode } from '../src/calendar/oauth/microsoft.js';
import { bindingCookie, bindingCookieName, readBindingCookie } from '../src/calendar/oauth/routes.js';
import { oauthTarget, providerTransport } from '../src/calendar/oauth/transport.js';
import { bearerTransport } from '../src/calendar/remote.js';
import { GuardedFetchError } from '../src/net/guardedFetch.js';
import { credentialKeyFromText, openJson, sealJson } from '../src/secrets/credentials.js';

const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.`
  + `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const google = { clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'secret' };
const microsoft = { clientId: '11111111-2222-3333-4444-555555555555', tenant: 'common' };

/** A transport answering every request with the next scripted reply, recording what was asked. */
function scripted(...replies: { status: number; body?: unknown; text?: string }[]) {
  const requests: DavRequest[] = [];
  const transport = async (request: DavRequest): Promise<DavResponse> => {
    requests.push(request);
    const reply = replies.shift();
    if (!reply) throw new Error('no reply scripted');
    const body = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return { status: reply.status, url: request.url, headers: {}, body: Buffer.from(body) };
  };
  return { transport, requests };
}

const flowCode = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) {
    if (error instanceof OAuthFlowFailure) return error.code;
    if (error instanceof CalDavError) return `caldav:${error.code}`;
    throw error;
  }
  return 'ok';
};

test('the provider transport reaches only the fixed provider hosts over https on the default port', async () => {
  for (const host of ['oauth2.googleapis.com', 'www.googleapis.com', 'apidata.googleusercontent.com', 'login.microsoftonline.com',
    'graph.microsoft.com']) {
    assert.equal(oauthTarget(`https://${host}/x`).hostname, host);
    assert.equal(oauthTarget(`https://${host.toUpperCase()}:443/x`).hostname, host);
  }
  for (const raw of ['http://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com:8443/token', 'https://accounts.google.com/',
    'https://example.com/', 'https://graph.microsoft.com.evil.test/', 'https://user:pw@graph.microsoft.com/', 'https://127.0.0.1/']) {
    assert.throws(() => oauthTarget(raw), (error: unknown) => error instanceof GuardedFetchError && error.code === 'URL_BLOCKED', raw);
  }
  // Refused before any connection is made.
  const transport = providerTransport();
  await assert.rejects(transport({ method: 'GET', url: new URL('https://example.com/'), headers: {}, followRedirects: false }),
    (error: unknown) => error instanceof GuardedFetchError && error.code === 'URL_BLOCKED');

  // Redirects are only followed to allowed hosts; the local server stands in for an allowed one.
  const server = createServer((_request, response) => { response.writeHead(302, { location: 'https://evil.example/steal' }); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const testTransport = providerTransport(raw => raw.startsWith(local) ? new URL(raw) : oauthTarget(raw));
    await assert.rejects(testTransport({ method: 'GET', url: new URL(`${local}/start`), headers: {}, followRedirects: true }),
      (error: unknown) => error instanceof GuardedFetchError && error.code === 'URL_BLOCKED');
    const unfollowed = await testTransport({ method: 'GET', url: new URL(`${local}/start`), headers: {}, followRedirects: false });
    assert.equal(unfollowed.status, 302);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Google authorization asks for offline calendar access with PKCE S256', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  const url = new URL(googleAuthorizeUrl(google, { redirectUri: 'https://nbase.example/api/calendar/oauth/google/callback', state: 's'.repeat(43),
    challenge, loginHint: 'alice@example.test' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: google.clientId,
    redirect_uri: 'https://nbase.example/api/calendar/oauth/google/callback', response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/calendar', access_type: 'offline', prompt: 'consent', state: 's'.repeat(43),
    code_challenge: challenge, code_challenge_method: 'S256', login_hint: 'alice@example.test' });
  assert.equal(googleCalendarUrl('alice@example.test'), 'https://apidata.googleusercontent.com/caldav/v2/alice%40example.test/events/');
});

test('id_token claims are checked for audience and issuer', () => {
  const claims = { iss: 'https://accounts.google.com', aud: google.clientId, sub: '1234', email: 'alice@example.test' };
  assert.deepEqual(googleIdentity(jwt(claims), google.clientId), { subject: '1234', account: 'alice@example.test' });
  assert.deepEqual(googleIdentity(jwt({ ...claims, iss: 'accounts.google.com', aud: ['x', google.clientId], email: undefined }), google.clientId),
    { subject: '1234', account: null });
  assert.equal(googleIdentity(jwt({ ...claims, aud: 'other' }), google.clientId), null);
  assert.equal(googleIdentity(jwt({ ...claims, iss: 'https://evil.example' }), google.clientId), null);
  assert.equal(googleIdentity(jwt({ ...claims, sub: undefined }), google.clientId), null);
  assert.equal(googleIdentity('not-a-token', google.clientId), null);
  assert.equal(googleIdentity(null, google.clientId), null);
  const ms = { aud: microsoft.clientId, oid: 'object-1', sub: 'pairwise', preferred_username: 'bob@contoso.test' };
  assert.deepEqual(microsoftIdentity(jwt(ms), microsoft.clientId), { subject: 'object-1', account: 'bob@contoso.test' });
  assert.deepEqual(microsoftIdentity(jwt({ ...ms, oid: undefined, email: 'b@contoso.test' }), microsoft.clientId),
    { subject: 'pairwise', account: 'b@contoso.test' });
  assert.equal(microsoftIdentity(jwt({ ...ms, aud: 'x' }), microsoft.clientId), null);
});

test('Google code exchange and refresh map provider answers', async () => {
  const idToken = jwt({ iss: 'https://accounts.google.com', aud: google.clientId, sub: 's1', email: 'a@example.test' });
  const tokens = { access_token: 'at', expires_in: 3599, refresh_token: 'rt', id_token: idToken,
    scope: 'openid https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email' };
  const ok = scripted({ status: 200, body: tokens });
  const result = await exchangeGoogleCode(ok.transport, google, { code: 'c', verifier: 'v', redirectUri: 'https://n.example/cb' });
  assert.deepEqual([result.grant.accessToken, result.grant.refreshToken, result.identity.subject], ['at', 'rt', 's1']);
  assert.equal(ok.requests[0]!.url.toString(), 'https://oauth2.googleapis.com/token');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(ok.requests[0]!.body)), { grant_type: 'authorization_code', code: 'c',
    client_id: google.clientId, client_secret: 'secret', redirect_uri: 'https://n.example/cb', code_verifier: 'v' });
  const exchange = (reply: { status: number; body?: unknown }) =>
    flowCode(exchangeGoogleCode(scripted(reply).transport, google, { code: 'c', verifier: 'v', redirectUri: 'https://n.example/cb' }));
  assert.equal(await exchange({ status: 200, body: { ...tokens, scope: 'openid email' } }), 'OAUTH_DENIED');
  assert.equal(await exchange({ status: 200, body: { ...tokens, refresh_token: undefined } }), 'OAUTH_FAILED');
  assert.equal(await exchange({ status: 200, body: { ...tokens, id_token: jwt({ iss: 'https://accounts.google.com', aud: 'x', sub: 's' }) } }), 'OAUTH_FAILED');
  assert.equal(await exchange({ status: 400, body: { error: 'invalid_grant' } }), 'OAUTH_FAILED');
  assert.equal(await exchange({ status: 401, body: { error: 'invalid_client' } }), 'OAUTH_FAILED');
  assert.equal(await exchange({ status: 503 }), 'FETCH_FAILED');
  assert.equal(await flowCode(exchangeGoogleCode(async () => { throw new Error('down'); }, google, { code: 'c', verifier: 'v', redirectUri: 'x' })),
    'FETCH_FAILED');
  const refresh = (reply: { status: number; body?: unknown }) => flowCode(refreshGoogleToken(scripted(reply).transport, google, 'rt'));
  assert.equal(await refresh({ status: 200, body: { access_token: 'a2', expires_in: 3600 } }), 'ok');
  assert.equal(await refresh({ status: 400, body: { error: 'invalid_grant' } }), 'caldav:AUTH_FAILED');
  assert.equal(await refresh({ status: 401, body: { error: 'invalid_client' } }), 'caldav:AUTH_FAILED');
  assert.equal(await refresh({ status: 500 }), 'caldav:FETCH_FAILED');
});

test('Google calendars: calendarList, disabled APIs, and creates without If-None-Match', async () => {
  const auth = { token: async () => 'tok', renew: async () => 'tok2' };
  const list = scripted(
    { status: 200, body: { nextPageToken: 'p2', items: [
      { id: 'alice@example.test', summary: 'Alice', backgroundColor: '#9FC6E7', accessRole: 'owner', primary: true },
      { id: 'team#x', summary: '团队', summaryOverride: '我的团队', accessRole: 'reader' },
      { id: 'busy', summary: '忙闲', accessRole: 'freeBusyReader' },
      { id: 'gone', summary: '已删', accessRole: 'owner', deleted: true },
    ] } },
    { status: 200, body: { items: [{ id: 'shared', summary: '共享', accessRole: 'writer' }] } });
  const listed = await listGoogleCalendars(list.transport, auth);
  assert.deepEqual(listed.calendars, [
    { url: 'https://apidata.googleusercontent.com/caldav/v2/alice%40example.test/events/', name: 'Alice', color: '#9fc6e7', writable: true },
    { url: 'https://apidata.googleusercontent.com/caldav/v2/team%23x/events/', name: '我的团队', color: null, writable: false },
    { url: 'https://apidata.googleusercontent.com/caldav/v2/shared/events/', name: '共享', color: null, writable: true },
  ]);
  assert.equal(listed.primary, listed.calendars[0]!.url);
  assert.equal(list.requests[0]!.headers.Authorization, 'Bearer tok');
  assert.equal(list.requests[1]!.url.searchParams.get('pageToken'), 'p2');
  const disabled = { status: 403, body: { error: { code: 403, errors: [{ reason: 'accessNotConfigured' }], status: 'PERMISSION_DENIED' } } };
  assert.equal(await flowCode(listGoogleCalendars(scripted(disabled).transport, auth)), 'caldav:API_DISABLED');
  assert.equal(await flowCode(listGoogleCalendars(scripted({ status: 403, text: '{"error":{"details":[{"reason":"SERVICE_DISABLED"}]}}' }).transport,
    auth)), 'caldav:API_DISABLED');
  assert.equal(await flowCode(listGoogleCalendars(scripted({ status: 401 }, { status: 401 }).transport, auth)), 'caldav:AUTH_FAILED');
  // Google's own answer names the API and the project, so a client from another project can be told apart.
  const realDisabled = { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED',
    message: 'Google Calendar API has not been used in project 123456789012 before or it is disabled. Enable it by visiting '
      + 'https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456789012 then retry.',
    errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }],
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com',
      metadata: { service: 'calendar-json.googleapis.com', consumer: 'projects/123456789012' } }] } } };
  const named = await listGoogleCalendars(scripted(realDisabled).transport, auth).then(() => null, (error: unknown) => error);
  assert.ok(named instanceof CalDavError);
  assert.deepEqual(named.detail, { service: 'calendar-json.googleapis.com', project: '123456789012' });
  assert.deepEqual(googleDisabledApi(Buffer.from('{"error":{"details":[{"reason":"SERVICE_DISABLED"}]}}')), {});
  assert.deepEqual(googleDisabledApi(Buffer.from('{"error":{"details":[{"metadata":{"service":"caldav.googleapis.com","consumer":"projects/42"}}]}}')),
    { service: 'caldav.googleapis.com', project: '42' });

  const calendar = new URL('https://apidata.googleusercontent.com/caldav/v2/alice%40example.test/events/');
  const caldav = scripted(disabled);
  assert.equal(await flowCode(googleCalDavClient(caldav.transport, auth).calendarState(calendar)), 'caldav:API_DISABLED');
  // A plain refusal of a write stays an answer for the sync engine (WRITE_REJECTED).
  const rejected = await googleCalDavClient(scripted({ status: 403, text: 'forbidden' }).transport, auth)
    .put(new URL('x.ics', calendar).toString(), 'BEGIN:VCALENDAR', { ifMatch: '"1"' });
  assert.equal(rejected.status, 403);

  const writes = scripted({ status: 201 }, { status: 201 });
  await googleCalDavClient(writes.transport, auth).put(new URL('new.ics', calendar).toString(), 'BEGIN:VCALENDAR', { ifNoneMatch: '*' });
  assert.equal(writes.requests[0]!.headers['If-None-Match'], undefined);
  assert.equal(writes.requests[0]!.headers.Authorization, 'Bearer tok');
  await new CalDavClient(writes.transport, { username: 'u', password: 'p' }, false).put(new URL('new.ics', calendar).toString(), 'x', { ifNoneMatch: '*' });
  assert.equal(writes.requests[1]!.headers['If-None-Match'], '*');
  assert.match(writes.requests[1]!.headers.Authorization!, /^Basic /);

  // A 401 renews the token once; a second 401 is the caller's.
  const renewing = scripted({ status: 401 }, { status: 207, text: '' });
  const answer = await bearerTransport(renewing.transport, auth)({ method: 'GET', url: calendar, headers: {}, followRedirects: false });
  assert.equal(answer.status, 207);
  assert.deepEqual(renewing.requests.map(r => r.headers.Authorization), ['Bearer tok', 'Bearer tok2']);
});

test('Microsoft device code flow maps every answer', async () => {
  const device = scripted({ status: 200, body: { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin',
    expires_in: 900, interval: 5 } });
  assert.deepEqual(await requestDeviceCode(device.transport, { ...microsoft, tenant: 'contoso.onmicrosoft.com' }), { deviceCode: 'dc',
    userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900, interval: 5 });
  assert.equal(device.requests[0]!.url.toString(), 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/devicecode');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(device.requests[0]!.body)), { client_id: microsoft.clientId,
    scope: 'offline_access openid profile email https://graph.microsoft.com/Calendars.ReadWrite' });
  assert.equal(await flowCode(requestDeviceCode(scripted({ status: 400, body: { error: 'invalid_client' } }).transport, microsoft)), 'OAUTH_FAILED');
  assert.equal(await flowCode(requestDeviceCode(scripted({ status: 502 }).transport, microsoft)), 'FETCH_FAILED');
  assert.equal(await flowCode(requestDeviceCode(async () => { throw new Error('down'); }, microsoft)), 'FETCH_FAILED');

  const poll = async (reply: { status: number; body?: unknown }) => {
    try { return (await pollDeviceToken(scripted(reply).transport, microsoft, 'dc')).status; } catch (error) {
      if (error instanceof OAuthFlowFailure) return error.code;
      throw error;
    }
  };
  for (const [error, expected] of [['authorization_pending', 'pending'], ['slow_down', 'slow_down'], ['authorization_declined', 'OAUTH_DENIED'],
    ['expired_token', 'OAUTH_EXPIRED'], ['code_expired', 'OAUTH_EXPIRED'], ['invalid_client', 'OAUTH_FAILED'],
    ['unauthorized_client', 'OAUTH_FAILED'], ['bad_verification_code', 'OAUTH_FAILED']] as const) {
    assert.equal(await poll({ status: 400, body: { error } }), expected, error);
  }
  assert.equal(await poll({ status: 503 }), 'FETCH_FAILED');
  const idToken = jwt({ aud: microsoft.clientId, oid: 'o1', preferred_username: 'bob@contoso.test' });
  assert.equal(await poll({ status: 200, body: { access_token: 'a', refresh_token: 'r', id_token: idToken, expires_in: 3600 } }), 'ready');
  assert.equal(await poll({ status: 200, body: { access_token: 'a', id_token: idToken } }), 'OAUTH_FAILED');
  const refresh = (reply: { status: number; body?: unknown }) => flowCode(refreshMicrosoftToken(scripted(reply).transport, microsoft, 'r'));
  assert.equal(await refresh({ status: 400, body: { error: 'invalid_grant' } }), 'caldav:AUTH_FAILED');
  assert.equal(await refresh({ status: 400, body: { error: 'interaction_required' } }), 'caldav:AUTH_FAILED');
  assert.equal(await refresh({ status: 500 }), 'caldav:FETCH_FAILED');
  const rotated = scripted({ status: 200, body: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 } });
  assert.equal((await refreshMicrosoftToken(rotated.transport, microsoft, 'r')).refreshToken, 'r2');
  assert.equal(new URLSearchParams(rotated.requests[0]!.body).get('grant_type'), 'refresh_token');
});

test('the browser binding cookie and sealed JSON records', () => {
  assert.equal(bindingCookieName(true), '__Host-nbase_oauth');
  assert.equal(bindingCookieName(false), 'nbase_oauth');
  const value = 'A'.repeat(42) + 'Q';
  assert.equal(bindingCookie(value, true), `__Host-nbase_oauth=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900; Secure`);
  assert.equal(bindingCookie(value, false), `nbase_oauth=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900`);
  assert.equal(readBindingCookie(`nbase_session=x; nbase_oauth=${value}`, false), value);
  assert.equal(readBindingCookie(`nbase_oauth=${value}`, true), null);
  assert.equal(readBindingCookie('nbase_oauth=short', false), null);
  assert.equal(readBindingCookie(`nbase_oauth=${value}; nbase_oauth=${value}`, false), null);

  const key = credentialKeyFromText(Buffer.alloc(32, 4).toString('base64'));
  const sealed = sealJson(key, 'oauth-app:w:google', { clientSecret: 'GOCSPX-secret' });
  assert.ok(!sealed.includes(Buffer.from('GOCSPX')));
  assert.deepEqual(openJson(key, 'oauth-app:w:google', sealed, key.id), { clientSecret: 'GOCSPX-secret' });
  assert.equal(openJson(key, 'oauth-app:w:microsoft', sealed, key.id), null);
  assert.equal(openJson(key, 'oauth-app:w:google', sealed, '0000000000000000'), null);
});
