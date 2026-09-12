import { MICROS_PER_DOLLAR } from '../../utils/credits.js';
import { miningConfig } from '../../config/mining.js';

/** GROSS USD value of one accepted share, in micros. Payout rate is applied
 *  later, in the payout loop, so this stays a pure price function. */
export function shareValueMicros(coin, difficulty, cfg = miningConfig()) {
    const rate = cfg?.valuation?.[coin]?.usdPerDiff;
    if (!rate) return 0;
    const usd = (Number(difficulty) || 0) * rate;
    return Math.max(0, Math.round(usd * MICROS_PER_DOLLAR));
}
