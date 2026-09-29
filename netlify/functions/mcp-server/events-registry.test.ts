import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_DEFINITIONS,
  MCP_EVENT_BY_NETLIFY_EVENT,
  getEventDefinition,
  listEvents,
} from './events/registry.ts';
import {
  matchesFilters,
  projectPayload,
  serializeDelivery,
  MAX_PAYLOAD_BYTES,
} from './events/project-payload.ts';

// The event names bitballoon's UrlHook actually declares (app/models/url_hook.rb).
// If Netlify adds or renames one, this is the list to reconcile against.
const NETLIFY_URL_HOOK_EVENTS = new Set([
  'submission_created',
  'split_test_activated', 'split_test_deactivated', 'split_test_modified',
  'deploy_request_pending', 'deploy_request_accepted', 'deploy_request_rejected', 'deploy_restored',
  'deploy_building', 'deploy_created', 'deploy_failed', 'deploy_locked', 'deploy_unlocked',
  'deploy_failed_after_succeeding', 'deploy_succeeded_after_failing',
  'deploy_deleted',
  'dev_server_created', 'dev_server_stopped', 'dev_server_failed', 'dev_server_live',
]);

test('every advertised event maps to a real Netlify url-hook event', () => {
  for (const [name, def] of Object.entries(EVENT_DEFINITIONS)) {
    assert.ok(
      NETLIFY_URL_HOOK_EVENTS.has(def.netlifyEvent),
      `${name} maps to "${def.netlifyEvent}", which UrlHook does not declare`,
    );
  }
});

test('netlify event names are not mapped twice', () => {
  const netlifyEvents = Object.values(EVENT_DEFINITIONS).map((d) => d.netlifyEvent);
  assert.equal(
    new Set(netlifyEvents).size,
    netlifyEvents.length,
    'two MCP events share one Netlify event, so the relay reverse-lookup is ambiguous',
  );
  assert.equal(Object.keys(MCP_EVENT_BY_NETLIFY_EVENT).length, netlifyEvents.length);
});

test('deploy_deleted is not capability-gated', () => {
  // In bitballoon deploy_deleted carries `visible_if` only, and `restricted_for?`
  // keys off `available_if` — so it is hidden from the UI on some plans but is
  // never blocked from firing. Gating it here would refuse a working subscription.
  assert.equal(EVENT_DEFINITIONS['deploy.deleted'].requiresCapability, undefined);
});

test('deploy events that need the capability declare it', () => {
  for (const name of [
    'deploy.failed', 'deploy.started_failing', 'deploy.recovered',
    'deploy.succeeded', 'deploy.building', 'deploy.locked', 'deploy.unlocked',
  ]) {
    assert.equal(
      EVENT_DEFINITIONS[name].requiresCapability,
      'deploy_url_hooks',
      `${name} should declare the deploy_url_hooks capability`,
    );
  }
});

test('listEvents advertises webhook delivery and both schemas for every event', () => {
  const { events } = listEvents();
  assert.equal(events.length, Object.keys(EVENT_DEFINITIONS).length);
  for (const event of events) {
    assert.deepEqual(event.delivery, ['webhook']);
    assert.ok(event.description.length > 20, `${event.name} needs a usable description`);
    assert.equal(event.inputSchema.type, 'object');
    assert.deepEqual(event.inputSchema.required, ['site'], `${event.name} must require a site`);
    assert.equal(event.inputSchema.additionalProperties, false);
    assert.equal(event.payloadSchema.type, 'object');
  }
});

test('deploy events expose branch and context filters; others do not', () => {
  const byName = Object.fromEntries(listEvents().events.map((e) => [e.name, e]));
  const deploy = byName['deploy.failed'].inputSchema.properties as Record<string, unknown>;
  assert.ok('branch' in deploy && 'context' in deploy);

  const form = byName['form.submission_created'].inputSchema.properties as Record<string, unknown>;
  assert.equal('branch' in form, false, 'a form submission has no branch to filter on');
});

test('getEventDefinition returns undefined for unknown names', () => {
  assert.equal(getEventDefinition('deploy.nope'), undefined);
  assert.equal(getEventDefinition('deploy_failed'), undefined, 'the Netlify name is not the MCP name');
  assert.ok(getEventDefinition('deploy.failed'));
});

// --- projection -------------------------------------------------------------

/** A deploy payload with the fields Netlify's DeploySerializer really sends,
 *  including the ones that must NOT be forwarded. */
const RAW_DEPLOY = {
  id: 'deploy-1',
  site_id: 'site-abc',
  name: 'my-marketing-site',
  state: 'error',
  error_message: 'Build script returned non-zero exit code: 2',
  branch: 'main',
  context: 'production',
  commit_ref: 'abc123',
  commit_url: 'https://github.com/x/y/commit/abc123',
  committer: 'someone',
  deploy_time: 47,
  admin_url: 'https://app.netlify.com/sites/x/deploys/deploy-1',
  deploy_ssl_url: 'https://main--x.netlify.app',
  created_at: '2026-09-29T00:00:00.000Z',
  // Everything below is in the real payload and must be dropped.
  file_configuration: { build: { command: 'npm run build', environment: { SECRET_ISH: 'value' } } },
  required: Array.from({ length: 500 }, (_, i) => `sha-${i}`),
  required_functions: ['fn-sha-1'],
  skew_protection_token: 'super-secret-token',
  user_id: 'owner-1',
};

test('projectPayload keeps the useful deploy fields', () => {
  const projected = projectPayload(getEventDefinition('deploy.failed')!, RAW_DEPLOY);
  assert.equal(projected.deploy_id, 'deploy-1');
  assert.equal(projected.site_id, 'site-abc');
  assert.equal(projected.site_name, 'my-marketing-site');
  assert.equal(projected.state, 'error');
  assert.equal(projected.error_message, 'Build script returned non-zero exit code: 2');
  assert.equal(projected.admin_url, 'https://app.netlify.com/sites/x/deploys/deploy-1');
  assert.equal(projected.deploy_url, 'https://main--x.netlify.app');
  assert.equal(projected.deploy_time, 47);
});

test('projectPayload drops build config, file digests and tokens', () => {
  const projected = projectPayload(getEventDefinition('deploy.failed')!, RAW_DEPLOY);
  for (const leaked of [
    'file_configuration', 'required', 'required_functions',
    'skew_protection_token', 'user_id',
  ]) {
    assert.equal(leaked in projected, false, `${leaked} must not be forwarded to a subscriber`);
  }
});

test('projectPayload normalizes missing fields to null rather than undefined', () => {
  const projected = projectPayload(getEventDefinition('deploy.failed')!, {
    id: 'd', site_id: 's', state: 'ready',
  });
  assert.equal(projected.error_message, null);
  assert.equal(projected.branch, null);
  assert.equal(projected.deploy_time, null);
  // JSON.stringify drops undefined but keeps null; the advertised schema says
  // these keys are present, so they must survive serialization.
  assert.ok('branch' in JSON.parse(JSON.stringify(projected)));
});

test('projectPayload passes form submission data through', () => {
  const projected = projectPayload(getEventDefinition('form.submission_created')!, {
    id: 'sub-1', site_id: 'site-abc', form_id: 'f1', form_name: 'contact',
    data: { email: 'a@b.com', message: 'hi' },
  });
  assert.equal(projected.submission_id, 'sub-1');
  assert.deepEqual(projected.data, { email: 'a@b.com', message: 'hi' });
});

test('matchesFilters narrows deploys by branch and context', () => {
  const def = getEventDefinition('deploy.failed')!;
  const data = projectPayload(def, RAW_DEPLOY); // branch main, context production

  assert.equal(matchesFilters(def, data, {}), true, 'no filters matches everything');
  assert.equal(matchesFilters(def, data, { context: 'production' }), true);
  assert.equal(matchesFilters(def, data, { context: 'deploy-preview' }), false);
  assert.equal(matchesFilters(def, data, { branch: 'main' }), true);
  assert.equal(matchesFilters(def, data, { branch: 'other' }), false);
  // Both must match, not either.
  assert.equal(matchesFilters(def, data, { branch: 'main', context: 'deploy-preview' }), false);
});

test('matchesFilters ignores filters for non-deploy events', () => {
  const def = getEventDefinition('form.submission_created')!;
  assert.equal(matchesFilters(def, { site_id: 's' }, { branch: 'main' }), true);
});

test('serializeDelivery flags a payload over the 256 KiB limit', () => {
  const small = serializeDelivery({ eventId: 'e', data: { a: 1 } });
  assert.equal(small.oversize, false);

  const huge = serializeDelivery({
    eventId: 'e',
    data: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) },
  });
  assert.equal(huge.oversize, true);
});
