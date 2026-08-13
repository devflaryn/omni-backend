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
      return artifacts
        .filter(a => a.os === os && (a.channel || 'stable') === channel)
        .map(a => ({ ...a, dest_name: a.dest_name ?? null, kind: a.kind || 'runtime' }));
    },
    get(name) {
      const e = artifacts.find(a => a.name === name) || null;
      return e ? { ...e, dest_name: e.dest_name ?? null } : null;
    },
  };
}
