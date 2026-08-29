/*
 * OMNI-EXEC integration middleware.
 *
 * Serves the Arceus X NEO executor's redirected load chain (github + spdmteam.com
 * traffic that the patched APK now sends to http://72.62.59.232) from THIS backend,
 * on the same port 80 the site already listens on. It is a pass-through: it only
 * answers the executor's own request shapes (*.lua, /gist, /SPDM-Team/..., the spdm
 * /api/* stubs, the version gate, the update path) and calls next() for everything
 * else, so the real site (/api/v1/*, auth, keys, downloads, the React frontend) is
 * completely untouched. It is mounted BEFORE arcjet + the routers + the static
 * catch-all in server.js.
 *
 * Ported from the standalone local-server (tools built during the APK analysis).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PAYL       = path.join(__dirname, 'payloads');
const BYPATH     = path.join(PAYL, 'by-path');
const UIDIR      = path.join(PAYL, 'ui');

// The public base the executor was baked to call. The patched .so rewrites every
// upstream host to `http://72.62.59.232` (port 80, no explicit port — forced by the
// in-place same-length URL rewrite). Override with OMNI_PUBLIC_BASE if the host changes.
const LOCAL_BASE = process.env.OMNI_PUBLIC_BASE || 'http://72.62.59.232';
const XOR_KEY    = Buffer.from('BWC');           // arceus.lua obfuscation key

// Hosts that appear literally inside downloaded Lua/JSON content -> rewrite to us.
const HOSTS = [
  'https://raw.githubusercontent.com', 'http://raw.githubusercontent.com',
  'https://gist.githubusercontent.com', 'http://gist.githubusercontent.com',
  'https://gist.github.com', 'https://github.com',
  'https://objects.githubusercontent.com',
  'https://www.spdmteam.com', 'https://spdmteam.com', 'http://spdmteam.com',
  'https://cdn.discordapp.com', 'https://discord.com', 'https://discordapp.com',
  'https://projectevo.xyz', 'https://www.scriptblox.com', 'https://scriptblox.com',
];

function rewriteLocal(text) {
  for (const h of HOSTS) text = text.split(h).join(LOCAL_BASE);
  return text;
}

function readPayload(name) { try { return fs.readFileSync(path.join(PAYL, name)); } catch { return null; } }
function readByPath(rel)   { try { return fs.readFileSync(path.join(BYPATH, rel)); } catch { return null; } }

/*
 * THE IN-GAME UI, assembled from payloads/ui/*.lua in FILENAME ORDER.
 *
 * The executor loads one chunk, so the modules are concatenated rather than
 * required: the numeric prefixes (00_, 05_, 10_, ...) ARE the dependency order,
 * and a module may use anything an earlier one defined. That makes the split a
 * FILE split and not a scope split -- every module lands in the same Luau
 * function, so `local OMNI` in 00_prelude is visible to all of them.
 *
 * Ordering is therefore load-bearing and `.sort()` is the mechanism. Inserting
 * a module between two existing ones means choosing a prefix between theirs;
 * renaming one to a number that sorts earlier than something it depends on
 * breaks the chunk at load, which is why the manifest comment naming the
 * modules in order is emitted into the payload itself.
 *
 * ONE pcall wraps the lot, matching what the single-file custom_ui.lua did: a
 * partially-applied UI is worse than none, and the warn() carries the error to
 * the executor console. Each module is preceded by a `--[[ file: ... ]]` banner
 * so a syntax error can be traced back to the file it came from -- without it
 * the only clue is a line number into a 1600-line chunk that exists nowhere on
 * disk.
 *
 * Returns null when the directory is absent or empty, which is what keeps
 * custom_ui.lua working as the fallback.
 */
function assembleUi() {
  let names;
  try {
    names = fs.readdirSync(UIDIR).filter(n => n.endsWith('.lua')).sort();
  } catch { return null; }
  if (!names.length) return null;

  const modules = names.map(name => {
    const body = fs.readFileSync(path.join(UIDIR, name), 'utf8');
    return `--[[ file: ${name} ]]\n${body}`;
  });

  return [
    '-- OMNI-EXEC in-game UI.',
    '-- Assembled from payloads/ui/ by omniExec.middleware.js; do not edit here.',
    `-- modules, in load order: ${names.join(', ')}`,
    'local __omni_ok, __omni_err = pcall(function()',
    modules.join('\n'),
    'end)',
    'if not __omni_ok then warn("[OMNI-EXEC UI] error: "..tostring(__omni_err)) end',
    '',
  ].join('\n');
}

// map a request path -> by-path filename (github stores slashes; the capture used '_')
function bypathName(p) {
  return p.replace(/^\/+/, '').replace(/\?.*$/, '').split('/').join('_');
}

function xorCode(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ XOR_KEY[i % XOR_KEY.length];
  return out;
}

// arceus.lua = base64( XOR(plaintext, 'BWC') ); rebuild it pointing the gist at us.
function arceusLua() {
  const plain = `local success, err = pcall(function() executecode(game:HttpGet('${LOCAL_BASE}/gist', true)) end) if not success then rconsolerr(err) end`;
  return Buffer.from(xorCode(Buffer.from(plain, 'utf8')).toString('base64'), 'utf8');
}

// If we ever fall back to the REAL gist (no custom_ui.lua present), recolor the blue
// Arceus theme to magenta + retitle so the modification is visible.
const MOD_RGB = 'Color3.fromRGB(255, 0, 200)';
function uiModify(text) {
  for (const [r, g, b] of [[0,153,255],[36,167,255],[0,136,255],[0,150,255],[10,133,255]]) {
    const re = new RegExp('Color3\\.fromRGB\\(\\s*'+r+'\\s*,\\s*'+g+'\\s*,\\s*'+b+'\\s*\\)', 'g');
    text = text.replace(re, MOD_RGB);
  }
  text = text.split('"Arceus X NEO"').join('"★ OMNI-EXEC MODDED ★"');
  text = text.split('"SPDM Team"').join('"OMNI-EXEC MOD"');
  text = text.split('"Powered by:"').join('"MODDED BUILD:"');
  const tint = [
    'task.spawn(function()',
    ' local cg=game:GetService("CoreGui"); local MAG=Color3.fromRGB(255,0,200)',
    ' for _=1,40 do pcall(function()',
    '  for _,sg in ipairs(cg:GetChildren()) do',
    '   if sg:IsA("ScreenGui") and not tostring(sg.Name):match("Roblox") then',
    '    for _,d in ipairs(sg:GetDescendants()) do',
    '     if d:IsA("ImageLabel") or d:IsA("ImageButton") then d.ImageColor3=MAG end',
    '    end',
    '   end',
    '  end',
    ' end); task.wait(0.75) end',
    'end)\n'
  ].join('\n');
  return tint + text;
}

function guessType(p) {
  if (/\.png$/i.test(p))   return 'image/png';
  if (/\.jpe?g$/i.test(p)) return 'image/jpeg';
  if (/\.webp$/i.test(p))  return 'image/webp';
  if (/\.json$/i.test(p))  return 'application/json';
  return 'application/octet-stream';
}

// Does this look like an executor request we own? Used to decide 404 (ours, missing)
// vs. next() (not ours -> let the site / frontend catch-all handle it).
function isOmniPath(p) {
  if (p.startsWith('/api/v1/')) return false;         // NEVER touch the real API
  // /omni/* belongs to the exec bridge and the dist API, both mounted AFTER
  // this middleware. Without this line the `.lua` rule below swallowed
  // /omni/exec/stattrack.lua — this middleware would claim it as an executor
  // path, find nothing in by-path/, and 404 it before the router that actually
  // serves it ever ran. Any future .lua the bridge serves has the same trap.
  if (p.startsWith('/omni/')) return false;
  if (p.startsWith('/api/')) return true;             // spdm licensing stubs
  if (p === '/gist' || p.endsWith('/gist')) return true;
  if (p.endsWith('.lua')) return true;
  if (p.endsWith('/neo_versions_required')) return true;
  if (p.includes('/SPDM-Team/') || p.includes('/SPDMTiahh/')) return true;
  if (/\/Updates\/releases\/download\/.*\.apk$/i.test(p)) return true;
  return false;
}

function send(res, code, ctype, out) {
  res.status(code);
  res.set('Content-Type', ctype);
  res.set('Access-Control-Allow-Origin', '*');
  res.end(out);
}

export default function omniExec(req, res, next) {
  // normalize: strip query, collapse slash runs (the spdm slot rewrites to
  // `http://72.62.59.232/` so a source `.../api/x` arrives as `//api/x`).
  const p = (req.url || '/').split('?')[0].replace(/\/{2,}/g, '/');

  if (!isOmniPath(p)) return next();

  let out = null, code = 200, ctype = 'text/plain; charset=utf-8';

  // ---- spdmteam.com licensing API (stubbed permissive so the key-system unlocks)
  if (p.startsWith('/api/')) {
    ctype = 'application/json';
    if (p.startsWith('/api/isauth'))            out = '{"status":"success","authorized":true,"auth":true,"valid":true,"message":"ok"}';
    else if (p.startsWith('/api/ping'))         out = '{"status":"success","ok":true}';
    else if (p.startsWith('/api/issubscribed')) out = '{"status":"success","subscribed":true,"premium":true}';
    else if (p.startsWith('/api/activeUsers'))  out = '{"status":"success","count":1337}';
    else if (p.startsWith('/api/webhooks'))     out = '{"ok":true}';
    else                                        out = '{"status":"success"}';
    return send(res, code, ctype, Buffer.from(out, 'utf8'));
  }

  // ---- update APK request (force-update path): soft-fail so it can't block.
  if (/\/Updates\/releases\/download\/.*\.apk$/i.test(p)) {
    return send(res, 200, 'application/octet-stream', Buffer.from(''));
  }

  // ---- version gate: emit a SELF-CONSISTENT map so required == installed -> never update.
  if (p === '/neo_versions_required' || p.endsWith('/neo_versions_required')) {
    const lines = [];
    const lowApk = `${LOCAL_BASE}/SPDMTiahh/Updates/releases/download/1.0.0/Roblox.Arceus.X.NEO.1.0.0.apk`;
    for (const rv of ['2.731.944', '2.732.1043', '2.726.1142', '2.733.988', '2.734.917']) lines.push(`${rv}|${lowApk}`);
    for (let a = 0; a <= 9; a++) for (let b = 0; b <= 9; b++) {
      const v = `2.${a}.${b}`;
      lines.push(`${v}|${LOCAL_BASE}/SPDMTiahh/Updates/releases/download/${v}/Roblox.Arceus.X.NEO.${v}.apk`);
    }
    return send(res, 200, 'text/plain; charset=utf-8', Buffer.from(lines.join('\n') + '\n', 'utf8'));
  }

  // ---- fetch#1: arceus.lua loader (rebuilt to point the gist at us)
  if (p.endsWith('/arceus.lua') || p === '/Costumers/arceus.lua') {
    return send(res, 200, 'text/plain; charset=utf-8', arceusLua());
  }

  // ---- fetch#2: the menu. Serve our CUSTOM UI if present, else the rewritten real gist.
  if (p === '/gist' || p.endsWith('/gist') || p.endsWith('gist_arceus_latest')) {
    // payloads/ui/ is the current UI; custom_ui.lua is the single-file one it
    // replaced and stays as the fallback, so a deployment that ships only the
    // old payload still serves a working menu.
    const custom = assembleUi() ?? readPayload('custom_ui.lua')?.toString('utf8');
    if (custom) {
      // inject the public base so the in-game exec-bridge knows where to poll
      const ui = custom.split('__OMNI_BASE__').join(LOCAL_BASE);
      return send(res, 200, 'text/plain; charset=utf-8', Buffer.from(ui, 'utf8'));
    }
    const g = readPayload('gist_arceus_latest');
    if (g) return send(res, 200, 'text/plain; charset=utf-8', Buffer.from(uiModify(rewriteLocal(g.toString('utf8'))), 'utf8'));
    return send(res, 404, 'text/plain; charset=utf-8', Buffer.from(''));
  }

  // ---- everything else executor-shaped: serve captured github content by path
  const fn = bypathName(p);
  let data = readByPath(fn);
  if (!data && fn) {
    const alt = fn.replace('_refs_heads_main_', '_main_').replace('_main_', '_refs_heads_main_');
    data = readByPath(alt);
  }
  if (data) {
    // Serve-time host rewrite must reach EVERY text payload, including the
    // extensionless script sources github serves (e.g. `EdgeIY.../…_source`,
    // an ESP loader stub) -- an allowlist of extensions silently let those
    // leak literal raw.githubusercontent.com fetch targets to the client. So
    // the rule is inverted: anything that is not a known-binary type AND
    // sniffs as UTF-8 text (no NUL byte in its head) is rewritten; genuine
    // binaries (images) fall through untouched.
    const isBinary = /\.(png|jpe?g|webp|gif|ico|bmp|so|apk|zip|gz|ttf|otf|woff2?)$/i.test(p);
    const head = data.subarray(0, 1024);
    const looksText = !head.includes(0);
    if (!isBinary && looksText) {
      return send(res, 200, 'text/plain; charset=utf-8', Buffer.from(rewriteLocal(data.toString('utf8')), 'utf8'));
    }
    return send(res, 200, guessType(p), data);
  }

  // ours by shape but not found -> 404 (don't fall through to the SPA index.html)
  return send(res, 404, 'text/plain; charset=utf-8', Buffer.from(''));
}
