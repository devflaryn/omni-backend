import { Router } from 'express';

import {
    listPlans,
    quote,
    createCheckout,
    orderStatus,
} from '../controllers/checkout.controller.js';

const checkoutRouter = Router();

/*
 * Path: /api/v1/checkout/...
 *
 * NO auth middleware anywhere in here, deliberately. Buying a key must not
 * require an account — that circularity (needed a key to sign up, needed an
 * account to buy a key) is the bug this whole flow exists to remove.
 *
 * The webhook is NOT mounted here. It needs the raw request body for HMAC
 * verification, so server.js mounts it ahead of express.json().
 */

checkoutRouter.get('/plans', listPlans);
checkoutRouter.post('/quote', quote);
checkoutRouter.post('/', createCheckout);
checkoutRouter.get('/:orderId/status', orderStatus);

export default checkoutRouter;
