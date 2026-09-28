import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedDesignHost } from './url-guard.ts';

test('isAllowedDesignHost allows claude.ai, claudeusercontent.com, and their subdomains', () => {
  for (const host of [
    'claude.ai',
    'www.claude.ai',
    'claudeusercontent.com',
    'files.claudeusercontent.com',
    'a.b.claudeusercontent.com',
    'FILES.CLAUDEUSERCONTENT.COM', // case-insensitive
    'CLAUDE.AI',
  ]) {
    assert.equal(isAllowedDesignHost(host), true, `${host} should be allowed`);
  }
});

test('isAllowedDesignHost rejects look-alikes, internal, and other hosts', () => {
  for (const host of [
    'claudeusercontent.com.evil.com', // suffix-append trick
    'claude.ai.evil.com',             // suffix-append trick
    'evilclaudeusercontent.com',      // missing the leading dot
    'notclaude.ai',                   // missing the leading dot
    'claude.ai.com',
    'localhost',
    '127.0.0.1',
    '169.254.169.254',                // cloud metadata
    'attacker.com',
  ]) {
    assert.equal(isAllowedDesignHost(host), false, `${host} should be rejected`);
  }
});
