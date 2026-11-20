import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredAPIToken } from '@netlify/dev-utils';

// Module mocks must be registered before api-networking is imported, so the real
// keychain, config.json and `netlify login` are never touched.
const readStoredAPIToken = mock.fn(async (): Promise<StoredAPIToken> => ({ source: 'none' }));
const runCommand = mock.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
mock.module('@netlify/dev-utils', {
  namedExports: { readStoredAPIToken, LEGACY_STORAGE_ENV_VAR: 'NETLIFY_USE_LEGACY_AUTH_STORAGE' },
});
mock.module('./cmd.ts', { namedExports: { runCommand } });

const { getNetlifyAccessToken, NetlifyUnauthError } = await import('./api-networking.ts');

const KEYCHAIN_TOKEN = 'nfp_keychain_token';

beforeEach(() => {
  delete process.env.NETLIFY_PERSONAL_ACCESS_TOKEN;
  readStoredAPIToken.mock.resetCalls();
  readStoredAPIToken.mock.restore();
  runCommand.mock.resetCalls();
  runCommand.mock.restore();
});

test('uses a token stored in the keychain when config.json has none', async () => {
  readStoredAPIToken.mock.mockImplementation(async () => ({ source: 'keychain', token: KEYCHAIN_TOKEN }));

  assert.equal(await getNetlifyAccessToken(), KEYCHAIN_TOKEN);
  assert.equal(runCommand.mock.callCount(), 0);
});

test('re-reads through dev-utils after spawning `netlify login`', async () => {
  readStoredAPIToken.mock.mockImplementationOnce(async () => ({ source: 'none' }), 0);
  readStoredAPIToken.mock.mockImplementationOnce(async () => ({ source: 'keychain', token: KEYCHAIN_TOKEN }), 1);

  assert.equal(await getNetlifyAccessToken(), KEYCHAIN_TOKEN);
  assert.equal(runCommand.mock.callCount(), 1);
  assert.equal(readStoredAPIToken.mock.callCount(), 2);
});

test('still reports not logged in when login exits 0 but no token is stored', async () => {
  await assert.rejects(getNetlifyAccessToken(), NetlifyUnauthError);
  assert.equal(runCommand.mock.callCount(), 1);
});

test('a keychain read failure is reported as such without spawning login', async () => {
  readStoredAPIToken.mock.mockImplementation(async () => ({
    source: 'none',
    keychainError: new Error('User interaction is not allowed.'),
  }));

  await assert.rejects(getNetlifyAccessToken(), (error: Error) => {
    assert.ok(!(error instanceof NetlifyUnauthError));
    assert.match(error.message, /credential store .*: User interaction is not allowed\./);
    assert.match(error.message, /Ask the user to unlock it/);
    assert.match(error.message, /NETLIFY_PERSONAL_ACCESS_TOKEN/);
    assert.match(error.message, /NETLIFY_USE_LEGACY_AUTH_STORAGE=1/);
    return true;
  });
  assert.equal(runCommand.mock.callCount(), 0);
});

test('NETLIFY_PERSONAL_ACCESS_TOKEN takes precedence over stored tokens', async () => {
  process.env.NETLIFY_PERSONAL_ACCESS_TOKEN = 'nfp_env_token';

  assert.equal(await getNetlifyAccessToken(), 'nfp_env_token');
  assert.equal(readStoredAPIToken.mock.callCount(), 0);
});
