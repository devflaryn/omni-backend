import { config } from 'dotenv';

config({ path: `.env.${process.env.NODE_ENV || 'development'}.local` });

export const {
    PORT, NODE_ENV,
    DB_URI,
    JWT_SECRET, JWT_EXPIRES_IN,
    ARCJET_ENV, ARCJET_KEY,
    REDIS_URL,
    // Optional: dedicated key for encrypting stored Roblox cookies. Falls back
    // to a derivation of JWT_SECRET (see utils/secretBox.js) when unset.
    ACCOUNT_ENC_KEY
} = process.env;