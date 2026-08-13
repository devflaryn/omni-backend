import { Router } from 'express';

import authorize from '../middlewares/auth.middleware.js';
import { signUp, signIn, signOut, me } from "../controllers/auth.controller.js";

const authRouter = new Router();

// Path: /api/v1/auth/...

authRouter.post('/sign-up', signUp);
authRouter.post('/sign-in', signIn);
authRouter.post('/sign-out', signOut);
authRouter.get('/me', authorize, me);

export default authRouter;
