import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import "./styles/AdminDashboard.css";
import { useAuth } from "./AuthContext"; // RBAC

const navItems = ["Dashboard", "Staff Accounts", "System Reports", "Audit Logs"];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DONUT_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#3b82f6", "#e6a817", "#a78bfa", "#f87171", "#14b8a6", "#eab308"];

function BarChart({ data, months }) {
  const svgWidth = 580, svgHeight = 220, paddingLeft = 40, paddingRight = 16, paddingTop = 16, paddingBottom = 36;
  const chartWidth = svgWidth - paddingLeft - paddingRight;
  const chartHeight = svgHeight - paddingTop - paddingBottom;
  const maxRaw = Math.max(...data.map(d => Math.max(d.uploads, d.archived)), 0);
  const maxVal = maxRaw > 0 ? maxRaw * 1.15 : 10;
  const barGroupWidth = chartWidth / data.length;
  const barWidth = barGroupWidth * 0.28;
  const yTicks = [0, Math.round(maxVal * 0.25), Math.round(maxVal * 0.5), Math.round(maxVal * 0.75), Math.round(maxVal)];

  return (
    <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="admin-bar-chart-svg-wrapper" preserveAspectRatio="xMidYMid meet">
      {yTicks.map((tick, idx) => {
        const y = paddingTop + chartHeight - (tick / maxVal) * chartHeight;
        return (
          <g key={idx}>
            <line x1={paddingLeft} y1={y} x2={svgWidth - paddingRight} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <text x={paddingLeft - 8} y={y + 4} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.25)">{tick}</text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const groupX = paddingLeft + i * barGroupWidth;
        const centerX = groupX + barGroupWidth / 2;
        const uploadH = (d.uploads / maxVal) * chartHeight;
        const archivedH = (d.archived / maxVal) * chartHeight;
        const uploadX = centerX - barWidth - 2;
        const archivedX = centerX + 2;
        return (
          <g key={i}>
            <rect x={uploadX} y={paddingTop + chartHeight - uploadH} width={barWidth} height={uploadH} fill="#e6a817" opacity="0.85" rx="2" />
            <rect x={archivedX} y={paddingTop + chartHeight - archivedH} width={barWidth} height={archivedH} fill="#3b82f6" opacity="0.65" rx="2" />
            <text x={centerX} y={svgHeight - 8} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.3)">{months[i]}</text>
          </g>
        );
      })}
      <line x1={paddingLeft} y1={paddingTop + chartHeight} x2={svgWidth - paddingRight} y2={paddingTop + chartHeight} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
    </svg>
  );
}

function DonutChart({ data, total }) {
  const size = 160, cx = size / 2, cy = size / 2, r = 58, innerR = 38;
  let cumulativePercent = 0;
  const slices = data.map((item) => {
    const percent = item.value / total;
    const startAngle = cumulativePercent * 2 * Math.PI - Math.PI / 2;
    const endAngle = (cumulativePercent + percent) * 2 * Math.PI - Math.PI / 2;
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + innerR * Math.cos(startAngle), iy1 = cy + innerR * Math.sin(startAngle);
    const ix2 = cx + innerR * Math.cos(endAngle), iy2 = cy + innerR * Math.sin(endAngle);
    const largeArc = percent > 0.5 ? 1 : 0;
    const d = [`M ${x1} ${y1}`, `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`, `L ${ix2} ${iy2}`, `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix1} ${iy1}`, "Z"].join(" ");
    cumulativePercent += percent;
    return { d, color: item.color };
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices.map((slice, i) => <path key={i} d={slice.d} fill={slice.color} opacity={0.85} />)}
    </svg>
  );
}

export default function AdminDashboard({ staffName = "Admin", onLogout, activePage, setActivePage, children }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const { canAccess } = useAuth(); // RBAC
  const visibleNavItems = navItems.filter((item) => canAccess(item)); // RBAC: only menu items this role may open
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [stats, setStats] = useState({
    staffCount: 0, studentCount: 0, activeStudentCount: 0,
    completedRequests: 0, totalRequestDocs: 0,
  });
  const [barData, setBarData] = useState(months.map(() => ({ uploads: 0, archived: 0 })));
  const [credentialDist, setCredentialDist] = useState([]);
  const [activities, setActivities] = useState([]);

  const today = new Date().toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" });

  useEffect(() => {
    let isMounted = true;

    async function loadDashboard() {
      setLoading(true);
      setErrorMsg("");
      try {
        const [staffRes, studentRes, activeStudentRes, completedReqRes, totalReqDocsRes, studentDocsRes, activitiesRes] = await Promise.all([
          supabase.from("tbl_staff").select("*", { count: "exact", head: true }).neq("user_role", "Admin"),
          supabase.from("tbl_student").select("*", { count: "exact", head: true }),
          supabase.from("tbl_student").select("*", { count: "exact", head: true }).ilike("status", "Active"),
          supabase.from("tbl_request_document").select("*", { count: "exact", head: true }).ilike("status", "Completed"),
          supabase.from("tbl_request_document").select("*", { count: "exact", head: true }),
          supabase.from("tbl_student_documents").select("document_name, date_uploaded, status"),
          supabase.from("tbl_system_activity").select(`activity_id, activity_type, activity_description, module_name, date_time, status, tbl_staff!inner ( name, username, user_role )`) // CHANGED (name)
            .neq("tbl_staff.user_role", "Admin")
            .order("date_time", { ascending: false }).limit(6),
        ]);

        if (!isMounted) return;
        const firstError = [staffRes, studentRes, activeStudentRes, completedReqRes, totalReqDocsRes, studentDocsRes, activitiesRes].find(r => r.error);
        if (firstError) throw firstError.error;

        const docs = studentDocsRes.data || [];

        const currentYear = new Date().getFullYear();
        const monthly = months.map(() => ({ uploads: 0, archived: 0 }));
        docs.forEach((d) => {
          if (!d.date_uploaded) return;
          const dt = new Date(d.date_uploaded);
          if (dt.getFullYear() !== currentYear) return;
          const m = dt.getMonth();
          monthly[m].uploads += 1;
          if ((d.status || "").toLowerCase() === "archived") monthly[m].archived += 1;
        });

        const counts = {};
        docs.forEach((d) => {
          const name = d.document_name || "Unspecified";
          counts[name] = (counts[name] || 0) + 1;
        });
        const distArray = Object.entries(counts)
          .map(([label, value], i) => ({ label, value, color: DONUT_COLORS[i % DONUT_COLORS.length] }))
          .sort((a, b) => b.value - a.value);

        const mappedActivities = (activitiesRes.data || []).map((a) => ({
          staff: a.tbl_staff?.name || a.tbl_staff?.username || "Unknown Staff", // CHANGED (name)
          action: a.activity_description,
          student: a.module_name,
          date: a.date_time ? new Date(a.date_time).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" }) : "—",
          time: a.date_time ? new Date(a.date_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "",
        }));

        setStats({
          staffCount: staffRes.count ?? 0,
          studentCount: studentRes.count ?? 0,
          activeStudentCount: activeStudentRes.count ?? 0,
          completedRequests: completedReqRes.count ?? 0,
          totalRequestDocs: totalReqDocsRes.count ?? 0,
        });
        setBarData(monthly);
        setCredentialDist(distArray);
        setActivities(mappedActivities);
      } catch (err) {
        if (isMounted) setErrorMsg(err.message || "Failed to load dashboard data");
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadDashboard();
    return () => { isMounted = false; };
  }, []);

  // ADDED: live updates for Recent Activities (same idea as Audit Logs).
  // Any new, changed or deleted row in tbl_system_activity re-fetches the
  // latest 6 staff activities (admin activity stays hidden).
  useEffect(() => {
    const fetchLatestActivities = async () => {
      const { data, error } = await supabase
        .from("tbl_system_activity")
        .select(`activity_id, activity_type, activity_description, module_name, date_time, status, tbl_staff!inner ( name, username, user_role )`) // CHANGED (name)
        .neq("tbl_staff.user_role", "Admin")
        .order("date_time", { ascending: false })
        .limit(6);

      if (error || !data) return;

      setActivities(data.map((a) => ({
        staff: a.tbl_staff?.name || a.tbl_staff?.username || "Unknown Staff", // CHANGED (name)
        action: a.activity_description,
        student: a.module_name,
        date: a.date_time ? new Date(a.date_time).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" }) : "—",
        time: a.date_time ? new Date(a.date_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "",
      })));
    };

    const channel = supabase
      .channel("realtime:admin-dashboard-activities")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tbl_system_activity" },
        fetchLatestActivities
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const totalCreds = credentialDist.reduce((s, c) => s + c.value, 0);
  const resolutionRate = stats.totalRequestDocs > 0 ? Math.round((stats.completedRequests / stats.totalRequestDocs) * 1000) / 10 : 0;

  const statCards = [
    { label: "Total Registrar Staff", value: stats.staffCount.toLocaleString(), sub: `${stats.staffCount} staff account${stats.staffCount === 1 ? "" : "s"}` },
    { label: "Total Student Records", value: stats.studentCount.toLocaleString(), sub: `${stats.activeStudentCount} active` },
    { label: "Completed Requests", value: stats.completedRequests.toLocaleString(), sub: stats.totalRequestDocs > 0 ? `${resolutionRate}% resolution rate` : "No requests yet" },
  ];

  return (
    <div className="admin-layout">
      <aside className="admin-sidebar" style={{ width: sidebarOpen ? "240px" : "0px" }}>
        <div className="admin-sidebar-brand">
          <h1 className="admin-sidebar-brand-title">RegisScan</h1>
          <p className="admin-sidebar-brand-sub">Registrar System</p>
        </div>
        <p className="admin-sidebar-section-label">Admin Panel</p>
        <nav className="admin-sidebar-nav">
          {visibleNavItems.map(item => (
            <button key={item} onClick={() => setActivePage(item)} className={activePage === item ? "admin-sidebar-nav-item-active" : "admin-sidebar-nav-item"}>
              {item}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <p className="admin-sidebar-footer-text">USTP · Admin</p>
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <div className="admin-topbar-left">
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="admin-topbar-toggle">
              <span className="admin-topbar-hamburger-line" />
              <span className="admin-topbar-hamburger-line" />
              <span className="admin-topbar-hamburger-line" />
            </button>
            <span className="admin-topbar-date">{today}</span>
          </div>
          <div className="admin-topbar-right">
            <div className="relative">
              <button onClick={() => setDropdownOpen(!dropdownOpen)} className="admin-topbar-staff-btn">
                <div className="admin-topbar-avatar">{staffName.split(" ").map(n => n[0]).join("").slice(0, 2)}</div>
                <span className="admin-topbar-staff-name">{staffName}</span>
              </button>
              {dropdownOpen && (
                <div className="admin-topbar-dropdown" style={{ top: "48px" }}>
                  <button className="admin-topbar-dropdown-logout" onClick={() => { setDropdownOpen(false); onLogout && onLogout(); }}>
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="admin-content">
          {activePage === "Dashboard" && (
            <>
              <div>
                <h2 className="admin-page-title">Admin Dashboard</h2>
                <p className="admin-page-sub">System overview and analytics</p>
              </div>

              {errorMsg && <p style={{ color: "#f87171", marginBottom: "1rem" }}>Couldn't load dashboard data: {errorMsg}</p>}

              <div className="admin-stats-grid">
                {statCards.map((s, i) => (
                  <div key={i} className="admin-stat-card">
                    <p className="admin-stat-label">{s.label}</p>
                    <p className="admin-stat-value">{loading ? "—" : s.value}</p>
                    <p className="admin-stat-sub">{loading ? "" : s.sub}</p>
                    <div className="admin-stat-accent" />
                  </div>
                ))}
              </div>

              <div className="admin-charts-row">
                <div className="admin-chart-card">
                  <h3 className="admin-chart-title">Monthly Document Activity</h3>
                  <BarChart data={barData} months={months} />
                  <div className="admin-bar-legend">
                    <span className="admin-bar-legend-item"><span className="admin-legend-dot-gold" /> Uploads</span>
                    <span className="admin-bar-legend-item"><span className="admin-legend-dot-blue" /> Archived</span>
                  </div>
                </div>

                <div className="admin-chart-card">
                  <h3 className="admin-chart-title">Credential Distribution</h3>
                  {totalCreds === 0 ? (
                    <p style={{ opacity: 0.5, fontSize: "0.875rem", padding: "1.5rem 0" }}>{loading ? "Loading…" : "No documents uploaded yet."}</p>
                  ) : (
                    <>
                      <div className="admin-donut-wrapper"><DonutChart data={credentialDist} total={totalCreds} /></div>
                      <div className="admin-donut-legend">
                        {credentialDist.map((item, i) => (
                          <div key={i} className="admin-donut-legend-row">
                            <span className="admin-donut-legend-label">
                              <span className="admin-donut-legend-dot" style={{ backgroundColor: item.color }} />
                              {item.label}
                            </span>
                            <span className="admin-donut-legend-value">{item.value}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="admin-activity-card">
                <h3 className="admin-activity-title">Recent Activities</h3>
                <div className="admin-activity-table-wrapper">
                  <table className="admin-activity-table">
                    <thead>
                      <tr>
                        <th className="admin-activity-th">Staff Name</th>
                        <th className="admin-activity-th">Activity</th>
                        <th className="admin-activity-th admin-activity-th-right">Date & Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading ? (
                        <tr><td colSpan={3} className="admin-activity-td">Loading…</td></tr>
                      ) : activities.length === 0 ? (
                        <tr><td colSpan={3} className="admin-activity-td">No recent activity yet.</td></tr>
                      ) : (
                        activities.map((a, i) => (
                          <tr key={i} className="admin-activity-tr">
                            <td className="admin-activity-td">
                              <div className="admin-activity-staff-cell">
                                <div className="admin-activity-staff-avatar">{a.staff.split(" ").map(n => n[0]).join("").slice(0, 2)}</div>
                                <span className="admin-activity-staff-name">{a.staff}</span>
                              </div>
                            </td>
                            <td className="admin-activity-td">
                              <div className="admin-activity-action-cell">
                                <div className="admin-activity-dot-sm"><div className="admin-activity-dot-inner" /></div>
                                <div>
                                  <p className="admin-activity-action">{a.action}</p>
                                  <p className="admin-activity-student">{a.student}</p>
                                </div>
                              </div>
                            </td>
                            <td className="admin-activity-td admin-activity-td-right">
                              <p className="admin-activity-date">{a.date}</p>
                              <p className="admin-activity-time">{a.time}</p>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {activePage !== "Dashboard" && (
            children ? children : (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <h2 className="admin-empty-title">{activePage}</h2>
                <p className="admin-empty-sub">This page is under construction.</p>
                <div className="admin-empty-accent" />
              </div>
            )
          )}
        </main>
      </div>
    </div>
  );
}