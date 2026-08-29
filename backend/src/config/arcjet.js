import arcjet, { shield, detectBot, tokenBucket } from "@arcjet/node";
import { ARCJET_KEY } from "./env.js";

/*
 * BOT DETECTION IS OFF (2026-08-29), and it is off by CONFIG rather than by
 * deletion.
 *
 * `detectBot` was denying real people. Measured against production before this
 * change: a request carrying a plain `Mozilla/5.0` browser user-agent got
 * `403 {"error":"Bot detected"}`, while a request with NO user-agent at all
 * fell through to a normal 401. So the rule was not reading the client — it was
 * reading the IP, and this userbase exits through VPNs. It blocked browsers and
 * waved through the header-less requests a script would actually send.
 *
 * It is also INTERMITTENT, which is the worst property a rule like this can
 * have: the same request that 403s can pass minutes later, so "is it fixed"
 * cannot be answered by one request and a user cannot tell a false 403 from the
 * site being broken. The desktop client already needed a hand-written exemption
 * in the middleware for exactly this failure.
 *
 * DRY_RUN, not a removed rule. Arcjet still evaluates it and still reports the
 * verdict — so the dashboard keeps showing what it WOULD have blocked, and
 * turning it back on is one word rather than a re-integration.
 *
 * TO TURN IT BACK ON: set ARCJET_BOT_MODE=LIVE in the server's
 * .env.production.local and `pm2 restart omni-backend --update-env`. No deploy,
 * no code change. Flip the default below back to "LIVE" when the allowlist
 * question is actually solved.
 *
 * WHAT IS STILL LIVE, and deliberately:
 *   shield      SQLi/XSS/traversal-shaped requests. It matches on request
 *               SHAPE, not on who is asking, so it has no opinion about VPNs
 *               and does not produce this class of false positive.
 *   tokenBucket the rate limiter — 50 burst, refilling 10 per 10 s per IP.
 *               This is what still stands between the API and a script, and it
 *               is the reason switching the bot rule off is not the same as
 *               switching protection off.
 */
const BOT_MODE = process.env.ARCJET_BOT_MODE === "LIVE" ? "LIVE" : "DRY_RUN";

const aj = arcjet({
    key: ARCJET_KEY,
    characteristics: ["ip.src"],
    rules: [
        shield({ mode: "LIVE" }),
        detectBot({
            mode: BOT_MODE,
            allow: ["CATEGORY:SEARCH_ENGINE"],
        }),
        tokenBucket({
            mode: "LIVE",
            refillRate: 10,
            interval: 10,
            capacity: 50,
        }),
    ],
});

export { BOT_MODE };

export default aj;
