import { isSubscriptionActive } from '../utils/applyLicenseKey.js';

/**
 * The paywall. Runs AFTER authorize, so req.user is populated.
 *
 * 402 (Payment Required), not 403: the client tells these apart — 403 means
 * "not yours", 402 means "your plan lapsed, redeem a key" — and showing the
 * wrong one of those two prompts is the difference between a user who renews
 * and a user who files a bug.
 */
const requireActiveSubscription = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!isSubscriptionActive(req.user.subscription)) {
        return res.status(402).json({
            success: false,
            error: 'subscription_inactive',
            message: req.user.subscription?.plan
                ? 'Your plan has expired. Redeem a new key to continue.'
                : 'This account has no active plan. Redeem a key to continue.',
        });
    }
    next();
};

export default requireActiveSubscription;
