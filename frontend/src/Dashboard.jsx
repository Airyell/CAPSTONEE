
import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import { useAuth } from "./AuthContext";
import DocumentScanner from "./DocumentScanner.jsx";
import useDocumentScanner from "./useDocumentScanner";
import { matchStudentFromOcr } from "./matchStudent";
import "./styles/Dashboard.css";

const ROWS_PER_PAGE = 10;

const SCANNER_API = "http://127.0.0.1:5000";
const DOCUMENT_BUCKET = "student-documents";

// Handles year_level stored as a number (1) or text ("1st Year")
const formatYear = (y) => {
  if (y === null || y === undefined || y === "") return "—";

  const n = Number(y);

  if (Number.isNaN(n)) return String(y);

  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";

  return `${n}${suffix} Year`;
};

// Optional: map OCR labels to the exact tbl_documents.document_name.
const DOCUMENT_TYPE_MAP = {
  // "TOR": "Transcript of Records",
  // "PSA": "PSA Birth Certificate",
};

// Splits "Last, First Middle" or "First Middle Last".
const splitName = (fullName = "") => {
  const name = fullName.trim();

  if (!name) {
    return { last: "", first: "" };
  }

  if (name.includes(",")) {
    const [last, rest] = name.split(",").map((s) => s.trim());

    return {
      last,
      first: (rest || "").split(/\s+/)[0] || "",
    };
  }

  const parts = name.split(/\s+/);

  return {
    last: parts[parts.length - 1] || "",
    first: parts[0] || "",
  };
};

const safeScannedFileName = (name) =>
  (name || "scanned_document.jpg")
    .replace(/^.*[\\/]/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_");

const scannedDocumentSlug = (name) =>
  (name || "other")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "other";

// Sends the confirmed scan to the Flask scanner service.
// The Flask service saves the actual image inside the student's folder.
async function saveScannedFile({
  imageDataUrl,
  documentType,
  student,
}) {
  if (
    typeof imageDataUrl !== "string" ||
    !imageDataUrl.startsWith("data:image/")
  ) {
    throw new Error(
      "Scanned image is missing. Please scan the document again."
    );
  }

  if (!documentType) {
    throw new Error("Please select a document type.");
  }

  if (!student?.student_id) {
    throw new Error("The confirmed student record is missing.");
  }

  if (!student?.college_name) {
    throw new Error(
      "The student's college could not be identified. Please check the student record."
    );
  }

  let response;

  try {
    response = await fetch(`${SCANNER_API}/store-scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_data_url: imageDataUrl,
        document_type: documentType,
        student: {
          student_id: student.student_id,
          first_name: student.first_name || "",
          middle_name: student.middle_name || "",
          last_name: student.last_name || "",
          college_name: student.college_name,
        },
      }),
    });
  } catch (error) {
    throw new Error(
      "Could not connect to the scanner folder service at port 5000. Make sure app.py is running."
    );
  }

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.success || !result.stored_path) {
    throw new Error(
      result.error ||
        result.message ||
        `Failed to save the scanned file to the student folder (HTTP ${response.status}).`
    );
  }

  return result.stored_path;
}

// Uploads a copy to Supabase Storage so StudentProfile can preview it.
async function uploadScannedFileToSupabase({
  imageDataUrl,
  studentId,
  documentType,
  fileName,
}) {
  if (
    typeof imageDataUrl !== "string" ||
    !imageDataUrl.startsWith("data:image/")
  ) {
    throw new Error(
      "The scanned image is missing for the Supabase upload."
    );
  }

  const response = await fetch(imageDataUrl);

  if (!response.ok) {
    throw new Error("Could not read the scanned image.");
  }

  const blob = await response.blob();

  const safeName = safeScannedFileName(fileName);
  const mimeTypes = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };

  const extension = mimeTypes[blob.type] || "jpg";

  const finalName = /\.[A-Za-z0-9]{2,5}$/.test(safeName)
    ? safeName
    : `${safeName}.${extension}`;

  const timestamp = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14);

  const storagePath =
    `students/${studentId}/` +
    `${scannedDocumentSlug(documentType)}/` +
    `${timestamp}_${finalName}`;

  const { error: uploadError } = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(storagePath, blob, {
      contentType: blob.type || "image/jpeg",
      upsert: false,
    });

  if (uploadError) {
    throw uploadError;
  }

  return storagePath;
}

export default function Dashboard({
  staffName,
  activePage,
  setActivePage,
  onLogout,
  onViewStudent,
  children,
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const uploadInputRef = useRef(null);

  // Role-based access control.
  const { canAccess, staffId, staffName: authStaffName } = useAuth();

  // Re-fetch stats and student list after a successful save.
  const [refreshKey, setRefreshKey] = useState(0);

  // ------------------------------------------------------------
  // SCANNER
  // ------------------------------------------------------------

  // ------------------------------------------------------------
// HANDLE UPLOADED DOCUMENT
// ------------------------------------------------------------

  const handleDocumentUpload = async (event) => {
  const file = event.target.files?.[0];

  // Allow selecting the same file again later.
  event.target.value = "";

  if (!file) return;

  try {
    await scanner.upload(file);
  } catch (error) {
    console.error("Document upload failed:", error);
  }
};

  const scanner = useDocumentScanner({
    onScanned: (credential, result) => {
      console.log("Dashboard scan complete:", result?.filename);
    },

    onConfirmed: async ({
      studentId,
      studentName,
      ocrName,
      documentId,
      documentType,
      fileName,
      fileUrl,
      imageDataUrl,
      matchedStudent: confirmedStudent,
    }) => {
      let uploadedPath = null;

      try {
        // 1. Verify the logged-in staff before saving anything.
        if (!staffId) {
          throw new Error(
            "Unable to identify the logged-in staff. Please check AuthContext and the staff ID."
          );
        }

        // 2. Resolve the student ID from the confirmation result or OCR.
        let sid =
          studentId ||
          confirmedStudent?.student_id ||
          null;

        if (!sid) {
          const match = await matchStudentFromOcr(
            ocrName ?? {
              ...splitName(studentName),
              middle: "",
            }
          );

          if (match?.student) {
            sid = match.student.student_id;
          }
        }

        if (!sid) {
          throw new Error(
            "No unique student match was found. Please confirm the correct student before saving."
          );
        }

        console.log("[AUTH STAFF ID]", staffId);
        console.log("[AUTH STAFF NAME]", authStaffName);

        // 3. Fetch the official student record and college name.
        const {
          data: student,
          error: studentError,
        } = await supabase
          .from("tbl_student")
          .select(`
            student_id,
            first_name,
            middle_name,
            last_name,
            college_id,
            tbl_college ( college_name )
          `)
          .eq("student_id", sid)
          .maybeSingle();

        if (studentError) throw studentError;

        if (!student) {
          throw new Error(
            "The selected student does not exist in the student database."
          );
        }

        const collegeRelation = Array.isArray(student.tbl_college)
          ? student.tbl_college[0]
          : student.tbl_college;

        const collegeName = collegeRelation?.college_name || "";

        if (!collegeName) {
          throw new Error(
            "The student's college could not be identified. Check the college assignment in tbl_student."
          );
        }

        // 4. Resolve the document type and document ID.
        const mappedDocumentType =
          DOCUMENT_TYPE_MAP[documentType] ?? documentType;

        let docId = documentId;

        if (!docId && mappedDocumentType) {
          const {
            data: doc,
            error: docError,
          } = await supabase
            .from("tbl_documents")
            .select("document_id, document_name")
            .ilike("document_name", mappedDocumentType)
            .maybeSingle();

          if (docError) throw docError;

          docId = doc?.document_id;
        }

        if (!docId) {
          throw new Error(
            `Unknown document type: ${documentType || "Not selected"}. Please select a valid document type.`
          );
        }

        const {
          data: documentRecord,
          error: documentError,
        } = await supabase
          .from("tbl_documents")
          .select("document_id, document_name")
          .eq("document_id", docId)
          .maybeSingle();

        if (documentError) throw documentError;

        if (!documentRecord) {
          throw new Error(
            "The selected document type was not found in tbl_documents."
          );
        }

        const officialDocumentType = documentRecord.document_name;

        // 5. Get the actual scanned image from the confirmation payload.
        // The scanner service returns image_data_url.
        const scannedImage =
          imageDataUrl ||
          (typeof fileUrl === "string" &&
          fileUrl.startsWith("data:image/")
            ? fileUrl
            : "");

        if (!scannedImage) {
          throw new Error(
            "No scanned image was received from OCR Confirmation. Check useDocumentScanner.jsx and OCRConfirmation.jsx to ensure imageDataUrl is passed to onConfirmed."
          );
        }

        // 6. Save the physical image into the student's local folder.
        // app.py creates the college and student folders if needed.
        const localPath = await saveScannedFile({
          imageDataUrl: scannedImage,
          documentType: officialDocumentType,
          student: {
            student_id: student.student_id,
            first_name: student.first_name || "",
            middle_name: student.middle_name || "",
            last_name: student.last_name || "",
            college_name: collegeName,
          },
        });

        console.log("[LOCAL STUDENT FOLDER]", localPath);

        // 7. Upload another copy to Supabase Storage for browser preview.
        uploadedPath = await uploadScannedFileToSupabase({
          imageDataUrl: scannedImage,
          studentId: student.student_id,
          documentType: officialDocumentType,
          fileName: fileName || `${officialDocumentType}.jpg`,
        });

        console.log("[SUPABASE STORAGE PATH]", uploadedPath);

        // 8. Insert the document record into the database.
        const safeName = safeScannedFileName(
          fileName || `${officialDocumentType}.jpg`
        ).slice(0, 100);

        const { error: insertError } = await supabase
          .from("tbl_student_documents")
          .insert({
            student_id: student.student_id,
            document_id: documentRecord.document_id,
            document_name: safeName,
            file_path: uploadedPath,
            uploaded_by: staffId,
            date_uploaded: new Date().toISOString(),
            status: "Active",
            remarks: "Verified",
          });

        if (insertError) {
  console.error("[DATABASE INSERT ERROR]", {
    message: insertError.message,
    details: insertError.details,
    hint: insertError.hint,
    code: insertError.code,
  });

  throw insertError;
}

  // ------------------------------------------------------------
// HANDLE UPLOADED DOCUMENT
// ------------------------------------------------------------

const handleDocumentUpload = async (event) => {
  const file = event.target.files?.[0];

  // Allow selecting the same file again later.
  event.target.value = "";

  if (!file) return;

  try {
    await scanner.upload(file);
  } catch (error) {
    console.error("Document upload failed:", error);
  }
};

        // 9. Refresh the dashboard after everything succeeds.
        setRefreshKey((current) => current + 1);

        console.log("Scanned document saved successfully.", {
          studentId: student.student_id,
          documentType: officialDocumentType,
          localPath,
          uploadedPath,
        });
      } catch (err) {
        console.error("Save scanned document failed:", err);

        // Remove the Supabase copy if it was uploaded but the
        // database insert or another later step failed.
        if (uploadedPath) {
          const { error: removeError } = await supabase.storage
            .from(DOCUMENT_BUCKET)
            .remove([uploadedPath]);

          if (removeError) {
            console.warn(
              "Could not remove the uploaded Supabase file:",
              removeError
            );
          }
        }

        // The scanner hook should keep the confirmation open on failure.
        throw err;
      }
    },
  });

  // ------------------------------------------------------------
  // STATS STATE
  // ------------------------------------------------------------

  const [stats, setStats] = useState([
    { label: "Total Colleges", value: 0 },
    { label: "Total Courses", value: 0 },
    { label: "Total Students", value: 0 },
    { label: "Credentials Stored", value: 0 },
    { label: "Total Requests", value: 0 },
    { label: "Current Requests", value: 0 },
  ]);

  const [loadingStats, setLoadingStats] = useState(true);

  // ------------------------------------------------------------
  // NEW STUDENTS STATE
  // ------------------------------------------------------------

  const [students, setStudents] = useState([]);
  const [totalStudents, setTotalStudents] = useState(0);
  const [loadingStudents, setLoadingStudents] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);

  // ------------------------------------------------------------
  // FETCH DASHBOARD STAT COUNTS
  // ------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    const fetchStats = async () => {
      setLoadingStats(true);

      try {
        const [
          collegesRes,
          coursesRes,
          studentsRes,
          credentialsRes,
          totalRequestsRes,
          currentRequestsRes,
        ] = await Promise.all([
          supabase
            .from("tbl_college")
            .select("*", { count: "exact", head: true }),

          supabase
            .from("tbl_program")
            .select("*", { count: "exact", head: true }),

          supabase
            .from("tbl_student")
            .select("*", { count: "exact", head: true }),

          supabase
            .from("tbl_student_documents")
            .select("*", { count: "exact", head: true }),

          supabase
            .from("tbl_request")
            .select("*", { count: "exact", head: true }),

          supabase
            .from("tbl_request_document")
            .select("*", { count: "exact", head: true })
            .eq("status", "Pending"),
        ]);

        const results = [
          collegesRes,
          coursesRes,
          studentsRes,
          credentialsRes,
          totalRequestsRes,
          currentRequestsRes,
        ];

        const failedResult = results.find((result) => result.error);

        if (failedResult?.error) {
          throw failedResult.error;
        }

        if (cancelled) return;

        setStats([
          {
            label: "Total Colleges",
            value: collegesRes.count ?? 0,
          },
          {
            label: "Total Courses",
            value: coursesRes.count ?? 0,
          },
          {
            label: "Total Students",
            value: studentsRes.count ?? 0,
          },
          {
            label: "Credentials Stored",
            value: credentialsRes.count ?? 0,
          },
          {
            label: "Total Requests",
            value: totalRequestsRes.count ?? 0,
          },
          {
            label: "Current Requests",
            value: currentRequestsRes.count ?? 0,
          },
        ]);
      } catch (err) {
        console.error("Error fetching stats:", err);
      } finally {
        if (!cancelled) {
          setLoadingStats(false);
        }
      }
    };

    fetchStats();

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // ------------------------------------------------------------
  // FETCH NEWEST STUDENTS WITHOUT SAVED DOCUMENTS
  // ------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    const fetchStudents = async () => {
      setLoadingStudents(true);

      try {
        const [studentRes, documentRes] = await Promise.all([
          supabase
            .from("tbl_student")
            .select(`
              student_id,
              first_name,
              middle_name,
              last_name,
              year_level,
              tbl_college ( college_name ),
              tbl_program ( program_name )
            `)
            .order("student_id", { ascending: false }),

          supabase
            .from("tbl_student_documents")
            .select("student_id"),
        ]);

        if (studentRes.error) throw studentRes.error;
        if (documentRes.error) throw documentRes.error;

        if (cancelled) return;

        const studentsWithDocuments = new Set(
          (documentRes.data ?? []).map((doc) =>
            String(doc.student_id)
          )
        );

        const eligibleStudents = (studentRes.data ?? []).filter(
          (student) =>
            !studentsWithDocuments.has(String(student.student_id))
        );

        const total = eligibleStudents.length;
        const totalPages = Math.max(
          1,
          Math.ceil(total / ROWS_PER_PAGE)
        );

        const safePage = Math.min(currentPage, totalPages);

        if (safePage !== currentPage) {
          setCurrentPage(safePage);
        }

        const from = (safePage - 1) * ROWS_PER_PAGE;

        const pageStudents = eligibleStudents.slice(
          from,
          from + ROWS_PER_PAGE
        );

        setStudents(
          pageStudents.map((s) => {
            const college = Array.isArray(s.tbl_college)
              ? s.tbl_college[0]
              : s.tbl_college;

            const program = Array.isArray(s.tbl_program)
              ? s.tbl_program[0]
              : s.tbl_program;

            return {
              id: s.student_id,
              name: [
                s.first_name,
                s.middle_name,
                s.last_name,
              ]
                .filter(Boolean)
                .join(" "),
              department: college?.college_name ?? "—",
              course: program?.program_name ?? "—",
              year: formatYear(s.year_level),
            };
          })
        );

        setTotalStudents(total);
      } catch (err) {
        if (!cancelled) {
          console.error("Error fetching new students:", err);
          setStudents([]);
          setTotalStudents(0);
        }
      } finally {
        if (!cancelled) {
          setLoadingStudents(false);
        }
      }
    };

    fetchStudents();

    return () => {
      cancelled = true;
    };
  }, [currentPage, refreshKey]);

  const totalPages = Math.max(
    1,
    Math.ceil(totalStudents / ROWS_PER_PAGE)
  );

  const showingFrom =
    totalStudents === 0
      ? 0
      : (currentPage - 1) * ROWS_PER_PAGE + 1;

  const showingTo = Math.min(
    currentPage * ROWS_PER_PAGE,
    totalStudents
  );

  // RBAC: only show the menu items this role may open.
  const navItems = [
    "Dashboard",
    "Students",
    "Departments",
    "Requests",
  ].filter((item) => canAccess(item));

  // ------------------------------------------------------------
  // PAGE
  // ------------------------------------------------------------

  return (
    <div className="dash-layout">
      {/* SIDEBAR */}
      <aside
        className="sidebar"
        style={{
          width: sidebarOpen ? "240px" : "0px",
        }}
      >
        <div className="sidebar-brand">
          <h1 className="sidebar-brand-title">RegisScan</h1>
          <p className="sidebar-brand-sub">Management System</p>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item}
              onClick={() => setActivePage(item)}
              className={
                activePage === item
                  ? "sidebar-nav-item-active"
                  : "sidebar-nav-item"
              }
            >
              {item}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <p className="sidebar-footer-text">
            USTP · Registrar
          </p>
        </div>
      </aside>

      {/* MAIN */}
      <div className="dash-main">
        {/* TOPBAR */}
        <header className="topbar">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="topbar-toggle"
            >
              <span className="topbar-hamburger-line" />
              <span className="topbar-hamburger-line" />
              <span className="topbar-hamburger-line" />
            </button>

            <span className="topbar-page-title">
              {activePage}
            </span>
          </div>

          <div className="relative">
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="topbar-staff-btn"
            >
              <div className="text-right">
                <p className="topbar-staff-name">
                  {staffName}
                </p>
                <p className="topbar-staff-role">
                  Registrar Staff
                </p>
              </div>

              <div className="topbar-avatar">
                {(staffName || "")
                  .split(" ")
                  .map((n) => n[0])
                  .join("")
                  .slice(0, 2)}
              </div>
            </button>

            {dropdownOpen && (
              <div className="topbar-dropdown">
                <button
                  className="topbar-dropdown-logout"
                  onClick={async () => {
                    setDropdownOpen(false);
                    await onLogout();
                  }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </header>

        {/* CONTENT */}
        <main className="dash-content">
          {activePage === "Dashboard" ? (
            <>
              <div className="mb-8" />

              {/* STAT CARDS */}
              <div className="grid grid-cols-3 gap-5 mb-10">
                {loadingStats
                  ? Array(6)
                      .fill(null)
                      .map((_, i) => (
                        <div
                          key={i}
                          className="stat-card stat-card-default"
                        >
                          <p className="stat-label">
                            Loading...
                          </p>
                          <p className="stat-value">—</p>
                          <div className="stat-accent" />
                        </div>
                      ))
                  : stats.map((stat, i) => {
                      const highlighted = i === 5;

                      return (
                        <div
                          key={i}
                          className={`stat-card ${
                            highlighted
                              ? "stat-card-highlighted"
                              : "stat-card-default"
                          }`}
                        >
                          <p
                            className={
                              highlighted
                                ? "stat-label-highlighted"
                                : "stat-label"
                            }
                          >
                            {stat.label}
                          </p>

                          <p
                            className={
                              highlighted
                                ? "stat-value-highlighted"
                                : "stat-value"
                            }
                          >
                            {stat.value.toLocaleString()}
                          </p>

                          <div
                            className={
                              highlighted
                                ? "stat-accent-highlighted"
                                : "stat-accent"
                            }
                          />
                        </div>
                      );
                    })}
              </div>

              {/* NEW STUDENTS */}
              <div className="activity-wrapper">
                <div className="activity-header">
                  <div>
                    <h3 className="activity-header-title">
                      New Students
                    </h3>
                    <p className="activity-header-sub">
                      Recently added student records
                    </p>
                  </div>

                  <div
  style={{
    display: "flex",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap",
  }}
>
  <button
    type="button"
    className="scan-btn"
    onClick={() => scanner.open()}
    disabled={scanner.uploading}
  >
    Scan Document
  </button>

  <button
    type="button"
    className="scan-btn"
    onClick={() => uploadInputRef.current?.click()}
    disabled={scanner.uploading}
  >
    Upload Document
  </button>
</div>
                </div>

                <table className="w-full text-sm">
                  <thead>
                    <tr className="activity-thead">
                      <th className="activity-th-first">
                        Student ID
                      </th>
                      <th className="activity-th">
                        Full Name
                      </th>
                      <th className="activity-th">
                        Department
                      </th>
                      <th className="activity-th">
                        Course
                      </th>
                      <th className="activity-th">
                        Year Level
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {loadingStudents ? (
                      <tr>
                        <td
                          colSpan={5}
                          style={{
                            textAlign: "center",
                            padding: "24px",
                            color: "#6b7280",
                          }}
                        >
                          Loading students...
                        </td>
                      </tr>
                    ) : students.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          style={{
                            textAlign: "center",
                            padding: "24px",
                            color: "#6b7280",
                          }}
                        >
                          No students found.
                        </td>
                      </tr>
                    ) : (
                      students.map((student, i) => (
                        <tr
                          key={student.id}
                          className={
                            i % 2 === 0
                              ? "activity-row-even"
                              : "activity-row-odd"
                          }
                        >
                          <td className="activity-td-staff">
                            {student.id}
                          </td>

                          <td className="activity-td-name">
                            <button
                              type="button"
                              onClick={() =>
                                onViewStudent &&
                                onViewStudent(student.id)
                              }
                              style={{
                                background: "none",
                                border: "none",
                                padding: 0,
                                font: "inherit",
                                color: "inherit",
                                cursor: "pointer",
                                textDecoration: "underline",
                                textAlign: "left",
                              }}
                            >
                              {student.name}
                            </button>
                          </td>

                          <td className="activity-td-action">
                            {student.department}
                          </td>

                          <td className="activity-td-action">
                            {student.course}
                          </td>

                          <td className="activity-td-year">
                            {student.year}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>

                {/* PAGINATION */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: "16px",
                    padding: "0 4px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "0.85rem",
                      color: "#6b7280",
                    }}
                  >
                    Showing{" "}
                    <strong style={{ color: "#111827" }}>
                      {showingFrom}
                    </strong>{" "}
                    –{" "}
                    <strong style={{ color: "#111827" }}>
                      {showingTo}
                    </strong>{" "}
                    of{" "}
                    <strong style={{ color: "#111827" }}>
                      {totalStudents}
                    </strong>
                  </span>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    <button
                      onClick={() =>
                        setCurrentPage((p) =>
                          Math.max(1, p - 1)
                        )
                      }
                      disabled={currentPage === 1}
                      style={{
                        border: "none",
                        background: "transparent",
                        fontSize: "0.85rem",
                        fontWeight: 500,
                        color:
                          currentPage === 1
                            ? "#c7cad1"
                            : "#6b7280",
                        cursor:
                          currentPage === 1
                            ? "not-allowed"
                            : "pointer",
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
                        setCurrentPage((p) =>
                          Math.min(totalPages, p + 1)
                        )
                      }
                      disabled={currentPage === totalPages}
                      style={{
                        border: "none",
                        background: "transparent",
                        fontSize: "0.85rem",
                        fontWeight: 500,
                        color:
                          currentPage === totalPages
                            ? "#c7cad1"
                            : "#6b7280",
                        cursor:
                          currentPage === totalPages
                            ? "not-allowed"
                            : "pointer",
                        padding: "6px 10px",
                      }}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            children
          )}
        </main>
      </div>

      {/* HIDDEN FILE INPUT */}
<input
  ref={uploadInputRef}
  type="file"
  accept=".jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff,image/jpeg,image/png,image/webp"
  style={{ display: "none" }}
  onChange={handleDocumentUpload}
/>

{/* SCAN MODAL + OCR CONFIRMATION */}
<DocumentScanner scanner={scanner} />
    </div>
  );
}