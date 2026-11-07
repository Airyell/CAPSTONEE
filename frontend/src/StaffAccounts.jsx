import { useState, useEffect, useCallback, useMemo } from "react";
import "./styles/StaffAccounts.css";
import { authHeaders } from "./rbac"; // RBAC

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "http://localhost:8000/api";

const EMPTY_FORM = { idNumber: "", fullName: "", email: "", password: "" }; // CHANGED (id): added idNumber
const ROWS_PER_PAGE = 10;

function getInitials(name) {
  return name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

export default function StaffAccounts() {
  const [staff, setStaff]               = useState([]);
  const [meta, setMeta]                 = useState({ total: 0, active: 0, inactive: 0 });
  const [loading, setLoading]           = useState(true);
  const [loadError, setLoadError]       = useState(null);
  const [search, setSearch]             = useState("");
  const [modalOpen, setModalOpen]       = useState(false);
  const [editTarget, setEditTarget]     = useState(null);
  const [form, setForm]                 = useState(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [saving, setSaving]             = useState(false);
  const [formError, setFormError]       = useState(null);
  const [currentPage, setCurrentPage]   = useState(1);

  // ── Load staff (Admin excluded by backend) ───────────────────────────
  const loadStaff = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`${API_BASE}/staff`, { headers: authHeaders() }); // RBAC
      if (res.status === 401 || res.status === 403) throw new Error("Not authorized. Please log out and log in again."); // RBAC
      if (!res.ok) throw new Error("Couldn't load staff from the server.");
      const json = await res.json();
      setStaff(json.data);
      setMeta(json.meta);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStaff(); }, [loadStaff]);

  const filtered = staff.filter(s =>
    s.fullName.toLowerCase().includes(search.toLowerCase()) ||
    s.id.toLowerCase().includes(search.toLowerCase()) ||
    (s.email || "").toLowerCase().includes(search.toLowerCase())
  );

  // Reset to page 1 whenever the search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE));
  const paginated = useMemo(() => {
    const start = (currentPage - 1) * ROWS_PER_PAGE;
    return filtered.slice(start, start + ROWS_PER_PAGE);
  }, [filtered, currentPage]);

  // ── Modal helpers ────────────────────────────────────────────────────
  function openAdd() {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(s) {
    setEditTarget(s);
    setForm({ idNumber: s.username || "", fullName: s.fullName, email: s.email || "", password: "" }); // CHANGED (id): fills in the current ID number
    setFormError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  // ── Save ─────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!form.idNumber.trim()) { setFormError("ID number is required."); return; } // CHANGED (id): now required when editing too
    if (!form.fullName.trim()) { setFormError("Full name is required."); return; }
    if (!form.email.trim())    { setFormError("Email is required."); return; }
    if (!editTarget && !form.password.trim()) { setFormError("Password is required for new staff."); return; }

    setSaving(true);
    setFormError(null);
    try {
      const url    = editTarget ? `${API_BASE}/staff/${editTarget.id}` : `${API_BASE}/staff`;
      const method = editTarget ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: authHeaders({ "Content-Type": "application/json", Accept: "application/json" }), // RBAC
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        const firstError = errJson?.errors
          ? Object.values(errJson.errors)[0]?.[0]
          : errJson?.message;
        throw new Error(firstError || "Couldn't save staff.");
      }

      await loadStaff();
      closeModal();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────
  async function confirmDelete() {
    try {
      const res = await fetch(`${API_BASE}/staff/${deleteTarget.id}`, { method: "DELETE", headers: authHeaders() }); // RBAC
      if (!res.ok) throw new Error("Couldn't delete staff.");
      await loadStaff();
      setDeleteTarget(null);
    } catch (err) {
      setLoadError(err.message);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="sa-wrapper">

      {/* Header */}
      <div className="sa-header">
        <div>
          <h2 className="sa-page-title">Staff Accounts</h2>
          <p className="sa-page-sub">Manage registrar staff access and roles</p>
        </div>
        <button className="sa-add-btn" onClick={openAdd}>+ Add Staff</button>
      </div>

      {loadError && (
        <div style={{ background: "#fee2e2", color: "#b91c1c", padding: "10px 14px", borderRadius: 8, marginBottom: 16, fontSize: 14 }}>
          {loadError}
        </div>
      )}

      {/* Stat Cards */}
      <div className="sa-stats-row">
        <div className="sa-stat-card">
          <div className="sa-stat-inner">
            <div>
              <p className="sa-stat-label">Total Staff</p>
              <p className="sa-stat-value">{meta.total}</p>
            </div>
            <div className="sa-stat-icon sa-stat-icon-gold">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </div>
          </div>
          <div className="sa-stat-accent" />
        </div>

        <div className="sa-stat-card">
          <div className="sa-stat-inner">
            <div>
              <p className="sa-stat-label">Active Staff</p>
              <p className="sa-stat-value">{meta.active}</p>
            </div>
            <div className="sa-stat-icon sa-stat-icon-green">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
            </div>
          </div>
          <div className="sa-stat-accent sa-stat-accent-green" />
        </div>

        <div className="sa-stat-card">
          <div className="sa-stat-inner">
            <div>
              <p className="sa-stat-label">Inactive Staff</p>
              <p className="sa-stat-value">{meta.inactive}</p>
            </div>
            <div className="sa-stat-icon sa-stat-icon-red">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
          </div>
          <div className="sa-stat-accent sa-stat-accent-red" />
        </div>
      </div>

      {/* Table */}
      <div className="sa-table-card">
        <div className="sa-search-row">
          <div className="sa-search-box">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              placeholder="Search by name, email, or ID…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="sa-search-input"
            />
            {search && <button className="sa-search-clear" onClick={() => setSearch("")}>✕</button>}
          </div>
          <p className="sa-result-count">{filtered.length} of {staff.length} staff</p>
        </div>

        <div className="sa-table-wrapper">
          <table className="sa-table">
            <thead>
              <tr>
                <th className="sa-th">Staff ID</th>
                <th className="sa-th">Full Name</th>
                <th className="sa-th">Role</th>
                <th className="sa-th">Status</th>
                <th className="sa-th">Last Login</th>
                <th className="sa-th sa-th-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="sa-empty-row">Loading staff…</td></tr>
              ) : paginated.length === 0 ? (
                <tr><td colSpan={6} className="sa-empty-row">No staff found matching your search.</td></tr>
              ) : (
                paginated.map(s => (
                  <tr key={s.id} className="sa-tr">
                    <td className="sa-td sa-td-id">{s.id}</td>
                    <td className="sa-td">
                      <div className="sa-name-cell">
                        <div className="sa-avatar">{getInitials(s.fullName)}</div>
                        <div>
                          <p className="sa-fullname">{s.fullName}</p>
                          <p className="sa-username-text">{s.email || "—"}</p>
                        </div>
                      </div>
                    </td>
                    <td className="sa-td sa-td-role">{s.role}</td>
                    <td className="sa-td">
                      <span className={s.status === "Active" ? "sa-badge-active" : "sa-badge-inactive"}>
                        {s.status}
                      </span>
                    </td>
                    <td className="sa-td sa-td-muted">{s.lastLogin || "—"}</td>
                    <td className="sa-td sa-td-actions">
                      <button className="sa-action-edit" onClick={() => openEdit(s)} title="Edit">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                      </button>
                      <button className="sa-action-delete" onClick={() => setDeleteTarget(s)} title="Delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/>
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                          <path d="M10 11v6"/><path d="M14 11v6"/>
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && filtered.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "16px", padding: "0 4px" }}>
            <span style={{ fontSize: "0.85rem", color: "rgba(255,255,255,0.5)" }}>
              Showing <strong style={{ color: "#fff" }}>{(currentPage - 1) * ROWS_PER_PAGE + 1}</strong>
              {" "}–{" "}
              <strong style={{ color: "#fff" }}>{Math.min(currentPage * ROWS_PER_PAGE, filtered.length)}</strong>
              {" "}of{" "}
              <strong style={{ color: "#fff" }}>{filtered.length}</strong>
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                style={{
                  border: "none",
                  background: "transparent",
                  fontSize: "0.85rem",
                  fontWeight: 500,
                  color: currentPage === 1 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.6)",
                  cursor: currentPage === 1 ? "not-allowed" : "pointer",
                  padding: "6px 10px",
                }}
              >
                Prev
              </button>

              <span
                style={{
                  border: "none",
                  borderRadius: "8px",
                  minWidth: "32px",
                  height: "32px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  background: "#e6a817",
                  color: "#1a1a5e",
                }}
              >
                {currentPage}
              </span>

              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                style={{
                  border: "none",
                  background: "transparent",
                  fontSize: "0.85rem",
                  fontWeight: 500,
                  color: currentPage === totalPages ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.6)",
                  cursor: currentPage === totalPages ? "not-allowed" : "pointer",
                  padding: "6px 10px",
                }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ADD / EDIT MODAL */}
      {modalOpen && (
        <div className="sa-modal-overlay" onClick={closeModal}>
          <div className="sa-modal" onClick={e => e.stopPropagation()}>
            <div className="sa-modal-header">
              <h3 className="sa-modal-title">{editTarget ? "Edit Staff" : "Add New Staff"}</h3>
              <button className="sa-modal-close" onClick={closeModal}>✕</button>
            </div>
            <div className="sa-modal-body">
              {formError && (
                <p style={{ color: "#b91c1c", fontSize: 13, marginBottom: 12 }}>{formError}</p>
              )}
              {/* CHANGED (id): ID number now shows when adding and editing (saved in the username column, used to log in) */}
              <div className="sa-form-group">
                <label className="sa-label">ID Number</label>
                <input
                  className="sa-input" type="text" placeholder="e.g. 01-20-2023"
                  value={form.idNumber}
                  onChange={e => setForm(f => ({ ...f, idNumber: e.target.value }))}
                />
              </div>
              <div className="sa-form-group">
                <label className="sa-label">Full Name</label>
                <input
                  className="sa-input" type="text" placeholder="e.g. Juan Dela Cruz"
                  value={form.fullName}
                  onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))}
                />
              </div>
              <div className="sa-form-group">
                <label className="sa-label">Email</label>
                <input
                  className="sa-input" type="email" placeholder="e.g. juan.delacruz@ustp.edu.ph"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                />
              </div>
              <div className="sa-form-group">
                <label className="sa-label">{editTarget ? "New Password" : "Password"}</label>
                <input
                  className="sa-input" type="password"
                  placeholder={editTarget ? "Leave blank to keep current" : "Set a password (max 24 chars)"}
                  maxLength={24}
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                />
              </div>
              <div className="sa-form-group">
                <label className="sa-label">Role</label>
                <div className="sa-input-readonly">Registrar Staff</div>
              </div>
              <div className="sa-form-group">
                <label className="sa-label">Status</label>
                {/* Status is read-only — system controls it based on login/logout */}
                <div className="sa-input-readonly" style={{ color: editTarget?.status === "Active" ? "#16a34a" : "#dc2626" }}>
                  {editTarget ? editTarget.status : "Inactive (until first login)"}
                </div>
              </div>
            </div>
            <div className="sa-modal-footer">
              <button className="sa-btn-cancel" onClick={closeModal}>Cancel</button>
              <button className="sa-btn-save" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : editTarget ? "Save Changes" : "Add Staff"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE MODAL */}
      {deleteTarget && (
        <div className="sa-modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="sa-modal sa-modal-sm" onClick={e => e.stopPropagation()}>
            <div className="sa-modal-header">
              <h3 className="sa-modal-title">Delete Staff</h3>
              <button className="sa-modal-close" onClick={() => setDeleteTarget(null)}>✕</button>
            </div>
            <div className="sa-modal-body">
              <p className="sa-delete-msg">
                Are you sure you want to delete <strong className="sa-delete-name">{deleteTarget.fullName}</strong>? This action cannot be undone.
              </p>
            </div>
            <div className="sa-modal-footer">
              <button className="sa-btn-cancel" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="sa-btn-delete" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}