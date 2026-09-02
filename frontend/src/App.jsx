import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";

import Home from "./pages/Home";
import Download from "./pages/Download";
import CheckoutStatus from "./pages/CheckoutStatus";
import Admin from "./pages/Admin";
import SignIn from "./pages/SignIn";
import SignUp from "./pages/SignUp";
import Dashboard from "./pages/Dashboard";
import { AuthProvider } from "./lib/auth.jsx";
import { useAuth } from "./lib/auth-context.js";

/*
 * The gate in front of anything that belongs to a user.
 *
 * It renders NOTHING while auth is still resolving. A redirect fired before
 * the first /api/v1/auth/me answers would bounce every signed-in reload
 * straight to the sign-in form, which is indistinguishable from being logged
 * out and is the one bug this shape exists to avoid.
 *
 * Where you were going is carried across in router state so /dashboard
 * survives a sign-in rather than dropping everyone on the same page.
 */
function RequireAuth({ children }) {
    const auth = useAuth();
    const location = useLocation();
    if (!auth.ready) return null;
    if (!auth.signedIn) return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
    return children;
}

export default function App() {
    return (
        <AuthProvider>
            <Router>
                <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/download" element={<Download />} />
                    <Route path="/checkout/:orderId" element={<CheckoutStatus />} />
                    <Route path="/sign-in" element={<SignIn />} />
                    <Route path="/sign-up" element={<SignUp />} />
                    <Route
                        path="/dashboard"
                        element={
                            <RequireAuth>
                                <Dashboard />
                            </RequireAuth>
                        }
                    />
                    {/* /admin keeps its OWN sign-in and its own token key. It is
                        the credits desk, not a user surface, and merging the two
                        would mean signing in to the dashboard silently granted or
                        revoked access to it. */}
                    <Route path="/admin" element={<Admin />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </Router>
        </AuthProvider>
    );
}
