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

  // Stream a blob by name: Range-resumable, sha256-tagged, 302-to-CDN capable.
  router.get('/blob/:name', (req, res) => {
    const entry = registry.get(req.params.name);
    if (!entry) return res.status(404).json({ ok: false, error: 'unknown artifact' });
    if (entry.redirect) return res.redirect(302, entry.redirect);  // CDN escape hatch

    const file = path.join(blobsDir, entry.file || '');
    let stat;
    try { stat = fs.statSync(file); }
    catch { return res.status(404).json({ ok: false, error: 'blob missing on disk' }); }

    res.status(200);
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

  return router;
}
