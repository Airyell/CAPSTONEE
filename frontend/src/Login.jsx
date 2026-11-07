import { useState } from "react";
import "./styles/Login.css";
import { supabase } from "./supabaseClient";
import { normalizeRole, requestApiToken, setAuthToken } from "./rbac";

const API_BASE =
  import.meta.env?.VITE_API_BASE_URL || "http://localhost:8000/api";

// ADDED: failed-login tracking for the Audit Logs
const FAILED_LOGIN_LIMIT = 3;        // log a warning every time this many failures pile up...
const FAILED_LOGIN_WINDOW_MIN = 15;  // ...within this many minutes, for the same account

async function recordLoginActivity(staffId, description, status) {
  const { error } = await supabase.from("tbl_system_activity").insert({
    staff_id: staffId,
    activity_type: "login",
    activity_description: description,
    module_name: "Authentication",
    date_time: new Date().toISOString(),
    status,
  });

  if (error) console.error("Failed to record login activity:", error);
}

// Logs the failed attempt, then logs a warning if this account has too many
// recent failures. Never throws, so logging can't break the login screen.
async function recordFailedLogin(staff) {
  try {
    const name = staff.name || staff.username;

    await recordLoginActivity(
      staff.staff_id,
      `Failed login attempt for ${name}`,
      "failed"
    );

    const since = new Date(
      Date.now() - FAILED_LOGIN_WINDOW_MIN * 60 * 1000
    ).toISOString();

    const { count, error } = await supabase
      .from("tbl_system_activity")
      .select("activity_id", { count: "exact", head: true })
      .eq("staff_id", staff.staff_id)
      .eq("activity_type", "login")
      .eq("status", "failed")
      .gte("date_time", since);

    if (error) {
      console.error("Failed to count failed logins:", error);
      return;
    }

    if (count >= FAILED_LOGIN_LIMIT && count % FAILED_LOGIN_LIMIT === 0) {
      await recordLoginActivity(
        staff.staff_id,
        `${count} failed login attempts for ${name} in the last ${FAILED_LOGIN_WINDOW_MIN} minutes`,
        "warning"
      );
    }
  } catch (err) {
    console.error("Failed to record failed login:", err);
  }
}

export default function Login({ onLogin, onStudentAccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [adminMode, setAdminMode] = useState(false);
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (inputUsername, inputPassword, expectedRole) => {
    if (loading) return;

    setError("");
    setLoading(true);

    try {
      const { data, error: dbError } = await supabase
        .from("tbl_staff")
        .select("staff_id, user_role, username, name, email, status") // CHANGED (name): added "name"
        .eq("username", inputUsername)
        .maybeSingle();

      if (dbError || !data) {
        setError("Invalid username or password.");
        return;
      }

      // CHANGED: password is now verified by Supabase Auth (replaces the plain-text comparison)
      const { data: authData, error: authError } =
        await supabase.auth.signInWithPassword({
          email: data.email,
          password: inputPassword,
        });

      if (authError || !authData?.session) {
        await recordFailedLogin(data); // ADDED: shows as "failed" in Audit Logs
        setError("Invalid username or password.");
        return;
      }

      if (
        expectedRole &&
        data.user_role?.toLowerCase() !== expectedRole.toLowerCase()
      ) {
        // ADDED: correct password but wrong login portal, shows as "warning" in Audit Logs
        await recordLoginActivity(
          data.staff_id,
          `${data.name || data.username} tried to log in through the ${expectedRole} login without ${expectedRole} privileges`,
          "warning"
        );
        await supabase.auth.signOut(); // ADDED
        setError(
          `Access denied. This account does not have ${expectedRole} privileges.`
        );
        return;
      }

      // ADDED: admin accounts must use the Admin login, not the staff login
      if (!expectedRole && data.user_role?.toLowerCase() === "admin") {
        await supabase.auth.signOut();
        setError(
          "Access denied. Admin accounts must log in through the Admin login."
        );
        return;
      }

      if (!normalizeRole(data.user_role)) {
        await supabase.auth.signOut(); // ADDED
        setError(
          "Your account role is not recognized. Please contact the administrator."
        );
        return;
      }

      // ADDED (name): the dashboards show the "name" column.
      // Falls back to the username only if a row has no name yet.
      const displayName = data.name || data.username;

      try {
        const response = await fetch(
          `${API_BASE}/staff/${data.staff_id}/login`,
          { method: "POST" }
        );

        if (!response.ok) {
          console.warn("Failed to update staff status:", response.status);
        }
      } catch (statusErr) {
        console.error("Failed to set staff status to Active:", statusErr);
      }

      const { error: activityError } = await supabase
        .from("tbl_system_activity")
        .insert({
          staff_id: data.staff_id,
          activity_type: "login",
          activity_description: `${displayName} logged in`, // CHANGED (name): was ${data.username}
          module_name: "Authentication",
          date_time: new Date().toISOString(),
          status: "success",
        });

      if (activityError) {
        console.error("Failed to record login activity:", activityError);
      }

      // CHANGED: the Supabase access token is now the API token
      // (replaces: const apiToken = await requestApiToken(inputUsername, inputPassword);)
      setAuthToken(authData.session.access_token);

      onLogin(displayName, data.user_role, Number(data.staff_id)); // CHANGED (name): was data.username
    } catch (err) {
      console.error("Login failed:", err);
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // ADMIN LOGIN VIEW
  if (adminMode) {
    return (
      <div className="login-page">
        <img src="/ustp.jpg" alt="USTP Campuses" className="login-bg" />
        <div className="login-overlay" />

        <div className="login-center">
          <div className="login-card">
            <div className="login-brand-wrapper">
              <h1 className="login-brand-title">RegisScan</h1>
              <p className="login-brand-sub">Admin Access Only</p>
              <div className="login-brand-accent" />
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleLogin(adminUsername, adminPassword, "admin");
              }}
            >
              <div className="mb-4">
                <div className="login-input-wrapper">
                  <input
                    type="text"
                    placeholder="Admin Username"
                    value={adminUsername}
                    onChange={(e) => setAdminUsername(e.target.value)}
                    className="login-input"
                    autoComplete="username"
                    required
                  />
                </div>
              </div>

              <div className="mb-8">
                <div className="login-input-wrapper password-input-wrapper">
                  <input
                    type={showAdminPassword ? "text" : "password"}
                    placeholder="Admin Password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    className="login-input"
                    autoComplete="current-password"
                    required
                  />

                  <button
                    type="button"
                    className="password-toggle-btn"
                    onClick={() =>
                      setShowAdminPassword((prev) => !prev)
                    }
                    aria-label={
                      showAdminPassword
                        ? "Hide admin password"
                        : "Show admin password"
                    }
                    aria-pressed={showAdminPassword}
                  >
                    {showAdminPassword ? (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8" />
                        <path d="M9.9 5.2A10.8 10.8 0 0112 5c5 0 8.5 4.5 9.5 7-.4 1.1-1.2 2.4-2.4 3.5M6.2 6.2C3.8 7.7 2.7 10 2.5 12c.5 1.3 2 3.4 4.7 4.8A10.6 10.6 0 0012 18c1.1 0 2.1-.2 3-.5" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {error && (
                <p
                  style={{
                    color: "red",
                    fontSize: "0.85rem",
                    marginBottom: "0.75rem",
                    textAlign: "center",
                  }}
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                className="login-btn"
                disabled={loading}
              >
                {loading ? "Logging in..." : "Log in as Admin"}
              </button>
            </form>

            <div
              className="login-admin-link"
              style={{ marginTop: "1.5rem" }}
            >
              <button
                type="button"
                className="login-admin-btn"
                onClick={() => {
                  setAdminMode(false);
                  setAdminUsername("");
                  setAdminPassword("");
                  setShowAdminPassword(false);
                  setError("");
                }}
              >
                Back to Staff Login
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // STAFF LOGIN VIEW
  return (
    <div className="login-page">
      <img src="/ustp.jpg" alt="USTP Campuses" className="login-bg" />
      <div className="login-overlay" />

      <div className="login-center">
        <div className="login-card">
          <div className="login-brand-wrapper">
            <h1 className="login-brand-title">RegisScan</h1>
            <p className="login-brand-sub">
              Document and Request Management System
            </p>
            <div className="login-brand-accent" />
          </div>

          <form
  onSubmit={(e) => {
    e.preventDefault();
    if (loading) return;
    handleLogin(username, password, null);
  }}
>
            <div className="mb-4">
              <div className="login-input-wrapper">
                <input
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="login-input"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <div className="mb-8">
              <div className="login-input-wrapper password-input-wrapper">
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="login-input"
                  autoComplete="current-password"
                  required
                />

                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={
                    showPassword ? "Hide password" : "Show password"
                  }
                  aria-pressed={showPassword}
                >
                  {showPassword ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8" />
                      <path d="M9.9 5.2A10.8 10.8 0 0112 5c5 0 8.5 4.5 9.5 7-.4 1.1-1.2 2.4-2.4 3.5M6.2 6.2C3.8 7.7 2.7 10 2.5 12c.5 1.3 2 3.4 4.7 4.8A10.6 10.6 0 0012 18c1.1 0 2.1-.2 3-.5" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p
                style={{
                  color: "red",
                  fontSize: "0.85rem",
                  marginBottom: "0.75rem",
                  textAlign: "center",
                }}
              >
                {error}
              </p>
            )}

            <button
  type="submit"
  className="login-btn"
  disabled={loading}
>
  {loading ? "Logging in..." : "Log in"}
</button>
          </form>

          <div className="login-divider-wrapper">
            <div className="login-divider-line" />
            <span className="login-divider-text">or</span>
            <div className="login-divider-line" />
          </div>

          <p className="login-guest-note">
            Some courses may allow student access
          </p>

          <button
            type="button"
            className="login-student-btn"
            onClick={onStudentAccess}
          >
            Access as Student
          </button>

          <div className="login-admin-link">
            <button
              type="button"
              className="login-admin-btn"
              onClick={() => {
                setAdminMode(true);
                setError("");
              }}
            >
              Admin
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}