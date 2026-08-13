import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadRegistry } from '../src/omni-exec/registry.js';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dist');

test('loadRegistry lists by os and channel', () => {
  const reg = loadRegistry(distDir);
  assert.equal(reg.appVersion, '1.0.0');
  const mac = reg.list('mac');
  assert.deepEqual(mac.map(a => a.name).sort(), ['cdn-mac', 'tiny-mac']);
  assert.equal(reg.list('win').length, 1);
  assert.equal(reg.list('mac', 'beta').length, 0);
});

test('loadRegistry.get finds by name, null otherwise', () => {
  const reg = loadRegistry(distDir);
  assert.equal(reg.get('tiny-mac').file, 'tiny.bin');
  assert.equal(reg.get('missing'), null);
});

test('loadRegistry tolerates a missing file', () => {
  const reg = loadRegistry('/no/such/dir');
  assert.equal(reg.appVersion, '0.0.0');
  assert.deepEqual(reg.list('mac'), []);
});
