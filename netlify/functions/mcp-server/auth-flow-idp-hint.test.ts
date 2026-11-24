import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.OAUTH_ISSUER = 'https://mcp.netlify.example.com';
process.env.NTL_AUTH_CLIENT_ID = 'test-ntl-client';
process.env.JWE_SECRET = 'b'.repeat(32);

const { handleAuthStart, handleClientRegistration } = await import('./auth-flow.ts');

const ISSUER = 'https://mcp.netlify.example.com';
const CLIENT_REDIRECT = 'https://client.example.com/callback';
const CHALLENGE = createHash('sha256').update('verifier-'.padEnd(64, 'x')).digest('base64url');

async function netlifyAuthorizeUrl(extra: Record<string, string>): Promise<URL> {
  const registration = await handleClientRegistration(new Request(`${ISSUER}/oauth-server/reg`, {
    method: 'POST',
    body: JSON.stringify({ client_name: 'Test client', redirect_uris: [CLIENT_REDIRECT], grant_types: ['authorization_code'] }),
  }), []);
  const clientId = JSON.parse(registration.body as string).client_id;

  const url = new URL(`${ISSUER}/oauth-server/auth`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...extra,
  }).toString();
  const res = await handleAuthStart(new Request(url));
  assert.equal(res.statusCode, 302);
  return new URL(res.headers!.Location as string);
}

test('passes an idp_hint on to the Netlify sign-in it redirects to', async () => {
  const location = await netlifyAuthorizeUrl({ idp_hint: 'some-idp' });

  assert.equal(location.origin, 'https://app.netlify.com');
  assert.equal(location.searchParams.get('idp_hint'), 'some-idp');
});

test('adds no idp_hint when the client sent none', async () => {
  const location = await netlifyAuthorizeUrl({});

  assert.equal(location.searchParams.has('idp_hint'), false);
});
