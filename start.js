import app from './server.js';
import { PORT } from './backend/src/config/env.js';
import connectToDatabase from './backend/src/database/mongodb.js';

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
