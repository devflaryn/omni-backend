import { Router } from 'express';

import authorize from '../middlewares/auth.middleware.js';
import requireActiveSubscription from '../middlewares/subscription.middleware.js';
import {
    listStats,
    getAccountStats,
    clearAccountStats,
} from '../controllers/stats.controller.js';

const statsRouter = Router();

// Path: /api/v1/stats/...
//
// THE FIRST ROUTER TO CARRY THE PAYWALL. accounts.routes.js left a note saying
// requireActiveSubscription was "still in the tree waiting for the premium-only
// routes that will carry it" — this is that route. Stat Track is a premium
// feature, so the gate is here rather than only in the UI: the desktop tab and
// the website dashboard both render their locked state off the 402 this
// returns, and switching the client off is not what stops the work happening.
//
// Ownership is enforced per request as well (every query is scoped by
// req.user._id), so an active plan never means unscoped.
//
// The INGEST half is deliberately not on this router: it comes from inside a
// Roblox client with no JWT, so it lives on the exec bridge at
// /omni/exec/stats, where it is gated by a claimed session token and by the
// account owner's plan. See controllers/stats.controller.js.
statsRouter.use(authorize, requireActiveSubscription);

statsRouter.get('/', listStats);
statsRouter.get('/:username', getAccountStats);
statsRouter.delete('/:username', clearAccountStats);

export default statsRouter;
