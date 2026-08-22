import aj from "../config/arcjet.js"

// The desktop Omni Executor client is not a browser and not a search-engine
// crawler, so Arcjet's detectBot({mode:"LIVE"}) rejected it outright ("Bot
// detected", 403) on EVERY network -- which silently killed cloud account sync
// for every install, VPN or not. It identifies itself with a stable UA and a
// per-device header (cloud.py `_headers`), so we exempt exactly that client from
// bot detection while still letting shield + the rate limiter run against it.
const isOmniClient = (req) => {
    const ua = req.get("user-agent") || "";
    return ua.startsWith("OmniExecutor/") && Boolean(req.get("x-omni-device-id"));
};

const arcjetMiddleware = async (req, res, next) => {
    try {
        const decision = await aj.protect(req, { requested: 1 });

        // A denied Omni client is only ever a false-positive bot verdict here;
        // honour a genuine rate-limit but never the bot rule for our own client.
        if (decision.isDenied() && decision.reason.isBot() && isOmniClient(req)) {
            return next();
        }

        if (decision.isDenied()) {
            if (decision.reason.isRateLimit()) return res.status(429).json({ error: "You're being rate limited" });
            if (decision.reason.isBot()) return res.status(403).json({ error: "Bot detected" });

            return res.status(403).json({ error: "Access denied" });
        }

        next();
    } catch (error) {
        console.log(`Arcjet Middleware Error: ${error}`);
        next(error);
    }
}

export default arcjetMiddleware;