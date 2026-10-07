import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkDeployStatus } from './deploy-watch.ts';

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, () => resolve((server.address() as any).port)));

test('checkDeployStatus does not throw when the endpoint is unreachable (watcher must not crash)', async () => {
  // Port 1 refuses the connection, so fetch() rejects. The bare setInterval
  // callback that used to do this inline would surface an unhandled rejection
  // and terminate the deploy watcher.
  const result = await checkDeployStatus('http://127.0.0.1:1/deploys/x');
  assert.equal(result.kind, 'poll-error');
});

test('checkDeployStatus does not throw when the deploy body is not JSON', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>502 Bad Gateway</body></html>');
  });
  const port = await listen(server);
  try {
    const result = await checkDeployStatus(`http://127.0.0.1:${port}/`);
    assert.equal(result.kind, 'poll-error'); // .json() threw, but it was caught
  } finally {
    server.close();
  }
});

test('checkDeployStatus reports ready with the parsed deploy', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ state: 'ready', url: 'https://example.netlify.app' }));
  });
  const port = await listen(server);
  try {
    const result = await checkDeployStatus(`http://127.0.0.1:${port}/`);
    assert.equal(result.kind, 'ready');
    assert.equal(result.kind === 'ready' && result.deploy.url, 'https://example.netlify.app');
  } finally {
    server.close();
  }
});

test('checkDeployStatus reports a pending state without exiting', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ state: 'building' }));
  });
  const port = await listen(server);
  try {
    const result = await checkDeployStatus(`http://127.0.0.1:${port}/`);
    assert.equal(result.kind, 'pending');
    assert.equal(result.kind === 'pending' && result.state, 'building');
  } finally {
    server.close();
  }
});

test('checkDeployStatus reports unavailable on a non-ok response', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('boom');
  });
  const port = await listen(server);
  try {
    const result = await checkDeployStatus(`http://127.0.0.1:${port}/`);
    assert.equal(result.kind, 'unavailable');
  } finally {
    server.close();
  }
});
