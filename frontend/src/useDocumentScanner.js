
import { useState, useCallback } from "react";
import { SCANNER_URL, OCR_URL, absoluteUrl } from "./scannerUtils";
import { supabase } from "./supabaseClient";
import { matchStudentFromOcr } from "./matchStudent";

/**
 * Reusable document-scanning logic.
 *
 * @param {object} options
 * @param {string} options.studentId
 *   When scanning from a student's profile, the student is already known.
 *
 * @param {function} options.onScanned
 *   Called after a successful scan.
 *
 * @param {function} options.onConfirmed
 *   Called when OCR confirmation is saved.
 *   Return false to keep the confirmation dialog open.
 *
 * @param {function} options.onCancelled
 *   Called when confirmation is cancelled or the scan is discarded.
 */

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

// Keep data URLs unchanged. Resolve ordinary relative/HTTP file URLs
// using the existing scanner utility.
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
  // The scanned image data URL is directly usable by the preview.
  if (imageDataUrl) {
    return imageDataUrl;
  }

  const value =
    data?.file_url ||
    data?.fileUrl ||
    data?.file_path ||
    data?.filePath ||
    "";

  if (!value || typeof value !== "string") {
    return "";
  }

  if (
    /^(data:|blob:|https?:\/\/)/i.test(value)
  ) {
    return value;
  }

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
// REUSABLE SCANNER HOOK
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
  // Upload document state
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  // Available physical scanners
  const [scanners, setScanners] = useState([]);
  const [selectedScanner, setSelectedScanner] = useState(null);
  const [loadingScanners, setLoadingScanners] = useState(false);
  const [scannerError, setScannerError] = useState("");

  // OCR confirmation
  const [ocrResult, setOcrResult] = useState(null);
  const [showOCRConfirmation, setShowOCRConfirmation] = useState(false);

  // ============================================================
  // SCANNER DISCOVERY
  // ============================================================

  const loadScanners = useCallback(
    async (force = false) => {
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
          throw new Error(
            "The scanner service returned an invalid response."
          );
        }

        if (!response.ok || !data.success) {
          throw new Error(
            data.message || "Unable to load scanners."
          );
        }

        setScanners(data.scanners || []);

        // Keep the selected scanner if it is still available.
        setSelectedScanner((current) => {
          if (
            current &&
            (data.scanners || []).some(
              (scanner) => scanner.id === current.id
            )
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
            : err.message ||
                "Unable to connect to the scanner service."
        );

        setScanners([]);
      } finally {
        setLoadingScanners(false);
      }
    },
    []
  );

  // ============================================================
  // OPEN / CLOSE MODAL
  // ============================================================

  const open = useCallback(
    (credential = null) => {
      setSelectedCredential(credential);
      setScanError("");
      setScannerError("");

      // Clear the previous scan.
      setOcrResult(null);
      setShowOCRConfirmation(false);

      setShowScanModal(true);
      loadScanners();
    },
    [loadScanners]
  );

  const close = useCallback(() => {
    if (scanning) return;

    setShowScanModal(false);
    setSelectedCredential(null);
    setSelectedScanner(null);
    setScanError("");
    setScannerError("");
  }, [scanning]);

  // ============================================================
  // SCAN DOCUMENT
  // ============================================================

  const scan = async () => {
    const credential = selectedCredential;
    const scanner = selectedScanner;

    if (!scanner) {
      setScanError("Please select a scanner first.");
      return;
    }

    try {
      setScanning(true);
      setScanError("");

      // The Flask scanner returns the scanned image as image_data_url.
      const response = await fetch(`${SCANNER_URL}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          device_uid: scanner.id,
        }),
      });

      let data;

      try {
        data = await response.json();
      } catch {
        throw new Error(
          "The scanner service returned an invalid response."
        );
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data?.message || "Failed to scan the document."
        );
      }

      console.log("[RAW SCAN RESPONSE]", {
        success: data.success,
        hasImageDataUrl: Boolean(
          data.image_data_url || data.imageDataUrl
        ),
        hasFileUrl: Boolean(data.file_url || data.fileUrl),
        documentType: data.document_type,
        documentId: data.document_id,
      });

      // Preserve the actual image separately from the preview URL.
      const imageDataUrl = getImageDataUrl(data);
      const fileUrl = getFileUrl(data, imageDataUrl);

      const result = {
        ...data,

        // Canonical image fields used by the confirmation and save flow.
        image_data_url: imageDataUrl,
        imageDataUrl: imageDataUrl,
        file_url: fileUrl,
        fileUrl: fileUrl,

        filename:
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
          data.document_type_key ||
          data.documentTypeKey ||
          "",

        document_type_confidence:
          data.document_type_confidence ??
          data.documentTypeConfidence ??
          null,

        document_type_matches:
          data.document_type_matches ||
          data.documentTypeMatches ||
          [],

        document_type_suggestions:
          data.document_type_suggestions || [],

        document_id:
          data.document_id ??
          data.documentId ??
          null,

        first_name:
          data.first_name ??
          data.firstName ??
          "",

        middle_name:
          data.middle_name ??
          data.middleName ??
          "",

        last_name:
          data.last_name ??
          data.lastName ??
          "",
      };

      // The scan can continue to confirmation even if OCR could not
      // return an image URL. Saving will validate that image later.
      if (!imageDataUrl && !fileUrl) {
        console.warn(
          "[SCAN WARNING] No usable image URL was returned by the scanner."
        );
      }

      // ========================================================
      // AUTO-FILL DOCUMENT TYPE + STUDENT MATCH
      // ========================================================

      try {
        result.document_id = await resolveDocumentId(result);

        const fullName =
          result.full_name ||
          result.fullName ||
          result.student_name ||
          result.studentName ||
          [
            result.first_name,
            result.middle_name,
            result.last_name,
          ]
            .filter(Boolean)
            .join(" ");

        if (
          studentId !== undefined &&
          studentId !== null &&
          studentId !== ""
        ) {
          // Scanning from Student Profile:
          // this student is already selected, so don't match by OCR name.
          result.matched_student = null;
          result.student_candidates = [];
          result.matched_student_id = studentId;
        } else if (fullName.trim()) {
          // Scanning from Dashboard:
          // match the OCR name to an existing student record.
          const match = await matchStudentFromOcr({
            first: result.first_name,
            middle: result.middle_name,
            last: result.last_name,
            fullName,
          });

          result.matched_student = match?.student || null;
          result.student_candidates = match?.candidates || [];
          result.matched_student_id =
            match?.student?.student_id ?? null;

          console.log("[OCR NAME]", fullName);
          console.log(
            "[STUDENT MATCH]",
            result.matched_student
          );
          console.log(
            "[STUDENT CANDIDATES]",
            result.student_candidates
          );
        } else {
          result.matched_student = null;
          result.student_candidates = [];
          result.matched_student_id = null;

          console.warn(
            "OCR returned no usable name for student matching."
          );
        }
      } catch (err) {
        console.error("Auto-fill lookup failed:", err);

        // A matching error should not discard the scanned image.
        result.matched_student = null;
        result.student_candidates = [];
        result.matched_student_id = studentId || null;
      }

      // Notify the parent that the scan completed.
      onScanned?.(credential, result);

      setOcrResult(result);
      setShowScanModal(false);
      setShowOCRConfirmation(true);
    } catch (err) {
      console.error("Scanner error:", err);

      const unreachable = err instanceof TypeError;

      setScanError(
        unreachable
          ? `Can't reach the scanner service at ${SCANNER_URL}. Make sure it is running and allows requests from this site (CORS).`
          : err.message ||
              "Unable to connect to the selected scanner."
      );
    } finally {
      setScanning(false);
    }
  };

  
  // ============================================================
  // UPLOAD DOCUMENT
  // ============================================================

  const upload = async (file) => {
    if (!file) {
      setUploadError("Please select a document first.");
      return;
    }

    const allowedExtensions = [
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".bmp",
      ".tif",
      ".tiff",
    ];

    const fileName = file.name || "";
    const extension = fileName
      .substring(fileName.lastIndexOf("."))
      .toLowerCase();

    if (!allowedExtensions.includes(extension)) {
      setUploadError(
        "Unsupported file format. Please select JPG, JPEG, PNG, WEBP, BMP, TIF, or TIFF."
      );
      return;
    }

    try {
      setUploading(true);
      setUploadError("");

      // Convert the selected image into a data URL
      // for the existing preview and save process.
      const imageDataUrl = await readFileAsDataUrl(file);

      // Send the original file to the Flask OCR server.
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(OCR_URL, {
        method: "POST",
        body: formData,
      });

      let data;

      try {
        data = await response.json();
      } catch {
        throw new Error(
          "The OCR service returned an invalid response."
        );
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data?.error ||
          data?.message ||
          "Unable to extract information from the uploaded document."
        );
      }

      console.log("[UPLOAD OCR RESPONSE]", data);

      // Create the same result structure used by the
      // physical scanner so OCRConfirmation can reuse it.
      const result = {
        ...data,

        image_data_url: imageDataUrl,
        imageDataUrl: imageDataUrl,
        file_url: imageDataUrl,
        fileUrl: imageDataUrl,

        filename: file.name,

        document_type:
          data.document_type ||
          data.detected_document_type ||
          data.detectedDocType ||
          "",

        document_type_key:
          data.document_type_key ||
          data.documentTypeKey ||
          "",

        document_type_confidence:
          data.document_type_confidence ??
          data.documentTypeConfidence ??
          null,

        document_type_matches:
          data.document_type_matches ||
          data.documentTypeMatches ||
          [],

        document_type_suggestions:
          data.document_type_suggestions || [],

        document_id:
          data.document_id ??
          data.documentId ??
          null,

        first_name:
          data.first_name ??
          data.firstName ??
          "",

        middle_name:
          data.middle_name ??
          data.middleName ??
          "",

        last_name:
          data.last_name ??
          data.lastName ??
          "",
      };

      // ========================================================
      // AUTO-FILL DOCUMENT TYPE + STUDENT MATCH
      // Same matching logic as physical scanner.
      // ========================================================

      try {
        result.document_id = await resolveDocumentId(result);

        const fullName =
          result.full_name ||
          result.fullName ||
          result.student_name ||
          result.studentName ||
          [
            result.first_name,
            result.middle_name,
            result.last_name,
          ]
            .filter(Boolean)
            .join(" ");

        if (
          studentId !== undefined &&
          studentId !== null &&
          studentId !== ""
        ) {
          // Student Profile upload:
          // The student is already known.
          result.matched_student = null;
          result.student_candidates = [];
          result.matched_student_id = studentId;
        } else if (fullName.trim()) {
          // Dashboard upload:
          // Match the extracted name with existing student records.
          const match = await matchStudentFromOcr({
            first: result.first_name,
            middle: result.middle_name,
            last: result.last_name,
            fullName,
          });

          result.matched_student = match?.student || null;
          result.student_candidates = match?.candidates || [];
          result.matched_student_id =
            match?.student?.student_id ?? null;

          console.log("[UPLOAD OCR NAME]", fullName);
          console.log(
            "[UPLOAD STUDENT MATCH]",
            result.matched_student
          );
          console.log(
            "[UPLOAD STUDENT CANDIDATES]",
            result.student_candidates
          );
        } else {
          result.matched_student = null;
          result.student_candidates = [];
          result.matched_student_id = null;

          console.warn(
            "Uploaded document OCR returned no usable student name."
          );
        }
      } catch (err) {
        console.error(
          "Upload auto-fill lookup failed:",
          err
        );

        // Do not discard the uploaded document if matching fails.
        result.matched_student = null;
        result.student_candidates = [];
        result.matched_student_id = studentId || null;
      }

      // Notify the parent using the same callback as scanning.
      onScanned?.(selectedCredential, result);

      // Open the SAME OCR confirmation component.
      setOcrResult(result);
      setShowScanModal(false);
      setShowOCRConfirmation(true);

    } catch (err) {
      console.error("Document upload OCR error:", err);

      const unreachable = err instanceof TypeError;

      setUploadError(
        unreachable
          ? `Can't reach the OCR service at ${OCR_URL}. Make sure the Flask OCR server is running and allows requests from this site (CORS).`
          : err.message ||
            "Unable to process the uploaded document."
      );

      console.error("[UPLOAD ERROR DETAILS]", err);

    } finally {
      setUploading(false);
    }
  };



  // ============================================================
  // SCAN AGAIN
  // ============================================================

  const scanAgain = () => {
    const credential = selectedCredential;

    // Discard the current scan and undo its pending state.
    onCancelled?.(credential);

    setOcrResult(null);
    setShowOCRConfirmation(false);

    setScanError("");
    setScannerError("");

    setSelectedScanner(null);
    setSelectedCredential(credential);

    setShowScanModal(true);
    loadScanners();
  };

  // ============================================================
  // CANCEL OCR CONFIRMATION
  // ============================================================

  const cancelOCR = () => {
    const credential = selectedCredential;

    setShowOCRConfirmation(false);
    setOcrResult(null);
    setSelectedCredential(null);

    onCancelled?.(credential);
  };

  // ============================================================
  // SAVE OCR CONFIRMATION
  // ============================================================

  const saveOCR = async (payload = {}) => {
    try {
      // OCRConfirmation may provide only the selected fields.
      // Merge the original scan result so the image and OCR match
      // are not lost before the parent callback receives them.
      const finalPayload = {
        ...(ocrResult || {}),
        ...(payload || {}),

        // Keep both naming conventions available.
        image_data_url:
          payload?.image_data_url ||
          payload?.imageDataUrl ||
          ocrResult?.image_data_url ||
          ocrResult?.imageDataUrl ||
          "",

        imageDataUrl:
          payload?.imageDataUrl ||
          payload?.image_data_url ||
          ocrResult?.imageDataUrl ||
          ocrResult?.image_data_url ||
          "",

        file_url:
          payload?.fileUrl ||
          payload?.file_url ||
          ocrResult?.file_url ||
          ocrResult?.fileUrl ||
          "",

        fileUrl:
          payload?.fileUrl ||
          payload?.file_url ||
          ocrResult?.fileUrl ||
          ocrResult?.file_url ||
          "",

        document_id:
          payload?.documentId ??
          payload?.document_id ??
          ocrResult?.document_id ??
          null,

        document_type:
          payload?.documentType ||
          payload?.document_type ||
          ocrResult?.document_type ||
          "",

        matched_student:
          payload?.matchedStudent ||
          payload?.matched_student ||
          ocrResult?.matched_student ||
          null,

        matched_student_id:
          payload?.studentId ||
          payload?.matched_student_id ||
          ocrResult?.matched_student_id ||
          studentId ||
          null,
      };

      console.log("[OCR SAVE PAYLOAD]", {
        studentId: finalPayload.studentId,
        matchedStudentId: finalPayload.matched_student_id,
        documentType: finalPayload.document_type,
        documentId: finalPayload.document_id,
        hasImageDataUrl: Boolean(finalPayload.image_data_url),
        hasFileUrl: Boolean(finalPayload.file_url),
      });

      if (!onConfirmed) {
        throw new Error(
          "No save handler is connected to the document scanner."
        );
      }

      const ok = await onConfirmed(
        finalPayload,
        selectedCredential
      );

      // Return false to keep OCR confirmation open for retry.
      if (ok === false) {
        return false;
      }

      setShowOCRConfirmation(false);
      setOcrResult(null);
      setSelectedCredential(null);

      return true;
    } catch (err) {
      console.error("OCR save error:", err);
      throw err;
    }
  };

  // ============================================================
  // RETURN
  // ============================================================

  return {
    // Modal state
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

    // OCR state
    ocrResult,
    showOCRConfirmation,

    // Upload state
    uploading,
    uploadError,

    // Actions
    open,
    close,
    scan,
    upload,
    scanAgain,
    cancelOCR,
    saveOCR,  
  };
}