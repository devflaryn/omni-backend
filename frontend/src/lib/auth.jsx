/*
 * Being signed in, on the website.
 *
 * The site used to be anonymous marketing with one exception — /admin, which
 * carried its own sign-in under its own localStorage key precisely because
 * there was no session to inherit. There is one now: this provider holds it,
 * and /admin's key is deliberately left alone rather than merged, so signing
 * in to the dashboard never silently grants (or revokes) the credits desk.
 *
 * The token is the same JWT the desktop app gets from /api/v1/auth/sign-in.
 * One account, one credential, three surfaces — the desktop app, the website
 * and the CLI all present it the same way.
 *
 * WHY localStorage AND NOT A COOKIE. The API authenticates from an
 * `Authorization: Bearer` header (auth.middleware.js reads nothing else), so a
 * cookie would have to be read back out by JS and re-attached anyway — the
 * same exposure with an extra moving part, and one that would start riding
 * along on every request to /omni/* as well.
 *
 * The stored token is treated as a CLAIM, never as proof: every mount asks
 * /api/v1/auth/me and takes the server's answer. A token that expired
 * overnight must not render a dashboard shell that then 401s field by field.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiCall } from "./api.js";
import { AuthContext } from "./auth-context.js";

const TOKEN_KEY = "omni-token";

/** Read the saved token. Storage can throw (private mode, blocked cookies). */
function readToken() {
    try {
        return localStorage.getItem(TOKEN_KEY) || null;
    } catch {
        return null;
    }
}

function writeToken(token) {
    try {
        if (token) localStorage.setItem(TOKEN_KEY, token);
        else localStorage.removeItem(TOKEN_KEY);
    } catch {
        /* a session that lives only in memory still works for this tab */
    }
}

export function AuthProvider({ children }) {
    const [token, setToken] = useState(readToken);
    const [user, setUser] = useState(null);
    const [subscription, setSubscription] = useState(null);
    // null while the first /me is in flight: the difference between "not signed
    // in" and "we have not asked yet" is a redirect to /sign-in that fires on
    // every reload for a perfectly valid session.
    const [ready, setReady] = useState(false);

    const signOut = useCallback(() => {
        writeToken(null);
        setToken(null);
        setUser(null);
        setSubscription(null);
    }, []);

    const adopt = useCallback((data) => {
        writeToken(data.token);
        setToken(data.token);
        setUser(data.user ?? null);
        setSubscription(data.subscription ?? null);
    }, []);

    useEffect(() => {
        let cancelled = false;
        if (!token) {
            setReady(true);
            return () => { cancelled = true; };
        }
        apiCall("/auth/me", { token })
            .then((res) => {
                if (cancelled) return;
                setUser(res?.data?.user ?? null);
                setSubscription(res?.data?.subscription ?? null);
            })
            .catch((error) => {
                if (cancelled) return;
                // Only a rejected token signs you out. A server that cannot be
                // reached must NOT — the credential is still good and dropping
                // it would make a flaky network look like a stolen session.
                if (error.status === 401) signOut();
            })
            .finally(() => {
                if (!cancelled) setReady(true);
            });
        return () => { cancelled = true; };
    }, [token, signOut]);

    const value = useMemo(() => ({
        token,
        user,
        subscription,
        ready,
        signedIn: Boolean(token),
        premium: subscription?.tier === "premium",
        signIn: async (email, password) => {
            const res = await apiCall("/auth/sign-in", { method: "POST", body: { email, password } });
            adopt(res.data);
            return res.data;
        },
        signUp: async (email, username, password) => {
            const res = await apiCall("/auth/sign-up", {
                method: "POST",
                body: { email, username, password },
            });
            adopt(res.data);
            return res.data;
        },
        signOut,
        // Every authenticated call on the site goes through here so the token
        // is attached in exactly one place.
        call: (path, options) => apiCall(path, { ...options, token }),
    }), [token, user, subscription, ready, adopt, signOut]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
