import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import DocumentScanner from "./DocumentScanner.jsx";
import useDocumentScanner from "./useDocumentScanner";
import { isPdf } from "./scannerUtils";
import { logActivity } from "./activityLog";
import "./styles/Students.css";
import "./styles/StudentProfile.css";
import "./styles/Dashboard.css";

const BUCKET = "student-documents";

// Local Flask scanner server.
const FOLDER_SERVER = "http://127.0.0.1:5000";

const statuses = ["Active", "LOA", "Inactive", "Graduated"];

const yearLevels = [
  { value: 1, label: "1st Year" },
  { value: 2, label: "2nd Year" },
  { value: 3, label: "3rd Year" },
  { value: 4, label: "4th Year" },
  { value: 5, label: "5th Year" },
];

const initialStudent = {
  student_id: "",
  first_name: "",
  last_name: "",
  middle_name: "",
  birthdate: "",
  gender: "",
  email: "",
  college_id: "",
  program_id: "",
  year_level: "",
  status: "Active",
};

const credentialNames = [
  "Certification of Live Birth",
  "Form 138",
  "Form 137",
  "Good Moral",
  "Transcript of Records",
  "Leave of Absence",
  "Withdrawal",
];

const initialCredentials = credentialNames.map((name) => ({
  name,
  date: null,
  status: "Not Uploaded",
  file: null,
  file_path: null,
  file_url: null,
}));

const EXT_BY_TYPE = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const safeFileName = (name) =>
  (name || "document")
    .replace(/^.*[\\/]/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_");

const storageFolder = (s) => `students/${s.student_id}`;

const docSlug = (name) =>
  (name || "other")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "other";

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const MIME_BY_EXT = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const mimeFromName = (name) =>
  MIME_BY_EXT[
    (name || "").split("?")[0].split(".").pop().toLowerCase()
  ] || "";

const looksPdf = (cred) =>
  /\.pdf(\?|$)/i.test(
    cred.file_path || cred.file || cred.file_url || ""
  );

const statusClass = (status) => {
  switch (status) {
    case "Active":
      return "profile-status-active";
    case "LOA":
      return "profile-status-loa";
    case "Graduated":
      return "profile-status-graduated";
    default:
      return "profile-status-inactive";
  }
};

const isVerified = (status) =>
  status === "Verified" || status === "Active";

const credStatusClass = (status) => {
  if (isVerified(status)) return "cred-verified";
  if (status === "Pending") return "cred-pending";
  return "cred-not-uploaded";
};

const verifiedCount = (creds) =>
  creds.filter((c) => isVerified(c.status)).length;

// ------------------------------------------------------------
// FILE HELPERS
// ------------------------------------------------------------

// Reads a scanned file from a data URL, HTTP URL, blob URL,
// or an existing path inside the Supabase Storage bucket.
const readSourceBlob = async (sourceUrl) => {
  if (!sourceUrl) {
    throw new Error(
      "The scanned image is missing. Please scan the document again."
    );
  }

  if (/^(https?:|blob:|data:)/i.test(sourceUrl)) {
    const res = await fetch(sourceUrl);

    if (!res.ok) {
      throw new Error(
        `Could not read the scanned file (${res.status}).`
      );
    }

    return res.blob();
  }

  const { data, error: downloadError } = await supabase.storage
    .from(BUCKET)
    .download(sourceUrl);

  if (downloadError) throw downloadError;

  return data;
};

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.split(",")[1] || "");
    };

    reader.onerror = () => {
      reject(new Error("Could not read the scanned file."));
    };

    reader.readAsDataURL(blob);
  });

// Converts a Blob to a data URL accepted by the Flask /store-scan endpoint.
const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      resolve(String(reader.result || ""));
    };

    reader.onerror = () => {
      reject(new Error("Could not prepare the scanned image."));
    };

    reader.readAsDataURL(blob);
  });

// ------------------------------------------------------------
// COMPONENT
// ------------------------------------------------------------

export default function StudentProfile({ studentId, onBack }) {
  const [student, setStudent] = useState(initialStudent);
  const [colleges, setColleges] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [credentials, setCredentials] = useState(initialCredentials);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Document Upload
  const uploadInputRef = useRef(null);
  const [uploadingFile, setUploadingFile] = useState(false);

  // Preview
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewCred, setPreviewCred] = useState(null);
  const [zoom, setZoom] = useState(100);

  // Edit
  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm, setEditForm] = useState(initialStudent);

  const showEditModalRef = useRef(showEditModal);

  useEffect(() => {
    showEditModalRef.current = showEditModal;
  }, [showEditModal]);

  // ============================================================
  // DOCUMENT STORAGE
  // ============================================================

  // Upload the scanned document to Supabase.
  // This path is stored in tbl_student_documents and used by Preview.
  const uploadToStudentFolder = async ({
    sourceUrl,
    fileName,
    documentName,
  }) => {
    const folder = `${storageFolder(student)}/${docSlug(documentName)}`;
    const blob = await readSourceBlob(sourceUrl);

    let name = safeFileName(fileName);

    if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) {
      const extension = EXT_BY_TYPE[blob.type];

      if (extension) {
        name += `.${extension}`;
      } else {
        name += ".jpg";
      }
    }

    const stamp = new Date()
      .toISOString()
      .replace(/\D/g, "")
      .slice(0, 14);

    const path = `${folder}/${stamp}_${name}`;

    const contentType =
      blob.type || mimeFromName(name) || "image/jpeg";

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, blob, {
        contentType,
        upsert: false,
      });

    if (uploadError) throw uploadError;

    return {
      path,
      blob,
      name,
    };
  };

  // Save the actual scanned image into:
  // C:\StudentRecords\<College>\<StudentID>_<StudentName>\
  //
  // This uses the /store-scan endpoint in app.py.
  const saveToLocalFolder = async ({
    blob,
    name,
    documentName,
  }) => {
    const college =
      colleges.find(
        (c) =>
          Number(c.college_id) === Number(student.college_id)
      )?.college_name || "";

    if (!college) {
      throw new Error(
        "The student's college could not be identified. Please check the student record."
      );
    }

    if (!blob || !blob.type.startsWith("image/")) {
      throw new Error(
        "The scanner did not provide an image that can be saved to the local student folder."
      );
    }

    const imageDataUrl = await blobToDataUrl(blob);

    const response = await fetch(`${FOLDER_SERVER}/store-scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_data_url: imageDataUrl,
        document_type: documentName,
        student: {
          student_id: student.student_id,
          first_name: student.first_name || "",
          middle_name: student.middle_name || "",
          last_name: student.last_name || "",
          college_name: college,
        },
      }),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.success || !result.stored_path) {
      throw new Error(
        result.error ||
          result.message ||
          `Could not save the scanned file to the local student folder (HTTP ${response.status}).`
      );
    }

    return result.stored_path;
  };

  // ============================================================
  // LOAD SAVED DOCUMENTS
  // ============================================================

  const loadDocuments = async (sid) => {
    const { data, error: docError } = await supabase
      .from("tbl_student_documents")
      .select(
        "student_documents_id, document_id, document_name, file_path, date_uploaded, status, tbl_documents(document_name)"
      )
      .eq("student_id", sid)
      .order("date_uploaded", { ascending: false });

    if (docError) throw docError;

    const merged = initialCredentials.map((c) => ({ ...c }));
    const seen = new Set();

    for (const row of data || []) {
      // Rows are newest first: display only the latest upload
      // for each document type.
      if (seen.has(row.document_id)) continue;
      seen.add(row.document_id);

      const typeName =
        row.tbl_documents?.document_name || "Document";

      const entry = {
        name: typeName,
        date: row.date_uploaded
          ? row.date_uploaded.split("T")[0]
          : null,
        status:
          !row.status || row.status === "Active"
            ? "Verified"
            : row.status,
        file: row.document_name,
        file_path: row.file_path,
        file_url: null,
      };

      const idx = merged.findIndex(
        (c) => norm(c.name) === norm(typeName)
      );

      if (idx >= 0) {
        merged[idx] = {
          ...entry,
          name: merged[idx].name,
        };
      } else {
        merged.push(entry);
      }
    }

    setCredentials(merged);
  };

  // ============================================================
  // SCANNER
  // ============================================================

  const today = () => new Date().toISOString().split("T")[0];

  const scanner = useDocumentScanner({
    studentId: student.student_id,

    // Update the selected credential row after a scan.
    onScanned: (credential, result) => {
      if (!credential) return;

      const previewSource =
        result?.file_url ||
        result?.fileUrl ||
        result?.image_data_url ||
        result?.imageDataUrl ||
        "";

      setCredentials((prev) =>
        prev.map((cred) =>
          cred.name === credential.name
            ? {
                ...cred,
                date: today(),
                status: "Pending",
                file: result?.filename || result?.fileName || cred.file,
                file_url: previewSource || null,
              }
            : cred
        )
      );
    },

    // Refresh the credential list if the scan is cancelled.
    onCancelled: () => {
      if (!student.student_id) return;

      loadDocuments(student.student_id).catch((err) =>
        console.warn("Could not refresh documents:", err)
      );
    },

    // Called when the OCR confirmation is saved.
    onConfirmed: async (
      {
        documentId,
        documentType,
        fileName,
        fileUrl,
        imageDataUrl,
      },
      selectedCredential
    ) => {
      let uploadedPath = null;

      try {
        const sid = student.student_id;

        if (!sid) {
          throw new Error("No student is selected.");
        }

        // Prefer the actual image data from OCR confirmation.
        // This avoids trying to fetch an empty fileUrl.
        const sourceUrl =
          imageDataUrl ||
          fileUrl ||
          "";

        if (!sourceUrl) {
          throw new Error(
            "The scanned image is missing. Please scan the document again and check the preview before saving."
          );
        }

        // Resolve the document type ID.
        let docId = documentId;

        if (!docId && documentType) {
          const { data, error: docError } = await supabase
            .from("tbl_documents")
            .select("document_id")
            .ilike("document_name", documentType)
            .maybeSingle();

          if (docError) throw docError;

          docId = data?.document_id;
        }

        if (!docId) {
          throw new Error(
            "Document type was not identified. Please select a document type."
          );
        }

        // Fetch the official document type name.
        const { data: docRow, error: docRowError } = await supabase
          .from("tbl_documents")
          .select("document_name")
          .eq("document_id", docId)
          .maybeSingle();

        if (docRowError) throw docRowError;

        const typeName =
          docRow?.document_name ||
          documentType ||
          selectedCredential?.name ||
          "Other";

        // 1. Upload to Supabase.
        // This is the file source used by the Preview button.
        const uploaded = await uploadToStudentFolder({
          sourceUrl,
          fileName: fileName || `${docSlug(typeName)}.jpg`,
          documentName: typeName,
        });

        uploadedPath = uploaded.path;

        // 2. Save a copy to the local student folder using Flask.
        // Example:
        // C:\StudentRecords\CEA\2026302405_Arielle_Vermoy_Dades\
        const localPath = await saveToLocalFolder({
          blob: uploaded.blob,
          name: uploaded.name,
          documentName: typeName,
        });

        // 3. Save the Supabase path in the database.
        // Do not save the Windows path here because Preview downloads
        // this file from Supabase Storage.
        const { error: insertError } = await supabase
          .from("tbl_student_documents")
          .insert({
            student_id: sid,
            document_id: docId,
            document_name:
              (fileName || uploaded.name || `${typeName}.jpg`).slice(
                0,
                100
              ) || null,
            file_path: uploadedPath,
            date_uploaded: new Date().toISOString(),
            status: "Verified",
          });

        if (insertError) {
          throw new Error(
            `The file was saved to the local folder at ${localPath}, but its database record could not be created: ${insertError.message}`
          );
        }

        // 4. Record the upload in Audit Logs.
        logActivity({
          type: "Upload",
          description: `Scanned and saved ${typeName} for student ${sid}`,
          module: "Documents Module",
        });

        // 5. Reload documents so the saved file appears in the table.
        await loadDocuments(sid);

        return true;
      } catch (err) {
        console.error("Save scanned document failed:", err);

        // Remove the Supabase upload if the database save failed.
        // The local file, if already saved, is not automatically removed.
        if (uploadedPath) {
          const { error: removeError } = await supabase.storage
            .from(BUCKET)
            .remove([uploadedPath]);

          if (removeError) {
            console.warn(
              "Could not remove the unused Supabase file:",
              removeError
            );
          }
        }

                // The confirmation shows this error beside the failed document.
        throw err;
      }
    },
  });

  // ============================================================
// UPLOAD DOCUMENT USING OCR
// ============================================================

const handleDocumentUpload = async (e) => {
  const files = Array.from(e.target.files || []);

  // Allow selecting the same files again.
  e.target.value = "";

  if (!files.length) return;

  if (!student.student_id) {
    alert("No student is selected.");
    return;
  }

  try {
    setUploadingFile(true);
    setError("");

    // The hook checks each file's format and skips unsupported ones.
    await scanner.upload(files);
  } catch (err) {
    console.error("Document upload OCR error:", err);

    alert(
      err.message ||
        "Failed to upload and process the document. Please try again."
    );
  } finally {
    setUploadingFile(false);
  }
};

  // ============================================================
  // LOAD COLLEGES, PROGRAMS, STUDENT AND DOCUMENTS
  // ============================================================

  useEffect(() => {
    if (
      studentId === undefined ||
      studentId === null ||
      studentId === ""
    ) {
      setLoading(false);
      setError("No student selected.");
      return;
    }

    let cancelled = false;

    const loadData = async () => {
      try {
        setLoading(true);
        setError("");

        const [collegeRes, programRes, studentRes] =
          await Promise.all([
            supabase
              .from("tbl_college")
              .select("*")
              .order("college_name"),

            supabase
              .from("tbl_program")
              .select("*")
              .order("program_name"),

            supabase
              .from("tbl_student")
              .select("*")
              .eq("student_id", studentId)
              .single(),
          ]);

        if (collegeRes.error) throw collegeRes.error;
        if (programRes.error) throw programRes.error;
        if (studentRes.error) throw studentRes.error;

        if (cancelled) return;

        setColleges(collegeRes.data || []);
        setPrograms(programRes.data || []);
        setStudent(studentRes.data);
        setEditForm(studentRes.data);

        await loadDocuments(studentRes.data.student_id);
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Failed to load student.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadData();

    return () => {
      cancelled = true;
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  // ============================================================
  // REALTIME STUDENT UPDATES
  // ============================================================

  useEffect(() => {
    if (
      studentId === undefined ||
      studentId === null ||
      studentId === ""
    ) {
      return;
    }

    const channel = supabase
      .channel(`realtime:tbl_student:${studentId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tbl_student",
          filter: `student_id=eq.${studentId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setStudent(initialStudent);
            setError("This student record was deleted.");
            return;
          }

          setStudent(payload.new);

          if (!showEditModalRef.current) {
            setEditForm(payload.new);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [studentId]);

  // ============================================================
  // EDIT FORM
  // ============================================================

  const handleEditChange = (field, value) => {
    setEditForm((prev) => {
      const updated = {
        ...prev,
        [field]: value,
      };

      if (field === "college_id") {
        updated.program_id = "";
      }

      return updated;
    });
  };

  const handleEditSave = async () => {
    try {
      setSaving(true);
      setError("");

      const updateData = {
        first_name: editForm.first_name,
        last_name: editForm.last_name,
        middle_name: editForm.middle_name || null,
        birthdate: editForm.birthdate || null,
        gender: editForm.gender || null,
        email: editForm.email || null,
        college_id: editForm.college_id
          ? Number(editForm.college_id)
          : null,
        program_id: editForm.program_id
          ? Number(editForm.program_id)
          : null,
        year_level: editForm.year_level
          ? Number(editForm.year_level)
          : null,
        status: editForm.status || null,
      };

      const { data, error: updateError } = await supabase
        .from("tbl_student")
        .update(updateData)
        .eq("student_id", editForm.student_id)
        .select()
        .single();

      if (updateError) throw updateError;

      logActivity({
        type: "Update",
        description: `Updated information of student ${editForm.student_id}`,
        module: "Students Module",
      });

      setStudent(data);
      setEditForm(data);
      setShowEditModal(false);
    } catch (err) {
      console.error("Update error:", err);
      setError(err.message || "Failed to update student.");
    } finally {
      setSaving(false);
    }
  };

  // ============================================================
  // DERIVED DISPLAY DATA
  // ============================================================

  const filteredPrograms = programs.filter(
    (program) =>
      Number(program.college_id) === Number(editForm.college_id)
  );

  const collegeName =
    colleges.find(
      (c) => Number(c.college_id) === Number(student.college_id)
    )?.college_name || "—";

  const programName =
    programs.find(
      (p) => Number(p.program_id) === Number(student.program_id)
    )?.program_name || "—";

  const yearName =
    yearLevels.find(
      (y) => Number(y.value) === Number(student.year_level)
    )?.label || "—";

  const fullName = [
    student.first_name,
    student.middle_name,
    student.last_name,
  ]
    .filter(Boolean)
    .join(" ");

  const initials =
    fullName
      .split(" ")
      .filter(Boolean)
      .map((n) => n[0])
      .join("")
      .slice(0, 2) || "ST";

  // ============================================================
  // PREVIEW
  // ============================================================

  const closePreview = () => {
    setShowPreviewModal(false);

    setPreviewCred((prev) => {
      if (prev?.blob_url) {
        URL.revokeObjectURL(prev.blob_url);
      }

      return null;
    });
  };

  const handlePreview = async (cred) => {
    setError("");

    let url = cred.file_url || null;
    let blobUrl = null;
    let pdf = looksPdf(cred);
    let previewError = "";

    // Download the private Supabase Storage file and display it
    // using a temporary browser blob URL.
    if (!url && cred.file_path) {
      try {
        if (/^https?:\/\//i.test(cred.file_path)) {
          // Compatibility with older records containing a URL.
          try {
            const res = await fetch(cred.file_path);

            if (!res.ok) {
              throw new Error(`HTTP ${res.status}`);
            }

            let blob = await res.blob();

            if (
              !blob.type ||
              blob.type === "application/octet-stream"
            ) {
              const guessed = mimeFromName(cred.file_path);

              if (guessed) {
                blob = new Blob([blob], { type: guessed });
              }
            }

            if (blob.type === "application/pdf") {
              pdf = true;
            }

            blobUrl = URL.createObjectURL(blob);
            url = blobUrl;
          } catch (fetchErr) {
            console.warn(
              "Old file link could not be fetched:",
              fetchErr
            );
          }
        } else {
          const { data, error: downloadError } =
            await supabase.storage
              .from(BUCKET)
              .download(cred.file_path);

          if (downloadError) throw downloadError;

          let blob = data;

          if (
            !blob.type ||
            blob.type === "application/octet-stream"
          ) {
            const guessed = mimeFromName(cred.file_path);

            if (guessed) {
              blob = new Blob([data], { type: guessed });
            }
          }

          if (blob.type === "application/pdf") {
            pdf = true;
          }

          blobUrl = URL.createObjectURL(blob);
          url = blobUrl;
        }
      } catch (err) {
        console.error("Preview failed:", err);

        previewError =
          (err && (err.message || err.error_description)) ||
          "Could not load the file.";
      }
    }

    setPreviewCred({
      ...cred,
      file_url: url,
      blob_url: blobUrl,
      is_pdf: pdf,
      preview_error: previewError,
    });

    setZoom(100);
    setShowPreviewModal(true);

    logActivity({
      type: "View",
      description: `Viewed ${cred.name} of student ${student.student_id}`,
      module: "Documents Module",
    });
  };

  // ============================================================
  // LOADING / NOT FOUND
  // ============================================================

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>Loading student information...</p>
      </div>
    );
  }

  if (!student.student_id) {
    return (
      <div className="profile-content">
        {onBack && (
          <button className="profile-edit-btn" onClick={onBack}>
            ← Back to students
          </button>
        )}

        <div className="mt-4 p-3 rounded bg-red-100 text-red-700">
          {error || "Student not found."}
        </div>
      </div>
    );
  }

  // ============================================================
  // PAGE
  // ============================================================

  return (
    <div className="profile-content">
      <div style={{ width: "100%" }}>
        {/* BACK BUTTON */}
        {onBack && (
          <button
            className="profile-edit-btn"
            style={{ marginBottom: "1rem" }}
            onClick={onBack}
          >
            ← Back to students
          </button>
        )}

        {/* ERROR */}
        {error && (
          <div className="mb-4 p-3 rounded bg-red-100 text-red-700">
            {error}
          </div>
        )}

        {/* STUDENT HEADER */}
        <div className="profile-header-card">
          <div className="flex items-center">
            <div className="profile-avatar">{initials}</div>

            <div>
              <h2 className="profile-student-name">
                {fullName || "No Student Name"}
              </h2>

              <p className="profile-student-id">
                {student.student_id}
              </p>

              <div className="profile-student-meta">
                <span className={statusClass(student.status)}>
                  {student.status}
                </span>

                <span className="profile-meta-tag">
                  {collegeName} · {programName} · {yearName}
                </span>
              </div>
            </div>
          </div>

          <div
  className="profile-header-actions"
  style={{
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "10px",
    width: "50%",
    maxWidth: "300px",
    margin: "15px auto 0",
  }}
>
  {/* SCAN DOCUMENT */}
  <button
    className="profile-edit-btn"
    style={{
      width: "100%",
      margin: 0,
      padding: "10px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      boxSizing: "border-box",
    }}
    onClick={() => scanner.open()}
    disabled={uploadingFile}
  >
    Scan Document
  </button>

  {/* UPLOAD DOCUMENT */}
  <button
    className="profile-edit-btn"
    style={{
      width: "100%",
      margin: 0,
      padding: "10px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      boxSizing: "border-box",
    }}
    onClick={() => uploadInputRef.current?.click()}
    disabled={uploadingFile}
  >
    {uploadingFile ? "Processing..." : "Upload Document"}
  </button>

  {/* HIDDEN FILE INPUT */}
  <input
    ref={uploadInputRef}
    type="file"
    multiple
    accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff"
    style={{ display: "none" }}
    onChange={handleDocumentUpload}
  />

  {/* EDIT INFORMATION */}
  <button
    className="profile-edit-btn"
    style={{
      gridColumn: "1 / -1",
      justifySelf: "center",
      width: "fit-content",
      margin: 0,
      textAlign: "center",
    }}
    onClick={() => {
      setEditForm(student);
      setShowEditModal(true);
    }}
  >
    Edit Information
  </button>
</div>
    </div>

        {/* STUDENT INFORMATION */}
        <div className="profile-info-card">
          <div className="profile-info-grid">
            {[
              ["Email", student.email],
              ["Gender", student.gender],
              ["Birthdate", student.birthdate],
              ["Year Level", yearName],
              ["College", collegeName],
              ["Program", programName],
              [
                "Document Folder",
                student.folder_path || storageFolder(student),
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="profile-info-label">{label}</p>
                <p className="profile-info-value">{value || "—"}</p>
              </div>
            ))}
          </div>
        </div>

        {/* CREDENTIALS */}
        <div className="credentials-card">
          <div className="credentials-header">
            <h3 className="credentials-title">
              Credential Documents
            </h3>

            <span className="credentials-count">
              {verifiedCount(credentials)}/{credentials.length} verified
            </span>
          </div>

          <table className="credentials-table">
            <thead>
              <tr className="credentials-thead">
                <th className="credentials-th-first">
                  Credential Name
                </th>
                <th className="credentials-th">Upload Date</th>
                <th className="credentials-th">
                  Verification Status
                </th>
                <th className="credentials-th">File Attachment</th>
                <th className="credentials-th">Action</th>
              </tr>
            </thead>

            <tbody>
              {credentials.map((cred, i) => (
                <tr
                  key={cred.name}
                  className={
                    i % 2 === 0
                      ? "credentials-row-even"
                      : "credentials-row-odd"
                  }
                >
                  <td className="credentials-td-first">
                    {cred.name}
                  </td>

                  <td className="credentials-td">
                    {cred.date ?? "—"}
                  </td>

                  <td className="credentials-td">
                    <span className={credStatusClass(cred.status)}>
                      {cred.status}
                    </span>
                  </td>

                  <td className="credentials-td-file">
                    {cred.file ? (
                      cred.file
                    ) : (
                      <span className="text-gray-300">No file</span>
                    )}
                  </td>

                  {/* CHANGED: per-row Scan / Rescan buttons removed; only Preview remains */}
                  <td className="credentials-td">
                    <div style={{ display: "flex", gap: "8px" }}>
                      {cred.file && (
                        <button
                          className="cred-preview-btn"
                          onClick={() => handlePreview(cred)}
                        >
                          Preview
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* SCAN MODAL + OCR CONFIRMATION */}
      <DocumentScanner
        scanner={scanner}
        studentId={student.student_id}
        studentName={fullName}
      />

      {/* PREVIEW MODAL */}
      {showPreviewModal && previewCred && (
        <div className="modal-overlay" onClick={closePreview}>
          <div
            className="preview-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="preview-modal-header">
              <h3 className="preview-modal-title">
                {previewCred.name}
              </h3>

              <span className="text-xs text-gray-400">
                {previewCred.file}
              </span>
            </div>

            <div className="preview-modal-body">
              {previewCred.file_url ? (
                previewCred.is_pdf ||
                isPdf(previewCred.file_url) ? (
                  <iframe
                    title={previewCred.name}
                    src={previewCred.file_url}
                    style={{
                      width: "100%",
                      height: "500px",
                      border: 0,
                    }}
                  />
                ) : (
                                                      <>
                    <div
                      style={{
                        maxHeight: "400px",
                        overflow: "auto",
                        textAlign: "center",
                      }}
                    >
                      <img
                        src={previewCred.file_url}
                        alt={previewCred.name}
                        onError={() =>
                          setPreviewCred((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  file_url: null,
                                  preview_error: `The file link did not load (${
                                    prev.file_path || "unknown path"
                                  }).`,
                                }
                              : prev
                          )
                        }
                        style={{
                          display: "block",
                          margin: "0 auto",
                          height: `${(375 * zoom) / 100}px`,
                          width: "auto",
                          maxWidth: "none",
                        }}
                      />
                    </div>

                    <div className="zoom-bar">
                      <button
                        type="button"
                        className="zoom-btn"
                        onClick={() => setZoom((z) => Math.max(50, z - 25))}
                        aria-label="Zoom out"
                      >
                        −
                      </button>

                      <input
                        type="range"
                        className="zoom-slider"
                        min="50"
                        max="300"
                        step="5"
                        value={zoom}
                        onChange={(e) => setZoom(Number(e.target.value))}
                        style={{
                          "--zoom-pct": `${((zoom - 50) / 250) * 100}%`,
                        }}
                      />

                      <button
                        type="button"
                        className="zoom-btn"
                        onClick={() => setZoom((z) => Math.min(300, z + 25))}
                        aria-label="Zoom in"
                      >
                        +
                      </button>

                      <span className="zoom-value">{zoom}%</span>

                      <button
                        type="button"
                        className="zoom-reset"
                        onClick={() => setZoom(100)}
                      >
                        Reset
                      </button>
                    </div>
                  </>
                )
              ) : (
                <div className="text-center">
                  <p className="text-4xl mb-4">📄</p>

                  <p className="text-gray-500 text-sm font-semibold">
                    {previewCred.file}
                  </p>

                  <p className="text-gray-400 text-xs mt-1">
                    {previewCred.preview_error
                      ? `Could not load the file: ${previewCred.preview_error}`
                      : "No preview available for this file yet"}
                  </p>
                </div>
              )}
            </div>

            <div className="preview-modal-footer">
              <button
                className="preview-close-btn"
                onClick={closePreview}
              >
                Close
              </button>

              {previewCred.file_url && (
                <a
                  href={previewCred.file_url}
                  download={previewCred.file}
                  target="_blank"
                  rel="noreferrer"
                  className="preview-download-btn"
                >
                  Download
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* EDIT INFORMATION MODAL */}
      {showEditModal && (
        <div
          className="modal-overlay"
          onClick={() => setShowEditModal(false)}
        >
          <div
            className="edit-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="edit-modal-title">Edit Information</h3>

            <p className="edit-modal-sub">
              Update the student's personal and academic details.
            </p>

            <div className="edit-grid">
              <div>
                <label className="edit-label">First Name</label>
                <input
                  className="edit-input"
                  value={editForm.first_name || ""}
                  onChange={(e) =>
                    handleEditChange("first_name", e.target.value)
                  }
                />
              </div>

              <div>
                <label className="edit-label">Last Name</label>
                <input
                  className="edit-input"
                  value={editForm.last_name || ""}
                  onChange={(e) =>
                    handleEditChange("last_name", e.target.value)
                  }
                />
              </div>
            </div>

            <div className="edit-grid">
              <div>
                <label className="edit-label">Middle Name</label>
                <input
                  className="edit-input"
                  value={editForm.middle_name || ""}
                  onChange={(e) =>
                    handleEditChange("middle_name", e.target.value)
                  }
                />
              </div>

              <div>
                <label className="edit-label">Student ID</label>
                <input
                  className="edit-input"
                  value={editForm.student_id || ""}
                  disabled
                />
              </div>
            </div>

            <div className="edit-grid">
              <div>
                <label className="edit-label">Gender</label>
                <select
                  className="edit-select"
                  value={editForm.gender || ""}
                  onChange={(e) =>
                    handleEditChange("gender", e.target.value)
                  }
                >
                  <option value="">Select Gender</option>
                  <option value="Female">Female</option>
                  <option value="Male">Male</option>
                  <option value="Prefer not to say">
                    Prefer not to say
                  </option>
                </select>
              </div>

              <div>
                <label className="edit-label">Birthdate</label>
                <input
                  className="edit-input"
                  type="date"
                  value={editForm.birthdate || ""}
                  onChange={(e) =>
                    handleEditChange("birthdate", e.target.value)
                  }
                />
              </div>
            </div>

            <div className="edit-grid">
              <div>
                <label className="edit-label">Status</label>
                <select
                  className="edit-select"
                  value={editForm.status || ""}
                  onChange={(e) =>
                    handleEditChange("status", e.target.value)
                  }
                >
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="edit-label">Year Level</label>
                <select
                  className="edit-select"
                  value={editForm.year_level || ""}
                  onChange={(e) =>
                    handleEditChange("year_level", e.target.value)
                  }
                >
                  <option value="">Select Year</option>

                  {yearLevels.map((year) => (
                    <option key={year.value} value={year.value}>
                      {year.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="edit-grid">
              <div>
                <label className="edit-label">College</label>
                <select
                  className="edit-select"
                  value={editForm.college_id || ""}
                  onChange={(e) =>
                    handleEditChange("college_id", e.target.value)
                  }
                >
                  <option value="">Select College</option>

                  {colleges.map((college) => (
                    <option
                      key={college.college_id}
                      value={college.college_id}
                    >
                      {college.college_name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="edit-label">Program</label>
                <select
                  className="edit-select"
                  value={editForm.program_id || ""}
                  onChange={(e) =>
                    handleEditChange("program_id", e.target.value)
                  }
                  disabled={!editForm.college_id}
                >
                  <option value="">Select Program</option>

                  {filteredPrograms.map((program) => (
                    <option
                      key={program.program_id}
                      value={program.program_id}
                    >
                      {program.program_name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="edit-label">Email</label>
            <input
              className="edit-input"
              type="email"
              value={editForm.email || ""}
              onChange={(e) =>
                handleEditChange("email", e.target.value)
              }
            />

            <div className="edit-footer">
              <button
                className="edit-cancel-btn"
                onClick={() => setShowEditModal(false)}
                disabled={saving}
              >
                Cancel
              </button>

              <button
                className="edit-save-btn"
                onClick={handleEditSave}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}