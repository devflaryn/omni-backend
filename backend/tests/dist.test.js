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
const app = makeApp();

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
  assert.equal(Buffer.from(r.body).toString(), 'hello world');
});

test('blob honors Range with 206', async () => {
  const r = await request(makeApp()).get('/omni/dist/blob/tiny-mac').set('Range', 'bytes=0-4');
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 0-4/11');
  assert.equal(r.headers['content-length'], '5');
  assert.equal(Buffer.from(r.body).toString(), 'hello');
});

test('blob suffix Range works', async () => {
  const r = await request(makeApp()).get('/omni/dist/blob/tiny-mac').set('Range', 'bytes=-5');
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 6-10/11');
  assert.equal(Buffer.from(r.body).toString(), 'world');
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

test('health reports blob presence and size', async () => {
  const r = await request(makeApp()).get('/omni/dist/health');
  assert.equal(r.status, 200);
  const tiny = r.body.blobs.find(b => b.name === 'tiny-mac');
  assert.equal(tiny.present, true);
  assert.equal(tiny.bytes, 11);
  assert.equal(tiny.expected, 11);
  const cdn = r.body.blobs.find(b => b.name === 'cdn-mac');
  assert.equal(cdn.redirect, true);
});

import realApp from '../../server.js';
test('dist mount does not shadow the frontend or /api/v1', async () => {
  const r = await request(realApp).get('/omni/dist/manifest?os=mac'); // real registry: empty artifacts ok
  assert.equal(r.status, 200);
  assert.equal(Array.isArray(r.body.artifacts), true);
});

test('manifest exposes dest_name for bare-blob artifacts', async () => {
  const res = await request(app).get('/omni/dist/manifest?os=mac');
  assert.equal(res.status, 200);
  const offset = res.body.artifacts.find(a => a.name === 'offset-arceus-arm');
  assert.ok(offset, 'offset artifact present');
  assert.equal(typeof offset.dest_name, 'string');
  assert.match(offset.dest_name, /^base_arm_data_offset_.+\.qcow2$/);
  const base = res.body.artifacts.find(a => a.name === 'base-arm');
  assert.equal(base.dest_name ?? null, null); // tar artifact: no dest_name
});

/* --- Windows/x86 runtime (Slice C) -------------------------------------
 * A Windows client asks for ?os=win and must get the x86 Bliss base, the
 * baked x86 arceus offset, and a QEMU installer it can self-install from.
 * The os field is a flat string, so a win entry is never returned to mac.
 */
test('manifest os=win returns the x86 base, the x86 offset and qemu', async () => {
  const res = await request(makeApp()).get('/omni/dist/manifest?os=win');
  assert.equal(res.status, 200);
  const names = res.body.artifacts.map(a => a.name);
  assert.ok(names.includes('base-x86'), 'x86 base present');
  assert.ok(names.includes('offset-arceus-x86'), 'x86 arceus offset present');
  assert.ok(names.includes('qemu-win'), 'qemu installer present');

  const base = res.body.artifacts.find(a => a.name === 'base-x86');
  assert.equal(base.dest, 'images/x86');
  assert.equal(base.unpack, 'tar');
  assert.equal(base.dest_name ?? null, null);   // tar artifact
});

test('the x86 offset lands beside the /data template it overlays', async () => {
  // A qcow2 backing reference resolves relative to the overlay's OWN
  // directory, so an offset written anywhere but images/x86 will not open.
  const res = await request(makeApp()).get('/omni/dist/manifest?os=win');
  const off = res.body.artifacts.find(a => a.name === 'offset-arceus-x86');
  assert.equal(off.dest, 'images/x86');
  assert.match(off.dest_name, /^base_x86_data_offset_.+\.qcow2$/);
});

test('qemu-win is delivered as a redirect, not a stored blob', async () => {
  const r = await request(makeApp()).get('/omni/dist/blob/qemu-win');
  assert.equal(r.status, 302);
  assert.ok(r.headers.location);
});

test('win artifacts never leak into the mac manifest', async () => {
  const res = await request(makeApp()).get('/omni/dist/manifest?os=mac');
  const names = res.body.artifacts.map(a => a.name);
  for (const n of ['base-x86', 'offset-arceus-x86', 'qemu-win']) {
    assert.ok(!names.includes(n), `${n} must not be offered to mac`);
  }
});
