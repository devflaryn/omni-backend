import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

import app from './server.js';
import { PORT } from './backend/src/config/env.js';
import connectToDatabase from './backend/src/database/mongodb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dedicated entry point for process managers (PM2, systemd, etc). Those
// commonly spawn scripts through an internal wrapper, so `process.argv[1]`
// no longer equals the script's own path — the `isMainModule` guard in
// server.js (correct for a plain `node server.js`) never fires in that
// case, and the process exits immediately with nothing listening. This
// file has no such guard: running it always starts the server.
app.listen(PORT, "0.0.0.0", async () => {
    console.log(`✅ Server running on port ${PORT}`);

    await connectToDatabase();
});

/*
 * THE EXECUTOR'S LOAD CHAIN IS HTTPS, SO WE MUST ANSWER ON 443.
 *
 * The patched APK reaches us two different ways and only one of them is port
 * 80. The .so byte-patch rewrites spdmteam/github hosts to `http://<our ip>`
 * in place, which lands on the HTTP listener above. But the Arceus loader
 * itself is fetched from `https://raw.githubusercontent.com/.../arceus.lua`,
 * and that URL is redirected by the guest's /system/etc/hosts — the scheme is
 * untouched, so the client dials OUR ip on 443.
 *
 * With nothing listening there the connection sat in SYN_SENT until it timed
 * out, the load chain died at its first fetch, and every downstream symptom
 * ("execution doesn't work", no in-game UI, `/omni/exec/status` reporting no
 * live session) followed from that one silent hang. tcpdump inside the guest
 * is what showed it: five packets, all to githubusercontent.com.https.
 *
 * A SELF-SIGNED cert is sufficient and is the point: the executor's TLS is
 * wolfSSL with no CA bundle and no verification, so it accepts whatever we
 * present. There is no domain here — clients reach a bare IP — so a CA-issued
 * cert is not obtainable anyway.
 *
 * Absent certs this is a no-op, which keeps `npm run dev` on a laptop exactly
 * as it was: HTTP only, no key material required.
 */
const CERT_DIR = process.env.OMNI_TLS_DIR || path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'server.key');
const CRT_FILE = path.join(CERT_DIR, 'server.crt');
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 443);

if (fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE)) {
    try {
        const creds = {
            key: fs.readFileSync(KEY_FILE),
            cert: fs.readFileSync(CRT_FILE),
        };
        https.createServer(creds, app).listen(HTTPS_PORT, "0.0.0.0", () => {
            console.log(`🔒 TLS listener on ${HTTPS_PORT} (executor load chain)`);
        }).on('error', (err) => {
            // Never take the HTTP server down with it: the site and the whole
            // /omni/dist update path live on 80 and must survive a bad cert,
            // a busy 443, or a missing CAP_NET_BIND_SERVICE.
            console.error(`TLS listener failed on ${HTTPS_PORT}: ${err.message}`);
        });
    } catch (err) {
        console.error(`TLS listener not started: ${err.message}`);
    }
} else {
    console.log(`(no TLS certs in ${CERT_DIR} — HTTP only)`);
}
