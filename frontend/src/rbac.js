// ============================================================================
// RBAC — Role Based Access Control (frontend core)
// ----------------------------------------------------------------------------
// One single place that answers: "what is each role allowed to do?"
//   • ROLES            – the roles that exist in tbl_staff.user_role
//   • PERMISSIONS      – every action that can be allowed / denied
//   • ROLE_PERMISSIONS – which role gets which permission   (RBAC matrix)
//   • PAGE_ACCESS      – which role may open which page
// Also holds the small helpers used to talk to the Laravel API with the
// login token (so the backend can enforce the same roles).
// ============================================================================

// ── 1. ROLES (must match the values saved in tbl_staff.user_role) ──────────
export const ROLES = {
  ADMIN: "Admin",
  REGISTRAR: "Registrar Staff",
};

// ── 2. PERMISSIONS ─────────────────────────────────────────────────────────
export const PERMISSIONS = {
  // Admin side
  STAFF_VIEW: "staff.view",
  STAFF_CREATE: "staff.create",
  STAFF_UPDATE: "staff.update",
  STAFF_DELETE: "staff.delete",
  REPORTS_VIEW: "reports.view",
  AUDIT_VIEW: "audit.view",

  // Registrar side
  STUDENTS_VIEW: "students.view",
  STUDENTS_CREATE: "students.create",
  STUDENTS_UPDATE: "students.update",
  DEPARTMENTS_VIEW: "departments.view",
  REQUESTS_VIEW: "requests.view",
  REQUESTS_UPDATE: "requests.update",
  DOCUMENTS_SCAN: "documents.scan",
};

// ── 3. ROLE → PERMISSIONS MATRIX ───────────────────────────────────────────
export const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: [
    PERMISSIONS.STAFF_VIEW,
    PERMISSIONS.STAFF_CREATE,
    PERMISSIONS.STAFF_UPDATE,
    PERMISSIONS.STAFF_DELETE,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.AUDIT_VIEW,
  ],
  [ROLES.REGISTRAR]: [
    PERMISSIONS.STUDENTS_VIEW,
    PERMISSIONS.STUDENTS_CREATE,
    PERMISSIONS.STUDENTS_UPDATE,
    PERMISSIONS.DEPARTMENTS_VIEW,
    PERMISSIONS.REQUESTS_VIEW,
    PERMISSIONS.REQUESTS_UPDATE,
    PERMISSIONS.DOCUMENTS_SCAN,
  ],
};

// ── 4. PAGE ACCESS (page name → roles allowed to open it) ─────────────────
export const PAGE_ACCESS = {
  Dashboard: [ROLES.ADMIN, ROLES.REGISTRAR],

  // Admin only
  "Staff Accounts": [ROLES.ADMIN],
  "System Reports": [ROLES.ADMIN],
  "Audit Logs": [ROLES.ADMIN],

  // Registrar Staff only
  Students: [ROLES.REGISTRAR],
  Departments: [ROLES.REGISTRAR],
  Requests: [ROLES.REGISTRAR],
  StudentProfile: [ROLES.REGISTRAR],
};

// ── 5. HELPERS ─────────────────────────────────────────────────────────────

// "admin" / "ADMIN " / "registrar staff" → canonical role, or null if unknown
export const normalizeRole = (role) => {
  const r = String(role ?? "").trim().toLowerCase();
  return Object.values(ROLES).find((x) => x.toLowerCase() === r) || null;
};

export const hasPermission = (role, permission) => {
  const key = normalizeRole(role);
  return !!key && ROLE_PERMISSIONS[key].includes(permission);
};

export const canAccessPage = (role, page) => {
  const key = normalizeRole(role);
  return !!key && !!PAGE_ACCESS[page]?.includes(key);
};

export const getDefaultPage = () => "Dashboard";

// ============================================================================
// API TOKEN HELPERS — lets Laravel know WHO is calling, so it can enforce the
// same roles on the server (frontend checks alone can be bypassed).
// The token is kept in sessionStorage → cleared when the tab is closed.
// ============================================================================
const API_BASE = import.meta.env?.VITE_API_BASE_URL || "http://localhost:8000/api";
const TOKEN_KEY = "regisscan_api_token";

export const setAuthToken = (token) => {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
};

export const getAuthToken = () => {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
};

export const clearAuthToken = () => {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
};

// Use on every request to a protected Laravel endpoint:
//   fetch(url, { headers: authHeaders() })
//   fetch(url, { headers: authHeaders({ "Content-Type": "application/json" }) })
export const authHeaders = (extra = {}) => {
  const token = getAuthToken();
  return {
    Accept: "application/json",
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

// Ask Laravel for a token (called by Login.jsx after the credentials are OK)
export async function requestApiToken(username, password) {
  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.token || null;
  } catch {
    return null;
  }
}

// Tell Laravel to invalidate the token (called on logout)
export async function revokeApiToken() {
  const token = getAuthToken();
  if (!token) return;
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: "POST", headers: authHeaders() });
  } catch { /* ignore */ }
}