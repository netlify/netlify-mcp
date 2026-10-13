import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { zipAndBuild } from './deploy-site.ts';

async function project(t: TestContext, files: Record<string, string | Uint8Array> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-source-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return directory;
}

type Upload = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

async function receiver(t: TestContext, options: {
  status?: number;
  response?: unknown;
  disconnect?: boolean;
} = {}) {
  const uploads: Upload[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    uploads.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    if (options.disconnect) {
      req.socket.destroy();
      return;
    }
    res.writeHead(options.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(options.response ?? { id: 'build-one', deploy_id: 'deploy-one' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { uploads, uploadPath: `http://127.0.0.1:${address.port}/api/v1/sites/site-one/builds` };
}

async function uploadedFiles(upload: Upload) {
  assert.equal(upload.method, 'POST');
  assert.equal(upload.url, '/api/v1/sites/site-one/builds');
  assert.equal(upload.headers['user-agent'], 'netlify-mcp');
  assert.equal(Number(upload.headers['content-length']), upload.body.length);
  const contentType = upload.headers['content-type'];
  assert.match(contentType ?? '', /^multipart\/form-data; boundary=.+/);
  const form = await new Response(new Uint8Array(upload.body), {
    headers: { 'content-type': contentType! },
  }).formData();
  assert.deepEqual([...form.keys()], ['zip']);
  const zip = form.get('zip');
  assert.ok(zip instanceof File);
  assert.equal(zip.type, 'application/zip');
  assert.match(zip.name, /^deploy-.+\.zip$/);
  return unzipSync(new Uint8Array(await zip.arrayBuffer()));
}

test('source uploads contain project files and dotfiles but exclude local artifacts', async t => {
  const binary = new Uint8Array([0, 255, 13, 10, 128]);
  const deployDirectory = await project(t, {
    'index.html': '<h1>Hello</h1>',
    'src/café.txt': 'héllo',
    'public/image.bin': binary,
    '.gitignore': 'node_modules\n',
    '.git/config': '[test]\nname = synthetic-fixture\n',
    '.env': 'TEST_ONLY=do-not-upload',
    '.netlify/state.json': '{"siteId":"site-one"}',
    'node_modules/package/index.js': 'local dependency',
    'coverage/report.txt': 'local coverage',
    'tmp/work.txt': 'local temporary file',
    '.DS_Store': 'local metadata',
    'deploy-old.zip': 'previous upload',
  });
  const { uploads, uploadPath } = await receiver(t);

  assert.deepEqual(await zipAndBuild({ deployDirectory, siteId: 'site-one', uploadPath }), {
    deployId: 'deploy-one', buildId: 'build-one',
  });

  assert.equal(uploads.length, 1);
  const files = await uploadedFiles(uploads[0]);
  assert.deepEqual(Object.keys(files).filter(name => !name.endsWith('/')).sort(), [
    '.gitignore', 'index.html', 'public/image.bin', 'src/café.txt',
  ]);
  assert.equal(Buffer.from(files['index.html']).toString(), '<h1>Hello</h1>');
  assert.equal(Buffer.from(files['src/café.txt']).toString(), 'héllo');
  assert.equal(Buffer.from(files['.gitignore']).toString(), 'node_modules\n');
  assert.deepEqual(files['public/image.bin'], binary);
  assert.deepEqual((await readdir(deployDirectory)).filter(name => name.endsWith('.zip')), ['deploy-old.zip']);
});

for (const status of [403, 413, 500]) {
  test(`a rejected upload (${status}) fails without linking the project or leaving its archive`, async t => {
    const deployDirectory = await project(t, { 'index.html': 'source', 'deploy-old.zip': 'previous upload' });
    const { uploads, uploadPath } = await receiver(t, { status, response: { message: 'Upload rejected' } });

    await assert.rejects(zipAndBuild({ deployDirectory, siteId: 'site-one', uploadPath }), new RegExp(`Failed to deploy site:.*${status}`));

    assert.equal(uploads.length, 1);
    assert.deepEqual((await readdir(deployDirectory)).sort(), ['deploy-old.zip', 'index.html']);
    assert.equal(await readFile(path.join(deployDirectory, 'index.html'), 'utf8'), 'source');
    assert.equal(await readFile(path.join(deployDirectory, 'deploy-old.zip'), 'utf8'), 'previous upload');
  });
}

test('a rejected upload preserves an existing project link and other state', async t => {
  const state = '{\n  "siteId": "original-site",\n  "accountId": "original-account",\n  "custom": true\n}\n';
  const deployDirectory = await project(t, { '.netlify/state.json': state, 'index.html': 'source' });
  const { uploads, uploadPath } = await receiver(t, { status: 403 });

  await assert.rejects(zipAndBuild({ deployDirectory, siteId: 'site-one', uploadPath }), /Failed to deploy site:.*403/);

  assert.equal(uploads.length, 1);
  assert.equal(await readFile(path.join(deployDirectory, '.netlify/state.json'), 'utf8'), state);
  assert.deepEqual((await readdir(deployDirectory)).sort(), ['.netlify', 'index.html']);
});

test('uploading to an explicit site preserves an existing project link and other state', async t => {
  const state = '{\n  "siteId": "original-site",\n  "accountId": "original-account",\n  "custom": true\n}\n';
  const deployDirectory = await project(t, { '.netlify/state.json': state, 'index.html': 'source' });
  const { uploadPath } = await receiver(t);

  await zipAndBuild({ deployDirectory, siteId: 'site-one', uploadPath });

  assert.equal(await readFile(path.join(deployDirectory, '.netlify/state.json'), 'utf8'), state);
  assert.deepEqual((await readdir(deployDirectory)).sort(), ['.netlify', 'index.html']);
});

for (const [name, state, expected] of [
  ['missing', undefined, { siteId: 'site-one' }],
  ['invalid JSON', 'not json', { siteId: 'site-one' }],
  ['unlinked', '{"accountId":"account-one"}', { accountId: 'account-one', siteId: 'site-one' }],
] as const) {
  test(`a successful upload links a project with ${name} state`, async t => {
    const deployDirectory = await project(t, state === undefined ? {} : { '.netlify/state.json': state });
    const { uploads, uploadPath } = await receiver(t);

    await zipAndBuild({ deployDirectory, siteId: 'site-one', uploadPath });

    assert.equal(uploads.length, 1);
    assert.deepEqual(Object.keys(await uploadedFiles(uploads[0])).filter(name => !name.endsWith('/')), []);
    assert.deepEqual(JSON.parse(await readFile(path.join(deployDirectory, '.netlify/state.json'), 'utf8')), expected);
    assert.deepEqual(await readdir(deployDirectory), ['.netlify']);
  });
}

test('repeated uploads read current source and accept an array build response', async t => {
  const deployDirectory = await project(t, { 'index.html': 'first version' });
  const { uploads, uploadPath } = await receiver(t, {
    response: [{ id: 'build-first', deploy_id: 'deploy-first' }, { id: 'build-other', deploy_id: 'deploy-other' }],
  });

  assert.deepEqual(await zipAndBuild({ deployDirectory, siteId: 'site-one', uploadPath }), {
    deployId: 'deploy-first', buildId: 'build-first',
  });
  await writeFile(path.join(deployDirectory, 'index.html'), 'second version');
  await zipAndBuild({ deployDirectory, siteId: 'site-one', uploadPath });

  assert.equal(uploads.length, 2);
  for (const [index, expected] of ['first version', 'second version'].entries()) {
    const files = await uploadedFiles(uploads[index]);
    assert.deepEqual(Object.keys(files).filter(name => !name.endsWith('/')), ['index.html']);
    assert.equal(Buffer.from(files['index.html']).toString(), expected);
  }
  assert.deepEqual((await readdir(deployDirectory)).sort(), ['.netlify', 'index.html']);
});

test('a disconnected upload fails, cleans its archive and allows a subsequent upload', async t => {
  const deployDirectory = await project(t, { 'index.html': 'source' });
  const failed = await receiver(t, { disconnect: true });

  await assert.rejects(zipAndBuild({ deployDirectory, siteId: 'site-one', uploadPath: failed.uploadPath }), /Failed to deploy site:/);

  assert.equal(failed.uploads.length, 1);
  assert.deepEqual(await readdir(deployDirectory), ['index.html']);
  const retry = await receiver(t);
  assert.deepEqual(await zipAndBuild({ deployDirectory, siteId: 'site-one', uploadPath: retry.uploadPath }), {
    deployId: 'deploy-one', buildId: 'build-one',
  });
  assert.equal(retry.uploads.length, 1);
  assert.equal(Buffer.from((await uploadedFiles(retry.uploads[0]))['index.html']).toString(), 'source');
  assert.deepEqual((await readdir(deployDirectory)).sort(), ['.netlify', 'index.html']);
});
