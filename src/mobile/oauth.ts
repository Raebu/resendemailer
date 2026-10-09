import { CapacitorHttp } from '@capacitor/core';
import { isoNow, one, run } from './db.js';
import {
  RESEND_OAUTH_REDIRECT_URI,
  RESEND_OAUTH_REGISTER_URL,
  RESEND_OAUTH_SCOPE,
  RESEND_OAUTH_TOKEN_URL,
  buildResendAuthorizationUrl,
  createPkce,
  parseResendOAuthCallback,
  tokenForm,
} from '../shared/resend-oauth.js';
import { configureBackgroundOAuthAccount, openExternalUrl } from './background.js';

type PendingOAuth = {
  name: string;
  clientId: string;
  verifier: string;
  state: string;
  redirectUri: string;
  scope: string;
  createdAt: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

const PENDING_KEY = 'resend_oauth_pending';

async function httpJson<T>(url: string, options: {
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
} = {}): Promise<T> {
  const response = await CapacitorHttp.request({
    url,
    method: options.method || 'GET',
    headers: options.headers || {},
    data: options.data,
    connectTimeout: 20_000,
    readTimeout: 30_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(String(response.data?.error_description || response.data?.message || response.data?.error || `HTTP ${response.status}`));
  }
  return response.data as T;
}

export async function beginResendOAuth(name: string): Promise<{ authorizationUrl: string }> {
  const displayName = String(name || 'Resend account').trim() || 'Resend account';
  const { verifier, challenge, state } = await createPkce();

  const registration = await httpJson<{ client_id: string }>(RESEND_OAUTH_REGISTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: {
      client_name: 'GIBP Mail',
      redirect_uris: [RESEND_OAUTH_REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: RESEND_OAUTH_SCOPE,
    },
  });
  if (!registration.client_id) throw new Error('Resend did not return an OAuth client id.');

  const pending: PendingOAuth = {
    name: displayName,
    clientId: registration.client_id,
    verifier,
    state,
    redirectUri: RESEND_OAUTH_REDIRECT_URI,
    scope: RESEND_OAUTH_SCOPE,
    createdAt: isoNow(),
  };
  await run(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [PENDING_KEY, JSON.stringify(pending)],
  );

  const authorizationUrl = buildResendAuthorizationUrl({
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    scope: pending.scope,
    state,
    codeChallenge: challenge,
  });
  await openExternalUrl(authorizationUrl);
  return { authorizationUrl };
}

export async function completeResendOAuth(rawUrl: string): Promise<{
  name: string;
  clientId: string;
  scope: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const row = await one<{ value: string }>('SELECT value FROM settings WHERE key=?', [PENDING_KEY]);
  if (!row?.value) throw new Error('No pending Resend connection was found.');

  const pending = JSON.parse(row.value) as PendingOAuth;
  const ageMs = Date.now() - new Date(pending.createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 15 * 60_000) {
    await run('DELETE FROM settings WHERE key=?', [PENDING_KEY]);
    throw new Error('The Resend connection request expired. Start it again.');
  }

  const callback = parseResendOAuthCallback(rawUrl);
  if (callback.error) {
    await run('DELETE FROM settings WHERE key=?', [PENDING_KEY]);
    throw new Error(callback.errorDescription || `Resend authorization failed: ${callback.error}`);
  }
  if (!callback.code || !callback.state || callback.state !== pending.state) {
    throw new Error('Resend OAuth state validation failed.');
  }

  const tokens = await httpJson<TokenResponse>(RESEND_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: tokenForm({
      grant_type: 'authorization_code',
      client_id: pending.clientId,
      code: callback.code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    }),
  });

  if (!tokens.access_token || !tokens.refresh_token) throw new Error('Resend did not return usable OAuth tokens.');

  await run('DELETE FROM settings WHERE key=?', [PENDING_KEY]);
  return {
    name: pending.name,
    clientId: pending.clientId,
    scope: tokens.scope || pending.scope,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: Math.max(60, Number(tokens.expires_in || 900)),
  };
}

export async function installResendOAuthAccount(input: {
  id: string;
  name: string;
  clientId: string;
  scope: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}): Promise<void> {
  await configureBackgroundOAuthAccount(input);
}
