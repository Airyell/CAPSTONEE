import OCRConfirmation from "./OCRconfirmation.jsx";

/**
 * Renders the Scan Document modal and the OCR confirmation dialog.
 * Drive it with the useDocumentScanner hook:
 *
 *   const scanner = useDocumentScanner({ studentId, onScanned, onConfirmed, onCancelled });
 *   <DocumentScanner scanner={scanner} studentId={id} studentName={name} />
 */
export default function DocumentScanner({ scanner, studentId, studentName }) {
  const {
    showScanModal,
    selectedCredential,
    scanning,
    scanError,

    // Upload state
    uploading,
    uploadError,
    scanners,
    selectedScanner,
    setSelectedScanner,
    loadingScanners,
    scannerError,
    loadScanners,
    ocrResult,
    showOCRConfirmation,
    close,
    scan,
    scanAgain,
    cancelOCR,
    saveOCR,
  } = scanner;

  return (
    <>
      {/* Spinner animation */}
      <style>{`
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @keyframes uploadFadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes uploadPulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }
`}</style>

{/* ========================================================
    UPLOAD DOCUMENT LOADING OVERLAY
    ======================================================== */}

{uploading && (
  <div
    style={{
      position: "fixed",
      inset: 0,
      zIndex: 99999,
      background: "rgba(15, 23, 42, 0.65)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "20px",
      animation: "uploadFadeIn 0.2s ease",
    }}
  >
    <div
      style={{
        width: "100%",
        maxWidth: "400px",
        background: "#ffffff",
        borderRadius: "16px",
        padding: "35px 25px",
        textAlign: "center",
        boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
      }}
    >
      <div
        style={{
          width: "55px",
          height: "55px",
          border: "5px solid #e5e7eb",
          borderTop: "5px solid #000B58",
          borderRadius: "50%",
          margin: "0 auto 22px",
          animation: "spin 1s linear infinite",
        }}
      />

      <h3
        style={{
          fontSize: "19px",
          fontWeight: "700",
          color: "#111827",
          marginBottom: "9px",
        }}
      >
        Processing Document
      </h3>

      <p
        style={{
          fontSize: "13px",
          lineHeight: "1.6",
          color: "#6b7280",
          margin: 0,
        }}
      >
        Please wait while the system extracts and analyzes
        the information from your uploaded document.
      </p>

      <p
        style={{
          marginTop: "18px",
          fontSize: "11px",
          color: "#000B58",
          fontWeight: "600",
          animation: "uploadPulse 1.5s infinite",
        }}
      >
        DO NOT CLOSE THIS WINDOW
      </p>
    </div>
  </div>
)}

{/* UPLOAD ERROR MESSAGE */}

{uploadError && !uploading && (
  <div
    style={{
      position: "fixed",
      bottom: "25px",
      right: "25px",
      zIndex: 100000,
      maxWidth: "400px",
      padding: "15px 20px",
      borderRadius: "10px",
      background: "#fee2e2",
      color: "#b91c1c",
      border: "1px solid #fecaca",
      boxShadow: "0 5px 20px rgba(0,0,0,0.12)",
      fontSize: "13px",
    }}
  >
    <strong>Upload Failed</strong>
    <p style={{ margin: "5px 0 0" }}>{uploadError}</p>
  </div>
)}

      {/* ========================================================
          SCAN DOCUMENT MODAL
          ======================================================== */}

      {showScanModal && (
        <div className="modal-overlay" onClick={close}>
          <div
            className="scan-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            {!scanning ? (
              <>
                <h3 className="scan-modal-title">Scan Document</h3>

                <p className="scan-modal-sub">
                  {studentName
                    ? `Select a scanner and scan a document for ${studentName}.`
                    : "Select a scanner and scan the student's document."}
                </p>

                {/* DOCUMENT TYPE */}
                {selectedCredential && (
                  <div
                    style={{
                      padding: "14px",
                      marginBottom: "15px",
                      borderRadius: "10px",
                      background: "#f8fafc",
                      border: "1px solid #e5e7eb",
                    }}
                  >
                    <p
                      style={{
                        fontSize: "12px",
                        color: "#6b7280",
                        marginBottom: "4px",
                      }}
                    >
                      Document Type
                    </p>

                    <p style={{ fontWeight: "600", fontSize: "16px" }}>
                      {selectedCredential.name}
                    </p>
                  </div>
                )}

                {/* SCANNER SELECTION */}
                <div style={{ marginBottom: "15px" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "8px",
                    }}
                  >
                    <label style={{ fontSize: "13px", fontWeight: "600" }}>
                      Available Scanner
                    </label>

                    <button
                      type="button"
                      onClick={() => loadScanners(true)}
                      disabled={loadingScanners}
                      style={{
                        border: "none",
                        background: "transparent",
                        cursor: loadingScanners ? "default" : "pointer",
                        fontSize: "18px",
                      }}
                      title="Refresh scanners"
                    >
                      ⟳
                    </button>
                  </div>

                  {loadingScanners ? (
                    <div
                      style={{
                        padding: "18px",
                        border: "1px solid #e5e7eb",
                        borderRadius: "10px",
                        textAlign: "center",
                        color: "#6b7280",
                      }}
                    >
                      Detecting scanners...
                    </div>
                  ) : scanners.length === 0 ? (
                    <div
                      style={{
                        padding: "18px",
                        border: "1px solid #fecaca",
                        background: "#fef2f2",
                        borderRadius: "10px",
                        color: "#b91c1c",
                        fontSize: "14px",
                      }}
                    >
                      No scanners were detected.
                      <div style={{ marginTop: "6px", fontSize: "12px" }}>
                        Make sure the scanner is powered on and connected to
                        this computer.
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                      }}
                    >
                      {scanners.map((s) => {
                        const isSelected = selectedScanner?.id === s.id;

                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setSelectedScanner(s)}
                            style={{
                              width: "100%",
                              padding: "14px",
                              borderRadius: "10px",
                              border: isSelected
                                ? "2px solid #000B58"
                                : "1px solid #e5e7eb",
                              background: isSelected ? "#f1f4ff" : "#ffffff",
                              textAlign: "left",
                              cursor: "pointer",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "12px",
                              }}
                            >
                              <div style={{ fontSize: "28px" }}>🖨️</div>

                              <div style={{ flex: 1 }}>
                                <p style={{ margin: 0, fontWeight: "600" }}>
                                  {s.name}
                                </p>

                                {s.manufacturer && (
                                  <p
                                    style={{
                                      margin: "3px 0 0",
                                      fontSize: "12px",
                                      color: "#6b7280",
                                    }}
                                  >
                                    {s.manufacturer}
                                  </p>
                                )}
                              </div>

                              {isSelected && (
                                <div style={{ fontSize: "18px" }}>✓</div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* SCANNER ERROR */}
                {scannerError && (
                  <div
                    style={{
                      padding: "12px",
                      marginBottom: "12px",
                      borderRadius: "8px",
                      background: "#fee2e2",
                      color: "#b91c1c",
                      fontSize: "13px",
                    }}
                  >
                    {scannerError}
                  </div>
                )}

                {/* SCAN ERROR */}
                {scanError && (
                  <div
                    style={{
                      padding: "12px",
                      marginBottom: "12px",
                      borderRadius: "8px",
                      background: "#fee2e2",
                      color: "#b91c1c",
                      fontSize: "13px",
                    }}
                  >
                    {scanError}
                  </div>
                )}

                {/* SCAN BUTTON */}
                <button
                  className="scan-option-btn w-full text-left"
                  onClick={scan}
                  disabled={!selectedScanner || loadingScanners}
                  style={{
                    opacity: !selectedScanner || loadingScanners ? 0.5 : 1,
                    cursor:
                      !selectedScanner || loadingScanners
                        ? "not-allowed"
                        : "pointer",
                  }}
                >
                  <p className="scan-option-title">Start Scanner</p>

                  <p className="scan-option-sub">
                    {selectedScanner
                      ? `Scan using ${selectedScanner.name}`
                      : "Select a scanner first"}
                  </p>
                </button>

                {/* CANCEL */}
                <button className="scan-cancel-btn w-full" onClick={close}>
                  Cancel
                </button>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "30px 15px" }}>
                <div style={{ fontSize: "48px", marginBottom: "15px" }}>
                  🖨️
                </div>

                <h3 className="scan-modal-title">Scanning Document</h3>

                <p className="scan-modal-sub">
                  {selectedCredential?.name || "Document"}
                </p>

                <p
                  style={{
                    fontSize: "13px",
                    color: "#6b7280",
                    marginTop: "8px",
                  }}
                >
                  Scanner: {selectedScanner?.name}
                </p>

                <div
                  style={{
                    margin: "25px auto",
                    width: "45px",
                    height: "45px",
                    border: "4px solid #e5e7eb",
                    borderTop: "4px solid #000B58",
                    borderRadius: "50%",
                    animation: "spin 1s linear infinite",
                  }}
                />

                <p style={{ fontSize: "13px", color: "#6b7280" }}>
                  Please wait while the document is being scanned.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================
          OCR CONFIRMATION
          ======================================================== */}

      {showOCRConfirmation && ocrResult && (
        <OCRConfirmation
          ocrResult={ocrResult}
          studentId={studentId ?? ""}
          studentName={studentName ?? ""}
          fileName={ocrResult.filename || ""}
          fileUrl={
  ocrResult.image_data_url ||
  ocrResult.file_url ||
  ocrResult.fileUrl ||
  ""
}
          detectedDocType={ocrResult.document_type || ""}
          documentTypeConfidence={ocrResult.document_type_confidence ?? null}
          preferredDocType={selectedCredential?.name || ""}
          onCancel={cancelOCR}
          onScanAgain={scanAgain}
          onSave={saveOCR}
        />
      )}
    </>
  );
}