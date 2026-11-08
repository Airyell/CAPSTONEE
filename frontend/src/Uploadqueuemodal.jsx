import { useRef } from "react";
import { createPortal } from "react-dom";
import "./styles/OCRConfirmation.css";
import "./styles/OCRBatch.css";

const STATUS = {
  queued: { label: "Queued", cls: "queued" },
  processing: { label: "Processing", cls: "processing" },
  completed: { label: "Completed", cls: "completed" },
  failed: { label: "Failed", cls: "failed" },
};

// Every button label stays on one line.
const BUTTON_STYLE = {
  flex: "none",
  width: "auto",
  whiteSpace: "nowrap",
};

export default function UploadQueueModal({
  open,
  items = [],
  scanning = false,
  busy = false,
  onAddFiles,
  onScanAnother,
  onReview,
  onRetry,
  onRemove,
  onDiscard,
}) {
  const inputRef = useRef(null);

  if (!open) return null;

  const total = items.length;
  const completed = items.filter((i) => i.status === "completed").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const finished = completed + failed;
  const percent = total ? Math.round((finished / total) * 100) : 0;

  const title = busy ? "Reading documents" : "Documents ready";

  const subtitle = busy
    ? `${finished} of ${total} processed. You can still add more files or scan another page.`
    : failed
      ? `${completed} ready, ${failed} failed. Retry or remove the failed files.`
      : `${completed} ${completed === 1 ? "document is" : "documents are"} ready for review.`;

  const handleFiles = (event) => {
    const files = Array.from(event.target.files || []);

    // Allow choosing the same files again later.
    event.target.value = "";

    if (files.length) onAddFiles?.(files);
  };

  const content = (
    <div className="ocr-overlay">
      <div
        className="ocrq-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={(el) => {
          // Inline !important beats the stylesheet's max-width: 560px !important.
          if (el) {
            el.style.setProperty("max-width", "880px", "important");
            el.style.setProperty("width", "100%", "important");
          }
        }}
      >
        <div className="ocr-header">
          <div>
            <h3 className="ocr-title">{title}</h3>
            <p className="ocr-sub">{subtitle}</p>
          </div>
        </div>

        <div className="ocrq-body">
          <div
            className="ocrq-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="ocrq-progress-bar" style={{ width: `${percent}%` }} />
          </div>

          <ul className="ocrq-list">
            {items.map((item) => {
              const status = STATUS[item.status] || STATUS.queued;

              return (
                <li key={item.id} className="ocrq-row">
                  <div className="ocrq-row-main">
                    <span className="ocrq-name" title={item.label}>
                      {item.label}
                    </span>

                    {item.status === "failed" && item.error && (
                      <span className="ocrq-error">{item.error}</span>
                    )}
                  </div>

                  <div className="ocrq-row-actions">
                    {item.status === "failed" && item.source === "upload" && (
                      <button
                        type="button"
                        className="ocrq-link-btn"
                        onClick={() => onRetry?.(item.id)}
                      >
                        Retry
                      </button>
                    )}

                    {item.status !== "processing" && (
                      <button
                        type="button"
                        className="ocrq-link-btn"
                        onClick={() => onRemove?.(item.id)}
                        aria-label={`Remove ${item.label}`}
                      >
                        Remove
                      </button>
                    )}

                    <span className={`ocrq-badge ocrq-badge-${status.cls}`}>
                      {status.label}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* ONE ROW: all four buttons side by side */}
        <div
          className="ocr-footer"
          style={{
            display: "flex",
            flexDirection: "row",
            flexWrap: "nowrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", flexWrap: "nowrap", gap: 10 }}>
            <button
              type="button"
              className="ocr-cancel-btn"
              style={BUTTON_STYLE}
              onClick={() => inputRef.current?.click()}
            >
              Add files
            </button>

            <button
              type="button"
              className="ocr-cancel-btn"
              style={BUTTON_STYLE}
              onClick={onScanAnother}
              disabled={scanning}
            >
              Scan another page
            </button>

            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff,image/jpeg,image/png,image/webp"
              style={{ display: "none" }}
              onChange={handleFiles}
            />
          </div>

          <div style={{ display: "flex", flexWrap: "nowrap", gap: 10 }}>
            <button
              type="button"
              className="ocr-cancel-btn"
              style={BUTTON_STYLE}
              onClick={onDiscard}
              disabled={scanning}
            >
              Discard all
            </button>

            <button
              type="button"
              className="ocr-save-btn"
              style={BUTTON_STYLE}
              onClick={onReview}
              disabled={busy || scanning || completed === 0}
            >
              Review and confirm ({completed})
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}