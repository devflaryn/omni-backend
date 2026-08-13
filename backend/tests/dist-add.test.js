import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('dist-add stamps sha256 + bytes into a registry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'distadd-'));
  fs.mkdirSync(path.join(tmp, 'dist', 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'dist', 'blobs', 'x.bin'), 'hello world'); // 11 bytes
  const script = path.resolve('scripts/dist-add.mjs');
  execFileSync('node', [script, '--name', 'base-arm', '--os', 'mac', '--version', 'v1',
    '--file', 'x.bin', '--dest', 'images/arm', '--unpack', 'tar'],
    { env: { ...process.env, OMNI_DIST_ROOT: tmp } });
  const reg = JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'registry.json'), 'utf8'));
  const e = reg.artifacts.find(a => a.name === 'base-arm');
  assert.equal(e.bytes, 11);
  assert.equal(e.sha256, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  assert.equal(e.unpack, 'tar');
  // idempotent replace (no duplicate)
  execFileSync('node', [script, '--name', 'base-arm', '--os', 'mac', '--version', 'v2',
    '--file', 'x.bin', '--dest', 'images/arm'], { env: { ...process.env, OMNI_DIST_ROOT: tmp } });
  const reg2 = JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'registry.json'), 'utf8'));
  assert.equal(reg2.artifacts.filter(a => a.name === 'base-arm').length, 1);
  assert.equal(reg2.artifacts.find(a => a.name === 'base-arm').version, 'v2');
});
