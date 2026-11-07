import { useState, useMemo, useEffect } from "react";
import { supabase } from "./supabaseClient";
import "./styles/AuditLogs.css";

const activityTypes = ["Upload", "View", "Update", "Login"];
const ROWS_PER_PAGE = 10;

const badgeClass = (status) => {
  const s = (status || "").toLowerCase();
  if (s === "success") return "al-badge-success";
  if (s === "failed")  return "al-badge-failed";
  return "al-badge-warning";
};

// Shared select shape so the initial load and the realtime "fetch just
// this row" path always map to the same log shape.
const LOG_SELECT = `
  activity_id,
  activity_type,
  activity_description,
  module_name,
  date_time,
  status,
  tbl_staff!inner ( name, username, user_role )
`; // CHANGED (name): added "name"

const mapLogRow = (row) => ({
  id: row.activity_id,
  timestamp: row.date_time,
  name: row.tbl_staff?.name || row.tbl_staff?.username || "Unknown Staff", // CHANGED (name)
  type: row.activity_type,
  description: row.activity_description,
  module: row.module_name,
  status: row.status,
});

export default function AuditLogs() {
  const [logs, setLogs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [filterType,   setFilterType]   = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [currentPage, setCurrentPage]   = useState(1);

  useEffect(() => {
    let isMounted = true;

    async function fetchLogs() {
      setLoading(true);
      const { data, error } = await supabase
        .from("tbl_system_activity")
        .select(LOG_SELECT)
        .neq("tbl_staff.user_role", "Admin") // CHANGED: hide admin activity
        .order("date_time", { ascending: false });

      if (!isMounted) return;

      if (error) {
        setErrorMsg(error.message);
        setLogs([]);
      } else {
        setLogs((data || []).map(mapLogRow));
        setErrorMsg("");
      }
      setLoading(false);
    }

    fetchLogs();
    return () => { isMounted = false; };
  }, []);

  // ============================================================
  // REALTIME: new/updated/deleted activity rows show up here live,
  // as staff perform actions elsewhere in the app, with no manual
  // refresh needed.
  //
  // Audit rows are inserted with just a staff_id, and the table
  // display needs the joined username, so on INSERT/UPDATE this
  // re-fetches that single row (with the tbl_staff join) rather than
  // trusting the raw realtime payload, then merges it into the list.
  //
  // Requires realtime to be enabled for tbl_system_activity in
  // Supabase (Database → Replication), and that RLS (if enabled)
  // allows the current user to SELECT the rows involved.
  // ============================================================

  useEffect(() => {
    const channel = supabase
      .channel("realtime:tbl_system_activity")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tbl_system_activity" },
        async (payload) => {
          if (payload.eventType === "DELETE") {
            setLogs((prev) =>
              prev.filter((l) => l.id !== payload.old.activity_id)
            );
            return;
          }

          const activityId = payload.new.activity_id;

          const { data, error } = await supabase
            .from("tbl_system_activity")
            .select(LOG_SELECT)
            .neq("tbl_staff.user_role", "Admin") // CHANGED: admin rows return nothing, so they are skipped below
            .eq("activity_id", activityId)
            .single();

          if (error || !data) return;

          const mappedRow = mapLogRow(data);

          setLogs((prev) => {
            const exists = prev.some((l) => l.id === mappedRow.id);
            const next = exists
              ? prev.map((l) => (l.id === mappedRow.id ? mappedRow : l))
              : [mappedRow, ...prev];

            return [...next].sort(
              (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
            );
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayCount  = logs.filter(l => (l.timestamp || "").startsWith(todayStr)).length;
  const failedCount = logs.filter(l => (l.status || "").toLowerCase() === "failed").length;

  const filtered = useMemo(() => {
    return logs.filter(l => {
      const matchType   = filterType   ? (l.type   || "").toLowerCase() === filterType.toLowerCase()   : true;
      const matchStatus = filterStatus ? (l.status || "").toLowerCase() === filterStatus.toLowerCase() : true;
      return matchType && matchStatus;
    });
  }, [logs, filterType, filterStatus]);

  // Reset to page 1 whenever the filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [filterType, filterStatus]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE));

  // Keep the page in range if realtime deletes rows from the last page
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const paginated = useMemo(() => {
    const start = (currentPage - 1) * ROWS_PER_PAGE;
    return filtered.slice(start, start + ROWS_PER_PAGE);
  }, [filtered, currentPage]);

  const formatTimestamp = (ts) => {
    if (!ts) return "—";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString("en-PH", {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  };

  return (
    <>
      <div className="mb-6">
        <h2 className="al-page-title">Audit Logs</h2>
        <p className="al-page-sub">System activity tracking</p>
      </div>

      <div className="al-stats-grid">
        <div className="al-stat-card">
          <p className="al-stat-label">Total Activities</p>
          <p className="al-stat-value">{logs.length}</p>
          <div className="al-stat-accent" />
        </div>
        <div className="al-stat-card">
          <p className="al-stat-label">Today's Activities</p>
          <p className="al-stat-value">{todayCount}</p>
          <div className="al-stat-accent" />
        </div>
        <div className="al-stat-card">
          <p className="al-stat-label">Failed Actions</p>
          <p className="al-stat-value">{failedCount}</p>
          <div className="al-stat-accent" />
        </div>
      </div>

      <div className="al-filter-bar">
        <div className="al-search">&#9906;</div>
        <select
          className="al-select"
          value={filterType}
          onChange={e => setFilterType(e.target.value)}
        >
          <option value="">All Types</option>
          {activityTypes.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          className="al-select"
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
        >
          <option value="">All Status</option>
          <option value="Success">Success</option>
          <option value="Failed">Failed</option>
          <option value="Warning">Warning</option>
        </select>
      </div>

      <div className="al-table-wrapper">
        <table className="al-table">
          <thead className="al-thead">
            <tr>
              <th className="al-th-first">Timestamp</th>
              <th className="al-th">Full Name</th>
              <th className="al-th">Activity Type</th>
              <th className="al-th">Description</th>
              <th className="al-th">Module</th>
              <th className="al-th">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="al-empty">Loading audit logs…</td>
              </tr>
            ) : errorMsg ? (
              <tr>
                <td colSpan={6} className="al-empty">Couldn't load logs: {errorMsg}</td>
              </tr>
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={6} className="al-empty">No logs found.</td>
              </tr>
            ) : (
              paginated.map((log, i) => (
                <tr key={log.id ?? i} className={i % 2 === 0 ? "al-row-even" : "al-row-odd"}>
                  <td className="al-td-timestamp">{formatTimestamp(log.timestamp)}</td>
                  <td className="al-td-name">{log.name}</td>
                  <td className="al-td">{log.type}</td>
                  <td className="al-td-desc">{log.description}</td>
                  <td className="al-td-module">{log.module}</td>
                  <td className="al-td-status">
                    <span className={badgeClass(log.status)}>{log.status}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {!loading && !errorMsg && filtered.length > 0 && (
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
    </>
  );
}