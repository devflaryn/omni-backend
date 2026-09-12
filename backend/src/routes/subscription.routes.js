import { Router } from 'express';
import authorize from '../middlewares/auth.middleware.js';
import { redeemCreditsForDay } from '../controllers/subscription.controller.js';

const subscriptionRouter = Router();
// Path: /api/v1/subscription/...
subscriptionRouter.post('/redeem-credits', authorize, redeemCreditsForDay);
export default subscriptionRouter;
