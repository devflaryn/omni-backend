#!/usr/bin/env node
/*
 * Upsert a registry entry for a distribution blob. Streams sha256 + bytes so
 * it never loads a multi-GB file into memory. Root defaults to the repo (this
 * script's parent dir); tests override with OMNI_DIST_ROOT.
 * Usage:
 *   node scripts/dist-add.mjs --name base-arm --os mac --version lineage-23.2 \
 *        --file base-arm.tar --dest images/arm [--channel stable] [--unpack tar]
 *   node scripts/dist-add.mjs --name qemu-mac-arm64 --os mac --version 9.1 \
 *        --dest qemu --redirect https://cdn.example.com/qemu.tar.gz
 */
import { createReadStream, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = process.env.OMNI_DIST_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const BLOBS = path.join(DIST, 'blobs');
const REG = path.join(DIST, 'registry.json');

const argv = process.argv;
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };

const name = arg('name'), osName = arg('os'), version = arg('version'), dest = arg('dest');
const file = arg('file'), redirect = arg('redirect');
const channel = arg('channel', 'stable'), unpack = arg('unpack');
if (!name || !osName || !version || !dest || (!file && !redirect)) {
  console.error('required: --name --os --version --dest and (--file <in dist/blobs> | --redirect <url>)');
  process.exit(1);
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256'); let bytes = 0;
    createReadStream(p)
      .on('data', d => { bytes += d.length; h.update(d); })
      .on('end', () => resolve({ sha256: h.digest('hex'), bytes }))
      .on('error', reject);
  });
}

const entry = { name, os: osName, channel, version, dest };
if (unpack) entry.unpack = unpack;
if (redirect) {
  entry.redirect = redirect;
} else {
  const { sha256, bytes } = await hashFile(path.join(BLOBS, file));
  entry.file = file; entry.bytes = bytes; entry.sha256 = sha256;
}

let reg = { app: { version: '1.0.0' }, artifacts: [] };
try { reg = JSON.parse(readFileSync(REG, 'utf8')); } catch {}
reg.artifacts = (reg.artifacts || []).filter(a => a.name !== name);
reg.artifacts.push(entry);
mkdirSync(DIST, { recursive: true });
writeFileSync(REG, JSON.stringify(reg, null, 2) + '\n');
console.log('registered', name, entry.sha256
  ? `(${entry.bytes} bytes, sha256 ${entry.sha256.slice(0, 12)}…)` : '(redirect)');
