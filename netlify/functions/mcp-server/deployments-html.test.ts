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
  let nextTimer = 0;
  const element = () => ({
    textContent: '', disabled: false, dataset: {},
    append() {}, replaceChildren() {}, addEventListener() {},
  });
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
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return {
    messages, document, nodes,
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
