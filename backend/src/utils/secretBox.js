import crypto from 'crypto';

import { ACCOUNT_ENC_KEY, JWT_SECRET } from '../config/env.js';

/*
 * Authenticated symmetric encryption for the one secret this backend now stores
 * on behalf of users: a Roblox `.ROBLOSECURITY` cookie. That cookie is FULL
 * account access, so it must not sit in Mongo in plaintext — a database dump
 * would otherwise hand over every account the product manages.
 *
 * AES-256-GCM (not CBC): the tag makes tampering detectable, which matters
 * because the decrypted value is fed straight into a browser/VM as a session.
 *
 * The key comes from ACCOUNT_ENC_KEY when set, and is otherwise DERIVED from
 * JWT_SECRET. Deriving is deliberate: it means an existing deployment gains
 * encryption without an ops step, and the derivation is domain-separated
 * (a fixed salt + info string) so the AES key is not the JWT secret itself.
 * Rotating either secret makes stored cookies undecryptable — that is the
 * intended failure mode (re-login), not silent plaintext fallback.
 */
const KEY_LEN = 32;
const IV_LEN = 12;          // GCM standard nonce length
const SCRYPT_SALT = 'omni-account-cookie-v1';

let cachedKey = null;

function key() {
    if (cachedKey) return cachedKey;
    const material = ACCOUNT_ENC_KEY || JWT_SECRET;
    if (!material) {
        throw new Error(
            'Cannot encrypt account cookies: set ACCOUNT_ENC_KEY (or JWT_SECRET) in the environment'
        );
    }
    cachedKey = crypto.scryptSync(String(material), SCRYPT_SALT, KEY_LEN);
    return cachedKey;
}

/** Encrypt a UTF-8 string. Returns "v1.<iv>.<tag>.<ciphertext>", all base64url. */
export function seal(plaintext) {
    if (typeof plaintext !== 'string' || !plaintext) {
        throw new Error('seal() needs a non-empty string');
    }
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Reverse of seal(). Throws if the blob was tampered with or the key changed. */
export function open(blob) {
    if (typeof blob !== 'string' || !blob) throw new Error('open() needs a sealed string');
    const [version, ivB64, tagB64, ctB64] = blob.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) {
        throw new Error('unrecognized sealed value');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
        decipher.update(Buffer.from(ctB64, 'base64url')),
        decipher.final(),
    ]).toString('utf8');
}

/** True if `blob` looks like something seal() produced (used to detect legacy plaintext). */
export function isSealed(blob) {
    return typeof blob === 'string' && blob.startsWith('v1.') && blob.split('.').length === 4;
}
