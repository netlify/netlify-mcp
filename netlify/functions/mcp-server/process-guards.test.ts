import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientNetworkError } from './process-guards.ts';

test('isTransientNetworkError flags detached socket resets / timeouts', () => {
  assert.equal(isTransientNetworkError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientNetworkError(new Error('socket hang up')), true); // matched by message alone
  assert.equal(isTransientNetworkError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isTransientNetworkError({ code: 'EPIPE' }), true);
  assert.equal(isTransientNetworkError({ code: 'UND_ERR_SOCKET' }), true);
  assert.equal(isTransientNetworkError({ cause: { code: 'ECONNRESET' } }), true); // nested undici cause
});

test('isTransientNetworkError does not flag genuine errors', () => {
  assert.equal(isTransientNetworkError(new TypeError('cannot read properties of undefined')), false);
  assert.equal(isTransientNetworkError({ code: 'ERR_INVALID_ARG_TYPE' }), false);
  assert.equal(isTransientNetworkError(new Error('Failed to fetch API: 422')), false);
  assert.equal(isTransientNetworkError(undefined), false);
  assert.equal(isTransientNetworkError(null), false);
});
