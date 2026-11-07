import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";
import "./styles/Students.css";
import { useAuth } from "./AuthContext"; // RBAC
import { PERMISSIONS } from "./rbac"; // RBAC
import { logActivity } from "./activityLog"; // ADDED

const yearLevels = ["1st Year", "2nd Year", "3rd Year", "4th Year", "5th Year"];
const statuses = ["Active", "LOA", "Inactive", "Graduated"];

const intToYearLevel = {
  1: "1st Year",
  2: "2nd Year",
  3: "3rd Year",
  4: "4th Year",
  5: "5th Year",
};

const yearLevelToInt = {
  "1st Year": 1,
  "2nd Year": 2,
  "3rd Year": 3,
  "4th Year": 4,
  "5th Year": 5,
};

const ROWS_PER_PAGE = 10;

// Folder helper (folder-server.js) running on this Windows computer
const FOLDER_SERVER_URL = "http://127.0.0.1:3001/create-folder";
const FOLDER_SYNC_URL = "http://127.0.0.1:3001/sync-folders";

// Automatic sync retry settings
const SYNC_MAX_ATTEMPTS = 3;
const SYNC_RETRY_DELAY_MS = 3000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildStudentName = (first, middle, last) =>
  [first, middle, last]
    .map((value) => (value || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");

// Every student folder lives in C:\StudentRecords\<College>\<ID>_<Name>
const STUDENT_RECORDS_ROOT = "C:\\StudentRecords";

const safeFolderPart = (value) =>
  String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120);

const buildCollegeFolder = (collegeName) =>
  safeFolderPart(collegeName).replace(/ /g, "_") || "Unassigned";

const buildStudentFolderPath = (collegeName, studentId, first, middle, last) => {
  const fullName = safeFolderPart(
    [first, middle, last].filter((p) => String(p || "").trim()).join(" ")
  ).replace(/ /g, "_");

  return (
    `${STUDENT_RECORDS_ROOT}\\${buildCollegeFolder(collegeName)}\\` +
    `${safeFolderPart(studentId)}_${fullName}`
  );
};

// Asks the folder helper to create the student's folder and returns its path
const createStudentFolder = async (
  collegeName,
  studentId,
  first,
  middle,
  last
) => {
  const response = await fetch(FOLDER_SERVER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      student_id: studentId,
      first_name: first,
      middle_name: middle || "",
      last_name: last,
      college_name: collegeName || "",
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || "Failed to create student folder.");
  }

  return result.folder_path;
};

// Makes sure every existing student has a folder in their college folder.
// Old folders are moved/renamed, missing ones are created. The response lists
// the students whose folder_path changed so it can be saved in the database.
const syncStudentFolders = async (studentList) => {
  const response = await fetch(FOLDER_SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ students: studentList }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || "Folder sync failed.");
  }

  return result;
};

const currentYear = new Date().getFullYear();
const yearOptions = Array.from({ length: 10 }, (_, i) => currentYear - i);

const statusClass = (status) => {
  if (status === "Active") return "status-badge status-active";
  if (status === "Graduated") return "status-badge status-graduated";
  return "status-badge status-inactive";
};

const emptyForm = () => ({
  enrollYear: String(currentYear),
  idSuffix: "",

  first_name: "",
  last_name: "",
  middle_name: "",
  birthdate: "",

  gender: "Female",
  email: "",
  contact: "",
  address: "",

  department: "",
  course: "",

  yearLevel: "1st Year",
  status: "Active",
});

// ============================================================
// STUDENTS COMPONENT
// ============================================================
export default function Students({ onViewStudent }) {
  const { can } = useAuth();

  const [students, setStudents] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [coursesByDept, setCoursesByDept] = useState({});

  const [search, setSearch] = useState("");
  const [filterDept, setFilterDept] = useState("");
  const [filterYear, setFilterYear] = useState("");
  const [filterCourse, setFilterCourse] = useState("");

  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);

  // Makes sure the automatic folder sync runs only once per page load
  const folderSyncDone = useRef(false);

  // ============================================================
  // FORM
  // ============================================================
  const [form, setForm] = useState(emptyForm());

  // ============================================================
  // STUDENT ID GENERATOR
  // ============================================================
  const generatedId =
    form.enrollYear && form.idSuffix
      ? `${form.enrollYear}${form.idSuffix.padStart(6, "0")}`
      : `${form.enrollYear}000000`;

  // ============================================================
  // FETCH COLLEGES
  // ============================================================
  useEffect(() => {
    const fetchColleges = async () => {
      const { data, error } = await supabase
        .from("tbl_college")
        .select("college_id, college_name")
        .order("college_name");

      if (!error && data) {
        setDepartments(data);
      }
    };

    fetchColleges();
  }, []);

  // ============================================================
  // FETCH PROGRAMS
  // ============================================================
  useEffect(() => {
    const fetchPrograms = async () => {
      const { data, error } = await supabase
        .from("tbl_program")
        .select("program_id, program_name, college_id")
        .order("program_name");

      if (!error && data) {
        const grouped = {};

        data.forEach((p) => {
          if (!grouped[p.college_id]) {
            grouped[p.college_id] = [];
          }

          grouped[p.college_id].push({
            program_id: p.program_id,
            program_name: p.program_name,
          });
        });

        setCoursesByDept(grouped);
      }
    };

    fetchPrograms();
  }, []);

  // ============================================================
  // FETCH STUDENTS
  // ============================================================
  const fetchStudents = useCallback(async (showSpinner = true) => {
    if (showSpinner) {
      setLoading(true);
    }

    const { data, error } = await supabase
      .from("tbl_student")
      .select(`
        student_id,
        first_name,
        last_name,
        middle_name,
        birthdate,
        gender,
        email,
        contact_number,
        address,
        year_level,
        status,
        folder_path,
        tbl_college (college_id, college_name),
        tbl_program (program_id, program_name)
      `)
      .order("last_name");

    if (!error && data) {
      setStudents(
        data.map((s) => ({
          id: s.student_id,

          name: `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim(),

          first_name: s.first_name ?? "",
          last_name: s.last_name ?? "",
          middle_name: s.middle_name ?? "",

          birthdate: s.birthdate ?? "",
          gender: s.gender ?? "",
          email: s.email ?? "",
          contact: s.contact_number ?? "",
          address: s.address ?? "",

          folder_path: s.folder_path ?? "",

          department: s.tbl_college?.college_name ?? "—",
          college_id: s.tbl_college?.college_id ?? null,

          course: s.tbl_program?.program_name ?? "—",
          program_id: s.tbl_program?.program_id ?? null,

          year: intToYearLevel[s.year_level] ?? `Year ${s.year_level}`,

          status: s.status ?? "Active",
        }))
      );
    }

    if (showSpinner) {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStudents();
  }, [fetchStudents]);

  // ============================================================
  // AUTOMATIC FOLDER SYNC
  // Runs once per page load, as soon as the students are loaded.
  // Folders live in C:\StudentRecords\<College>\<ID>_<Name>.
  // Old folders are moved, missing folders are created, and the
  // new folder_path is saved in tbl_student.
  // If the helper is not reachable yet, it retries a few times.
  // ============================================================
  useEffect(() => {
    if (loading || folderSyncDone.current || students.length === 0) return;
    folderSyncDone.current = true;

    const studentList = students.map((s) => ({
      student_id: s.id,
      first_name: s.first_name,
      middle_name: s.middle_name,
      last_name: s.last_name,
      college_name: s.department === "—" ? "" : s.department,
      folder_path: s.folder_path,
    }));

    const autoSync = async () => {
      for (let attempt = 1; attempt <= SYNC_MAX_ATTEMPTS; attempt++) {
        try {
          const r = await syncStudentFolders(studentList);

          let saved = 0;
          let blocked = 0;

          for (const u of r.updates || []) {
            const { data, error } = await supabase
              .from("tbl_student")
              .update({ folder_path: u.folder_path })
              .eq("student_id", u.student_id)
              .select("student_id");

            // No error but no row returned = blocked by RLS or a trigger
            if (error || !data || data.length === 0) {
              blocked++;
              console.warn(
                `Could not save folder path for ${u.student_id}:`,
                error?.message || "blocked by RLS or a trigger"
              );
            } else {
              saved++;
            }
          }

          console.log(
            `Folder sync: ${r.created} created, ${r.renamed} moved/renamed, ` +
              `${r.existing} already correct, ${r.skipped.length} skipped, ` +
              `${r.failed.length} failed. Paths saved: ${saved}, not saved: ${blocked}`,
            r.skipped.length || r.failed.length ? r : ""
          );

          if (saved > 0) {
            await fetchStudents(false);
          }

          return; // done
        } catch (err) {
          console.warn(
            `Folder sync attempt ${attempt}/${SYNC_MAX_ATTEMPTS} failed:`,
            err.message
          );

          if (attempt < SYNC_MAX_ATTEMPTS) {
            await wait(SYNC_RETRY_DELAY_MS);
          }
        }
      }

      console.warn(
        "Folder sync skipped: folder-server.js is not reachable. " +
          "Start start-folder-server.bat and reload the page."
      );
    };

    autoSync();
  }, [loading, students, fetchStudents]);

  // ============================================================
  // REALTIME STUDENT UPDATES
  // ============================================================
  useEffect(() => {
    const channel = supabase
      .channel("realtime:tbl_student:list")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tbl_student",
        },
        () => {
          fetchStudents(false);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchStudents]);

  // ============================================================
  // FILTER STUDENTS
  // ============================================================
  const filtered = students.filter((s) => {
    const term = search.trim().toLowerCase();

    const matchSearch =
      !term ||
      [s.first_name, s.middle_name, s.last_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term) ||
      String(s.id).includes(term);

    const matchDept = filterDept ? s.college_id === Number(filterDept) : true;
    const matchYear = filterYear ? s.year === filterYear : true;
    const matchCourse = filterCourse ? s.course === filterCourse : true;

    return matchSearch && matchDept && matchYear && matchCourse;
  });

  // ============================================================
  // RESET PAGE WHEN FILTERS CHANGE
  // ============================================================
  useEffect(() => {
    setCurrentPage(1);
  }, [search, filterDept, filterYear, filterCourse]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE));

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginated = useMemo(() => {
    const start = (currentPage - 1) * ROWS_PER_PAGE;
    return filtered.slice(start, start + ROWS_PER_PAGE);
  }, [filtered, currentPage]);

  // ============================================================
  // FORM CHANGE
  // ============================================================
  const handleFormChange = (field, value) => {
    setForm((prev) => ({
      ...prev,
      [field]: value,
      ...(field === "department" ? { course: "" } : {}),
    }));
  };

  // ============================================================
  // INSERT NEW STUDENT
  // ============================================================
  const handleSubmit = async () => {
    if (!can(PERMISSIONS.STUDENTS_CREATE)) {
      alert("You do not have permission to add students.");
      return;
    }

    if (
      !form.idSuffix ||
      !form.first_name.trim() ||
      !form.last_name.trim() ||
      !form.department ||
      !form.course
    ) {
      alert("Please complete all required student fields.");
      return;
    }

    setSubmitting(true);

    let studentSaved = false;

    try {
      const studentId = Number(generatedId);

      // College name of the selected department (used for the folder)
      const collegeName =
        departments.find((d) => String(d.college_id) === String(form.department))
          ?.college_name || "";

      // 1. Save student details (with folder path) in Supabase.
      const { error: insertError } = await supabase
        .from("tbl_student")
        .insert({
          student_id: studentId,
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          middle_name: form.middle_name.trim() || null,
          birthdate: form.birthdate || null,
          gender: form.gender || null,
          email: form.email.trim() || null,
          contact_number: form.contact.trim() || null,
          address: form.address.trim() || null,
          college_id: Number(form.department),
          program_id: Number(form.course),
          year_level: yearLevelToInt[form.yearLevel] || 1,
          status: form.status,
          folder_path: buildStudentFolderPath(
            collegeName,
            studentId,
            form.first_name,
            form.middle_name,
            form.last_name
          ),
        });

      if (insertError) {
        if (insertError.code === "23505") {
          alert(
            "A student with this ID or the same name (folder) already exists."
          );
        } else {
          alert("Failed to save student: " + insertError.message);
        }
        return;
      }

      studentSaved = true;

      // 2. Create the student's folder in C:\StudentRecords\<College>\.
      let folderPath = null;
      let folderError = null;

      try {
        folderPath = await createStudentFolder(
          collegeName,
          studentId,
          form.first_name,
          form.middle_name,
          form.last_name
        );

        // 3. Save the returned path in tbl_student.
        const { data: savedRows, error: updateError } = await supabase
          .from("tbl_student")
          .update({ folder_path: folderPath })
          .eq("student_id", studentId)
          .select("folder_path");

        if (updateError) {
          folderError = new Error(
            "Folder created, but the folder path could not be saved: " +
              updateError.message
          );
        } else if (!savedRows || savedRows.length === 0) {
          folderError = new Error(
            "Folder created, but the database blocked saving the path (check the RLS update policy on tbl_student)."
          );
        }
      } catch (error) {
        folderError = error;
      }

      // 4. Log the student registration.
      try {
        await logActivity({
          type: "Create",
          description: `Added new student ${studentId} (${buildStudentName(
            form.first_name,
            form.middle_name,
            form.last_name
          )})`,
          module: "Students Module",
        });
      } catch (error) {
        console.error("Activity logging failed:", error);
      }

      // 5. Refresh the table and reset the form.
      await fetchStudents();

      setForm(emptyForm());
      setShowModal(false);

      if (folderError) {
        alert(
          "Student saved successfully, but folder setup needs attention.\n\n" +
            folderError.message +
            "\n\nStart start-folder-server.bat, then reload this page. " +
            "The folder will be created automatically."
        );
      }
    } catch (error) {
      console.error("Student registration failed:", error);

      alert(
        studentSaved
          ? "The student was saved, but an unexpected error occurred. Check the console."
          : "Failed to add student: " + error.message
      );
    } finally {
      setSubmitting(false);
    }
  };

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <>
      {/* HEADER */}
      <div className="students-header">
        <h2 className="students-title">Student Records</h2>

        {can(PERMISSIONS.STUDENTS_CREATE) && (
          <button
            className="students-add-btn"
            onClick={() => setShowModal(true)}
          >
            Add Student
          </button>
        )}
      </div>

      {/* FILTER BAR */}
      <div className="students-filter-bar">
        <input
          type="text"
          placeholder="Search by name or student ID..."
          className="students-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <select
          className="students-select"
          value={filterDept}
          onChange={(e) => {
            setFilterDept(e.target.value);
            setFilterCourse("");
          }}
        >
          <option value="">All Departments</option>

          {departments.map((d) => (
            <option key={d.college_id} value={d.college_id}>
              {d.college_name}
            </option>
          ))}
        </select>

        <select
          className="students-select"
          value={filterCourse}
          onChange={(e) => setFilterCourse(e.target.value)}
        >
          <option value="">All Courses</option>

          {(filterDept
            ? coursesByDept[Number(filterDept)] || []
            : Object.values(coursesByDept).flat()
          ).map((c) => (
            <option key={c.program_id} value={c.program_name}>
              {c.program_name}
            </option>
          ))}
        </select>

        <select
          className="students-select"
          value={filterYear}
          onChange={(e) => setFilterYear(e.target.value)}
        >
          <option value="">All Year Levels</option>

          {yearLevels.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>

      {/* TABLE */}
      <div className="students-table-wrapper">
        <table className="students-table">
          <thead>
            <tr className="students-thead">
              <th className="students-th-first">Student ID</th>
              <th className="students-th">Full Name</th>
              <th className="students-th">Department</th>
              <th className="students-th">Course</th>
              <th className="students-th">Year Level</th>
              <th className="students-th">Status</th>
              <th className="students-th">Record</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="students-empty">
                  Loading students...
                </td>
              </tr>
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={7} className="students-empty">
                  No students found.
                </td>
              </tr>
            ) : (
              paginated.map((s, i) => (
                <tr
                  key={s.id}
                  className={
                    i % 2 === 0 ? "students-row-even" : "students-row-odd"
                  }
                >
                  <td className="students-td-first">{s.id}</td>
                  <td className="students-td-name">{s.name}</td>
                  <td className="students-td">{s.department}</td>
                  <td className="students-td">{s.course}</td>
                  <td className="students-td">{s.year}</td>

                  <td className="students-td">
                    <span className={statusClass(s.status)}>{s.status}</span>
                  </td>

                  <td className="students-td">
                    <button
                      className="students-view-btn"
                      onClick={() => onViewStudent && onViewStudent(s.id)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* PAGINATION */}
      {!loading && filtered.length > 0 && (
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
              {(currentPage - 1) * ROWS_PER_PAGE + 1}
            </strong>{" "}
            –{" "}
            <strong style={{ color: "#111827" }}>
              {Math.min(currentPage * ROWS_PER_PAGE, filtered.length)}
            </strong>{" "}
            of{" "}
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
              onClick={() =>
                setCurrentPage((p) => Math.min(totalPages, p + 1))
              }
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

      {/* ADD STUDENT MODAL */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div
            className="modal-card"
            style={{ maxWidth: "600px", maxHeight: "90vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "20px",
              }}
            >
              <h3 className="modal-title" style={{ margin: 0 }}>
                Add New Student
              </h3>

              <button
                onClick={() => setShowModal(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#9ca3af",
                  fontSize: "18px",
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>

            {/* STUDENT ID GENERATOR */}
            <div
              style={{
                background: "rgba(230,168,23,0.08)",
                border: "1px solid rgba(230,168,23,0.2)",
                borderRadius: "10px",
                padding: "14px 16px",
                marginBottom: "20px",
              }}
            >
              <p
                className="modal-label"
                style={{ marginBottom: "10px", color: "#e6a817" }}
              >
                Student ID Generator
              </p>

              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <select
                  className="modal-select"
                  style={{ flex: 1, marginBottom: 0 }}
                  value={form.enrollYear}
                  onChange={(e) =>
                    handleFormChange("enrollYear", e.target.value)
                  }
                >
                  {yearOptions.map((y) => (
                    <option key={y} value={String(y)}>
                      {y}
                    </option>
                  ))}
                </select>

                <span
                  style={{
                    color: "#9ca3af",
                    fontWeight: "bold",
                    fontSize: "16px",
                  }}
                >
                  —
                </span>

                <input
                  className="modal-input"
                  style={{ flex: 2, marginBottom: 0 }}
                  placeholder="123456"
                  maxLength={6}
                  value={form.idSuffix}
                  onChange={(e) =>
                    handleFormChange(
                      "idSuffix",
                      e.target.value.replace(/\D/g, "")
                    )
                  }
                />

                <div
                  style={{
                    background: "rgba(26,26,110,0.08)",
                    border: "1px solid rgba(26,26,110,0.2)",
                    borderRadius: "8px",
                    padding: "10px 14px",
                    fontSize: "13px",
                    fontWeight: "bold",
                    color: "#1a1a6e",
                    whiteSpace: "nowrap",
                  }}
                >
                  {generatedId}
                </div>
              </div>
            </div>

            {/* FIRST NAME & LAST NAME */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "14px",
                marginBottom: "14px",
              }}
            >
              <div>
                <label className="modal-label">First Name</label>
                <input
                  className="modal-input"
                  style={{ marginBottom: 0 }}
                  placeholder="First name"
                  value={form.first_name}
                  onChange={(e) =>
                    handleFormChange("first_name", e.target.value)
                  }
                />
              </div>

              <div>
                <label className="modal-label">Last Name</label>
                <input
                  className="modal-input"
                  style={{ marginBottom: 0 }}
                  placeholder="Last name"
                  value={form.last_name}
                  onChange={(e) =>
                    handleFormChange("last_name", e.target.value)
                  }
                />
              </div>
            </div>

            {/* MIDDLE NAME & BIRTHDATE */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "14px",
                marginBottom: "14px",
              }}
            >
              <div>
                <label className="modal-label">
                  Middle Name{" "}
                  <span style={{ fontWeight: 400, color: "#999" }}>
                    (optional)
                  </span>
                </label>
                <input
                  className="modal-input"
                  style={{ marginBottom: 0 }}
                  placeholder="Middle name"
                  value={form.middle_name}
                  onChange={(e) =>
                    handleFormChange("middle_name", e.target.value)
                  }
                />
              </div>

              <div>
                <label className="modal-label">Birthdate</label>
                <input
                  type="date"
                  className="modal-input"
                  style={{ marginBottom: 0 }}
                  value={form.birthdate}
                  onChange={(e) =>
                    handleFormChange("birthdate", e.target.value)
                  }
                />
              </div>
            </div>

            {/* GENDER & EMAIL */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "14px",
                marginBottom: "14px",
              }}
            >
              <div>
                <label className="modal-label">Gender</label>
                <select
                  className="modal-select"
                  style={{ marginBottom: 0 }}
                  value={form.gender}
                  onChange={(e) => handleFormChange("gender", e.target.value)}
                >
                  <option>Female</option>
                  <option>Male</option>
                  <option>Prefer not to say</option>
                </select>
              </div>

              <div>
                <label className="modal-label">Email</label>
                <input
                  type="email"
                  className="modal-input"
                  style={{ marginBottom: 0 }}
                  placeholder="Email address"
                  value={form.email}
                  onChange={(e) => handleFormChange("email", e.target.value)}
                />
              </div>
            </div>

            {/* DEPARTMENT & COURSE */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "14px",
                marginBottom: "14px",
              }}
            >
              <div>
                <label className="modal-label">Department</label>
                <select
                  className="modal-select"
                  style={{ marginBottom: 0 }}
                  value={form.department}
                  onChange={(e) =>
                    handleFormChange("department", e.target.value)
                  }
                >
                  <option value="">Select Department</option>

                  {departments.map((d) => (
                    <option key={d.college_id} value={d.college_id}>
                      {d.college_name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="modal-label">Course</label>
                <select
                  className="modal-select"
                  style={{ marginBottom: 0 }}
                  value={form.course}
                  onChange={(e) => handleFormChange("course", e.target.value)}
                  disabled={!form.department}
                >
                  <option value="">Select Course</option>

                  {(coursesByDept[Number(form.department)] || []).map((c) => (
                    <option key={c.program_id} value={c.program_id}>
                      {c.program_name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* YEAR LEVEL & STATUS */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "14px",
                marginBottom: "20px",
              }}
            >
              <div>
                <label className="modal-label">Year Level</label>
                <select
                  className="modal-select"
                  style={{ marginBottom: 0 }}
                  value={form.yearLevel}
                  onChange={(e) =>
                    handleFormChange("yearLevel", e.target.value)
                  }
                >
                  {yearLevels.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="modal-label">Status</label>
                <select
                  className="modal-select"
                  style={{ marginBottom: 0 }}
                  value={form.status}
                  onChange={(e) => handleFormChange("status", e.target.value)}
                >
                  {statuses.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* FOOTER */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px",
              }}
            >
              <button
                className="modal-submit-btn"
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? "Saving..." : "Save Student"}
              </button>

              <button
                className="modal-cancel-btn"
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: "8px",
                  padding: "10px",
                }}
                onClick={() => setShowModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}