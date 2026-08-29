/*
 * The auth context and its hook, kept out of auth.jsx so that file exports a
 * component and nothing else (react-refresh's rule, and it keeps the provider
 * hot-reloadable while you are building a form against it).
 */
import { createContext, useContext } from "react";

export const AuthContext = createContext(null);

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
    return ctx;
}
