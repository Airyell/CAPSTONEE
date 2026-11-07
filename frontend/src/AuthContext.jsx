// ============================================================================
// RBAC — React side
//   <AuthProvider>   wraps the logged-in app and shares the current role
//   useAuth()        → { role, can(permission), canAccess(page), ... }
//   <Can>            show children only if the role has the permission
//   <ProtectedPage>  show a page only if the role may open it
// ============================================================================
import { createContext, useContext, useMemo } from "react";
import { hasPermission, canAccessPage } from "./rbac";

const AuthContext = createContext({
  role: null,
  staffId: null,
  staffName: "",
  can: () => false,
  canAccess: () => false,
});

export function AuthProvider({ role, staffId, staffName, children }) {
  const value = useMemo(
    () => ({
      role,
      staffId,
      staffName,
      can: (permission) => hasPermission(role, permission),
      canAccess: (page) => canAccessPage(role, page),
    }),
    [role, staffId, staffName]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);

// <Can permission={PERMISSIONS.STUDENTS_CREATE}> <button/> </Can>
export function Can({ permission, fallback = null, children }) {
  const { can } = useAuth();
  return can(permission) ? children : fallback;
}

export function AccessDenied({ page }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "4rem 1rem",
      }}
    >
      <h2 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.5rem" }}>
        Access Denied
      </h2>
      <p style={{ opacity: 0.7, fontSize: "0.95rem" }}>
        Your account does not have permission to open {page ? `"${page}"` : "this page"}.
      </p>
    </div>
  );
}

// <ProtectedPage page="Staff Accounts"> <StaffAccounts /> </ProtectedPage>
export function ProtectedPage({ page, children }) {
  const { canAccess } = useAuth();
  if (!canAccess(page)) return <AccessDenied page={page} />;
  return children;
}