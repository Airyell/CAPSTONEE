import { useState, useEffect } from "react";
import "./styles/SystemReports.css";
import { authHeaders } from "./rbac"; // RBAC

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "http://localhost:8000/api";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── TREND BAR CHART ──────────────────────────────────────────────────
function TrendChart({ data }) {
  const svgWidth = 680, svgHeight = 200;
  const paddingLeft = 44, paddingRight = 16, paddingTop = 12, paddingBottom = 36;
  const chartWidth  = svgWidth  - paddingLeft - paddingRight;
  const chartHeight = svgHeight - paddingTop  - paddingBottom;
  const maxVal = Math.max(...data.map(d => Math.max(d.uploads, d.requests)), 1) * 1.2;
  const barGroupWidth = chartWidth / data.length;
  const barWidth = barGroupWidth * 0.28;
  const yTicks = [0, 60, 90, 120];

  return (
    <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="sr-bar-chart-svg" preserveAspectRatio="xMidYMid meet">
      {yTicks.map(tick => {
        const y = paddingTop + chartHeight - (tick / maxVal) * chartHeight;
        return (
          <g key={tick}>
            <line x1={paddingLeft} y1={y} x2={svgWidth - paddingRight} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
            <text x={paddingLeft - 8} y={y + 4} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.22)">{tick}</text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const centerX  = paddingLeft + i * barGroupWidth + barGroupWidth / 2;
        const uploadH  = (d.uploads  / maxVal) * chartHeight;
        const requestH = (d.requests / maxVal) * chartHeight;
        return (
          <g key={i}>
            <rect x={centerX - barWidth - 2} y={paddingTop + chartHeight - uploadH}  width={barWidth} height={uploadH}  fill="#e6a817" opacity="0.88" rx="2" />
            <rect x={centerX + 2}            y={paddingTop + chartHeight - requestH} width={barWidth} height={requestH} fill="#3b82f6" opacity="0.7"  rx="2" />
            <text x={centerX} y={svgHeight - 8} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.28)">{months[i]}</text>
          </g>
        );
      })}
      <line x1={paddingLeft} y1={paddingTop + chartHeight} x2={svgWidth - paddingRight} y2={paddingTop + chartHeight} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
    </svg>
  );
}

// ── MOST REQUESTED CREDENTIALS CHART ─────────────────────────────────
function RequestedChart({ data, maxVal }) {
  const svgWidth = 420, svgHeight = 240;
  const paddingLeft = 12, paddingRight = 44, paddingTop = 12, paddingBottom = 36;
  const chartWidth  = svgWidth  - paddingLeft - paddingRight;
  const chartHeight = svgHeight - paddingTop  - paddingBottom;
  const barGroupHeight = chartHeight / Math.max(data.length, 1);
  const barH = barGroupHeight * 0.48;
  const xTicks = [0, 75, 150, 225, 300];

  return (
    <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="sr-req-chart-svg" preserveAspectRatio="xMidYMid meet">
      {xTicks.map(tick => {
        const x = paddingLeft + (tick / maxVal) * chartWidth;
        return (
          <g key={tick}>
            <line x1={x} y1={paddingTop} x2={x} y2={paddingTop + chartHeight} stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
            <text x={x} y={svgHeight - 6} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.22)">{tick}</text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const centerY  = paddingTop + i * barGroupHeight + barGroupHeight / 2;
        const barWidth = (d.value / maxVal) * chartWidth;
        return (
          <g key={i}>
            <rect x={paddingLeft} y={centerY - barH / 2} width={barWidth} height={barH} fill="#22c55e" opacity="0.8" rx="3" />
            <text x={paddingLeft + barWidth + 6} y={centerY + 4} fontSize="10" fill="rgba(255,255,255,0.7)" fontWeight="bold">{d.value}</text>
          </g>
        );
      })}
      <line x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={paddingTop + chartHeight} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
    </svg>
  );
}

// ── COLORS FOR STORED CREDENTIALS BARS ───────────────────────────────
const BAR_COLORS = ["#e6a817","#e6a817","#3b82f6","#a78bfa","#22c55e","#ec4899","#6366f1","#f87171"];

// CHANGED: shortens long labels and ends them with "..."
const truncateLabel = (text, maxLength = 18) =>
  text && text.length > maxLength ? text.slice(0, maxLength).trimEnd() + "..." : text;

// ── MAIN COMPONENT ────────────────────────────────────────────────────
export default function SystemReports() {
  const [year, setYear]                       = useState(new Date().getFullYear());
  const [stats, setStats]                     = useState([]);
  const [monthlyTrends, setMonthlyTrends]     = useState(Array(12).fill({ uploads: 0, requests: 0 }));
  const [storedCreds, setStoredCreds]         = useState([]);
  const [requestedCreds, setRequestedCreds]   = useState([]);
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState(null);

  // ADDED: Archived Logs states
  const [showLogs, setShowLogs]               = useState(false);
  const [logs, setLogs]                       = useState([]);
  const [logsLoading, setLogsLoading]         = useState(false);
  const [logsError, setLogsError]             = useState(null);
  const [logMonth, setLogMonth]               = useState("all"); // "all" or 0-11

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/reports?year=${year}`, { headers: authHeaders() }) // RBAC
      .then(res => {
        if (res.status === 401 || res.status === 403) throw new Error("Not authorized. Please log out and log in again."); // RBAC
        if (!res.ok) throw new Error("Couldn't load report data.");
        return res.json();
      })
      .then(json => {
        setStats(json.stats);
        setMonthlyTrends(json.monthlyTrends);
        setStoredCreds(json.mostStoredCredentials);
        setRequestedCreds(json.mostRequestedCredentials);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [year]);

  // CHANGED: load archived logs on page load (and when the year changes), not only when the card is opened
  useEffect(() => {
    setLogsLoading(true);
    setLogsError(null);
    fetch(`${API_BASE}/reports/archived-logs?year=${year}`, { headers: authHeaders() }) // RBAC
      .then(res => {
        if (res.status === 401 || res.status === 403) throw new Error("Not authorized. Please log out and log in again.");
        if (!res.ok) throw new Error("Couldn't load archived logs.");
        return res.json();
      })
      .then(json => setLogs(Array.isArray(json) ? json : (json.logs || [])))
      .catch(err => setLogsError(err.message))
      .finally(() => setLogsLoading(false));
  }, [year]);

  // ADDED: filter logs by selected month
  const getLogDate = (l) => new Date(l.date || l.created_at || l.timestamp);
  const filteredLogs = logs.filter(l =>
    logMonth === "all" || getLogDate(l).getMonth() === Number(logMonth)
  );

  const maxStored    = Math.max(...storedCreds.map(c => c.value), 1);
  const maxRequested = Math.max(...requestedCreds.map(c => c.value), 1) * 1.15;

  // Year selector — current year and 4 years back
  const currentYear = new Date().getFullYear();
  const START_YEAR = 2022; // earliest year to show
  const yearOptions = Array.from({ length: currentYear - START_YEAR + 1 }, (_, i) => currentYear - i);

  return (
    <>
      {/* Header */}
      <div className="mb-6">
        <h2 className="sr-page-title">System Reports</h2>
        <p className="sr-page-sub">Analytics and document activity overview</p>
      </div>

      {error && (
        <div style={{ background: "#fee2e2", color: "#b91c1c", padding: "10px 14px", borderRadius: 8, marginBottom: 16, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* Stat Cards */}
      <div className="sr-stats-grid sr-stats-grid-4"> {/* CHANGED: added sr-stats-grid-4 */}
        {loading
          ? Array(3).fill(null).map((_, i) => ( // CHANGED: 4 -> 3 placeholders
              <div key={i} className="sr-stat-card" style={{ opacity: 0.4 }}>
                <p className="sr-stat-label">Loading…</p>
                <p className="sr-stat-value">—</p>
                <p className="sr-stat-sub">—</p>
                <div className="sr-stat-accent" />
              </div>
            ))
          : stats.filter(s => !/archiv/i.test(s.label)).map((s, i) => ( // CHANGED: hides the archived card
              <div key={i} className="sr-stat-card">
                <p className="sr-stat-label">{s.label}</p>
                <p className="sr-stat-value">{s.value}</p>
                <p className="sr-stat-sub">{s.sub}</p>
                <div className="sr-stat-accent" />
              </div>
            ))
        }

        {/* ADDED: Archived Logs card (clickable) */}
        <div
          className="sr-stat-card sr-archived-card"
          role="button"
          tabIndex={0}
          onClick={() => setShowLogs(prev => !prev)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setShowLogs(prev => !prev); }}
        >
          <p className="sr-stat-label">Archived Logs</p>
          <p className="sr-stat-value">{!logsLoading && !logsError ? logs.length : "—"}</p> {/* CHANGED: shows count without needing a click */}
          <p className="sr-stat-sub">{showLogs ? "Click to hide logs" : "Click to view logs by month"}</p>
          <div className="sr-stat-accent" />
        </div>
      </div>

      {/* ADDED: Archived Logs panel with month filter */}
      {showLogs && (
        <div className="sr-card">
          <div className="sr-card-header">
            <h3 className="sr-card-title">Archived Logs</h3>
            <div className="sr-date-row">
              <label className="sr-date-label">Month:</label>
              <select
                className="sr-date-input"
                value={logMonth}
                onChange={e => setLogMonth(e.target.value)}
              >
                <option value="all">All Months</option>
                {months.map((m, i) => <option key={m} value={i}>{m}</option>)}
              </select>
            </div>
          </div>

          {logsLoading ? (
            <p className="sr-logs-msg">Loading…</p>
          ) : logsError ? (
            <p className="sr-logs-msg sr-logs-msg-error">{logsError}</p>
          ) : filteredLogs.length === 0 ? (
            <p className="sr-logs-msg">No archived logs for this month.</p>
          ) : (
            <div className="sr-logs-list">
              {filteredLogs.map((l, i) => {
                const d = getLogDate(l);
                return (
                  <div key={l.id ?? i} className="sr-log-row">
                    <span>{l.message || l.action || l.description || "—"}{l.user ? ` — ${l.user}` : ""}</span>
                    <span className="sr-log-date">
                      {isNaN(d) ? "—" : `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Monthly Upload Trends */}
      <div className="sr-card">
        <div className="sr-card-header">
          <h3 className="sr-card-title">Monthly Upload Trends</h3>
          <div className="sr-date-row">
            <label className="sr-date-label">Year:</label>
            <select
              className="sr-date-input"
              value={year}
              onChange={e => setYear(Number(e.target.value))}
            >
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <TrendChart data={monthlyTrends} />
        <div className="sr-bar-legend">
          <span className="sr-bar-legend-item"><span className="sr-legend-dot-gold" /> Uploads</span>
          <span className="sr-bar-legend-item"><span className="sr-legend-dot-blue" /> Document Requests</span>
        </div>
      </div>

      {/* Bottom Row */}
      <div className="sr-bottom-row">

        {/* Most Stored Credentials */}
        <div className="sr-card" style={{ marginBottom: 0 }}>
          <div className="sr-card-header">
            <h3 className="sr-card-title">Most Stored Credentials</h3>
          </div>
          {loading
            ? <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>Loading…</p>
            : storedCreds.length === 0
              ? <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>No data yet.</p>
              : storedCreds.map((c, i) => (
                  <div key={i} className="sr-hbar-row">
                    <span className="sr-hbar-label">{truncateLabel(c.label)}</span> {/* CHANGED: truncated label */}
                    <div className="sr-hbar-track">
                      <div
                        className="sr-hbar-fill"
                        style={{ width: `${(c.value / maxStored) * 100}%`, backgroundColor: BAR_COLORS[i % BAR_COLORS.length], opacity: 0.85 }}
                      />
                    </div>
                    <span className="sr-hbar-value">{c.value}</span>
                  </div>
                ))
          }
        </div>

        {/* Most Requested Credentials */}
        <div className="sr-card" style={{ marginBottom: 0 }}>
          <div className="sr-card-header">
            <h3 className="sr-card-title">Most Requested Credentials</h3>
          </div>
          {loading
            ? <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>Loading…</p>
            : requestedCreds.length === 0
              ? <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>No data yet.</p>
              : (
                  <div className="flex gap-6">
                    <div className="flex flex-col justify-around py-1" style={{ minWidth: "148px" }}>
                      {requestedCreds.map((c, i) => (
                        <span key={i} className="sr-hbar-label" style={{ paddingBottom: "6px" }}>{c.label}</span>
                      ))}
                    </div>
                    <div className="flex-1">
                      <RequestedChart data={requestedCreds} maxVal={maxRequested} />
                    </div>
                  </div>
                )
          }
        </div>

      </div>
    </>
  );
}