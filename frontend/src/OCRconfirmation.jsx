import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabaseClient";
import "./styles/OCRConfirmation.css";
import "./styles/OCRBatch.css";

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

const normalizeName = (name) =>
  String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const nameTokens = (name) =>
  normalizeName(name)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter(Boolean);

const studentLabel = (s) =>
  s
    ? [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(" ")
    : "";

const getPreviewUrl = (item) =>
  item?.result?.image_data_url ||
  item?.imageDataUrl ||
  item?.result?.file_url ||
  item?.result?.fileUrl ||
  "";

// Statuses that should NOT count as an existing document.
// Example: ["Rejected", "Deleted"] lets the student re-upload a rejected file.
const IGNORED_DUPLICATE_STATUSES = [];

// Look for an already-saved document of the same type for the same student.
export const findExistingDocument = async (studentId, documentId) => {
  let query = supabase
    .from("tbl_student_documents")
    .select("student_documents_id, document_name, date_uploaded, status")
    .eq("student_id", Number(studentId))
    .eq("document_id", Number(documentId));

  if (IGNORED_DUPLICATE_STATUSES.length) {
    query = query.not(
      "status",
      "in",
      `(${IGNORED_DUPLICATE_STATUSES.map((s) => `"${s}"`).join(",")})`
    );
  }

  const { data, error } = await query.limit(1);

  if (error) throw error;

  return data?.[0] || null;
};

const formatDate = (value) => {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
};

// ------------------------------------------------------------
// ONE PREVIEW PAGE (inside the scrollable list)
// ------------------------------------------------------------

function PreviewPage({ item, index }) {
  const url = getPreviewUrl(item);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [url]);

  return (
    <div className="ocr-preview-item" data-index={index}>
      <span className="ocr-preview-tag">{index + 1}</span>

      {url && !failed ? (
        <img
          src={url}
          alt={`Scanned document ${index + 1}`}
          className="ocr-preview-image"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="ocr-no-preview">
          <p className="ocr-no-preview-title">
            {failed ? "Preview could not be loaded" : "No preview available"}
          </p>
          <p className="ocr-no-preview-text">
            Remove this file and add it again.
          </p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// DETECTED INFORMATION FOR ONE DOCUMENT
//
// Every document keeps its own panel mounted (hidden when it is not
// in view), so edits and database checks are not lost when the staff
// scrolls away and back.
// ------------------------------------------------------------

function ItemPanel({
  item,
  position,
  hidden,
  docs,
  docsError,
  studentId,
  studentName,
  saving,
  saveInfo,
  inBatchDuplicate,
  mismatchMessage,
  onChange,
  onRemove,
}) {
  const ocrResult = item.result || {};
  const studentKnown =
    studentId !== undefined && studentId !== null && studentId !== "";

  const [documentId, setDocumentId] = useState("");
  const [suggested, setSuggested] = useState(false);

  const [pickedStudent, setPickedStudent] = useState(null);
  const [editedStudentName, setEditedStudentName] = useState("");
  const [studentLookupStatus, setStudentLookupStatus] = useState("");

  const [duplicateDoc, setDuplicateDoc] = useState(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);
  const [duplicateCheckError, setDuplicateCheckError] = useState("");

  const ocrName = {
    first: ocrResult.first_name || "",
    middle: ocrResult.middle_name || "",
    last: ocrResult.last_name || "",
  };

  const ocrFullName = [ocrName.first, ocrName.middle, ocrName.last]
    .filter(Boolean)
    .join(" ");

  const candidates = Array.isArray(ocrResult.student_candidates)
    ? ocrResult.student_candidates
    : [];

  const matchedStudent = ocrResult.matched_student || null;

  const studentOptions = [
    ...(matchedStudent ? [matchedStudent] : []),
    ...candidates,
  ].filter(
    (student, index, self) =>
      student?.student_id &&
      self.findIndex(
        (s) => String(s.student_id) === String(student.student_id)
      ) === index
  );

  // 1. Auto-select the detected document type.
  useEffect(() => {
    if (!docs.length) return;

    const label = (ocrResult.document_type || "").trim().toLowerCase();

    let match = ocrResult.document_id
      ? docs.find(
          (d) => String(d.document_id) === String(ocrResult.document_id)
        )
      : null;

    if (!match && label && label !== "unknown") {
      match = docs.find(
        (d) => String(d.document_name || "").trim().toLowerCase() === label
      );
    }

    if (match) {
      setDocumentId(String(match.document_id));
      setSuggested(false);
      return;
    }

    const top = ocrResult.document_type_suggestions?.[0];

    if (top) {
      const suggestedDoc = docs.find(
        (d) => String(d.document_id) === String(top.document_id)
      );

      if (suggestedDoc) {
        setDocumentId(String(suggestedDoc.document_id));
        setSuggested(true);
        return;
      }
    }

    setDocumentId((currentId) =>
      docs.some((d) => String(d.document_id) === currentId) ? currentId : ""
    );

    setSuggested(false);
  }, [docs, item.id]);

  // 2. Verify the student record from a name.
  const verifyStudentName = async (nameToCheck) => {
    const searchName = (nameToCheck || "").trim();

    if (!searchName) {
      setPickedStudent(null);
      setStudentLookupStatus("Please enter the student's name.");
      return;
    }

    if (studentKnown) {
      setStudentLookupStatus("Existing student record.");
      return;
    }

    setStudentLookupStatus("Checking student record...");
    setPickedStudent(null);

    try {
      const candidateMatch = studentOptions.find(
        (student) =>
          normalizeName(studentLabel(student)) === normalizeName(searchName)
      );

      if (candidateMatch) {
        setPickedStudent(candidateMatch);
        setStudentLookupStatus(
          "Student record found. Student ID automatically loaded."
        );
        return;
      }

      const nameParts = searchName.split(/\s+/).filter(Boolean);

      if (nameParts.length < 2) {
        setStudentLookupStatus("Please enter the student's complete name.");
        return;
      }

      const lastWord = nameParts[nameParts.length - 1];

      const { data: rows, error } = await supabase
        .from("tbl_student")
        .select("student_id, first_name, middle_name, last_name")
        .ilike("last_name", `%${lastWord}%`)
        .limit(100);

      if (error) {
        console.error("Student name lookup failed:", error);
        setStudentLookupStatus(
          "Could not verify the student name. Please try again."
        );
        return;
      }

      const target = normalizeName(searchName);

      const data = (rows || []).filter(
        (s) => normalizeName(studentLabel(s)) === target
      );

      if (data.length === 1) {
        setPickedStudent(data[0]);
        setStudentLookupStatus(
          "Student record found. Student ID automatically loaded."
        );
      } else if (data.length > 1) {
        setStudentLookupStatus(
          "Multiple student records found. Please check the complete name."
        );
      } else {
        setStudentLookupStatus(
          "No matching student record found. Please check the spelling."
        );
      }
    } catch (error) {
      console.error("Error checking student name:", error);
      setStudentLookupStatus(
        "An error occurred while checking the student record."
      );
    }
  };

  // 3. Initialize the editable name, then look the student up.
  useEffect(() => {
    const initialName = studentKnown ? studentName : ocrFullName;

    setPickedStudent(null);
    setStudentLookupStatus("");

    // The hook already found one confident match (it tolerates a missing
    // middle name and small OCR mistakes), so use it directly.
    if (!studentKnown && matchedStudent?.student_id) {
      setEditedStudentName(studentLabel(matchedStudent));
      setPickedStudent(matchedStudent);
      setStudentLookupStatus(
        "Matched from the name found in the document. Please confirm it is the correct student."
      );
      return;
    }

    setEditedStudentName(initialName);

    if (!studentKnown && initialName.trim()) {
      verifyStudentName(initialName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, studentId, studentName]);

  const finalStudentId = studentKnown
    ? String(studentId)
    : pickedStudent?.student_id
      ? String(pickedStudent.student_id)
      : "";

  const finalStudentName = editedStudentName.trim();

  // 4. Duplicate check against saved documents.
  useEffect(() => {
    let cancelled = false;

    setDuplicateDoc(null);
    setDuplicateCheckError("");

    if (!finalStudentId || !documentId) {
      setCheckingDuplicate(false);
      return;
    }

    setCheckingDuplicate(true);

    findExistingDocument(finalStudentId, documentId)
      .then((existing) => {
        if (!cancelled) setDuplicateDoc(existing);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Duplicate document check failed:", error);
        setDuplicateCheckError(
          "Could not check for existing documents. Please try again."
        );
      })
      .finally(() => {
        if (!cancelled) setCheckingDuplicate(false);
      });

    return () => {
      cancelled = true;
    };
  }, [finalStudentId, documentId]);

  // 5. Report this document's state to the container.
  useEffect(() => {
    const doc = docs.find((d) => String(d.document_id) === String(documentId));

    onChange(item.id, {
      documentId,
      documentName: doc?.document_name || "",
      studentId: finalStudentId,
      studentName: finalStudentName,
      pickedStudent,
      checkingDuplicate,
      duplicateDoc,
      ocrName,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    item.id,
    documentId,
    docs,
    finalStudentId,
    finalStudentName,
    pickedStudent,
    checkingDuplicate,
    duplicateDoc,
  ]);

  // Profile only: warn when the OCR name does not look like the student.
  const profileNameWarning = (() => {
    if (!studentKnown || !ocrFullName) return "";

    const ocrT = nameTokens(ocrFullName);
    const stuT = nameTokens(studentName);

    if (!ocrT.length || !stuT.length) return "";

    const overlap = ocrT.filter((t) => stuT.includes(t)).length;

    return overlap >= Math.min(2, ocrT.length)
      ? ""
      : `The name read from this document ("${ocrFullName}") does not look like ${studentName}. Check that it belongs to this student.`;
  })();

  const disabled = saving || saveInfo?.state === "saving";

  return (
    <div
      className="ocr-panel ocr-item-panel"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        display: hidden ? "none" : "flex",
        flexDirection: "column",
        overflowY: "auto",
        boxSizing: "border-box",
      }}
    >
      <div className="ocr-panel-header">
        <span className="ocr-panel-title">Detected information</span>
        <span className="ocr-position">{position}</span>
      </div>

      {/* DOCUMENT TYPE */}
      <div className="ocr-field-group">
        <label className="ocr-field-label">Document type</label>

        <select
          className="ocr-field-select"
          value={documentId}
          onChange={(e) => {
            setDocumentId(e.target.value);
            setSuggested(false);
          }}
          disabled={disabled || !docs.length}
        >
          <option value="">Select Document Type</option>

          {docs.map((d) => (
            <option key={d.document_id} value={String(d.document_id)}>
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

        {checkingDuplicate && (
          <p className="ocr-field-hint">Checking for existing documents...</p>
        )}

        {!checkingDuplicate && duplicateDoc && (
          <p className="ocr-field-hint is-error" role="alert">
            This document type is already saved for this student
            {formatDate(duplicateDoc.date_uploaded)
              ? ` (uploaded ${formatDate(duplicateDoc.date_uploaded)})`
              : ""}
            {duplicateDoc.status ? `, status: ${duplicateDoc.status}` : ""}.
          </p>
        )}

        {inBatchDuplicate && (
          <p className="ocr-field-hint is-error" role="alert">
            Another document in this batch already has this type for the
            same student. Change the type or remove this file.
          </p>
        )}

        {!checkingDuplicate && duplicateCheckError && (
          <p className="ocr-field-hint is-error" role="alert">
            {duplicateCheckError}
          </p>
        )}
      </div>

      {/* STUDENT NAME */}
      <div className="ocr-field-group">
        <label className="ocr-field-label" htmlFor={`ocr-student-${item.id}`}>
          Student name
        </label>

        <input
          id={`ocr-student-${item.id}`}
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
          onBlur={() => verifyStudentName(editedStudentName)}
          placeholder="Enter student name"
          disabled={disabled}
          autoComplete="off"
        />

        <p className="ocr-field-hint">
          {studentLookupStatus ||
            "Automatically extracted by OCR. Edit the name if needed."}
        </p>

        {studentKnown && ocrFullName && (
          <p className="ocr-field-hint">Read from document: {ocrFullName}</p>
        )}

        {mismatchMessage && (
          <p className="ocr-field-hint is-error" role="alert">
            {mismatchMessage}
          </p>
        )}

        {profileNameWarning && (
          <p className="ocr-field-hint is-warning" role="alert">
            {profileNameWarning}
          </p>
        )}
      </div>

      {/* STUDENT ID */}
      <div className="ocr-info-row">
        <span className="ocr-info-label">Student ID</span>
        <span className="ocr-info-value">{finalStudentId || "—"}</span>
      </div>

      {saveInfo?.state === "failed" && (
        <p className="ocr-field-hint is-error" role="alert">
          Could not save: {saveInfo.message}
        </p>
      )}

      {saveInfo?.state === "saving" && (
        <p className="ocr-field-hint">Saving this document...</p>
      )}

      <button
        type="button"
        className="ocr-remove-link"
        onClick={() => onRemove?.(item.id)}
        disabled={disabled}
      >
        Remove this document from the batch
      </button>
    </div>
  );
}

// ------------------------------------------------------------
// CONTAINER
// ------------------------------------------------------------

export default function OCRConfirmation({
  items = [],
  studentId = "",
  studentName = "",
  onBack,
  onCancel,
  onRemove,
  onSave,
}) {
  const studentKnown =
    studentId !== undefined && studentId !== null && studentId !== "";

  const [docs, setDocs] = useState([]);
  const [docsError, setDocsError] = useState("");

  const [states, setStates] = useState({});
  const [saveStatus, setSaveStatus] = useState({});
  const [saving, setSaving] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

   // Load document types for the whole batch:
  // standard types (no student, not a group) + this student's custom types.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const numericStudentId = Number(studentId);
        const hasStudent =
          studentKnown && Number.isFinite(numericStudentId);

        let query = supabase
          .from("tbl_documents")
          .select("document_id, document_name")
          .order("document_name");

        if (hasStudent) {
          query = query.or(
            `and(student_id.is.null,is_group.eq.false,is_enrollment_requirement.eq.true),` +
              `and(student_id.eq.${numericStudentId},is_group.eq.false)`
          );
        } else {
          query = query
            .is("student_id", null)
            .eq("is_group", false)
            .eq("is_enrollment_requirement", true);
        }

        const { data, error } = await query;

        if (cancelled) return;

        if (error) {
          console.error("Failed to load document types:", error);
          setDocsError("Could not load document types from the database.");
          return;
        }

        if (!data?.length) {
          setDocs([]);
          setDocsError("No document types were found in the database.");
          return;
        }

        setDocs(data);
        setDocsError("");
      } catch (error) {
        if (cancelled) return;
        console.error("Error loading document types:", error);
        setDocsError("Could not load document types from the database.");
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [studentId, studentKnown]);

  // ----------------------------------------------------------
  // BATCH LOGIC
  // ----------------------------------------------------------

  const rows = items.map((item, index) => ({
    item,
    index,
    st: states[item.id] || {},
  }));

  const seenKeys = new Set();

  rows.forEach((row) => {
    const { st } = row;
    const key =
      st.studentId && st.documentId ? `${st.studentId}:${st.documentId}` : "";

    row.inBatchDuplicate = !!key && seenKeys.has(key);

    if (key) seenKeys.add(key);

    row.ready =
      !!st.documentId &&
      !!st.studentId &&
      !!st.studentName &&
      !st.checkingDuplicate &&
      !st.duplicateDoc &&
      !row.inBatchDuplicate &&
      !docsError;
  });

  const readyCount = rows.filter((r) => r.ready).length;

  const chipState = (row) => {
    const info = saveStatus[row.item.id];

    if (info?.state === "saving") return "saving";
    if (info?.state === "failed") return "failed";

    return row.ready ? "ready" : "attention";
  };

  // ----------------------------------------------------------
  // SCROLL SYNC: the item in view decides what the right side shows
  // ----------------------------------------------------------

  const syncActiveIndex = useCallback(() => {
    const el = scrollRef.current;

    if (!el || !el.clientHeight) return;

    const index = Math.min(
      Math.max(items.length - 1, 0),
      Math.max(0, Math.round(el.scrollTop / el.clientHeight))
    );

    setActiveIndex((prev) => (prev === index ? prev : index));
  }, [items.length]);

  useEffect(() => {
    const frame = requestAnimationFrame(syncActiveIndex);
    return () => cancelAnimationFrame(frame);
  }, [items.length, syncActiveIndex]);

  const jumpTo = (index) => {
    const el = scrollRef.current;

    if (!el) return;

    el.scrollTo({ top: index * el.clientHeight, behavior: "smooth" });
  };

  // ----------------------------------------------------------
  // SAVE ALL
  // ----------------------------------------------------------

  const handleSaveAll = async () => {
    if (saving || !readyCount) return;

    setSaving(true);

    for (const row of rows) {
      if (!row.ready) continue;

      const { item, st } = row;
      const previewUrl = getPreviewUrl(item);

      setSaveStatus((prev) => ({ ...prev, [item.id]: { state: "saving" } }));

      try {
        if (!previewUrl) {
          throw new Error("The scanned image is missing. Remove and add it again.");
        }

        // Re-check right before saving, in case a record was added elsewhere.
        const existing = await findExistingDocument(st.studentId, st.documentId);

        if (existing) {
          throw new Error(
            `${st.documentName} is already saved for this student.`
          );
        }

        const ok = await onSave(item.id, {
          studentId: st.studentId,
          studentName: st.studentName,
          ocrName: st.ocrName,
          documentId: Number(st.documentId),
          documentType: st.documentName || "",
          fileName: item.filename || "",
          fileUrl: previewUrl,
          imageDataUrl: previewUrl.startsWith("data:image/") ? previewUrl : "",
          matchedStudent: studentKnown
            ? item.result?.matched_student || null
            : st.pickedStudent || null,
        });

        if (ok === false) {
          throw new Error("The document was not saved. Please try again.");
        }

        setSaveStatus((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      } catch (error) {
        console.error("Save failed for", item.label, error);

        setSaveStatus((prev) => ({
          ...prev,
          [item.id]: {
            state: "failed",
            message:
              error instanceof Error
                ? error.message
                : "Failed to save the document.",
          },
        }));
      }
    }

    setSaving(false);
  };

  if (!items.length) return null;

  const activeItem = items[Math.min(activeIndex, items.length - 1)];
  const failedCount = Object.values(saveStatus).filter(
    (s) => s.state === "failed"
  ).length;

  const content = (
    <div className="ocr-overlay">
      <div className="ocr-card">
        {/* HEADER */}
        <div className="ocr-header">
          <div>
            <h3 className="ocr-title">DOCUMENT CONFIRMATION</h3>
            <p className="ocr-sub">
              Review detected information before saving
            </p>
          </div>

          <span className="ocr-complete-badge">
            <span className="ocr-complete-dot" />
            {items.length} {items.length === 1 ? "document" : "documents"}
          </span>
        </div>

        {/* BODY */}
        <div className="ocr-body">
          {/* FILE PREVIEW (scrollable list of every document) */}
          <div className="ocr-panel">
            <div className="ocr-panel-header">
              <span className="ocr-panel-title">File preview</span>
              <span className="ocr-file-type-badge">IMAGE</span>
            </div>

            <div
              className="ocr-preview-scroll"
              ref={scrollRef}
              onScroll={syncActiveIndex}
              tabIndex={0}
              aria-label="Scroll to review each uploaded document"
            >
              {items.map((item, index) => (
                <PreviewPage key={item.id} item={item} index={index} />
              ))}
            </div>

            {items.length > 0 && (
              <div className="ocr-chip-row" aria-label="Jump to a document">
                {rows.map((row) => (
                  <button
                    key={row.item.id}
                    type="button"
                    className={`ocr-chip ocr-chip-${chipState(row)}${
                      row.index === activeIndex ? " is-active" : ""
                    }`}
                    onClick={() => jumpTo(row.index)}
                    title={row.item.label}
                  >
                    {row.index + 1}
                  </button>
                ))}
              </div>
            )}

            <div className="ocr-meta-row">
              <span className="ocr-meta-label">File name</span>
              <span className="ocr-meta-value">
                {activeItem?.filename || activeItem?.label}
              </span>
            </div>
          </div>

          {/* DETECTED INFORMATION (follows the document in view) */}
          <div
            style={{
              position: "relative",
              height: "auto",
              minHeight: 480,
              alignSelf: "stretch",
            }}
          >
            {rows.map((row, index) => (
              <ItemPanel
                key={row.item.id}
                item={row.item}
                position={`Document ${index + 1} of ${items.length}`}
                hidden={index !== activeIndex}
                docs={docs}
                docsError={docsError}
                studentId={studentId}
                studentName={studentName}
                saving={saving}
                saveInfo={saveStatus[row.item.id]}
                inBatchDuplicate={row.inBatchDuplicate}
                onChange={handlePanelChange}
                onRemove={onRemove}
              />
            ))}
          </div>
        </div>

        {/* FOOTER */}
        <div className="ocr-footer">
          <p className="ocr-footer-note">
            {readyCount} of {items.length} ready to save
            {failedCount ? `, ${failedCount} failed` : ""}
          </p>

          <div className="ocr-footer-actions">
            <button
              type="button"
              className="ocr-cancel-btn"
              onClick={onBack}
              disabled={saving}
            >
              Back to queue
            </button>

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
              onClick={handleSaveAll}
              disabled={!readyCount || saving}
            >
              {saving ? "Saving..." : `Save All (${readyCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}