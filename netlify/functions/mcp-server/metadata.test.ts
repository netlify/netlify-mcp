import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAuthServerMetadata, buildProtectedResourceMetadata } from './metadata.ts';
import { SUPPORTED_SCOPES } from './oauth-config.ts';

// getOAuthIssuer() reads process.env.OAUTH_ISSUER at call time (uncached), so we
// set a deployed-style https issuer to assert the documents come out with
// absolute, same-origin https URLs.
const ISSUER = 'https://mcp.netlify.example.com';
process.env.OAUTH_ISSUER = ISSUER;
// Canonical form WHATWG URL produces (bare origin gains a trailing slash).
const CANONICAL_ISSUER = new URL(ISSUER).toString(); // 'https://mcp.netlify.example.com/'

function sameOrigin(url: string): boolean {
  return new URL(url).origin === new URL(CANONICAL_ISSUER).origin;
}

test('AS metadata: issuer is the canonical issuer', () => {
  const md = buildAuthServerMetadata();
  assert.equal(md.issuer, CANONICAL_ISSUER);
});

test('AS metadata: all endpoints are absolute and share the issuer origin', () => {
  const md = buildAuthServerMetadata();
  for (const url of [md.authorization_endpoint, md.token_endpoint, md.registration_endpoint]) {
    assert.ok(/^https?:\/\//.test(url), `expected absolute URL, got ${url}`);
    assert.ok(sameOrigin(url), `expected ${url} to share origin with ${CANONICAL_ISSUER}`);
  }
  assert.equal(md.authorization_endpoint, `${CANONICAL_ISSUER}oauth-server/auth`);
  assert.equal(md.token_endpoint, `${CANONICAL_ISSUER}oauth-server/token`);
  assert.equal(md.registration_endpoint, `${CANONICAL_ISSUER}oauth-server/reg`);
});

test('AS metadata: PKCE S256 is the only advertised challenge method', () => {
  const md = buildAuthServerMetadata();
  assert.deepEqual(md.code_challenge_methods_supported, ['S256']);
});

test('AS metadata: response/grant/auth-method sets match what we implement', () => {
  const md = buildAuthServerMetadata();
  assert.deepEqual(md.response_types_supported, ['code']);
  assert.deepEqual(md.response_modes_supported, ['query']);
  assert.deepEqual(md.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(md.token_endpoint_auth_methods_supported, [
    'none',
    'client_secret_post',
    'client_secret_basic',
  ]);
});

test('AS metadata: scopes match SUPPORTED_SCOPES and exclude openid (not OIDC)', () => {
  const md = buildAuthServerMetadata();
  assert.deepEqual(md.scopes_supported, SUPPORTED_SCOPES);
  assert.ok(!md.scopes_supported.includes('openid'), 'must not advertise openid');
});

test('AS metadata: advertises no OIDC-only or unimplemented endpoints/fields', () => {
  const md = buildAuthServerMetadata() as Record<string, unknown>;
  // OIDC-only fields must never appear (we issue no id_token / JWKS / userinfo).
  const forbidden = [
    'jwks_uri',
    'userinfo_endpoint',
    'id_token_signing_alg_values_supported',
    'claims_supported',
    'subject_types_supported',
    // Endpoints we deliberately do not implement or advertise.
    'revocation_endpoint',
    'introspection_endpoint',
    'device_authorization_endpoint',
    'pushed_authorization_request_endpoint',
    'end_session_endpoint',
    // Omitted, not set false: we still emit `iss` on the redirect.
    'authorization_response_iss_parameter_supported',
  ];
  for (const field of forbidden) {
    assert.ok(!(field in md), `AS metadata must not include ${field}`);
  }
});

test('PRM: resource is the /mcp path under the issuer, AS points back to issuer', () => {
  const prm = buildProtectedResourceMetadata();
  assert.equal(prm.resource, `${CANONICAL_ISSUER}mcp`);
  assert.deepEqual(prm.authorization_servers, [CANONICAL_ISSUER]);
  assert.deepEqual(prm.bearer_methods_supported, ['header']);
  assert.deepEqual(prm.scopes_supported, SUPPORTED_SCOPES);
});

test('PRM authorization_servers byte-matches AS metadata issuer', () => {
  // A mismatch here (e.g. trailing-slash drift) makes strict clients reject the
  // discovery chain, so pin it explicitly.
  const prm = buildProtectedResourceMetadata();
  const as = buildAuthServerMetadata();
  assert.equal(prm.authorization_servers[0], as.issuer);
});

test('metadata reflects a localhost issuer as http (scheme follows the issuer)', () => {
  const prev = process.env.OAUTH_ISSUER;
  process.env.OAUTH_ISSUER = 'http://localhost:8888';
  try {
    const md = buildAuthServerMetadata();
    assert.equal(md.issuer, 'http://localhost:8888/');
    assert.equal(md.token_endpoint, 'http://localhost:8888/oauth-server/token');
  } finally {
    process.env.OAUTH_ISSUER = prev;
  }
});
