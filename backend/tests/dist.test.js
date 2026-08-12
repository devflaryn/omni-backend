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
