import express from "express";

import path from 'path';
import { fileURLToPath } from 'url';

import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { PORT } from "./backend/src/config/env.js";

import authRouter from "./backend/src/routes/auth.routes.js";
import userRouter from "./backend/src/routes/user.routes.js";
import keysRouter from "./backend/src/routes/keys.routes.js";
import accountsRouter from "./backend/src/routes/accounts.routes.js";
import downloadsRouter from "./backend/src/routes/downloads.routes.js";
import creditsRouter from "./backend/src/routes/credits.routes.js";
import statsRouter from "./backend/src/routes/stats.routes.js";
import connectToDatabase from "./backend/src/database/mongodb.js";
import errorMiddleware from "./backend/src/middlewares/error.middleware.js";
import arcjetMiddleware from "./backend/src/middlewares/arcjet.middleware.js";
import omniExec from "./backend/src/omni-exec/omniExec.middleware.js";
import execBridge from "./backend/src/omni-exec/execBridge.js";
import { loadRegistry } from "./backend/src/omni-exec/registry.js";
import { createDistRouter } from "./backend/src/omni-exec/distApi.js";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// OMNI-EXEC: serve the redirected Arceus executor load-chain (the patched APK dials
// this host on :80). Mounted BEFORE arcjet + the API routers + the static catch-all —
// it only answers the executor's own request shapes and calls next() for everything
// else, so the site's /api/v1/*, auth, and React frontend are unaffected.
app.use(omniExec);

// OMNI-EXEC remote-execute bridge (GUI -> queue -> in-game poller). Not under /api,
// so arcjet doesn't touch it; mounted before the static catch-all.
app.use('/omni/exec', execBridge);

// OMNI-EXEC distribution API (installer pulls artifacts by name; VPS now, 302->CDN later).
app.use('/omni/dist', createDistRouter(loadRegistry(path.join(__dirname, 'dist'))));

app.use('/api', arcjetMiddleware);

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/keys', keysRouter);
app.use('/api/v1/accounts', accountsRouter);
app.use('/api/v1/downloads', downloadsRouter);
app.use('/api/v1/credits', creditsRouter);
app.use('/api/v1/stats', statsRouter);

// TODO: add a production logic
const reactBuildPath = path.join(__dirname, 'frontend', 'dist');
app.use(express.static(reactBuildPath));

app.get('*', (req, res) => {
    res.sendFile(path.join(reactBuildPath, 'index.html'));
});

app.use(errorMiddleware);

// Importing this module (e.g. from a test file) must never bind a real
// port or open a second DB connection — only `node server.js` does that.
const isMainModule = process.argv[1] === __filename;

if (isMainModule) {
    app.listen(PORT, "0.0.0.0", async () => {
        console.log(`✅ Server running on port ${PORT}`);

        await connectToDatabase();
    });
}

export default app;