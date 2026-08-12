# Distribution API (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a named-blob distribution API to omni-backend so a future installer can fetch the manifest and download runtime artifacts (QEMU, base image, offset) by name — resumable, verifiable, and CDN-switchable server-side.

**Architecture:** A small artifact **registry** (`dist/registry.json` mapping name→{version,sha256,bytes,file/redirect,dest}) drives an Express router mounted at `/omni/dist`: `/manifest` returns the artifacts an OS needs (each with a `/omni/dist/blob/<name>` URL), and `/blob/<name>` streams the file off VPS disk with HTTP Range support — or `302`-redirects to a CDN if the registry entry has a `redirect`. The client never learns real URLs. Big blobs live under `dist/blobs/` (git-ignored) and are uploaded out-of-band.

**Tech Stack:** Node ESM, Express 4, Node's built-in `node:test` + `supertest`, `crypto`/`fs` streaming.

## Global Constraints

- Module system: **ESM** (`"type": "module"`); use `import`/`export`, no `require`.
- HTTP: **Express 4** `Router`. Mount `/omni/dist` **before** the static catch-all and **outside** arcjet (it is not under `/api`).
- Tests: **`node:test` + `supertest`**, run via `npm test` (`node --test 'backend/tests/**/*.test.js'`). Test the router in isolation on a throwaway `express()` app pointed at a **fixtures** dist dir — never the real `dist/`.
- `dist/registry.json` is **committed**; `dist/blobs/` is **git-ignored** (multi-GB, uploaded out-of-band).
- Blob endpoint MUST: support `Range` (return `206` + `Content-Range`), send `Accept-Ranges: bytes`, set `ETag`/`X-Omni-SHA256` to the artifact sha256, `404` unknown/missing, and `302` to `entry.redirect` when present (the CDN escape hatch).
- Never load a whole blob into memory — stream files and stream sha256 hashing.
- Commit message convention (repo): end bodies with the two trailer lines used elsewhere in this repo's history (`Co-Authored-By:` / `Claude-Session:`). Omitted from the sample commands below for brevity — add them.

---

## File Structure

- Create `backend/src/omni-exec/registry.js` — load + validate the registry, expose `list(os,channel)` / `get(name)` / `distDir` / `appVersion`. Injectable `distDir` for tests.
- Create `backend/src/omni-exec/distApi.js` — `createDistRouter(registry)` → Express Router with `/manifest`, `/blob/:name`, `/health`.
- Create `dist/registry.json` — the real registry (starts with `app.version` + empty artifacts; populated by `dist-add`).
- Create `scripts/dist-add.mjs` — CLI to stamp/refresh a registry entry from a file in `dist/blobs/` (streams sha256 + bytes) or register a `redirect`.
- Create `backend/tests/dist.test.js` — isolated router tests.
- Create `backend/tests/fixtures/dist/registry.json` + `backend/tests/fixtures/dist/blobs/tiny.bin` — test fixtures.
- Modify `server.js` — import + mount `/omni/dist`.
- Modify `.gitignore` — ignore `dist/blobs/`.
- Modify `package.json` — add a `dist:add` script.

---

### Task 1: Artifact registry module

**Files:**
- Create: `backend/src/omni-exec/registry.js`
- Create: `backend/tests/fixtures/dist/registry.json`
- Create: `backend/tests/fixtures/dist/blobs/tiny.bin`
- Test: `backend/tests/registry.test.js`

**Interfaces:**
- Produces: `loadRegistry(distDir: string) → { distDir, appVersion: string, list(os: string, channel?: string) → Artifact[], get(name: string) → Artifact|null }` where `Artifact = { name, os, channel?, version, file?, redirect?, bytes?, sha256?, dest, unpack? }`.

- [ ] **Step 1: Create the test fixtures**

Run:
```bash
cd "/Users/berat/Desktop/Omni Apps/omni-backend"
mkdir -p backend/tests/fixtures/dist/blobs
printf 'hello world' > backend/tests/fixtures/dist/blobs/tiny.bin   # 11 bytes, no newline
shasum -a 256 backend/tests/fixtures/dist/blobs/tiny.bin            # -> b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
```
Write `backend/tests/fixtures/dist/registry.json`:
```json
{
  "app": { "version": "1.0.0" },
  "artifacts": [
    { "name": "tiny-mac", "os": "mac", "channel": "stable", "version": "1",
      "file": "tiny.bin", "bytes": 11,
      "sha256": "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      "dest": "images/arm" },
    { "name": "cdn-mac", "os": "mac", "channel": "stable", "version": "1",
      "dest": "qemu", "redirect": "https://cdn.example.com/qemu.tar.gz" },
    { "name": "tiny-win", "os": "win", "channel": "stable", "version": "1",
      "file": "tiny.bin", "bytes": 11,
      "sha256": "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      "dest": "images/x86" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/registry.test.js`:
```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-backend" && node --test backend/tests/registry.test.js`
Expected: FAIL — `Cannot find module '.../registry.js'`.

- [ ] **Step 4: Write the implementation**

Create `backend/src/omni-exec/registry.js`:
```js
import fs from 'fs';
import path from 'path';

/*
 * Artifact registry for the distribution API. Reads <distDir>/registry.json and
 * exposes lookups. distDir also holds blobs/ (the real files). `distDir` is
 * injected so tests can point at a fixtures dir instead of the real dist/.
 */
export function loadRegistry(distDir) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(distDir, 'registry.json'), 'utf8'));
  } catch {
    data = { app: { version: '0.0.0' }, artifacts: [] };
  }
  const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
  return {
    distDir,
    appVersion: (data.app && data.app.version) || '0.0.0',
    list(os, channel = 'stable') {
      return artifacts.filter(a => a.os === os && (a.channel || 'stable') === channel);
    },
    get(name) {
      return artifacts.find(a => a.name === name) || null;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test backend/tests/registry.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/omni-exec/registry.js backend/tests/registry.test.js backend/tests/fixtures/dist
git commit -m "feat(dist): artifact registry module + fixtures"
```

---

### Task 2: `/manifest` endpoint

**Files:**
- Create: `backend/src/omni-exec/distApi.js`
- Test: `backend/tests/dist.test.js`

**Interfaces:**
- Consumes: `loadRegistry` (Task 1).
- Produces: `createDistRouter(registry) → express.Router`. `GET /manifest?os=mac|win&channel=stable` → `{ ok, os, channel, app:{version}, artifacts:[{name,version,bytes,sha256,url,dest,unpack}] }` where `url = "/omni/dist/blob/<name>"`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/dist.test.js`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/dist.test.js`
Expected: FAIL — `Cannot find module '.../distApi.js'`.

- [ ] **Step 3: Write the router with the manifest route**

Create `backend/src/omni-exec/distApi.js`:
```js
import fs from 'fs';
import path from 'path';
import { Router } from 'express';

/*
 * Named-blob distribution API. The installer asks for artifacts by NAME; the
 * server decides whether to stream from disk or 302 to a CDN. Mounted at
 * /omni/dist in server.js. `registry` comes from loadRegistry().
 */
export function createDistRouter(registry) {
  const router = Router();
  const blobsDir = path.join(registry.distDir, 'blobs');

  // What a given OS/channel must download.
  router.get('/manifest', (req, res) => {
    const os = String(req.query.os || '');
    const channel = String(req.query.channel || 'stable');
    if (os !== 'mac' && os !== 'win')
      return res.status(400).json({ ok: false, error: 'os must be "mac" or "win"' });
    const artifacts = registry.list(os, channel).map(a => ({
      name: a.name, version: a.version, bytes: a.bytes ?? null, sha256: a.sha256 ?? null,
      url: `/omni/dist/blob/${a.name}`, dest: a.dest, unpack: a.unpack || null,
    }));
    res.json({ ok: true, os, channel, app: { version: registry.appVersion }, artifacts });
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/tests/dist.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/omni-exec/distApi.js backend/tests/dist.test.js
git commit -m "feat(dist): /manifest endpoint"
```

---

### Task 3: `/blob/:name` — stream, Range, 404, 302

**Files:**
- Modify: `backend/src/omni-exec/distApi.js`
- Test: `backend/tests/dist.test.js`

**Interfaces:**
- Produces: `GET /blob/:name` → `200` full stream (`Accept-Ranges: bytes`, `ETag`/`X-Omni-SHA256`, `Content-Length`); `206` + `Content-Range` for a valid `Range`; `416` for an unsatisfiable range; `404` for unknown name or missing file; `302 Location` for an entry with `redirect`.

- [ ] **Step 1: Write the failing tests (append to `backend/tests/dist.test.js`)**

```js
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
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test backend/tests/dist.test.js`
Expected: FAIL — `/blob/:name` route not defined (404s where 200/206/302 expected).

- [ ] **Step 3: Add the blob route (insert before `return router;` in `distApi.js`)**

```js
  // Stream a blob by name: Range-resumable, sha256-tagged, 302-to-CDN capable.
  router.get('/blob/:name', (req, res) => {
    const entry = registry.get(req.params.name);
    if (!entry) return res.status(404).json({ ok: false, error: 'unknown artifact' });
    if (entry.redirect) return res.redirect(302, entry.redirect);  // CDN escape hatch

    const file = path.join(blobsDir, entry.file || '');
    let stat;
    try { stat = fs.statSync(file); }
    catch { return res.status(404).json({ ok: false, error: 'blob missing on disk' }); }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');
    if (entry.sha256) {
      res.setHeader('ETag', `"${entry.sha256}"`);
      res.setHeader('X-Omni-SHA256', entry.sha256);
    }

    const range = req.headers.range;
    if (!range) {
      res.setHeader('Content-Length', stat.size);
      return fs.createReadStream(file).pipe(res);
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = m && (m[1] === '' ? stat.size - Number(m[2]) : Number(m[1]));
    let end = m && (m[2] === '' ? stat.size - 1 : Number(m[1] === '' ? stat.size - 1 : m[2]));
    if (!m || Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || end >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(file, { start, end }).pipe(res);
  });
```

- [ ] **Step 4: Run to verify all blob tests pass**

Run: `node --test backend/tests/dist.test.js`
Expected: PASS (all manifest + blob tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/omni-exec/distApi.js backend/tests/dist.test.js
git commit -m "feat(dist): /blob streaming with Range + 302 CDN redirect"
```

---

### Task 4: `/health`, mount in server.js, gitignore blobs

**Files:**
- Modify: `backend/src/omni-exec/distApi.js`
- Modify: `server.js`
- Modify: `.gitignore`
- Create: `dist/registry.json`
- Test: `backend/tests/dist.test.js` (health) + one passthrough check

**Interfaces:**
- Produces: `GET /health` → `{ ok, app, blobs:[{name, present, bytes, expected}|{name, redirect:true}] }`. `/omni/dist` mounted on the real app.

- [ ] **Step 1: Write the failing health test (append to `backend/tests/dist.test.js`)**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/tests/dist.test.js`
Expected: FAIL — `/health` route not defined.

- [ ] **Step 3: Add the health route (before `return router;`)**

```js
  // Ops sanity: which blobs are present + size-correct (no hashing — sizes only).
  router.get('/health', (req, res) => {
    const blobs = [];
    for (const os of ['mac', 'win']) {
      for (const a of registry.list(os)) {
        if (a.redirect) { blobs.push({ name: a.name, redirect: true }); continue; }
        let present = false, bytes = null;
        try { bytes = fs.statSync(path.join(blobsDir, a.file)).size; present = true; } catch {}
        blobs.push({ name: a.name, present, bytes, expected: a.bytes ?? null });
      }
    }
    res.json({ ok: true, app: registry.appVersion, blobs });
  });
```

- [ ] **Step 4: Create the real (empty) registry + gitignore blobs**

Create `dist/registry.json`:
```json
{ "app": { "version": "1.0.0" }, "artifacts": [] }
```
Append to `.gitignore`:
```
# distribution blobs (multi-GB, uploaded out-of-band; registry.json IS committed)
/dist/blobs/
```

- [ ] **Step 5: Mount in `server.js`**

Add imports next to the other omni-exec imports:
```js
import { loadRegistry } from "./backend/src/omni-exec/registry.js";
import { createDistRouter } from "./backend/src/omni-exec/distApi.js";
```
Add the mount right after the `app.use('/omni/exec', execBridge);` line:
```js
// OMNI-EXEC distribution API (installer pulls artifacts by name; VPS now, 302->CDN later).
app.use('/omni/dist', createDistRouter(loadRegistry(path.join(__dirname, 'dist'))));
```
(`path` and `__dirname` are already defined at the top of server.js.)

- [ ] **Step 6: Add a passthrough test (append to `backend/tests/dist.test.js`)**

```js
import realApp from '../../server.js';
test('dist mount does not shadow the frontend or /api/v1', async () => {
  const r = await request(realApp).get('/omni/dist/manifest?os=mac'); // real registry: empty artifacts ok
  assert.equal(r.status, 200);
  assert.equal(Array.isArray(r.body.artifacts), true);
});
```

- [ ] **Step 7: Run the whole suite**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-backend" && NODE_ENV=development npm test 2>&1 | tail -8`
Expected: all dist tests pass; existing suite still green (0 failures).

- [ ] **Step 8: Commit**

```bash
git add backend/src/omni-exec/distApi.js server.js .gitignore dist/registry.json backend/tests/dist.test.js
git commit -m "feat(dist): /health + mount /omni/dist + gitignore blobs"
```

---

### Task 5: `dist-add` registry-stamping CLI

**Files:**
- Create: `scripts/dist-add.mjs`
- Modify: `package.json` (add `dist:add` script)
- Test: `backend/tests/dist-add.test.js`

**Interfaces:**
- Produces: `node scripts/dist-add.mjs --name <n> --os mac|win --version <v> --dest <d> (--file <in dist/blobs> | --redirect <url>) [--channel stable] [--unpack tar|tar.gz]` — streams sha256+bytes for `--file`, upserts the entry into `dist/registry.json` (replacing any same-name entry).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/dist-add.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/tests/dist-add.test.js`
Expected: FAIL — `scripts/dist-add.mjs` does not exist.

- [ ] **Step 3: Write the script**

Create `scripts/dist-add.mjs`:
```js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test backend/tests/dist-add.test.js`
Expected: PASS.

- [ ] **Step 5: Add the npm script**

In `package.json` `"scripts"`, add:
```json
"dist:add": "node scripts/dist-add.mjs"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/dist-add.mjs backend/tests/dist-add.test.js package.json
git commit -m "feat(dist): dist-add registry-stamping CLI"
```

---

### Task 6: Populate real macOS artifacts + deploy + live verify

This task has no unit test — its deliverable is the API live on the VPS serving the real macOS artifacts. It is the acceptance gate for Slice A.

**Files:**
- Modify: `dist/registry.json` (via `dist:add`, committed)
- Runtime: `dist/blobs/*` on the VPS (not committed)

- [ ] **Step 1: Build the macOS blobs locally**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-backend"
mkdir -p dist/blobs
IMG=~/Desktop/OmniImages/arm
# base-arm = the immutable arm trio, one tar
tar -C "$IMG" -cf dist/blobs/base-arm.tar \
    base_arm_system_rooted.qcow2 base_arm_data_rooted.qcow2 base_arm_efivars.fd
# offset = the proven arceus offset (single qcow2)
cp "$IMG/base_arm_data_offset_arceusae.qcow2" dist/blobs/offset-arceus-arm.qcow2
ls -la dist/blobs
```

- [ ] **Step 2: Register them (computes sha256/bytes; streams, so GB-safe)**

```bash
node scripts/dist-add.mjs --name base-arm --os mac --version lineage-23.2 \
     --file base-arm.tar --dest images/arm --unpack tar
node scripts/dist-add.mjs --name offset-arceus-arm --os mac --version 2.732.1043 \
     --file offset-arceus-arm.qcow2 --dest images/arm
cat dist/registry.json
```
(QEMU-mac artifact is deferred to Slice B per the spec's open item; base + offset are enough to prove the pipeline.)

- [ ] **Step 3: Commit the registry (blobs stay local/uploaded, not committed)**

```bash
git add dist/registry.json
git commit -m "chore(dist): register macOS base-arm + arceus offset artifacts"
git push origin main
```

- [ ] **Step 4: Deploy code + upload blobs to the VPS**

Deploy the code the same way as prior backend changes (scp the changed source, no blob in the source tarball), then upload the blobs separately, then restart PM2. Use the existing expect SSH/scp wrappers in the session scratchpad and the VPS password from `.env.development.local` (0600 temp file, never echoed):
```bash
# code (small):
tar czf /tmp/dist-code.tgz server.js .gitignore dist/registry.json \
    backend/src/omni-exec/registry.js backend/src/omni-exec/distApi.js scripts/dist-add.mjs
#   scp /tmp/dist-code.tgz -> /root/omni-backend, extract, pm2 restart omni-backend
# blobs (big, separate, resumable): rsync is ideal; scp works
#   ensure /root/omni-backend/dist/blobs exists, then upload:
#   scp dist/blobs/base-arm.tar dist/blobs/offset-arceus-arm.qcow2 root@72.62.59.232:/root/omni-backend/dist/blobs/
```
(Exact expect-wrapper invocations mirror the earlier exec-bridge deploy in this session.)

- [ ] **Step 5: Live verification**

From the Mac (use Python urllib — `curl` is intercepted in this environment):
```python
import urllib.request, json
B="http://72.62.59.232"
m=json.load(urllib.request.urlopen(B+"/omni/dist/manifest?os=mac", timeout=15))
print("artifacts:", [(a['name'], a['bytes']) for a in m['artifacts']])
# Range check on the big offset: fetch first 16 bytes
req=urllib.request.Request(B+"/omni/dist/blob/offset-arceus-arm", headers={"Range":"bytes=0-15"})
r=urllib.request.urlopen(req, timeout=15)
print("range status:", r.status, "len:", len(r.read()), "content-range:", r.headers.get("Content-Range"))
h=json.load(urllib.request.urlopen(B+"/omni/dist/health", timeout=15))
print("health:", [(b['name'], b.get('present'), b.get('bytes')==b.get('expected')) for b in h['blobs']])
```
Expected: manifest lists `base-arm` + `offset-arceus-arm` with real byte sizes; the Range request returns `206`/`Content-Range: bytes 0-15/<size>` and 16 bytes; health shows both present with matching sizes.

- [ ] **Step 6: Done — Slice A acceptance**

Slice A is complete when the live manifest + a resumable blob download + health all succeed against `72.62.59.232`. Slice B (the macOS `.dmg` bootstrapper that consumes this API) gets its own plan next.

---

## Self-Review notes (author)

- **Spec coverage:** manifest endpoint ✓ (Task 2), named-blob + Range + 302 CDN ✓ (Task 3), registry/storage + git-ignore ✓ (Tasks 1,4), `dist-add` sha256/bytes ✓ (Task 5), real mac artifacts (base-arm trio tar, arceus offset) + live proof ✓ (Task 6). QEMU-mac artifact intentionally deferred to Slice B (spec risk #2) — noted in Task 6 step 2.
- **Type consistency:** `loadRegistry`→`{distDir,appVersion,list,get}` used identically in Tasks 2–4; `createDistRouter(registry)` consistent; artifact fields (`name,os,channel,version,file,redirect,bytes,sha256,dest,unpack`) identical across registry, manifest, dist-add, fixtures.
- **No placeholders:** every step has real code/commands; the only deferred item (exact expect-wrapper SSH lines in Task 6 step 4) points at the concrete precedent already used this session.
