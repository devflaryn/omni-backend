import { redeemDayWithCredits } from '../services/subscriptionCredits.service.js';
import { CreditsError } from '../services/credits.service.js';
import { subscriptionView } from './auth.controller.js';
import { displayBalanceMicros, effectiveBalanceMicros, microsToCredits } from '../utils/credits.js';

export const redeemCreditsForDay = async (req, res, next) => {
    try {
        const { user } = await redeemDayWithCredits(req.user._id);
        const shown = displayBalanceMicros(effectiveBalanceMicros(user.credits));
        res.status(200).json({
            success: true,
            data: {
                subscription: subscriptionView(user),
                credits: { balanceMicros: shown, credits: microsToCredits(shown) },
            },
        });
    } catch (error) {
        if (error instanceof CreditsError) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        next(error);
    }
};
