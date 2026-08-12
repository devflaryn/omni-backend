import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadRegistry } from '../src/omni-exec/registry.js';
import { createDistRouter } from '../src/omni-exec/distApi.js';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dist');
function makeApp() {
  const app = express();
  app.use('/omni/dist', createDistRouter(loadRegistry(distDir)));
  return app;
}

test('manifest returns mac artifacts with blob urls', async () => {
  const r = await request(makeApp()).get('/omni/dist/manifest?os=mac');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.app.version, '1.0.0');
  const tiny = r.body.artifacts.find(a => a.name === 'tiny-mac');
  assert.equal(tiny.url, '/omni/dist/blob/tiny-mac');
  assert.equal(tiny.bytes, 11);
  assert.equal(tiny.dest, 'images/arm');
  assert.ok(tiny.sha256);
});

test('manifest rejects unknown os', async () => {
  const r = await request(makeApp()).get('/omni/dist/manifest?os=nope');
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
});

test('blob streams full body with sha256 headers', async () => {
  const r = await request(makeApp()).get('/omni/dist/blob/tiny-mac');
  assert.equal(r.status, 200);
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.equal(r.headers['content-length'], '11');
  assert.equal(r.headers['x-omni-sha256'],
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  assert.equal(r.text, 'hello world');
});

test('blob honors Range with 206', async () => {
  const r = await request(makeApp()).get('/omni/dist/blob/tiny-mac').set('Range', 'bytes=0-4');
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 0-4/11');
  assert.equal(r.headers['content-length'], '5');
  assert.equal(r.text, 'hello');
});

test('blob suffix Range works', async () => {
  const r = await request(makeApp()).get('/omni/dist/blob/tiny-mac').set('Range', 'bytes=-5');
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 6-10/11');
  assert.equal(r.text, 'world');
});

test('unsatisfiable Range -> 416', async () => {
  const r = await request(makeApp()).get('/omni/dist/blob/tiny-mac').set('Range', 'bytes=50-99');
  assert.equal(r.status, 416);
  assert.equal(r.headers['content-range'], 'bytes */11');
});

test('unknown blob -> 404', async () => {
  const r = await request(makeApp()).get('/omni/dist/blob/nope');
  assert.equal(r.status, 404);
});

test('redirect entry -> 302 to CDN', async () => {
  const r = await request(makeApp()).get('/omni/dist/blob/cdn-mac').redirects(0);
  assert.equal(r.status, 302);
  assert.equal(r.headers['location'], 'https://cdn.example.com/qemu.tar.gz');
});
