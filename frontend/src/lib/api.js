/*
 * One JSON round trip against this origin's API.
 *
 * Throws an Error carrying the server's own message AND its status, because
 * the status is load-bearing on this site and the three cases are answered
 * differently everywhere they are handled:
 *
 *   401  the session is dead        -> sign out
 *   402  the plan lapsed / is free  -> show the premium panel, NOT an error
 *   any  something actually broke   -> say so, keep the session
 *
 * Collapsing them into one "request failed" is what turns "redeem a key" into
 * "something went wrong", which is the difference between a user who renews
 * and a user who files a bug (see subscription.middleware.js).
 *
 * Lives apart from auth.jsx so that file can export only its component —
 * react-refresh needs a component-only module to hot-reload the provider.
 */
export async function apiCall(path, { token, method = "GET", body } = {}) {
    const res = await fetch(`/api/v1${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const error = new Error(json.message || json.error || `HTTP ${res.status}`);
        error.status = res.status;
        error.code = json.error || null;
        throw error;
    }
    return json;
}
