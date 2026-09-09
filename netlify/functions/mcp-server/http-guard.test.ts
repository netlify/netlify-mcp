import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import './http-guard.ts'; // self-installs the patch on import

// The guard exists so a socket 'error' (ECONNRESET / "socket hang up") on a
// fire-and-forget request can't become an uncaughtException. We assert the guard
// attaches a default 'error' listener to every outbound request.
for (const [name, mod] of [['http', http], ['https', https]] as const) {
  for (const method of ['request', 'get'] as const) {
    test(`${name}.${method} outbound requests get a default error listener`, () => {
      // Port 1 refuses the connection; we only inspect the listener, then clean up.
      const req = (mod as typeof http)[method](`${name}://127.0.0.1:1/`);
      assert.ok(req.listenerCount('error') >= 1, `${name}.${method} should have an error listener`);
      req.on('error', () => {}); // handle the (expected) connection failure in-test
      req.destroy();
    });
  }
}
