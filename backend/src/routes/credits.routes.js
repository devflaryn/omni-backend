import { Router } from 'express';

import authorize from '../middlewares/auth.middleware.js';
import adminOnly from '../middlewares/admin.middleware.js';
import {
    getMyCredits,
    getMyTransactions,
    internalAuthorize,
    internalCharge,
    adminListUsers,
    adminAdjustCredits,
    adminUserTransactions,
} from '../controllers/credits.controller.js';

const creditsRouter = Router();

// Path: /api/v1/credits/...

// The signed-in user's own balance and history.
creditsRouter.get('/me', authorize, getMyCredits);
creditsRouter.get('/me/transactions', authorize, getMyTransactions);

// Service-to-service, called by the Python captcha solver. These deliberately
// do NOT use `authorize`: the caller is a machine holding a shared secret, and
// the END user is identified by the token it forwards in the body, which the
// controller verifies itself.
creditsRouter.post('/internal/authorize', internalAuthorize);
creditsRouter.post('/internal/charge', internalCharge);

// The admin desk. `adminOnly` already exists, so "a single admin" is just a
// matter of promoting exactly one account.
creditsRouter.get('/admin/users', authorize, adminOnly, adminListUsers);
creditsRouter.post('/admin/users/:id/adjust', authorize, adminOnly, adminAdjustCredits);
creditsRouter.get('/admin/users/:id/transactions', authorize, adminOnly, adminUserTransactions);

export default creditsRouter;
