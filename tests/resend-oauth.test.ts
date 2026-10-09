import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEND_OAUTH_REDIRECT_URI,
  RESEND_OAUTH_SCOPE,
  buildResendAuthorizationUrl,
  createPkce,
  parseResendOAuthCallback,
  tokenForm,
} from '../src/shared/resend-oauth.js';

test('Resend OAuth authorization requests full access with PKCE', async () => {
  const pkce = await createPkce();
  assert.ok(pkce.verifier.length >= 43);
  assert.ok(pkce.challenge.length >= 43);
  assert.notEqual(pkce.verifier, pkce.challenge);

  const url = new URL(buildResendAuthorizationUrl({
    clientId: 'client-123',
    state: pkce.state,
    codeChallenge: pkce.challenge,
  }));
  assert.equal(url.origin, 'https://api.resend.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('redirect_uri'), RESEND_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), RESEND_OAUTH_SCOPE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('Resend OAuth callback parser rejects unrelated deep links', () => {
  assert.throws(() => parseResendOAuthCallback('global.gibp.mail://other/resend?code=x&state=y'));
  assert.deepEqual(
    parseResendOAuthCallback('global.gibp.mail://oauth/resend?code=abc&state=xyz'),
    { code: 'abc', state: 'xyz', error: null, errorDescription: null },
  );
});

test('token form encoding is standards-safe', () => {
  const body = tokenForm({ grant_type: 'refresh_token', refresh_token: 'a+b/c=', client_id: 'client' });
  assert.match(body, /grant_type=refresh_token/);
  assert.match(body, /refresh_token=a%2Bb%2Fc%3D/);
});
