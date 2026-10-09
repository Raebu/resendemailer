export const RESEND_OAUTH_AUTHORIZE_URL = 'https://api.resend.com/oauth/authorize';
export const RESEND_OAUTH_REGISTER_URL = 'https://api.resend.com/oauth/register';
export const RESEND_OAUTH_TOKEN_URL = 'https://api.resend.com/oauth/token';
export const RESEND_OAUTH_REVOKE_URL = 'https://api.resend.com/oauth/revoke';
export const RESEND_OAUTH_REDIRECT_URI = 'global.gibp.mail://oauth/resend';
export const RESEND_OAUTH_SCOPE = 'full_access';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function createPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64Url(randomBytes(64));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return {
    verifier,
    challenge: base64Url(digest),
    state: base64Url(randomBytes(32)),
  };
}

export function buildResendAuthorizationUrl(input: {
  clientId: string;
  redirectUri?: string;
  scope?: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(RESEND_OAUTH_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri || RESEND_OAUTH_REDIRECT_URI,
    scope: input.scope || RESEND_OAUTH_SCOPE,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export function parseResendOAuthCallback(rawUrl: string): {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
} {
  const url = new URL(rawUrl);
  if (url.protocol !== 'global.gibp.mail:' || url.hostname !== 'oauth' || url.pathname !== '/resend') {
    throw new Error('Unexpected Resend OAuth callback URL.');
  }
  return {
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    error: url.searchParams.get('error'),
    errorDescription: url.searchParams.get('error_description'),
  };
}

export function tokenForm(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
