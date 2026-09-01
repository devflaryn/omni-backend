/*
 * Vanity display names for the website.
 *
 * The account keeps its real username server-side — this only changes what the
 * marketing and dashboard surfaces greet you by. Case-insensitive lookup, and
 * anything without an override renders unchanged.
 */
const OVERRIDES = {
    beratbadem00: "devflaryn",
};

export function displayName(username) {
    if (!username) return "";
    return OVERRIDES[username.toLowerCase()] || username;
}
