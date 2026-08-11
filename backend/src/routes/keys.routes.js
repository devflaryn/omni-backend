import { Router } from 'express';

import authorize from '../middlewares/auth.middleware.js';
import adminOnly from '../middlewares/admin.middleware.js';
import { generateKeys, redeemKey } from '../controllers/keys.controller.js';

const keysRouter = Router();

// Path: /api/v1/keys/...

keysRouter.post('/generate', authorize, adminOnly, generateKeys);
keysRouter.post('/redeem', authorize, redeemKey);

export default keysRouter;
