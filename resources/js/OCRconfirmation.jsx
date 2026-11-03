
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabaseClient";
import "./styles/OCRConfirmation.css";

const isPdf = (url) => /\.pdf(\?|#|$)/i.test(url || "");

// Normalize names for comparison.
const normalizeName = (name) =>
  String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

export default function OCRConfirmation({
  ocrResult = null,
  studentId = "",
  studentName = "",
  fileName = "",
  fileUrl = "",
  detectedDocType = "",
  documentTypeConfidence = null,
  onCancel,
  onSave,
}) {
  const [docs, setDocs] = useState([]);
  const [docsError, setDocsError] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [suggested, setSuggested] = useState(false);

  const [pickedStudent, setPickedStudent] = useState(null);
  const [editedStudentName, setEditedStudentName] = useState("");

  const [studentLookupStatus, setStudentLookupStatus] = useState("");

  const [saving, setSaving] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  // Use the scanned image returned by Flask when fileUrl is empty.
  const previewUrl =
    fileUrl ||
    ocrResult?.image_data_url ||
    ocrResult?.file_url ||
    ocrResult?.fileUrl ||
    "";

  const previewIsPdf = isPdf(previewUrl);

  // Reset preview error whenever a new scan is loaded.
  useEffect(() => {
    setPreviewError(false);
  }, [previewUrl]);

  // OCR-extracted name.
  const ocrName = {
    first: ocrResult?.first_name || "",
    middle: ocrResult?.middle_name || "",
    last: ocrResult?.last_name || "",
  };

  const ocrFullName = [
    ocrName.first,
    ocrName.middle,
    ocrName.last,
  ]
    .filter(Boolean)
    .join(" ");

  // Possible student matches returned by the backend.
  const candidates = Array.isArray(ocrResult?.student_candidates)
    ? ocrResult.student_candidates
    : [];

  const matchedStudent = ocrResult?.matched_student || null;

  // Combine matched student and possible candidates.
  // Remove duplicate records using student_id.
  const studentOptions = [
    ...(matchedStudent ? [matchedStudent] : []),
    ...candidates,
  ].filter(
    (student, index, self) =>
      student?.student_id &&
      self.findIndex(
        (s) =>
          String(s.student_id) === String(student.student_id)
      ) === index
  );

  // 1. Load document types from the database.
  useEffect(() => {
    let cancelled = false;

    const loadDocumentTypes = async () => {
      try {
        const { data, error } = await supabase
          .from("tbl_documents")
          .select("document_id, document_name")
          .order("document_name");

        if (cancelled) return;

        if (error) {
          console.error("Failed to load document types:", error);

          setDocsError(
            "Could not load document types from the database."
          );
          return;
        }

        if (!data?.length) {
          setDocs([]);
          setDocsError(
            "No document types were found in the database."
          );
          return;
        }

        setDocs(data);
        setDocsError("");
      } catch (error) {
        if (cancelled) return;

        console.error("Error loading document types:", error);

        setDocsError(
          "Could not load document types from the database."
        );
      }
    };

    loadDocumentTypes();

    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Automatically select the detected document type.
  useEffect(() => {
    if (!docs.length) return;

    const label = (
      ocrResult?.document_type ||
      detectedDocType ||
      ""
    )
      .trim()
      .toLowerCase();

    // First: match the document ID returned by the classifier.
    let match = ocrResult?.document_id
      ? docs.find(
          (d) =>
            String(d.document_id) ===
            String(ocrResult.document_id)
        )
      : null;

    // Second: match the detected document name.
    if (!match && label && label !== "unknown") {
      match = docs.find(
        (d) =>
          String(d.document_name || "")
            .trim()
            .toLowerCase() === label
      );
    }

    if (match) {
      setDocumentId(String(match.document_id));
      setSuggested(false);
      return;
    }

    // Third: use the classifier's best suggestion.
    const top = ocrResult?.document_type_suggestions?.[0];

    if (top) {
      const suggestedDoc = docs.find(
        (d) =>
          String(d.document_id) ===
          String(top.document_id)
      );

      if (suggestedDoc) {
        setDocumentId(String(suggestedDoc.document_id));
        setSuggested(true);
        return;
      }
    }

    // No valid match: keep the current selection if possible.
    setDocumentId((currentId) => {
      const stillExists = docs.some(
        (d) => String(d.document_id) === currentId
      );

      return stillExists ? currentId : "";
    });

    setSuggested(false);
  }, [docs, ocrResult, detectedDocType]);


// 3. Initialize the editable student name whenever a new scan loads.
useEffect(() => {
    const initialName = studentId
        ? studentName
        : ocrFullName;

    setEditedStudentName(initialName);
    setPickedStudent(null);
    setStudentLookupStatus("");

    // Automatically search the database using the OCR name.
    // No need to edit or blur the Student Name field.
    if (!studentId && initialName.trim()) {
        handleStudentNameBlur(initialName);
    }
}, [ocrResult, studentId, studentName]);


// 4. Find the student record using the provided name.
const handleStudentNameBlur = async (
    nameToCheck = editedStudentName
) => {
    const searchName = nameToCheck.trim();

    if (!searchName) {
      setPickedStudent(null);
      setStudentLookupStatus(
        "Please enter the student's name."
      );
      return;
    }

    // Existing Student Profile scans already have a student ID.
    if (studentId) {
      setStudentLookupStatus(
        "Existing student record."
      );
      return;
    }

    setStudentLookupStatus("Checking student record...");

    setPickedStudent(null);

    try {
      // First: check the candidates already returned by OCR.
      const candidateMatch = studentOptions.find((student) => {
        const fullName = [
          student.first_name,
          student.middle_name,
          student.last_name,
        ]
          .filter(Boolean)
          .join(" ");

        return (
          normalizeName(fullName) ===
          normalizeName(searchName)
        );
      });

      if (candidateMatch) {
        setPickedStudent(candidateMatch);

        setStudentLookupStatus(
          "Student record found. Student ID automatically loaded."
        );
        return;
      }

      // Second: search the actual student table.
      // Assumes student name columns are first_name,
      // middle_name, and last_name.
      const nameParts = searchName
        .split(/\s+/)
        .filter(Boolean);

      if (nameParts.length < 2) {
        setStudentLookupStatus(
          "Please enter the student's complete name."
        );
        return;
      }

      const firstName = nameParts[0];
      const lastName = nameParts[nameParts.length - 1];
      const middleName = nameParts
        .slice(1, -1)
        .join(" ");

      let query = supabase
        .from("tbl_student")
        .select(
          "student_id, first_name, middle_name, last_name"
        )
        .ilike("first_name", firstName)
        .ilike("last_name", lastName);

      if (middleName) {
        query = query.ilike("middle_name", middleName);
      }

      const { data, error } = await query.limit(2);

      if (error) {
        console.error(
          "Student name lookup failed:",
          error
        );

        setStudentLookupStatus(
          "Could not verify the student name. Please try again."
        );
        return;
      }

      // Only accept one unambiguous database match.
      if (data?.length === 1) {
        setPickedStudent(data[0]);

        setStudentLookupStatus(
          "Student record found. Student ID automatically loaded."
        );
      } else if (data?.length > 1) {
        setStudentLookupStatus(
          "Multiple student records found. Please check the complete name."
        );
      } else {
        setStudentLookupStatus(
          "No matching student record found. Please check the spelling."
        );
      }
    } catch (error) {
      console.error(
        "Error checking student name:",
        error
      );

      setStudentLookupStatus(
        "An error occurred while checking the student record."
      );
    }
  };

  // 5. Determine the final student information.
  const finalStudentId =
    studentId || pickedStudent?.student_id || "";

  const finalStudentName = editedStudentName.trim();

  // 6. Save the confirmed document.
  const handleSave = async () => {
    if (!documentId || saving) return;

    if (!finalStudentId) {
      alert(
        "No matching student record found. Please correct the student name before saving."
      );
      return;
    }

    if (!finalStudentName) {
      alert("Please enter the student's name.");
      return;
    }

    if (!previewUrl) {
      alert(
        "The scanned file is missing. Please scan the document again."
      );
      return;
    }

    try {
      setSaving(true);

      const doc = docs.find(
        (d) =>
          String(d.document_id) === String(documentId)
      );

      if (!doc) {
        throw new Error(
          "The selected document type was not found."
        );
      }

      if (typeof onSave !== "function") {
        throw new Error(
          "The save function is not available."
        );
      }

      await onSave({
        studentId: finalStudentId,
        studentName: finalStudentName,
        ocrName,
        documentId: Number(documentId),
        documentType: doc.document_name || "",
        fileName,
        fileUrl: previewUrl,

        // Include original scanned image data.
        imageDataUrl: previewUrl.startsWith("data:image/")
          ? previewUrl
          : "",

        // Include the confirmed student record.
        matchedStudent: studentId
          ? matchedStudent
          : pickedStudent || null,
      });
    } catch (error) {
      console.error(
        "OCR confirmation save failed:",
        error
      );

      alert(
        error instanceof Error
          ? error.message
          : "Failed to save the document. Please try again."
      );
    } finally {
      setSaving(false);
    }
  };

  const content = (
    <div className="ocr-overlay">
      <div className="ocr-card">

        {/* HEADER */}
        <div className="ocr-header">
          <div>
            <h3 className="ocr-title">
              DOCUMENT CONFIRMATION
            </h3>

            <p className="ocr-sub">
              Review detected information before saving
            </p>
          </div>
        </div>

        {/* BODY */}
        <div className="ocr-body">

          {/* FILE PREVIEW */}
          <div className="ocr-panel">
            <div className="ocr-panel-header">
              <span className="ocr-panel-title">
                File preview
              </span>

              <span className="ocr-file-type-badge">
                {previewIsPdf ? "PDF" : "IMAGE"}
              </span>
            </div>

            <div className="ocr-preview-box">
              {previewUrl && !previewError ? (
                previewIsPdf ? (
                  <iframe
                    title="Scanned document preview"
                    src={previewUrl}
                    className="ocr-preview-iframe"
                    onError={() => setPreviewError(true)}
                  />
                ) : (
                  <img
                    src={previewUrl}
                    alt="Scanned document"
                    className="ocr-preview-image"
                    onError={() => setPreviewError(true)}
                  />
                )
              ) : (
                <div className="ocr-no-preview">
                  <p className="ocr-no-preview-title">
                    {previewError
                      ? "Preview could not be loaded"
                      : "No preview available"}
                  </p>

                  <p className="ocr-no-preview-text">
                    {previewError
                      ? "Please scan the document again and check the scanner response."
                      : "The scanned image was not received. Please scan the document again."}
                  </p>
                </div>
              )}
            </div>

            {fileName && (
              <div className="ocr-meta-row">
                <span className="ocr-meta-label">
                  File name
                </span>

                <span className="ocr-meta-value">
                  {fileName}
                </span>
              </div>
            )}
          </div>

          {/* DETECTED INFORMATION */}
          <div>
            <div className="ocr-panel">
              <div className="ocr-panel-header">
                <span className="ocr-panel-title">
                  Detected information
                </span>
              </div>

              {/* DOCUMENT TYPE */}
              <div className="ocr-field-group">
                <label className="ocr-field-label">
                  Document type
                </label>

                <select
                  className="ocr-field-select"
                  value={documentId}
                  onChange={(e) => {
                    setDocumentId(e.target.value);
                    setSuggested(false);
                  }}
                  disabled={saving || !docs.length}
                >
                  <option value="">
                    Select Document Type
                  </option>

                  {docs.map((d) => (
                    <option
                      key={d.document_id}
                      value={String(d.document_id)}
                    >
                      {d.document_name}
                    </option>
                  ))}
                </select>

                <p className="ocr-field-hint">
                  {docsError ||
                    (documentId
                      ? suggested
                        ? "Best guess from OCR. Please confirm."
                        : "Auto-detected via OCR. Correct if needed."
                      : "Could not detect the type. Please choose one.")}
                </p>

                {documentTypeConfidence != null &&
                  documentTypeConfidence !== "" &&
                  Number.isFinite(Number(documentTypeConfidence)) && (
                    <p className="ocr-field-hint">
                      Detection confidence:{" "}
                      {(
                        Number(documentTypeConfidence) <= 1
                          ? Number(documentTypeConfidence) * 100
                          : Number(documentTypeConfidence)
                      ).toFixed(1)}
                      %
                    </p>
                  )}
              </div>

              {/* EDITABLE STUDENT NAME */}
              <div className="ocr-field-group">
                <label
                  className="ocr-field-label"
                  htmlFor="ocr-student-name"
                >
                  Student name
                </label>

                <input
                  id="ocr-student-name"
                  type="text"
                  className="ocr-field-select ocr-student-name-input"
                  value={editedStudentName}
                  onChange={(e) => {
                    setEditedStudentName(e.target.value);
                    setPickedStudent(null);
                    setStudentLookupStatus(
                      "Name edited. Leave this field to verify the student record."
                    );
                  }}
                  onBlur={handleStudentNameBlur}
                  placeholder="Enter student name"
                  disabled={saving}
                  autoComplete="off"
                />

                <p className="ocr-field-hint">
                  {studentLookupStatus ||
                    "Automatically extracted by OCR. Edit the name if needed."}
                </p>
              </div>

              {/* STUDENT ID */}
              <div className="ocr-info-row">
                <span className="ocr-info-label">
                  Student ID
                </span>

                <span className="ocr-info-value">
                  {finalStudentId || "—"}
                </span>
              </div>
            </div>
          </div>

        </div>

        {/* FOOTER */}
        <div className="ocr-footer">
          <div />

          <div className="ocr-footer-actions">
            <button
              type="button"
              className="ocr-cancel-btn"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </button>

            <button
              type="button"
              className="ocr-save-btn"
              onClick={handleSave}
              disabled={
                !documentId ||
                !finalStudentId ||
                !finalStudentName ||
                !previewUrl ||
                saving ||
                !!docsError
              }
            >
              {saving ? "Saving..." : "Save Document"}
            </button>
          </div>
        </div>

      </div>
    </div>
  );

  return createPortal(content, document.body);
}
