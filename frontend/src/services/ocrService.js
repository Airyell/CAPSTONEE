const OCR_API_URL = import.meta.env.VITE_OCR_API_URL;

export async function processOCR(file) {
    if (!OCR_API_URL) {
        throw new Error("OCR API URL is not configured.");
    }

    const formData = new FormData();

    // The field name must match your Python OCR endpoint.
    formData.append("file", file);

    const response = await fetch(`${OCR_API_URL}/ocr`, {
        method: "POST",
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`OCR failed: ${response.status}`);
    }

    return await response.json();
}