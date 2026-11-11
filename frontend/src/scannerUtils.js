// Base URL of the local Flask scanner service
export const SCANNER_URL = "http://127.0.0.1:5000";
const OCR_BASE = (import.meta.env.VITE_OCR_API_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
export const OCR_URL = `${OCR_BASE}/ocr`;

// Make sure a scanner-returned URL is absolute
// Flask may return "/scans/x.jpg"
export const absoluteUrl = (url) => {
  if (!url) return null;

  if (/^(https?:|data:|blob:)/i.test(url)) {
    return url;
  }

  return `${SCANNER_URL}${url.startsWith("/") ? "" : "/"}${url}`;
};

export const isPdf = (url) => /\.pdf(\?|#|$)/i.test(url || "");