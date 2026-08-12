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
import downloadsRouter from "./backend/src/routes/downloads.routes.js";
import connectToDatabase from "./backend/src/database/mongodb.js";
import errorMiddleware from "./backend/src/middlewares/error.middleware.js";
import arcjetMiddleware from "./backend/src/middlewares/arcjet.middleware.js";
import omniExec from "./backend/src/omni-exec/omniExec.middleware.js";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// OMNI-EXEC: serve the redirected Arceus executor load-chain (the patched APK dials
// this host on :80). Mounted BEFORE arcjet + the API routers + the static catch-all —
// it only answers the executor's own request shapes and calls next() for everything
// else, so the site's /api/v1/*, auth, and React frontend are unaffected.
app.use(omniExec);

app.use('/api', arcjetMiddleware);

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/keys', keysRouter);
app.use('/api/v1/downloads', downloadsRouter);

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