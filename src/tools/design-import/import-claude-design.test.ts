import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_TOOL_NAME, registerClaudeDesignImportTool, runClaudeDesignImport } from './import-claude-design.ts';
import { log } from '../../../netlify/functions/mcp-server/logger.ts';
import { withRequestSignals } from '../../../netlify/functions/mcp-server/request-signals.ts';
import { NetlifyApiError, NetlifyUnauthError } from '../../utils/api-networking.ts';

test('a 401 on site creation is a NetlifyApiError(401), not an auth error, and does not retry under the default team', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const siteCreates: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'files.claudeusercontent.com') return new Response('<html></html>');
    if (url.pathname === '/api/v1/accounts') {
      return new Response(JSON.stringify([{ slug: 'acme-team', name: 'Acme Team' }]));
    }
    if (url.pathname === '/api/v1/sites' && init?.method === 'POST') siteCreates.push(url.search);
    return new Response('{}', { status: 401 });
  }) as typeof fetch;
  const request = new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test' },
  });

  await withRequestSignals(async () => {
    const err = await runClaudeDesignImport(
      { url: 'https://files.claudeusercontent.com/design.html', account_slug: 'acme-team' },
      request,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof NetlifyApiError, 'expected a NetlifyApiError');
    assert.ok(!(err instanceof NetlifyUnauthError), `got an auth error: ${err.message}`);
    assert.equal(err.status, 401);
    assert.deepEqual(siteCreates, ['?account_slug=acme-team']);
  });
});

test('the import tool returns isError and logs a 401 at warn, not error', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === 'files.claudeusercontent.com') return new Response('<html></html>');
    return new Response('{}', { status: 401 });
  }) as typeof fetch;
  const errorLog = t.mock.method(log, 'error', () => {});
  const warnLog = t.mock.method(log, 'warn', () => {});

  let handler: ((input: any) => Promise<any>) | undefined;
  const server = {
    registerTool: (name: string, _config: unknown, cb: (input: any) => Promise<any>) => {
      if (name === IMPORT_TOOL_NAME) handler = cb;
    },
  };
  const request = new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test' },
  });
  registerClaudeDesignImportTool(server as any, request);

  await withRequestSignals(async () => {
    const result = await handler!({ url: 'https://files.claudeusercontent.com/design.html' });
    assert.equal(result.isError, true);
  });
  assert.equal(errorLog.mock.callCount(), 0);
  assert.ok(warnLog.mock.calls.some((c) => c.arguments[0] === 'tool operation client error'));
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
