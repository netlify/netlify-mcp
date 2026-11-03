import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { deploymentsHtml } from './deployments-html.ts';

// Run the shipped script against a tiny host/DOM, with controllable time and RPC replies.
function host() {
  const messages: any[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const listeners: Record<string, (event: any) => void> = {};
  const nodes = new Map<string, any>();
  const links: any[] = [];
  let nextTimer = 0;
  let now = 0;
  const element = (tag?: string) => {
    const node: any = {
      textContent: '', value: '', disabled: false, dataset: {}, children: [],
      append(...children: any[]) { node.children.push(...children); }, replaceChildren() { node.children = []; },
      addEventListener(type: string, callback: any) {
        node[type] = () => callback({ preventDefault() {} });
      },
    };
    if (tag === 'a') links.push(node);
    return node;
  };
  const parent = { postMessage: (message: any) => messages.push(message) };
  const document = {
    hidden: false, body: { offsetHeight: 200 }, createElement: element,
    querySelector(selector: string) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    addEventListener: (type: string, callback: any) => { listeners[type] = callback; },
  };
  runInNewContext(deploymentsHtml.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document, window: { parent, addEventListener: document.addEventListener },
    ResizeObserver: class { observe() {} },
    performance: { now: () => now },
    Date: class extends Date { static now() { return 1767225600000 + now; } },
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return {
    messages, document, nodes, links,
    advance: (milliseconds: number) => { now += milliseconds; },
    pollCount: () => [...timers.values()].filter(t => t.delay === 5000).length,
    async send(data: object) {
      listeners.message({ source: parent, data: { jsonrpc: '2.0', ...data } });
      await new Promise(setImmediate);
    },
    poll() {
      const [id, timer] = [...timers].find(([, t]) => t.delay === 5000)!;
      timers.delete(id);
      timer.callback();
    },
    visibility(hidden: boolean) { document.hidden = hidden; listeners.visibilitychange({}); },
  };
}
const result = (active: boolean) => ({ structuredContent: {
  siteId: 'site-1', deployId: null, deploys: [], hasActiveDeploys: active,
} });
async function initialize(h: ReturnType<typeof host>) {
  await h.send({ id: h.messages[0].id, result: {} });
  await h.send({ method: 'ui/notifications/tool-result', params: result(true) });
}

test('card polls only while active and visible, and stops on completion or error', async () => {
  const h = host();
  await initialize(h);
  assert.equal(h.pollCount(), 1);
  h.visibility(true);
  assert.equal(h.pollCount(), 0);
  h.visibility(false);
  h.poll();
  assert.equal(h.messages.at(-1).params.name, 'netlify-refresh-deployments');
  await h.send({ id: h.messages.at(-1).id, result: result(false) });
  assert.equal(h.pollCount(), 0);
  await h.send({ method: 'ui/notifications/tool-result', params: result(true) });
  h.poll();
  await h.send({ id: h.messages.at(-1).id, error: { message: 'Access denied' } });
  assert.equal(h.pollCount(), 0);
  assert.match(h.nodes.get('#status').textContent, /Access denied/);
  assert.equal(h.nodes.get('#refresh').disabled, false);
});

test('polling expires after 15 minutes and only manual refresh starts a new window', async () => {
  const h = host();
  await initialize(h);
  h.advance(15 * 60 * 1000 - 5000);
  h.poll();
  await h.send({ id: h.messages.at(-1).id, result: result(true) });
  assert.equal(h.pollCount(), 1);
  const messageCount = h.messages.length;
  h.advance(5000);
  h.poll();
  assert.equal(h.messages.length, messageCount, 'no API request at the deadline');
  assert.equal(h.pollCount(), 0);
  assert.match(h.nodes.get('#status').textContent, /Automatic updates paused/);
  assert.equal(h.nodes.get('#refresh').disabled, false);
  h.visibility(true);
  h.visibility(false);
  assert.equal(h.pollCount(), 0, 'visibility changes must not reset the deadline');

  h.nodes.get('#refresh').click();
  assert.equal(h.messages.length, messageCount + 1);
  await h.send({ id: h.messages.at(-1).id, result: result(true) });
  assert.equal(h.pollCount(), 1);
  h.advance(15 * 60 * 1000 - 5000);
  h.poll();
  await h.send({ id: h.messages.at(-1).id, result: result(true) });
  assert.equal(h.pollCount(), 1, 'manual refresh grants another full window');
  h.advance(5000);
  h.poll();
  assert.equal(h.pollCount(), 0);
});

test('hidden time counts toward the limit and a late response cannot restart polling', async () => {
  const h = host();
  await initialize(h);
  h.poll();
  const refreshId = h.messages.at(-1).id;
  h.visibility(true);
  h.advance(15 * 60 * 1000);
  await h.send({ id: refreshId, result: result(true) });
  h.visibility(false);
  assert.equal(h.pollCount(), 0);
  assert.match(h.nodes.get('#status').textContent, /Automatic updates paused/);
});

test('teardown acknowledges a host request even when its ID matches an in-flight refresh', async () => {
  const h = host();
  await initialize(h);
  h.poll();
  const refreshId = h.messages.at(-1).id;
  await h.send({ id: refreshId, method: 'ui/resource-teardown', params: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1))), {
    jsonrpc: '2.0', id: refreshId, result: {},
  });
  await h.send({ id: refreshId, result: result(true) });
  h.visibility(false);
  assert.equal(h.pollCount(), 0, 'a late response must not restart polling after teardown');
  assert.equal(h.nodes.get('#refresh').disabled, true);
});

test('a rejected link open does not stop active deployment polling', async () => {
  const h = host();
  await initialize(h);
  await h.send({ method: 'ui/notifications/tool-result', params: { structuredContent: {
    ...result(true).structuredContent,
    deploys: [{ name: 'test', state: 'building', commit: '', createdAt: '',
      adminUrl: 'https://app.netlify.com/sites/test/deploys/test' }],
  } } });
  h.links[0].click();
  assert.equal(h.messages.at(-1).method, 'ui/open-link');
  await h.send({ id: h.messages.at(-1).id, error: { message: 'Opening links is unavailable' } });
  assert.match(h.nodes.get('#link-error').textContent, /Could not open the link/);
  assert.equal(h.pollCount(), 1);
  h.poll();
  assert.equal(h.messages.at(-1).params.name, 'netlify-refresh-deployments');
  await h.send({ id: h.messages.at(-1).id, result: result(true) });
  assert.match(h.nodes.get('#link-error').textContent, /Could not open the link/);
  h.links[0].click();
  assert.equal(h.nodes.get('#link-error').textContent, '');
});

test('a late link error preserves the reason deployment polling stopped', async () => {
  const h = host();
  await initialize(h);
  await h.send({ method: 'ui/notifications/tool-result', params: { structuredContent: {
    ...result(true).structuredContent,
    deploys: [{ name: 'test', state: 'building', commit: '', createdAt: '',
      adminUrl: 'https://app.netlify.com/sites/test/deploys/test' }],
  } } });
  h.links[0].click();
  const linkId = h.messages.at(-1).id;
  h.poll();
  await h.send({ id: h.messages.at(-1).id, error: { message: 'Access denied' } });
  await h.send({ id: linkId, error: { message: 'Link rejected' } });
  assert.match(h.nodes.get('#status').textContent, /Access denied/);
  assert.match(h.nodes.get('#link-error').textContent, /Link rejected/);
  assert.equal(h.pollCount(), 0);
});

test('refresh errors stop polling across visibility changes until manual refresh', async () => {
  const h = host();
  await initialize(h);
  h.poll();
  await h.send({ id: h.messages.at(-1).id, error: { message: 'Access denied' } });
  const messageCount = h.messages.length;
  h.visibility(true);
  h.visibility(false);
  assert.equal(h.pollCount(), 0);
  assert.equal(h.messages.length, messageCount);
  assert.match(h.nodes.get('#status').textContent, /Access denied/);
  await h.send({ method: 'ui/notifications/tool-result', params: result(true) });
  assert.match(h.nodes.get('#status').textContent, /Access denied/, 'late results must preserve the polling error');
  assert.equal(h.pollCount(), 0);
  h.nodes.get('#refresh').click();
  assert.equal(h.messages.length, messageCount + 1);
  await h.send({ id: h.messages.at(-1).id, result: result(true) });
  assert.doesNotMatch(h.nodes.get('#status').textContent, /Access denied/);
  assert.equal(h.pollCount(), 1);
  h.poll();
  assert.equal(h.messages.at(-1).params.name, 'netlify-refresh-deployments');
});

test('tool-result isError responses display their message and stop polling', async () => {
  for (const delivery of ['refresh', 'notification']) {
    const h = host();
    await initialize(h);
    const error = { isError: true, content: [{ type: 'text', text: 'Netlify request failed: 403' }] };
    if (delivery === 'refresh') {
      h.poll();
      await h.send({ id: h.messages.at(-1).id, result: error });
    } else {
      await h.send({ method: 'ui/notifications/tool-result', params: error });
    }
    assert.match(h.nodes.get('#status').textContent, /Could not update deployments.*403/);
    assert.equal(h.pollCount(), 0);
    h.visibility(true);
    h.visibility(false);
    assert.equal(h.pollCount(), 0, 'tool errors stay stopped across visibility changes');
  }
});

test('Apply restarts polling after a tool error or the deadline with a full new window', async () => {
  for (const reason of ['error', 'deadline']) {
    const h = host();
    await initialize(h);
    if (reason === 'error') {
      h.poll();
      await h.send({ id: h.messages.at(-1).id, result: {
        isError: true, content: [{ type: 'text', text: 'Access denied' }],
      } });
    } else {
      h.advance(15 * 60 * 1000);
      h.poll();
    }
    assert.equal(h.pollCount(), 0);
    const count = h.messages.length;
    h.nodes.get('#filter-status').value = 'enqueued';
    h.nodes.get('#filters').submit();
    assert.equal(h.messages.length, count + 1, reason);
    assert.equal(h.messages.at(-1).params.arguments.status, 'enqueued');
    await h.send({ id: h.messages.at(-1).id, result: result(true) });
    assert.equal(h.pollCount(), 1);
    assert.doesNotMatch(h.nodes.get('#status').textContent, /Access denied|Automatic updates paused/);
    h.advance(15 * 60 * 1000 - 5000);
    h.poll();
    await h.send({ id: h.messages.at(-1).id, result: result(true) });
    assert.equal(h.pollCount(), 1);
    h.advance(5000);
    h.poll();
    assert.equal(h.pollCount(), 0, 'Apply grants exactly one new polling window');
  }
});

test('failed Apply restores the last applied controls and Refresh uses those filters', async () => {
  for (const initialTime of ['1', 'custom']) {
    const h = host();
    await initialize(h);
    h.nodes.get('#filter-status').value = 'enqueued';
    h.nodes.get('#filter-time').value = initialTime;
    h.nodes.get('#filter-time').change();
    h.nodes.get('#filter-from').value = '2026-01-01T00:00';
    h.nodes.get('#filter-to').value = '2026-01-02T00:00';
    h.nodes.get('#filters').submit();
    const { siteId, ...filters } = h.messages.at(-1).params.arguments;
    await h.send({ id: h.messages.at(-1).id, result: { structuredContent: {
      ...result(true).structuredContent, filters,
    } } });
    h.advance(5000);
    h.nodes.get('#filter-status').value = 'error';
    h.nodes.get('#filter-time').value = initialTime === 'custom' ? '24' : 'custom';
    h.nodes.get('#filter-time').change();
    h.nodes.get('#filters').submit();
    await h.send({ id: h.messages.at(-1).id, result: {
      isError: true, content: [{ type: 'text', text: 'Filter request failed' }],
    } });
    assert.equal(h.nodes.get('#filter-status').value, 'enqueued');
    assert.equal(h.nodes.get('#filter-time').value, initialTime);
    assert.equal(h.nodes.get('#custom-range').hidden, initialTime !== 'custom');
    assert.equal(h.nodes.get('#filter-from').required, initialTime === 'custom');
    assert.equal(h.nodes.get('#filter-to').required, initialTime === 'custom');
    if (initialTime === 'custom') {
      assert.equal(h.nodes.get('#filter-from').value, '2026-01-01T00:00');
      assert.equal(h.nodes.get('#filter-to').value, '2026-01-02T00:00');
    }
    assert.match(h.nodes.get('#status').textContent, /Filter request failed/);
    assert.equal(h.pollCount(), 0);
    h.advance(5000);
    h.nodes.get('#refresh').click();
    const args = h.messages.at(-1).params.arguments;
    assert.equal(args.status, filters.status);
    assert.equal(args.from, filters.from + (initialTime === 'custom' ? 0 : 10));
    assert.equal(args.to, filters.to + (initialTime === 'custom' ? 0 : 10));
  }
});


test('card shows team and labeled creation time, without commit details', async () => {
  const h = host();
  await initialize(h);
  const data = { ...result(false).structuredContent, project: { name: 'Project', teamName: 'Team', teamUrl: 'https://app.netlify.com/teams/example/overview' }, deploys: [{ id: 'd1', name: 'Project', state: 'ready', createdAt: '2026-01-01T12:00:00Z', branch: 'main', commit: 'hidden-commit', commitUrl: 'https://github.com/commit', adminUrl: 'https://app.netlify.com/sites/example/deploys/d1' }] };
  await h.send({ method: 'ui/notifications/tool-result', params: { structuredContent: data } });
  assert.match(JSON.stringify(h.nodes.get('#project').children), /Team:/);
  assert.ok(h.links.some(link => link.textContent === 'Team ↗'));
  const rendered = JSON.stringify(h.nodes.get('#deployments').children);
  assert.match(rendered, /Created /);
  assert.doesNotMatch(rendered, /hidden-commit|View commit/);
  h.nodes.get('#refresh').click();
  const { project, ...updated } = data;
  await h.send({ id: h.messages.at(-1).id, result: { structuredContent: updated } });
  assert.match(JSON.stringify(h.nodes.get('#project').children), /Team:/, 'refresh retains team context');
});

test('status and custom time filters are applied on the host, retained on polls, and can be cleared', async () => {
  const h = host();
  await initialize(h);
  h.nodes.get('#filter-status').value = 'error';
  h.nodes.get('#filter-time').value = 'custom';
  h.nodes.get('#filter-time').change();
  assert.equal(h.nodes.get('#custom-range').hidden, false);
  h.nodes.get('#filter-from').value = '2026-01-01T00:00:00Z';
  h.nodes.get('#filter-to').value = '2026-01-02T00:00:00Z';
  h.nodes.get('#filters').submit();
  const args = h.messages.at(-1).params.arguments;
  assert.equal(args.status, 'error');
  assert.equal(args.from, 1767225600);
  assert.equal(args.to, 1767312000);
  assert.equal(h.nodes.get('#apply-filters').disabled, true);
  const filters = { status: args.status, from: args.from, to: args.to };
  await h.send({ id: h.messages.at(-1).id, result: { structuredContent: { ...result(true).structuredContent, filters } } });
  h.advance(5000);
  h.poll();
  assert.equal(JSON.stringify(h.messages.at(-1).params.arguments), JSON.stringify(args));
  await h.send({ id: h.messages.at(-1).id, result: { structuredContent: { ...result(false).structuredContent, filters } } });
  h.advance(5000);
  h.nodes.get('#refresh').click();
  assert.equal(JSON.stringify(h.messages.at(-1).params.arguments), JSON.stringify(args), 'custom bounds remain fixed on manual refresh');
  await h.send({ id: h.messages.at(-1).id, result: { structuredContent: { ...result(false).structuredContent, filters } } });
  h.nodes.get('#filter-from').value = '2027-01-01T00:00:00Z';
  const count = h.messages.length;
  h.nodes.get('#filters').submit();
  assert.equal(h.messages.length, count, 'invalid range must not query the API');
  assert.match(h.nodes.get('#status').textContent, /valid time range/);
  h.nodes.get('#filter-status').value = '';
  h.nodes.get('#filter-time').value = '';
  h.nodes.get('#filters').submit();
  assert.equal(JSON.stringify(h.messages.at(-1).params.arguments), JSON.stringify({ siteId: 'site-1' }));
});

test('applied time presets advance on polls and manual refresh, ignoring unapplied edits', async () => {
  for (const hours of [1, 24, 48, 168]) {
    const h = host();
    await initialize(h);
    h.nodes.get('#filter-status').value = 'enqueued';
    h.nodes.get('#filter-time').value = String(hours);
    h.nodes.get('#filters').submit();
    const initial = h.messages.at(-1).params.arguments;
    assert.equal(initial.to, 1767225600);
    assert.equal(initial.from, initial.to - hours * 3600);
    const reply = () => {
      const { siteId, ...filters } = h.messages.at(-1).params.arguments;
      return h.send({ id: h.messages.at(-1).id, result: { structuredContent: {
        ...result(true).structuredContent, filters,
      } } });
    };
    await reply();
    // Editing the form alone must not change the applied range or status.
    h.nodes.get('#filter-time').value = 'custom';
    h.nodes.get('#filter-status').value = 'error';
    h.advance(5000);
    h.poll();
    let args = h.messages.at(-1).params.arguments;
    assert.equal(args.to, initial.to + 5);
    assert.equal(args.from, initial.from + 5);
    assert.equal(args.status, 'enqueued');
    await reply();
    h.advance(10000);
    h.nodes.get('#refresh').click();
    args = h.messages.at(-1).params.arguments;
    assert.equal(args.to, initial.to + 15);
    assert.equal(args.from, initial.from + 15);
    await reply();
    h.nodes.get('#filter-from').value = '2026-01-01T00:00:00Z';
    h.nodes.get('#filter-to').value = '2026-01-02T00:00:00Z';
    h.nodes.get('#filters').submit();
    await reply();
    h.advance(5000);
    h.poll();
    assert.equal(h.messages.at(-1).params.arguments.from, 1767225600);
    assert.equal(h.messages.at(-1).params.arguments.to, 1767312000, 'switching to custom stops the range advancing');
    await reply();
    h.nodes.get('#filter-time').value = '';
    h.nodes.get('#filters').submit();
    await reply();
    h.advance(5000);
    h.poll();
    assert.equal(h.messages.at(-1).params.arguments.from, undefined, 'clearing the preset stays cleared');
    assert.equal(h.messages.at(-1).params.arguments.to, undefined);
  }
});
