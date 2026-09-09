import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaudeDesignImport } from './import-claude-design.ts';

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
