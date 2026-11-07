import { useState, useCallback, useEffect, useRef } from "react";
import { SCANNER_URL, OCR_URL, absoluteUrl } from "./scannerUtils";
import { supabase } from "./supabaseClient";
import { matchStudentFromOcr } from "./matchStudent";

/**
 * Reusable document-scanning logic with a multi-document queue.
 *
 * Queue item shape:
 *   {
 *     id, source: "upload" | "scan",
 *     file, imageDataUrl, filename, label,
 *     status: "queued" | "processing" | "completed" | "failed",
 *     result,   // enriched OCR result (same shape as before)
 *     error,
 *   }
 *
 * @param {object}   options
 * @param {string}   options.studentId   Known student (Student Profile). Empty on Dashboard.
 * @param {function} options.onScanned   (credential, result) after each item is processed.
 * @param {function} options.onConfirmed (payload, credential) save ONE document.
 *                                       Throw or return false on failure.
 * @param {function} options.onCancelled (credential) when the whole batch is discarded.
 */

const ALLOWED_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
];

let itemCounter = 0;

const newId = () => `item_${Date.now()}_${++itemCounter}`;

// ------------------------------------------------------------
// STUDENT LOOKUP INSIDE RAW OCR TEXT
//
// The OCR engine often drops every space ("NameCHRISTINEPAULAOUAPINSILVESTRE"),
// so word-by-word matching fails. This searches the raw text for a
// student's name instead, ignoring spaces and punctuation.
// ------------------------------------------------------------

const lettersOnly = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

function findStudentsInText(rawText, students) {
  const text = lettersOnly(rawText);

  if (!text) return [];

  const hits = [];

  for (const s of students) {
    const F = lettersOnly(s.first_name);
    const M = lettersOnly(s.middle_name);
    const L = lettersOnly(s.last_name);

    if (F.length < 3 || L.length < 3) continue;

    const m0 = M.slice(0, 1);

    const patterns = [
      F + M + L, // First Middle Last
      L + F + M, // Last First Middle
      F + m0 + L, // First M. Last
      L + F + m0, // Last, First M.
      F + L, // First Last
      L + F, // Last, First
    ];

    let best = 0;

    for (const p of patterns) {
      if (p.length >= 8 && p.length > best && text.includes(p)) {
        best = p.length;
      }
    }

    if (best) hits.push({ student: s, length: best });
  }

  // Longest (most specific) match first.
  return hits.sort((a, b) => b.length - a.length);
}

let studentCache = { at: 0, rows: [] };

// Loads every student (the database returns at most 1000 rows per request).
async function loadAllStudents() {
  if (studentCache.rows.length && Date.now() - studentCache.at < 60000) {
    return studentCache.rows;
  }

  const PAGE = 1000;
  const rows = [];

  for (let from = 0; from < 20000; from += PAGE) {
    const { data, error } = await supabase
      .from("tbl_student")
      .select("student_id, first_name, middle_name, last_name, birthdate")
      .order("student_id")
      .range(from, from + PAGE - 1);

    if (error) throw error;

    rows.push(...(data || []));

    if (!data || data.length < PAGE) break;
  }

  studentCache = { at: Date.now(), rows };

  return rows;
}

// Returns { student, candidates }. "student" is set only when exactly
// one student is the clear best match.
async function findStudentInRawText(rawText) {
  try {
    const students = await loadAllStudents();
    const hits = findStudentsInText(rawText, students);

    if (!hits.length) return { student: null, candidates: [] };

    const candidates = hits.slice(0, 3).map((h) => h.student);
    const clear = hits.length === 1 || hits[0].length > hits[1].length;

    return { student: clear ? hits[0].student : null, candidates };
  } catch (err) {
    console.error("Raw-text student search failed:", err);
    return { student: null, candidates: [] };
  }
}

// ------------------------------------------------------------
// DOCUMENT TYPE LOOKUP
// ------------------------------------------------------------

async function resolveDocumentId(result) {
  if (result.document_id) {
    return result.document_id;
  }

  const name = (result.document_type || "").trim();

  if (!name || name.toLowerCase() === "unknown") {
    return null;
  }

  const { data, error } = await supabase
    .from("tbl_documents")
    .select("document_id")
    .ilike("document_name", name)
    .limit(2);

  if (error) {
    console.error("Document type lookup failed:", error);
    return null;
  }

  return data?.length === 1 ? data[0].document_id : null;
}

// ------------------------------------------------------------
// IMAGE HELPERS
// ------------------------------------------------------------

function getImageDataUrl(data) {
  const candidates = [
    data?.image_data_url,
    data?.imageDataUrl,
    data?.file_url,
    data?.fileUrl,
  ];

  return (
    candidates.find(
      (value) =>
        typeof value === "string" &&
        /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)
    ) || ""
  );
}

function getFileUrl(data, imageDataUrl) {
  if (imageDataUrl) return imageDataUrl;

  const value =
    data?.file_url ||
    data?.fileUrl ||
    data?.file_path ||
    data?.filePath ||
    "";

  if (!value || typeof value !== "string") return "";

  if (/^(data:|blob:|https?:\/\/)/i.test(value)) return value;

  return absoluteUrl(value) || "";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unable to convert the selected file."));
        return;
      }

      resolve(reader.result);
    };

    reader.onerror = () => {
      reject(new Error("Unable to read the selected file."));
    };

    reader.readAsDataURL(file);
  });
}

// ------------------------------------------------------------
// RESULT SHAPE (same fields the confirmation and save flow expect)
// ------------------------------------------------------------

function buildResult(data, imageDataUrl, fileUrl, filename) {
  return {
    ...data,

    image_data_url: imageDataUrl,
    imageDataUrl: imageDataUrl,
    file_url: fileUrl,
    fileUrl: fileUrl,

    filename:
      filename ||
      data.filename ||
      data.file_name ||
      data.fileName ||
      "",

    document_type:
      data.document_type ||
      data.detected_document_type ||
      data.detectedDocType ||
      "",

    document_type_key:
      data.document_type_key || data.documentTypeKey || "",

    document_type_confidence:
      data.document_type_confidence ??
      data.documentTypeConfidence ??
      null,

    document_type_matches:
      data.document_type_matches || data.documentTypeMatches || [],

    document_type_suggestions: data.document_type_suggestions || [],

    document_id: data.document_id ?? data.documentId ?? null,

    first_name: data.first_name ?? data.firstName ?? "",
    middle_name: data.middle_name ?? data.middleName ?? "",
    last_name: data.last_name ?? data.lastName ?? "",
  };
}

// Auto-fill document type + student match (same logic as before).
async function enrichResult(result, studentId) {
  const studentKnown =
    studentId !== undefined && studentId !== null && studentId !== "";

  try {
    result.document_id = await resolveDocumentId(result);

    const fullName =
      result.full_name ||
      result.fullName ||
      result.student_name ||
      result.studentName ||
      [result.first_name, result.middle_name, result.last_name]
        .filter(Boolean)
        .join(" ");

    if (studentKnown) {
      // Student Profile: the student is already selected.
      result.matched_student = null;
      result.student_candidates = [];
      result.matched_student_id = studentId;
    } else {
      // Dashboard: match the OCR name to an existing student.
      let student = null;
      let candidates = [];

      if (fullName.trim()) {
        try {
          const match = await matchStudentFromOcr({
            first: result.first_name,
            middle: result.middle_name,
            last: result.last_name,
            fullName,
          });

          student = match?.student || null;
          candidates = match?.candidates || [];
        } catch (matchError) {
          console.error("Name matching failed:", matchError);
        }
      }

      // If the name could not be matched (or was not split), search the
      // raw OCR text for a student's name.
      if (!student) {
        const found = await findStudentInRawText(
          result.raw_text || result.text || ""
        );

        if (found.student) {
          student = found.student;

          candidates = [
            found.student,
            ...candidates.filter(
              (c) => String(c.student_id) !== String(found.student.student_id)
            ),
          ].slice(0, 3);
        } else if (!candidates.length) {
          candidates = found.candidates;
        }
      }

      result.matched_student = student;
      result.student_candidates = candidates;
      result.matched_student_id = student?.student_id ?? null;
    }
  } catch (err) {
    console.error("Auto-fill lookup failed:", err);

    // A matching error must not discard the scanned image.
    result.matched_student = null;
    result.student_candidates = [];
    result.matched_student_id = studentKnown ? studentId : null;
  }

  return result;
}

// ------------------------------------------------------------
// HOOK
// ------------------------------------------------------------

export default function useDocumentScanner({
  studentId,
  onScanned,
  onConfirmed,
  onCancelled,
} = {}) {
  const [showScanModal, setShowScanModal] = useState(false);
  const [selectedCredential, setSelectedCredential] = useState(null);

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");

  // "uploading" is only true while the chosen files are being read.
  // It does NOT stay true during OCR, so staff can keep adding files.
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const [scanners, setScanners] = useState([]);
  const [selectedScanner, setSelectedScanner] = useState(null);
  const [loadingScanners, setLoadingScanners] = useState(false);
  const [scannerError, setScannerError] = useState("");

  // Queue + dialogs
  const [items, setItems] = useState([]);
  const [showQueue, setShowQueue] = useState(false);
  const [showOCRConfirmation, setShowOCRConfirmation] = useState(false);
  const [workerTick, setWorkerTick] = useState(0);

  // Latest values for async code (avoids stale closures).
  const studentIdRef = useRef(studentId);
  const onScannedRef = useRef(onScanned);
  const onConfirmedRef = useRef(onConfirmed);
  const onCancelledRef = useRef(onCancelled);
  const credentialRef = useRef(selectedCredential);
  const itemsRef = useRef(items);
  const processingRef = useRef(false);
  const scanCounterRef = useRef(0);

  studentIdRef.current = studentId;
  onScannedRef.current = onScanned;
  onConfirmedRef.current = onConfirmed;
  onCancelledRef.current = onCancelled;
  credentialRef.current = selectedCredential;
  itemsRef.current = items;

  const updateItem = useCallback((id, patch) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }, []);

  const completedItems = items.filter((i) => i.status === "completed");

  const queueBusy = items.some(
    (i) => i.status === "queued" || i.status === "processing"
  );

  // ============================================================
  // QUEUE WORKER (one document at a time)
  // ============================================================

  const processUpload = async (item) => {
    const formData = new FormData();
    formData.append("file", item.file);

    const response = await fetch(OCR_URL, {
      method: "POST",
      body: formData,
    });

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error("The OCR service returned an invalid response.");
    }

    if (!response.ok || !data.success) {
      throw new Error(
        data?.error ||
          data?.message ||
          "Unable to extract information from this document."
      );
    }

    const result = buildResult(
      data,
      item.imageDataUrl,
      item.imageDataUrl,
      item.filename
    );

    return enrichResult(result, studentIdRef.current);
  };

  useEffect(() => {
    if (processingRef.current) return;

    const next = items.find((i) => i.status === "queued");

    if (!next) return;

    processingRef.current = true;

    updateItem(next.id, { status: "processing", error: "" });

    (async () => {
      try {
        const result = await processUpload(next);

        updateItem(next.id, { status: "completed", result });

        onScannedRef.current?.(credentialRef.current, result);
      } catch (err) {
        console.error("OCR queue item failed:", err);

        const unreachable = err instanceof TypeError;

        updateItem(next.id, {
          status: "failed",
          error: unreachable
            ? `Can't reach the OCR service at ${OCR_URL}. Make sure the Flask OCR server is running.`
            : err.message || "Unable to process this document.",
        });
      } finally {
        processingRef.current = false;
        setWorkerTick((t) => t + 1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, workerTick, updateItem]);

  // Close the confirmation when nothing is left to confirm.
  useEffect(() => {
    if (
      showOCRConfirmation &&
      !items.some((i) => i.status === "completed")
    ) {
      setShowOCRConfirmation(false);

      if (items.length) {
        setShowQueue(true);
      } else {
        setSelectedCredential(null);
      }
    }
  }, [items, showOCRConfirmation]);

  // Close the queue when it becomes empty.
  useEffect(() => {
    if (showQueue && items.length === 0 && !scanning) {
      setShowQueue(false);
      setSelectedCredential(null);
    }
  }, [items.length, showQueue, scanning]);

  // ============================================================
  // SCANNER DISCOVERY
  // ============================================================

  const loadScanners = useCallback(async (force = false) => {
    try {
      setLoadingScanners(true);
      setScannerError("");

      const url = force
        ? `${SCANNER_URL}/scanners?force=1`
        : `${SCANNER_URL}/scanners`;

      const response = await fetch(url);

      let data;

      try {
        data = await response.json();
      } catch {
        throw new Error("The scanner service returned an invalid response.");
      }

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to load scanners.");
      }

      setScanners(data.scanners || []);

      setSelectedScanner((current) => {
        if (
          current &&
          (data.scanners || []).some((scanner) => scanner.id === current.id)
        ) {
          return current;
        }

        return null;
      });
    } catch (err) {
      console.error("Scanner discovery error:", err);

      const unreachable = err instanceof TypeError;

      setScannerError(
        unreachable
          ? `Can't reach the scanner service at ${SCANNER_URL}. Make sure it is running and allows requests from this site (CORS).`
          : err.message || "Unable to connect to the scanner service."
      );

      setScanners([]);
    } finally {
      setLoadingScanners(false);
    }
  }, []);

  // ============================================================
  // OPEN / CLOSE SCAN MODAL
  // ============================================================

  const open = useCallback(
    (credential = null) => {
      setSelectedCredential(credential);
      setScanError("");
      setScannerError("");
      setShowScanModal(true);
      loadScanners();
    },
    [loadScanners]
  );

  const close = useCallback(() => {
    if (scanning) return;

    setShowScanModal(false);
    setScanError("");
    setScannerError("");

    if (itemsRef.current.length) {
      // Pages are already in the queue: go back to it.
      setShowQueue(true);
    } else {
      setSelectedCredential(null);
      setSelectedScanner(null);
    }
  }, [scanning]);

  // From the queue: scan one more page with the same scanner.
  const scanAnother = useCallback(() => {
    setShowQueue(false);
    setScanError("");
    setScannerError("");
    setShowScanModal(true);
    loadScanners();
  }, [loadScanners]);

  // ============================================================
  // SCAN ONE PAGE (adds it to the queue)
  // ============================================================

  const scan = async () => {
    const scanner = selectedScanner;

    if (!scanner) {
      setScanError("Please select a scanner first.");
      return;
    }

    try {
      setScanning(true);
      setScanError("");

      const response = await fetch(`${SCANNER_URL}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_uid: scanner.id }),
      });

      let data;

      try {
        data = await response.json();
      } catch {
        throw new Error("The scanner service returned an invalid response.");
      }

      if (!response.ok || !data.success) {
        throw new Error(data?.message || "Failed to scan the document.");
      }

      const imageDataUrl = getImageDataUrl(data);
      const fileUrl = getFileUrl(data, imageDataUrl);

      if (!imageDataUrl && !fileUrl) {
        console.warn(
          "[SCAN WARNING] No usable image URL was returned by the scanner."
        );
      }

      let result = buildResult(data, imageDataUrl, fileUrl, "");

      scanCounterRef.current += 1;

      const id = newId();

      // The scan is already read by OCR in the scanner service, so the
      // page enters the queue as "processing" while the student/document
      // lookup runs, then becomes "completed".
      setItems((prev) => [
        ...prev,
        {
          id,
          source: "scan",
          file: null,
          imageDataUrl: imageDataUrl || fileUrl,
          filename: result.filename,
          label: result.filename || `Scanned page ${scanCounterRef.current}`,
          status: "processing",
          result: null,
          error: "",
        },
      ]);

      setShowScanModal(false);
      setShowQueue(true);

      result = await enrichResult(result, studentIdRef.current);

      updateItem(id, { status: "completed", result });

      onScannedRef.current?.(credentialRef.current, result);
    } catch (err) {
      console.error("Scanner error:", err);

      const unreachable = err instanceof TypeError;

      setScanError(
        unreachable
          ? `Can't reach the scanner service at ${SCANNER_URL}. Make sure it is running and allows requests from this site (CORS).`
          : err.message || "Unable to connect to the selected scanner."
      );
    } finally {
      setScanning(false);
    }
  };

  // ============================================================
  // UPLOAD ONE OR MANY IMAGES (adds them to the queue)
  // ============================================================

  const upload = async (fileList) => {
    const files =
      typeof File !== "undefined" && fileList instanceof File
        ? [fileList]
        : Array.from(fileList || []);

    if (!files.length) {
      setUploadError("Please select a document first.");
      return;
    }

    const valid = [];
    const skipped = [];

    for (const file of files) {
      const name = file.name || "";
      const extension = name.includes(".")
        ? name.substring(name.lastIndexOf(".")).toLowerCase()
        : "";

      if (ALLOWED_EXTENSIONS.includes(extension)) {
        valid.push(file);
      } else {
        skipped.push(name || "(unnamed file)");
      }
    }

    setUploadError(
      skipped.length
        ? `Skipped (unsupported format): ${skipped.join(", ")}. Use JPG, PNG, WEBP, BMP, or TIFF.`
        : ""
    );

    if (!valid.length) return;

    setUploading(true);

    const added = [];

    for (const file of valid) {
      try {
        const imageDataUrl = await readFileAsDataUrl(file);

        added.push({
          id: newId(),
          source: "upload",
          file,
          imageDataUrl,
          filename: file.name,
          label: file.name,
          status: "queued",
          result: null,
          error: "",
        });
      } catch (err) {
        console.error("Could not read file:", file.name, err);
        skipped.push(file.name);
      }
    }

    if (added.length) {
      setItems((prev) => [...prev, ...added]);
      setShowQueue(true);
    }

    if (skipped.length && !added.length) {
      setUploadError(`Could not read: ${skipped.join(", ")}.`);
    }

    setUploading(false);
  };

  const clearUploadError = useCallback(() => setUploadError(""), []);

  // ============================================================
  // QUEUE ACTIONS
  // ============================================================

  const retryItem = useCallback(
    (id) => updateItem(id, { status: "queued", error: "" }),
    [updateItem]
  );

  const removeItem = useCallback((id) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const reviewItems = useCallback(() => {
    if (!itemsRef.current.some((i) => i.status === "completed")) return;

    setShowQueue(false);
    setShowOCRConfirmation(true);
  }, []);

  const backToQueue = useCallback(() => {
    setShowOCRConfirmation(false);
    setShowQueue(true);
  }, []);

  // Throw away the whole batch.
  const discardAll = useCallback(() => {
    if (scanning) return;

    const credential = credentialRef.current;

    setItems([]);
    setShowQueue(false);
    setShowOCRConfirmation(false);
    setSelectedCredential(null);

    onCancelledRef.current?.(credential);
  }, [scanning]);

  // ============================================================
  // SAVE ONE DOCUMENT (called once per item by "Save All")
  // ============================================================

  const saveItem = async (id, payload = {}) => {
    const item = itemsRef.current.find((i) => i.id === id);
    const base = item?.result || {};

    const finalPayload = {
      ...base,
      ...(payload || {}),

      image_data_url:
        payload?.image_data_url ||
        payload?.imageDataUrl ||
        base.image_data_url ||
        base.imageDataUrl ||
        "",

      imageDataUrl:
        payload?.imageDataUrl ||
        payload?.image_data_url ||
        base.imageDataUrl ||
        base.image_data_url ||
        "",

      file_url:
        payload?.fileUrl || payload?.file_url || base.file_url || base.fileUrl || "",

      fileUrl:
        payload?.fileUrl || payload?.file_url || base.fileUrl || base.file_url || "",

      document_id:
        payload?.documentId ?? payload?.document_id ?? base.document_id ?? null,

      document_type:
        payload?.documentType || payload?.document_type || base.document_type || "",

      matched_student:
        payload?.matchedStudent ||
        payload?.matched_student ||
        base.matched_student ||
        null,

      matched_student_id:
        payload?.studentId ||
        payload?.matched_student_id ||
        base.matched_student_id ||
        studentIdRef.current ||
        null,
    };

    if (!onConfirmedRef.current) {
      throw new Error("No save handler is connected to the document scanner.");
    }

    const ok = await onConfirmedRef.current(
      finalPayload,
      credentialRef.current
    );

    // false = keep this document in the confirmation so it can be retried.
    if (ok === false) return false;

    setItems((prev) => prev.filter((i) => i.id !== id));

    return true;
  };

  // ============================================================
  // RETURN
  // ============================================================

  return {
    // Scan modal
    showScanModal,
    selectedCredential,
    scanning,
    scanError,

    // Scanner list
    scanners,
    selectedScanner,
    setSelectedScanner,
    loadingScanners,
    scannerError,
    loadScanners,

    // Queue
    items,
    completedItems,
    queueBusy,
    showQueue,
    showOCRConfirmation,

    // Upload state
    uploading,
    uploadError,
    clearUploadError,

    // Actions
    open,
    close,
    scan,
    scanAnother,
    upload,
    retryItem,
    removeItem,
    reviewItems,
    backToQueue,
    discardAll,
    saveItem,
  };
}