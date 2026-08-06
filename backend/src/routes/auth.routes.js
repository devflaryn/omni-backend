import { Router } from 'express';

import { signUp, signIn, signOut } from "../controllers/auth.controller.js";

const authRouter = new Router();

// Path: /api/v1/auth/...

authRouter.post('/sign-up', signUp);
authRouter.post('/sign-in', signIn);
authRouter.post('/sign-out', signOut);

export default authRouter;