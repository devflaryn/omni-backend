import { Router } from 'express';

import authorize from '../middlewares/auth.middleware.js';
import requireActiveSubscription from '../middlewares/subscription.middleware.js';
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
// Everything here is behind BOTH gates: a valid token (who you are) and an
// active plan (whether the product is yours to use). Every handler additionally
// scopes its query by req.user._id — the token alone never selects a row.
accountsRouter.use(authorize, requireActiveSubscription);

accountsRouter.get('/', listAccounts);
accountsRouter.post('/sync', syncAccounts);
accountsRouter.put('/:username', upsertAccount);
accountsRouter.get('/:username/cookie', getAccountCookie);
accountsRouter.post('/:username/state', setAccountState);
accountsRouter.delete('/:username', deleteAccount);

export default accountsRouter;
