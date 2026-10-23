import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaudeDesignImport } from './import-claude-design.ts';
import { log } from '../../../netlify/functions/mcp-server/logger.ts';
import { withRequestSignals } from '../../../netlify/functions/mcp-server/request-signals.ts';
import { NetlifyUnauthError } from '../../utils/api-networking.ts';

test('a 401 on site creation follows the normal failure path, not an auth error', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === 'files.claudeusercontent.com') return new Response('<html></html>');
    return new Response('{}', { status: 401 });
  }) as typeof fetch;
  const request = new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test' },
  });

  await withRequestSignals(async () => {
    const err = await runClaudeDesignImport({ url: 'https://files.claudeusercontent.com/design.html' }, request).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error, 'expected an error');
    assert.ok(!(err instanceof NetlifyUnauthError), `got an auth error: ${err.message}`);
    assert.match(err.message, /failed to create site \(401\)/);
  });
});

test('a disallowed host is logged with the full url and the claude design project id', async (t) => {
  const calls: Array<[string, any]> = [];
  t.mock.method(log, 'error', (message: string, fields: any) => {
    calls.push([message, fields]);
  });

  await assert.rejects(() =>
    runClaudeDesignImport(
      { url: 'https://attacker.example:8443/evil?sig=secret-signature', claude_design_project_id: 'proj_abc123' },
      undefined,
    ),
  );

  assert.equal(calls.length, 1);
  const [message, fields] = calls[0];
  assert.match(message, /url host not on allow-list/);
  assert.equal(fields.host, 'attacker.example');
  // The log (operator-only) gets the FULL url, unlike the thrown message.
  assert.equal(fields.url, 'https://attacker.example:8443/evil?sig=secret-signature');
  assert.equal(fields.claudeDesignProjectId, 'proj_abc123');
});

test('a url on a disallowed host is rejected with the offending origin in the message', async () => {
  await assert.rejects(
    () => runClaudeDesignImport({ url: 'https://attacker.example:8443/evil?sig=should-not-leak' }, undefined),
    (error: Error) => {
      assert.match(error.message, /Claude Design URL \(claude\.ai, claudeusercontent\.com and their subdomains\)/);
      assert.match(error.message, /https:\/\/attacker\.example:8443/);
      // origin never includes the path/query — a real signed URL's signature must not leak into the message
      assert.doesNotMatch(error.message, /evil|sig=/);
      return true;
    },
  );
});

test('a non-https url is rejected before the host is even checked', async () => {
  await assert.rejects(
    () => runClaudeDesignImport({ url: 'http://files.claudeusercontent.com/design.html' }, undefined),
    /url must be an https URL/,
  );
});
