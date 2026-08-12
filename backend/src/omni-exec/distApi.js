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
