import { CalDavError } from '../caldav/client.js';
import type { HttpTransport } from '../remote.js';
import { audienceIncludes, cleanClaim, errorOf, idTokenClaims, OAuthFlowFailure, postForm, tokenGrant, type OAuthIdentity,
  type TokenGrant } from './common.js';

/** Microsoft accounts: the device code flow (a public client, no secret), events through Microsoft Graph. */
export interface MicrosoftApp { clientId: string; tenant: string }

export const microsoftScope = 'offline_access openid profile email https://graph.microsoft.com/Calendars.ReadWrite';
const loginBase = 'https://login.microsoftonline.com/';
const defaultVerificationUri = 'https://microsoft.com/devicelogin';

function endpoint(app: MicrosoftApp, name: 'devicecode' | 'token'): string {
  return `${loginBase}${encodeURIComponent(app.tenant)}/oauth2/v2.0/${name}`;
}

export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }

/** Asks for a user code. A refusal (unknown client, public client flows not allowed) is OAUTH_FAILED. */
export async function requestDeviceCode(transport: HttpTransport, app: MicrosoftApp): Promise<DeviceCode> {
  let answer;
  try { answer = await postForm(transport, endpoint(app, 'devicecode'), { client_id: app.clientId, scope: microsoftScope }); } catch {
    throw new OAuthFlowFailure('FETCH_FAILED');
  }
  if (answer.status >= 500) throw new OAuthFlowFailure('FETCH_FAILED');
  const data = answer.status === 200 ? answer.data : null;
  const deviceCode = cleanClaim(data?.device_code, 4096);
  const userCode = cleanClaim(data?.user_code, 64);
  if (!data || !deviceCode || !userCode) throw new OAuthFlowFailure('OAUTH_FAILED');
  const uri = cleanClaim(data.verification_uri, 2000);
  const expiresIn = Number(data.expires_in);
  const interval = Number(data.interval);
  return { deviceCode, userCode, verificationUri: uri && /^https:\/\//i.test(uri) ? uri : defaultVerificationUri,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900,
    interval: Number.isInteger(interval) && interval >= 1 && interval <= 60 ? interval : 5 };
}

/** `oid` (or `sub`) and `email` (or `preferred_username`) of an id_token for this client. */
export function microsoftIdentity(idToken: string | null, clientId: string): OAuthIdentity | null {
  const claims = idToken ? idTokenClaims(idToken) : null;
  if (!claims || !audienceIncludes(claims, clientId)) return null;
  const subject = cleanClaim(claims.oid, 255) ?? cleanClaim(claims.sub, 255);
  return subject ? { subject, account: cleanClaim(claims.email, 320) ?? cleanClaim(claims.preferred_username, 320) } : null;
}

export type DevicePoll = { status: 'pending' } | { status: 'slow_down' }
  | { status: 'ready'; grant: TokenGrant & { refreshToken: string }; identity: OAuthIdentity };

/** One question to the token endpoint while the user signs in. Failures are OAuthFlowFailure. */
export async function pollDeviceToken(transport: HttpTransport, app: MicrosoftApp, deviceCode: string): Promise<DevicePoll> {
  let answer;
  try {
    answer = await postForm(transport, endpoint(app, 'token'), { grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: app.clientId, device_code: deviceCode });
  } catch { throw new OAuthFlowFailure('FETCH_FAILED'); }
  const grant = answer.status === 200 ? tokenGrant(answer.data) : null;
  if (grant) {
    const identity = microsoftIdentity(grant.idToken, app.clientId);
    if (!identity || !grant.refreshToken) throw new OAuthFlowFailure('OAUTH_FAILED');
    return { status: 'ready', grant: { ...grant, refreshToken: grant.refreshToken }, identity };
  }
  const error = errorOf(answer);
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow_down' };
  if (error === 'authorization_declined' || error === 'access_denied') throw new OAuthFlowFailure('OAUTH_DENIED');
  if (error === 'expired_token' || error === 'code_expired') throw new OAuthFlowFailure('OAUTH_EXPIRED');
  if (!error && answer.status >= 500) throw new OAuthFlowFailure('FETCH_FAILED');
  throw new OAuthFlowFailure('OAUTH_FAILED');
}

/** A new access token and, each time, a new refresh token. A revoked or expired grant is AUTH_FAILED. */
export async function refreshMicrosoftToken(transport: HttpTransport, app: MicrosoftApp, refreshToken: string): Promise<TokenGrant> {
  const answer = await postForm(transport, endpoint(app, 'token'), { grant_type: 'refresh_token', client_id: app.clientId,
    refresh_token: refreshToken, scope: microsoftScope });
  const grant = answer.status === 200 ? tokenGrant(answer.data) : null;
  if (grant) return grant;
  if (['invalid_grant', 'interaction_required', 'invalid_client', 'unauthorized_client'].includes(errorOf(answer) ?? '')) {
    throw new CalDavError('AUTH_FAILED');
  }
  throw new CalDavError('FETCH_FAILED');
}
