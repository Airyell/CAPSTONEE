import { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabaseClient";
import "./styles/Departments.css";

// Number of credential documents each student is expected to have
const REQUIRED_DOCS = 8;

// document_name stores the uploaded file name (e.g. "Form_138.jpg",
// "Certification_of_Live_Birth_20261029_105109.jpg"), so each name is reduced
// to one of the 8 credentials shown in the student profile.
const CREDENTIAL_KEYS = {
  "certification of live birth": "Certification of Live Birth",
  "form 138": "Form 138",
  "form 137": "Form 137",
  "good moral": "Good Moral",
  "grades": "Grades",
  "transcript of records": "TOR",
  "tor": "TOR",
  "leave of absence": "LOA",
  "loa": "LOA",
  "withdrawal": "Withdrawal",
};

const toCredential = (fileName) => {
  const key = String(fileName ?? "")
    .replace(/\.[^.]+$/, "") // drop extension
    .replace(/_\d{8}_\d{6}$/, "") // drop upload timestamp
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return CREDENTIAL_KEYS[key] ?? null;
};

// Set this to the status values that should NOT count toward completion
const NOT_COUNTED = ["Rejected"];

// rows -> { [student_id]: number of distinct document types on file }
const countDistinctDocs = (rows) => {
  const sets = {};
  (rows ?? []).forEach((d) => {
    if (NOT_COUNTED.includes(d.status)) return;
    const credential = toCredential(d.document_name);
    if (!credential) return;
    if (!sets[d.student_id]) sets[d.student_id] = new Set();
    sets[d.student_id].add(credential);
  });
  const counts = {};
  Object.keys(sets).forEach((id) => {
    counts[id] = sets[id].size;
  });
  return counts;
};

const statusClass = (status) => {
  switch (status) {
    case "Active": return "dept-status-active";
    case "LOA": return "dept-status-loa";
    case "Graduated": return "dept-status-graduated";
    default: return "dept-status-inactive";
  }
};

// =====================================================
// URL HELPERS
// Departments has its own Laravel route, /departments/{dept_code}.
// This component manages its own sub-path. The code in the URL is
// matched against college_name (e.g. "CITC"). Because colleges load
// from the database, the match is resolved after the fetch completes.
// =====================================================
const getDeptCodeFromPath = () => {
  try {
    const parts = window.location.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);

    if (parts[0] === "departments" && parts[1]) {
      return decodeURIComponent(parts[1]).toUpperCase();
    }
  } catch (error) {
    console.error("Failed to read department from URL:", error);
  }
  return null;
};

const findCollegeByCode = (list, code) => {
  if (!code) return null;
  return list.find((c) => String(c.college_name).toUpperCase() === code) ?? null;
};

export default function Departments({ onViewStudent }) {
  const [colleges, setColleges] = useState([]);
  const [selectedDept, setSelectedDeptState] = useState(null); // college_id
  const [students, setStudents] = useState([]);
  const [filterCourse, setFilterCourse] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const rowsPerPage = 10;

  // ── Wrapper that keeps the URL in sync with the selected dept ──
  const setSelectedDept = (collegeId) => {
    setSelectedDeptState(collegeId);

    try {
      const college = colleges.find((c) => c.college_id === collegeId);
      const nextPath = college
        ? `/departments/${encodeURIComponent(college.college_name)}`
        : "/departments";

      if (window.location.pathname !== nextPath) {
        window.history.pushState({ dept: collegeId }, "", nextPath);
      }
    } catch (err) {
      console.error("Failed to update department URL:", err);
    }
  };

  // ── Load colleges (+ programs, student/document counts) from Supabase ──
  useEffect(() => {
    const loadColleges = async () => {
      try {
        setError("");

        const [collegeRes, programRes, studentRes, docRes] = await Promise.all([
          supabase.from("tbl_college").select("*").order("college_name"),
          supabase.from("tbl_program").select("*").order("program_name"),
          supabase
            .from("tbl_student")
            .select("student_id, college_id")
            .range(0, 49999),
          supabase
            .from("tbl_student_documents")
            .select("student_id, document_name, status")
            .range(0, 49999),
        ]);

        if (collegeRes.error) throw collegeRes.error;
        if (programRes.error) throw programRes.error;
        if (studentRes.error) throw studentRes.error;
        if (docRes.error) throw docRes.error;

        // student_id → college_id
        const collegeOfStudent = {};
        const studentsPerCollege = {};

        (studentRes.data ?? []).forEach((s) => {
          collegeOfStudent[s.student_id] = s.college_id;
          studentsPerCollege[s.college_id] =
            (studentsPerCollege[s.college_id] || 0) + 1;
        });

        const docsPerStudent = countDistinctDocs(docRes.data);
        const docsPerCollege = {};
        Object.entries(docsPerStudent).forEach(([sid, count]) => {
          const cid = collegeOfStudent[sid];
          if (cid != null) {
            docsPerCollege[cid] =
              (docsPerCollege[cid] || 0) + Math.min(count, REQUIRED_DOCS);
          }
        });

        const list = (collegeRes.data ?? []).map((c) => {
          const students_count = studentsPerCollege[c.college_id] || 0;
          const documents_count = docsPerCollege[c.college_id] || 0;
          const expected = students_count * REQUIRED_DOCS;

          return {
            ...c,
            programs: (programRes.data ?? []).filter(
              (p) => Number(p.college_id) === Number(c.college_id)
            ),
            students_count,
            documents_count,
            completion: expected
              ? Math.min(100, Math.round((documents_count / expected) * 100))
              : 0,
          };
        });

        setColleges(list);

        const match = findCollegeByCode(list, getDeptCodeFromPath());
        setSelectedDeptState(match ? match.college_id : null);
      } catch (err) {
        console.error("Failed to load colleges:", err);
        setColleges([]);
        setError(err.message || "Failed to load departments.");
      } finally {
        setLoading(false);
      }
    };

    loadColleges();
  }, []);

  // ── Keep state in sync when the user uses browser back/forward ──
  useEffect(() => {
    const handlePopState = () => {
      const match = findCollegeByCode(colleges, getDeptCodeFromPath());
      setSelectedDeptState(match ? match.college_id : null);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [colleges]);

  // ── Load students of the selected college from Supabase ──
  useEffect(() => {
    if (!selectedDept) return;

    let cancelled = false;

    const loadStudents = async () => {
      try {
        const { data, error: studentErr } = await supabase
          .from("tbl_student")
          .select("*")
          .eq("college_id", selectedDept)
          .order("student_id");

        if (studentErr) throw studentErr;

        const ids = (data ?? []).map((s) => s.student_id);
        let docCount = {};

        if (ids.length > 0) {
          const { data: docs, error: docErr } = await supabase
            .from("tbl_student_documents")
            .select("student_id, document_name, status")
            .in("student_id", ids)
            .range(0, 49999);

          if (docErr) throw docErr;
          docCount = countDistinctDocs(docs);
        }

        if (cancelled) return;

        setStudents(
          (data ?? []).map((s) => ({
            ...s,
            documents: docCount[s.student_id] || 0,
          }))
        );
      } catch (err) {
        console.error("Failed to load students:", err);
        if (!cancelled) {
          setStudents([]);
          setError(err.message || "Failed to load students.");
        }
      }
    };

    loadStudents();

    return () => {
      cancelled = true;
    };
  }, [selectedDept]);

  const dept = colleges.find((c) => c.college_id === selectedDept);

  const enrichedStudents = useMemo(() => {
    return students.map((s) => ({
      ...s,
      course:
        dept?.programs?.find((p) => p.program_id === s.program_id)
          ?.program_name ?? "",
      year: s.year_level,
      documents: s.documents ?? 0,
    }));
  }, [students, dept]);

  const filtered = useMemo(() => {
    return enrichedStudents.filter((s) => {
      const fullName = `${s.first_name} ${s.last_name}`.toLowerCase();
      const matchSearch =
        fullName.includes(search.toLowerCase()) ||
        String(s.student_id).includes(search);
      const matchCourse = filterCourse ? s.course === filterCourse : true;
      return matchSearch && matchCourse;
    });
  }, [enrichedStudents, search, filterCourse]);

  useEffect(() => {
    setCurrentPage(1);
  }, [search, filterCourse, selectedDept]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / rowsPerPage));
  const paginated = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage;
    return filtered.slice(start, start + rowsPerPage);
  }, [filtered, currentPage]);

  // Students in scope: the selected course only (search doesn't change the rate)
  const scopeStudents = useMemo(
    () =>
      filterCourse
        ? enrichedStudents.filter((s) => s.course === filterCourse)
        : enrichedStudents,
    [enrichedStudents, filterCourse]
  );

  const totalStudents = filtered.length;
  const totalDocs = filtered.reduce((sum, s) => sum + s.documents, 0);

  const completionRate = scopeStudents.length
    ? Math.min(
        100,
        Math.round(
          (scopeStudents.reduce(
            (sum, s) => sum + Math.min(s.documents, REQUIRED_DOCS),
            0
          ) /
            (scopeStudents.length * REQUIRED_DOCS)) *
            100
        )
      )
    : 0;

  const handleDeptClick = (collegeId) => {
    setSelectedDept(collegeId);
    setFilterCourse("");
    setSearch("");
    setStudents([]); // avoid flashing the previous college's students
  };

  const handleBack = () => {
    setSelectedDept(null);
    setFilterCourse("");
    setSearch("");
    setStudents([]);
  };

  if (loading) return <p>Loading departments...</p>;

  if (error && colleges.length === 0) {
    return (
      <div className="mt-4 p-3 rounded bg-red-100 text-red-700">{error}</div>
    );
  }

  // ── OVERVIEW ──
  if (!selectedDept) {
    return (
      <>
        <div className="dept-page-header">
          <h2 className="dept-page-title">Departments</h2>
          <p className="dept-page-sub">College overview and student records</p>
        </div>

        <div className="dept-grid">
          {colleges.map((c) => (
            <div
              key={c.college_id}
              className="dept-card"
              onClick={() => handleDeptClick(c.college_id)}
            >
              <div className="dept-card-top">
                <div className="dept-card-icon">
                  <div className="dept-card-icon-inner" />
                </div>
                <span className="dept-card-abbr">{c.college_name}</span>
              </div>

              <div className="dept-card-stats">
                <div className="dept-card-stat-row">
                  <span className="dept-card-stat-label">Students</span>
                  <span className="dept-card-stat-value">
                    {(c.students_count ?? 0).toLocaleString()}
                  </span>
                </div>

                <div className="dept-card-stat-row">
                  <span className="dept-card-stat-label">Credentials</span>
                  <span className="dept-card-stat-value">
                    {(c.documents_count ?? 0).toLocaleString()}
                  </span>
                </div>

                <div className="dept-card-stat-row">
                  <span className="dept-card-stat-label">Completion</span>
                  <span className="dept-card-stat-value-gold">
                    {c.completion ?? 0}%
                  </span>
                </div>
              </div>

              <div className="dept-progress-bar-bg">
                <div
                  className="dept-progress-bar-fill"
                  style={{ width: `${c.completion ?? 0}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  // ── BREAKDOWN ──
  return (
    <>
      {/* Back */}
      <button className="dept-back-btn" onClick={handleBack}>
        &larr; Back to Departments
      </button>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-100 text-red-700">{error}</div>
      )}

      {/* Header */}
      <div className="dept-breakdown-header">
        <div>
          <h2 className="dept-breakdown-abbr">{dept?.college_name}</h2>
          <p className="dept-breakdown-name">
            {dept?.full_name ?? dept?.college_name}
          </p>
        </div>

        <div className="dept-progress-bar-bg" style={{ width: "200px" }}>
          <div
            className="dept-progress-bar-fill"
            style={{ width: `${completionRate}%` }}
          />
        </div>
      </div>

      {/* Summary Stats */}
      <div className="dept-summary-grid">
        <div className="dept-summary-card">
          <p className="dept-summary-label">Total Students</p>
          <p className="dept-summary-value">{totalStudents.toLocaleString()}</p>
          <div className="dept-summary-accent" />
        </div>

        <div className="dept-summary-card">
          <p className="dept-summary-label">Documents Uploaded</p>
          <p className="dept-summary-value">{totalDocs.toLocaleString()}</p>
          <div className="dept-summary-accent" />
        </div>

        <div className="dept-summary-card">
          <p className="dept-summary-label">Completion Rate</p>
          <p className="dept-summary-value-gold">{completionRate}%</p>
          <div className="dept-summary-accent" />
        </div>
      </div>

      {/* Filter Bar */}
      <div className="dept-filter-bar">
        <input
          type="text"
          placeholder="Search by name or student ID..."
          className="dept-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <select
          className="dept-select"
          value={filterCourse}
          onChange={(e) => setFilterCourse(e.target.value)}
        >
          <option value="">All Courses</option>
          {dept?.programs?.map((p) => (
            <option key={p.program_id} value={p.program_name}>
              {p.program_name}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="dept-table-wrapper">
        <table className="dept-table">
          <thead>
            <tr className="dept-thead">
              <th className="dept-th-first">Student ID</th>
              <th className="dept-th">Full Name</th>
              <th className="dept-th">Course</th>
              <th className="dept-th">Year Level</th>
              <th className="dept-th">Credential Completion</th>
            </tr>
          </thead>

          <tbody>
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={5} className="dept-empty">
                  No students found.
                </td>
              </tr>
            ) : (
              paginated.map((s, i) => {
                const pct = Math.min(
                  100,
                  Math.round((s.documents / REQUIRED_DOCS) * 100)
                );

                return (
                  <tr
                    key={s.student_id}
                    className={i % 2 === 0 ? "dept-row-even" : "dept-row-odd"}
                  >
                    <td className="dept-td-first">{s.student_id}</td>
                    <td
                      className="dept-td-name dept-td-name-link"
                      onClick={() => onViewStudent?.(s.student_id)}
                    >
                      {s.first_name} {s.last_name}
                    </td>
                    <td className="dept-td">{s.course}</td>
                    <td className="dept-td">{s.year}</td>
                    <td className="dept-td">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-1.5 bg-[#e6a817] rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs font-bold text-gray-500 w-8 text-right">
                          {pct}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {filtered.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: "16px",
            padding: "0 4px",
          }}
        >
          <span style={{ fontSize: "0.85rem", color: "#6b7280" }}>
            Showing{" "}
            <strong style={{ color: "#111827" }}>
              {(currentPage - 1) * rowsPerPage + 1}
            </strong>
            {" "}–{" "}
            <strong style={{ color: "#111827" }}>
              {Math.min(currentPage * rowsPerPage, filtered.length)}
            </strong>
            {" "}of{" "}
            <strong style={{ color: "#111827" }}>{filtered.length}</strong>
          </span>

          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              style={{
                border: "none",
                background: "transparent",
                fontSize: "0.85rem",
                fontWeight: 500,
                color: currentPage === 1 ? "#c7cad1" : "#6b7280",
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
                background: "#1a1a5e",
                color: "#fff",
              }}
            >
              {currentPage}
            </span>

            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              style={{
                border: "none",
                background: "transparent",
                fontSize: "0.85rem",
                fontWeight: 500,
                color: currentPage === totalPages ? "#c7cad1" : "#6b7280",
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