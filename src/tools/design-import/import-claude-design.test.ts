import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaudeDesignImport } from './import-claude-design.ts';
import { log } from '../../../netlify/functions/mcp-server/logger.ts';

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
      assert.match(error.message, /Claude Design URL \(\*\.claudeusercontent\.com\)/);
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
