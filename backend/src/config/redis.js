import Redis from "ioredis";
import { REDIS_URL } from "./env.js";

const redis = new Redis(REDIS_URL);

redis.on("connect", () => console.log("🔌 Redis Connected!"));
redis.on("error", (err) => console.error("❌ Redis Error:", err));

export default redis;