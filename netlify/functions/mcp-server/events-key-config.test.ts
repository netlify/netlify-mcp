// Its own file on purpose: utils.ts caches each derived key at module scope, so
// verifying the key-validation paths needs a process where the events key was
// never successfully read. node:test runs each file in its own process.
//
// Every scenario here is a REJECTION, which is what makes one process enough:
// the cache is only populated after validation passes, so a failing read leaves
// it empty and the next scenario re-runs the checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A non-localhost issuer, so neither key gets the dev-only fallback.
process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'auth-key-for-tests-at-least-32-characters-long';
delete process.env.EVENTS_RELAY_JWE_SECRET;

const { openRelayToken } = await import('./events/subscription.ts');
const { getEventsRelayKey } = await import('./utils.ts');

/** Capture a thrown error for field assertions. */
function thrown(fn: () => unknown): any {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

test('a deployed instance with no events key reports misconfigured, not unreadable', async () => {
  // Load-bearing: `unreadable` becomes a 410, and Netlify DELETES a hook that
  // answers 410. If one unset env var took that path it would wipe every
  // subscription on the platform.
  const result = await openRelayToken('anything-at-all');
  assert.equal(result.status, 'misconfigured');
  assert.ok(result.status === 'misconfigured');
  assert.equal(result.envVar, 'EVENTS_RELAY_JWE_SECRET');
  assert.match(result.message, /EVENTS_RELAY_JWE_SECRET is not set/);
});

test('getEventsRelayKey fails closed with a named env var', () => {
  const error = thrown(() => getEventsRelayKey());
  assert.equal(error.name, 'MissingJWEKeyError');
  assert.equal(error.envVar, 'EVENTS_RELAY_JWE_SECRET');
  // The message has to be actionable: an operator reading this log line should
  // learn both what to set and how to generate it.
  assert.match(error.message, /openssl rand/);
  assert.match(error.message, /different from JWE_SECRET/);
});

test('an events key shorter than 32 characters is rejected', () => {
  process.env.EVENTS_RELAY_JWE_SECRET = 'too-short';
  try {
    assert.match(thrown(() => getEventsRelayKey()).message, /too short/);
  } finally {
    delete process.env.EVENTS_RELAY_JWE_SECRET;
  }
});

test('an events key that DERIVES to the auth key is rejected', () => {
  // deriveKey() truncates to 32 characters, so a shared 32-char PREFIX collides
  // even though the two strings differ. A raw string comparison would wave this
  // through and leave the rotation levers silently coupled — which is exactly
  // the bug that shipped in the first draft of this split, where both dev-only
  // fallback keys shared a 32-char prefix.
  process.env.JWE_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-auth-tail';
  process.env.EVENTS_RELAY_JWE_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-events-tail';
  try {
    const error = thrown(() => getEventsRelayKey());
    assert.match(error.message, /same key as JWE_SECRET/);
    assert.match(error.message, /first 32 characters/, 'the message should explain WHY they collide');
  } finally {
    delete process.env.EVENTS_RELAY_JWE_SECRET;
  }
});
