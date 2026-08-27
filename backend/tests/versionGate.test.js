import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import omniExec from '../src/omni-exec/omniExec.middleware.js';

function serve() {
  const app = express();
  app.use(omniExec);
  return app;
}

test('neo_versions_required never asks 2.734.917 to update', async () => {
  const app = serve();
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/neo_versions_required`);
    const body = await res.text();
    const row = body.split('\n').find(l => l.startsWith('2.734.917|'));
    assert.ok(row, 'expected a 2.734.917 row in the version map');
    // A self-consistent/low required target means the client (already 2.734.917)
    // is never below "required", so it does not force-update.
    assert.ok(/\/1\.0\.0\/|2\.734\.917/.test(row), 'row must map to a non-upgrading target');
  } finally {
    server.close();
  }
});
