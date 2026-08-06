import express from "express";

import path from 'path';
import { fileURLToPath } from 'url';

import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { PORT } from "./backend/src/config/env.js";

import authRouter from "./backend/src/routes/auth.routes.js";
import userRouter from "./backend/src/routes/user.routes.js";
import connectToDatabase from "./backend/src/database/mongodb.js";
import errorMiddleware from "./backend/src/middlewares/error.middleware.js";
import arcjetMiddleware from "./backend/src/middlewares/arcjet.middleware.js";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use('/api', arcjetMiddleware);

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);

// TODO: add a production logic
const reactBuildPath = path.join(__dirname, 'frontend', 'dist');
app.use(express.static(reactBuildPath));

app.get('*', (req, res) => {
    res.sendFile(path.join(reactBuildPath, 'index.html'));
});

app.use(errorMiddleware);

app.listen(PORT, "0.0.0.0", async () => {
    console.log(`✅ Server running on port ${PORT}`);

    await connectToDatabase();
});

export default app;