import { Router } from 'express';

import authorize from '../middlewares/auth.middleware.js';
import {
    listAccounts,
    upsertAccount,
    getAccountCookie,
    deleteAccount,
    syncAccounts,
    setAccountState,
} from '../controllers/accounts.controller.js';

const accountsRouter = Router();

// Path: /api/v1/accounts/...
// One gate: a valid token. Every handler additionally scopes its query by
// req.user._id — the token alone never selects a row.
//
// requireActiveSubscription USED to sit here too, and deliberately does not any
// more. Sign-up is free, and a free account owns its Roblox accounts and their
// cookies exactly as a premium one does — leaving the paywall on this router
// would mean every new account was created locked out of its own data. The tier
// is meant to gate FEATURES, and the middleware is still in the tree waiting
// for the premium-only routes that will carry it.
accountsRouter.use(authorize);

accountsRouter.get('/', listAccounts);
accountsRouter.post('/sync', syncAccounts);
accountsRouter.put('/:username', upsertAccount);
accountsRouter.get('/:username/cookie', getAccountCookie);
accountsRouter.post('/:username/state', setAccountState);
accountsRouter.delete('/:username', deleteAccount);

export default accountsRouter;
