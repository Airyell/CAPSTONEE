import os
import re
import json
import traceback
import time
import tempfile
import threading
from difflib import SequenceMatcher
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, request, jsonify
from flask_cors import CORS
from document_classifier import (
    classify_document_type,
    get_document_types,
    SUPABASE_URL,
    SUPABASE_KEY,
)


app = Flask(__name__)

# Allowed frontend origins, comma-separated. Set ALLOWED_ORIGINS on Render,
# e.g. https://your-app.vercel.app
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if o.strip()
]
CORS(app, resources={r"/*": {"origins": ALLOWED_ORIGINS}})

# ============================================================
# CLASSIFIER STATUS
# ============================================================

@app.route("/classifier-status", methods=["GET"])
def classifier_status():
    docs = get_document_types()

    return jsonify(
        {
            "credentials_found": bool(SUPABASE_URL and SUPABASE_KEY),
            "documents_loaded": len(docs),
            "documents": [
                {
                    "id": d["document_id"],
                    "name": d["document_name"]
                }
                for d in docs
            ],
        }
    )


# ============================================================
# OCR CONFIGURATION
# ============================================================

# mkldnn (oneDNN) is OFF by default because it crashes inference on some
# Paddle 3.x / CPU / Windows setups. Set OCR_ENABLE_MKLDNN=1 to turn it on.
OCR_ENABLE_MKLDNN = (
    os.environ.get("OCR_ENABLE_MKLDNN", "0") == "1"
)

try:
    OCR_CPU_THREADS = max(
        1,
        int(
            os.environ.get(
                "OCR_CPU_THREADS",
                min(4, os.cpu_count() or 4)
            )
        )
    )
except Exception:
    OCR_CPU_THREADS = 4


try:
    # 1800-2000 is a useful speed/legibility balance for scanned records.
    OCR_MAX_SIZE = max(500, int(os.environ.get("OCR_MAX_SIZE", "2000")))
except Exception:
    OCR_MAX_SIZE = 2000

# Scan only the top part of the page first (the student name and the
# document title are almost always there). The full page is only scanned
# if the name or the document type was not found. This roughly halves the
# OCR time. Set OCR_UPPER_FIRST=0 to always scan the full page.
OCR_UPPER_FIRST = os.environ.get("OCR_UPPER_FIRST", "1") == "1"

try:
    OCR_UPPER_FRACTION = min(
        1.0,
        max(0.25, float(os.environ.get("OCR_UPPER_FRACTION", "0.55")))
    )
except Exception:
    OCR_UPPER_FRACTION = 0.55

# Expensive image operations are opt-in. Enable only when a scan is poor.
OCR_DESKEW = os.environ.get("OCR_DESKEW", "0") == "1"
OCR_ENABLE_ENHANCED_FALLBACK = os.environ.get("OCR_ENABLE_ENHANCED_FALLBACK", "0") == "1"
OCR_ENABLE_UPPER_FALLBACK = os.environ.get("OCR_ENABLE_UPPER_FALLBACK", "0") == "1"
OCR_VERBOSE = os.environ.get("OCR_VERBOSE", "0") == "1"


OCR_TEXTLINE_ORIENTATION = (
    os.environ.get("OCR_TEXTLINE_ORIENTATION", "0") == "1"
)


# ============================================================
# OCR ENGINE
# ============================================================
#
# OCR_ENGINE=rapidocr  (default) -> ONNX Runtime. Fast on CPU and does not
#                                   have the Paddle 3.x oneDNN crash.
# OCR_ENGINE=paddle              -> original PaddleOCR 3.x engine.
#
# If rapidocr is not installed, the server falls back to PaddleOCR.

OCR_ENGINE_NAME = os.environ.get("OCR_ENGINE", "rapidocr").strip().lower()

OCR_DET_MODEL = os.environ.get(
    "OCR_DET_MODEL",
    "PP-OCRv5_mobile_det"
)

OCR_REC_MODEL = os.environ.get(
    "OCR_REC_MODEL",
    "PP-OCRv5_mobile_rec"
)

OCR_DOC_ORIENTATION = (
    os.environ.get("OCR_DOC_ORIENTATION", "0") == "1"
)


def _build_paddle_engine():
    from paddleocr import PaddleOCR

    common = dict(
        text_detection_model_name=OCR_DET_MODEL,
        text_recognition_model_name=OCR_REC_MODEL,
        device="cpu",
        use_doc_orientation_classify=OCR_DOC_ORIENTATION,
        use_doc_unwarping=False,
        use_textline_orientation=OCR_TEXTLINE_ORIENTATION,
        lang="en",
    )

    attempts = [
        {
            **common,
            "enable_mkldnn": OCR_ENABLE_MKLDNN,
            "cpu_threads": OCR_CPU_THREADS,
        },
        {
            **common,
        },
        {
            "device": "cpu",
            "lang": "en",
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
        },
    ]

    last_error = None

    for kwargs in attempts:
        try:
            print("[OCR] Initializing PaddleOCR...")

            engine = PaddleOCR(**kwargs)

            print(
                "[OCR] PaddleOCR initialized successfully."
            )

            return engine

        except Exception as exc:
            last_error = exc

            print("[OCR] Initialization failed:")
            print(str(exc))

    raise RuntimeError(
        "Could not initialize PaddleOCR: "
        f"{last_error}"
    )


def _build_rapid_engine():
    """
    Supports both package generations:
    - rapidocr_onnxruntime (older, Python <= 3.12)
    - rapidocr (newer)
    """

    try:
        from rapidocr_onnxruntime import RapidOCR

        print("[OCR] Initializing RapidOCR (rapidocr_onnxruntime)...")

        try:
            engine = RapidOCR(
                intra_op_num_threads=OCR_CPU_THREADS,
                inter_op_num_threads=1,
            )

        except Exception as exc:
            print("[OCR] Could not set thread options:", exc)

            engine = RapidOCR()

        return engine, "rapidocr_onnxruntime"

    except ImportError:
        pass

    from rapidocr import RapidOCR

    print("[OCR] Initializing RapidOCR (rapidocr)...")

    return RapidOCR(), "rapidocr"


def _build_ocr_engine():
    """
    Returns (engine, backend_name).
    """

    if OCR_ENGINE_NAME != "paddle":
        try:
            engine, backend = _build_rapid_engine()

            print(f"[OCR] RapidOCR ready ({backend}).")

            return engine, backend

        except ImportError:
            print(
                "[OCR] RapidOCR is not installed. "
                "Run: pip install rapidocr-onnxruntime onnxruntime  "
                "(falling back to PaddleOCR)"
            )

        except Exception as exc:
            print("[OCR] RapidOCR failed to initialize:", exc)
            print("[OCR] Falling back to PaddleOCR.")

    return _build_paddle_engine(), "paddle"


ocr_engine, OCR_BACKEND = _build_ocr_engine()

# Prevent concurrent inference calls on the same OCR engine.
ocr_lock = threading.Lock()


# ============================================================
# BASIC TEXT FUNCTIONS
# ============================================================

def clean_text(text):
    if text is None:
        return ""

    text = str(text)

    text = (
        text
        .replace("\n", " ")
        .replace("\r", " ")
        .replace("\t", " ")
    )

    text = re.sub(r"\s+", " ", text)

    return text.strip()


NON_NAME_FIELD_PATTERNS = [
    r"\bDATE\s+OF\s+BIRTH\b",
    r"\bPLACE\s+OF\s+BIRTH\b",
    r"\bSEX\b",
    r"\bCITIZENSHIP\b",
    r"\bRELIGION\b",
    r"\bOCCUPATION\b",
    r"\bRESIDENCE\b",
    r"\bHOSPITAL\b",
    r"\bCLINIC\b",
    r"\bINSTITUTION\b",
    r"\bCITY\s*/?\s*MUNICIPALITY\b",
    r"\bPROVINCE\b",
    r"\bFIRST\b",
    r"\bMIDDLE\b",
    r"\bLAST\b",
    r"\bNAME\s+IN\s+PRINT\b",
    r"\bSIGNATURE\b",
]


def is_non_name_field_text(value):
    text = clean_text(value or "").strip()

    if not text:
        return True

    normalized = re.sub(
        r"[^A-Z]",
        "",
        text.upper()
    )

    forbidden_labels = {
        "DATE",
        "DATEOFBIRTH",
        "PLACEOFBIRTH",
        "SEX",
        "MALE",
        "FEMALE",
        "CITIZENSHIP",
        "RELIGION",
        "OCCUPATION",
        "RESIDENCE",
        "HOSPITAL",
        "CLINIC",
        "INSTITUTION",
        "PROVINCE",
        "FIRST",
        "MIDDLE",
        "LAST",
        "SURNAME",
        "NAMEINPRINT",
        "SIGNATURE",
        "MONTH",
        "YEAR",
        "DAY",
    }

    if normalized in forbidden_labels:
        return True

    forbidden_phrases = (
        "DATEOFBIRTH",
        "PLACEOFBIRTH",
        "NAMEINPRINT",
        "CITIZENSHIP",
        "OCCUPATION",
        "RESIDENCE",
        "HOSPITAL",
        "INSTITUTION",
    )

    if any(
        phrase in normalized
        for phrase in forbidden_phrases
    ):
        return True

    for pattern in NON_NAME_FIELD_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return True

    return False


def normalize_text(text):
    text = clean_text(text).upper()

    text = re.sub(
        r"[^A-Z0-9 ]",
        " ",
        text
    )

    text = re.sub(r"\s+", " ", text)

    return text.strip()


def clean_name(text):
    text = clean_text(text)

    text = re.sub(
        r"[^A-Za-zÀ-ÖØ-öø-ÿ' -]",
        " ",
        text
    )

    text = re.sub(r"\s+", " ", text)

    return text.strip()


# ============================================================
# GEOMETRY
# ============================================================

def polygon_to_box(polygon):
    try:
        arr = np.asarray(
            polygon,
            dtype=float
        )

        if arr.ndim == 2 and arr.shape[1] >= 2:
            return (
                float(np.min(arr[:, 0])),
                float(np.min(arr[:, 1])),
                float(np.max(arr[:, 0])),
                float(np.max(arr[:, 1]))
            )

    except Exception:
        pass

    return None


def box_center(box):
    return (
        (box[0] + box[2]) / 2.0,
        (box[1] + box[3]) / 2.0
    )


def box_width(box):
    return max(
        0.0,
        box[2] - box[0]
    )


def box_height(box):
    return max(
        0.0,
        box[3] - box[1]
    )


def horizontal_overlap(a, b):
    left = max(a[0], b[0])
    right = min(a[2], b[2])

    return max(
        0.0,
        right - left
    )


def vertical_overlap(a, b):
    top = max(a[1], b[1])
    bottom = min(a[3], b[3])

    return max(
        0.0,
        bottom - top
    )


# ============================================================
# IMAGE PREPARATION
# ============================================================

def resize_document(image):
    if image is None:
        return image

    h, w = image.shape[:2]

    largest = max(h, w)

    if largest <= OCR_MAX_SIZE:
        return image

    scale = OCR_MAX_SIZE / float(largest)

    new_w = max(
        1,
        int(w * scale)
    )

    new_h = max(
        1,
        int(h * scale)
    )

    return cv2.resize(
        image,
        (new_w, new_h),
        interpolation=cv2.INTER_AREA
    )


def deskew_document(image):
    try:
        gray = cv2.cvtColor(
            image,
            cv2.COLOR_BGR2GRAY
        )

        _, threshold = cv2.threshold(
            gray,
            0,
            255,
            cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
        )

        coords = np.column_stack(
            np.where(threshold > 0)
        )

        if len(coords) < 200:
            return image

        angle = cv2.minAreaRect(coords)[-1]

        # Normalize to (-45, 45] for OpenCV versions.
        if angle > 45:
            angle -= 90
        elif angle < -45:
            angle += 90

        angle = -angle

        # Never make a large rotation guess.
        if abs(angle) > 2.5:
            return image

        h, w = image.shape[:2]

        matrix = cv2.getRotationMatrix2D(
            (w // 2, h // 2),
            angle,
            1.0
        )

        return cv2.warpAffine(
            image,
            matrix,
            (w, h),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE
        )

    except Exception:
        return image


def prepare_image(image):
    image = resize_document(image)
    if OCR_DESKEW:
        image = deskew_document(image)
    return image


# ============================================================
# OCR RESULT PARSING
# ============================================================

def safe_get(obj, key, default=None):
    """
    Safely retrieve a value from:
    - dict
    - PaddleOCR Result object
    - objects exposing attributes
    """

    if obj is None:
        return default

    if isinstance(obj, dict):
        return obj.get(key, default)

    try:
        value = getattr(obj, key)
        return value
    except Exception:
        pass

    return default


def parse_ocr_result(result):
    """
    Parse PaddleOCR 3.x output across:
    dict, JSON-string, list, tuple, and iterator forms.
    """

    items = []

    if result is None:
        print(
            "[OCR PARSER] ERROR: PaddleOCR returned None."
        )
        return items

    if OCR_VERBOSE:
        print("[OCR PARSER] Incoming result type:", type(result).__name__)

    json_result = None

    try:
        json_result = result.json
    except Exception:
        json_result = None

    if json_result is not None:
        if isinstance(json_result, str):
            try:
                json_result = json.loads(json_result)

                print(
                    "[OCR PARSER] Decoded result.json string."
                )

            except Exception as exc:
                print(
                    "[OCR PARSER] Could not decode result.json:",
                    exc
                )

        if isinstance(json_result, dict):
            result = json_result

    if not isinstance(
        result,
        (dict, list, tuple, str, bytes)
    ):
        if not hasattr(result, "json"):
            try:
                result = list(result)
            except (TypeError, Exception):
                pass

    if isinstance(result, (list, tuple)):
        print(
            "[OCR PARSER] Result sequence length:",
            len(result)
        )

        for element in result:
            items.extend(
                parse_ocr_result(element)
            )

        return items

    if isinstance(result, str):
        try:
            result = json.loads(result)

        except Exception:
            print(
                "[OCR PARSER] Result was text but not valid JSON."
            )
            return items

    if not isinstance(result, dict):
        for key in (
            "rec_texts",
            "rec_scores",
            "rec_polys",
            "rec_boxes"
        ):
            if safe_get(result, key) is not None:
                break
        else:
            print(
                "[OCR PARSER] Unsupported result structure:",
                type(result).__name__
            )
            return items

    if (
        isinstance(result, dict)
        and isinstance(result.get("res"), dict)
    ):
        result = result["res"]

    rec_texts = safe_get(
        result,
        "rec_texts"
    )

    rec_scores = safe_get(
        result,
        "rec_scores"
    )

    rec_polys = safe_get(
        result,
        "rec_polys"
    )

    if rec_polys is None:
        rec_polys = safe_get(
            result,
            "dt_polys"
        )

    rec_boxes = safe_get(
        result,
        "rec_boxes"
    )

    if rec_texts is None:
        print(
            "[OCR PARSER] ERROR: rec_texts missing. Available keys:",
            list(result.keys())
            if isinstance(result, dict)
            else "object attributes"
        )

        return items

    try:
        texts = list(rec_texts)
    except Exception:
        texts = []

    try:
        scores = (
            list(rec_scores)
            if rec_scores is not None
            else []
        )
    except Exception:
        scores = []

    try:
        polygons = (
            list(rec_polys)
            if rec_polys is not None
            else []
        )
    except Exception:
        polygons = []

    try:
        boxes = (
            list(rec_boxes)
            if rec_boxes is not None
            else []
        )
    except Exception:
        boxes = []

    if OCR_VERBOSE:
        print(f"[OCR PARSER] Arrays: texts={len(texts)}, scores={len(scores)}, polys={len(polygons)}, boxes={len(boxes)}")

    for i, raw_text in enumerate(texts):
        text = clean_text(raw_text)

        if not text:
            continue

        try:
            score = (
                float(scores[i])
                if i < len(scores)
                else 0.0
            )
        except (TypeError, ValueError):
            score = 0.0

        box = None

        if i < len(polygons):
            try:
                box = polygon_to_box(
                    polygons[i]
                )
            except Exception:
                box = None

        if box is None and i < len(boxes):
            try:
                raw_box = np.asarray(
                    boxes[i],
                    dtype=float
                ).flatten()

                if len(raw_box) >= 4:
                    box = tuple(
                        float(v)
                        for v in raw_box[:4]
                    )

            except Exception:
                box = None

        items.append(
            {
                "text": text,
                "score": score,
                "box": box
            }
        )

    if OCR_VERBOSE:
        print(f"[OCR PARSER] Parsed {len(items)} usable text detections.")
        if items:
            print("[OCR PARSER] First detections:", " | ".join(item["text"] for item in items[:12]))

    return items


# ============================================================
# ADDITIONAL OCR: IMAGE ENHANCEMENT
# ============================================================

def enhance_image_for_ocr(image):
    """
    Create an enhanced image to help OCR read faded,
    low-contrast, or slightly blurry text.

    The original image is not modified.
    """

    if image is None or image.size == 0:
        return image

    try:
        gray = cv2.cvtColor(
            image,
            cv2.COLOR_BGR2GRAY
        )

        clahe = cv2.createCLAHE(
            clipLimit=2.0,
            tileGridSize=(8, 8)
        )

        enhanced_gray = clahe.apply(gray)

        denoised = cv2.fastNlMeansDenoising(
            enhanced_gray,
            None,
            h=8,
            templateWindowSize=7,
            searchWindowSize=21
        )

        blurred = cv2.GaussianBlur(
            denoised,
            (0, 0),
            1.0
        )

        sharpened = cv2.addWeighted(
            denoised,
            1.5,
            blurred,
            -0.5,
            0
        )

        return cv2.cvtColor(
            sharpened,
            cv2.COLOR_GRAY2BGR
        )

    except Exception as exc:
        print(
            "[OCR ENHANCEMENT] Failed:",
            str(exc)
        )

        return image


# ============================================================
# ADDITIONAL OCR: UPPER SECTION
# ============================================================

def crop_upper_name_section(image):
    """
    Return the upper 65% of the document.
    """

    if image is None or image.size == 0:
        return None, 0

    height, width = image.shape[:2]

    crop_bottom = int(height * 0.65)

    crop_bottom = max(
        1,
        min(crop_bottom, height)
    )

    upper_crop = image[
        0:crop_bottom,
        0:width
    ].copy()

    return upper_crop, 0


def shift_ocr_items(
    items,
    x_offset=0,
    y_offset=0
):
    """
    Convert crop-relative OCR boxes into full-document coordinates.
    """

    shifted_items = []

    for item in items:
        new_item = dict(item)

        box = item.get("box")

        if box is not None:
            new_item["box"] = (
                float(box[0]) + x_offset,
                float(box[1]) + y_offset,
                float(box[2]) + x_offset,
                float(box[3]) + y_offset
            )

        shifted_items.append(new_item)

    return shifted_items


def merge_ocr_items(
    original_items,
    additional_items
):
    """
    Combine OCR results while avoiding duplicate detections
    of the same text in nearly identical locations.
    """

    merged = list(original_items)

    for candidate in additional_items:
        candidate_text = normalize_text(
            candidate.get("text", "")
        )

        candidate_box = candidate.get("box")

        if not candidate_text or candidate_box is None:
            continue

        duplicate_found = False

        for existing in merged:
            existing_text = normalize_text(
                existing.get("text", "")
            )

            existing_box = existing.get("box")

            if existing_box is None:
                continue

            if candidate_text != existing_text:
                continue

            center_a = box_center(candidate_box)
            center_b = box_center(existing_box)

            distance = (
                abs(center_a[0] - center_b[0])
                + abs(center_a[1] - center_b[1])
            )

            max_height = max(
                1.0,
                box_height(candidate_box),
                box_height(existing_box)
            )

            if distance <= max_height * 1.5:
                duplicate_found = True

                if float(candidate.get("score", 0)) > float(
                    existing.get("score", 0)
                ):
                    existing["score"] = candidate.get(
                        "score",
                        0
                    )

                break

        if not duplicate_found:
            merged.append(candidate)

    return merged


def run_upper_name_ocr(image):
    """
    Optional fallback pass for non-strict documents.
    """

    if image is None or image.size == 0:
        return []

    upper_crop, y_offset = crop_upper_name_section(
        image
    )

    if upper_crop is None or upper_crop.size == 0:
        return []

    print(
        f"[UPPER OCR] Fallback crop: "
        f"{upper_crop.shape[1]} x "
        f"{upper_crop.shape[0]}"
    )

    items = run_ocr(upper_crop)

    return shift_ocr_items(
        items,
        x_offset=0,
        y_offset=y_offset
    )


# ============================================================
# OCR RUNNER
# ============================================================

def _rapid_result_to_items(raw):
    """
    Convert RapidOCR output into the same item format used by the
    rest of the pipeline: {"text", "score", "box"}.
    """

    items = []

    if raw is None:
        return items

    # Newer `rapidocr` package returns an object with boxes/txts/scores.
    if hasattr(raw, "txts"):
        texts = raw.txts
        scores = raw.scores
        boxes = raw.boxes

        if texts is None or boxes is None:
            return items

        triples = zip(boxes, texts, scores)

    else:
        # rapidocr_onnxruntime returns (result, elapsed).
        result = raw[0] if isinstance(raw, tuple) else raw

        if not result:
            return items

        triples = (
            (entry[0], entry[1], entry[2])
            for entry in result
        )

    for polygon, raw_text, raw_score in triples:
        text = clean_text(raw_text)

        if not text:
            continue

        try:
            score = float(raw_score)
        except (TypeError, ValueError):
            score = 0.0

        items.append(
            {
                "text": text,
                "score": score,
                "box": polygon_to_box(polygon),
            }
        )

    return items


def run_ocr(image):
    if image is None or image.size == 0:
        print("[OCR] Empty image received.")
        return []

    if OCR_BACKEND != "paddle":
        try:
            prediction_start = time.perf_counter()

            with ocr_lock:
                if OCR_BACKEND == "rapidocr_onnxruntime":
                    # Documents are upright, so the angle classifier
                    # is skipped.
                    raw = ocr_engine(image, use_cls=False)
                else:
                    raw = ocr_engine(image)

            items = _rapid_result_to_items(raw)

            breakdown = ""

            if (
                isinstance(raw, tuple)
                and len(raw) > 1
                and raw[1]
            ):
                try:
                    breakdown = " (det/cls/rec: " + "/".join(
                        f"{float(v):.1f}" for v in raw[1]
                    ) + "s)"
                except Exception:
                    breakdown = ""

            print(
                f"[OCR] RapidOCR: {len(items)} detections in "
                f"{time.perf_counter() - prediction_start:.2f}s"
                f"{breakdown}"
            )

            return items

        except Exception as exc:
            print("")
            print("================================================")
            print("[OCR] RAPIDOCR PREDICTION ERROR")
            print("================================================")
            print(str(exc))

            traceback.print_exc()

            print("================================================")

            return []

    try:
        prediction_start = time.perf_counter()
        with ocr_lock:
            result = ocr_engine.predict(image)
        items = parse_ocr_result(result)
        if OCR_VERBOSE:
            print(f"[OCR] Prediction + parsing: {time.perf_counter() - prediction_start:.3f}s; detections={len(items)}")

        return items

    except AttributeError as exc:
        print(
            "[OCR] PaddleOCR predict() unavailable. "
            "Trying legacy .ocr() API."
        )

        print(
            "[OCR] AttributeError:",
            str(exc)
        )

        try:
            with ocr_lock:
                result = ocr_engine.ocr(
                    image,
                    cls=OCR_TEXTLINE_ORIENTATION
                )

            items = parse_ocr_result(result)

            print(
                f"[OCR] Legacy API parsed "
                f"{len(items)} text detections."
            )

            return items

        except Exception as legacy_exc:
            print(
                "[OCR] Legacy OCR failed:",
                str(legacy_exc)
            )

            return []

    except Exception as exc:
        print("")
        print("================================================")
        print("[OCR] PREDICTION ERROR")
        print("================================================")
        print(str(exc))

        traceback.print_exc()

        print("================================================")

        return []


# ============================================================
# LABEL IDENTIFICATION
# ============================================================

def classify_label(text):
    text = normalize_text(text)

    replacements = {
        "1ST NAME": "FIRST NAME",
        "F1RST NAME": "FIRST NAME",
        "F1RST": "FIRST",
        "M1DDLE NAME": "MIDDLE NAME",
        "M1DDLE": "MIDDLE",
        "LAST N4ME": "LAST NAME",
        "L4ST NAME": "LAST NAME",
    }

    for old, new in replacements.items():
        text = text.replace(old, new)

    if text in {
        "FIRST NAME",
        "FIRST",
        "GIVEN NAME"
    }:
        return "FIRST"

    if text in {
        "MIDDLE NAME",
        "MIDDLE"
    }:
        return "MIDDLE"

    if text in {
        "LAST NAME",
        "LAST",
        "SURNAME",
        "FAMILY NAME"
    }:
        return "LAST"

    return None


# ============================================================
# OWNER / CHILD SECTION DETECTION
# ============================================================

def is_owner_anchor(text):
    normalized = normalize_text(text)

    strong_patterns = [
        "NAME OF CHILD",
        "CHILD'S NAME",
        "CHILDS NAME",
        "NAME OF THE CHILD",
    ]

    for pattern in strong_patterns:
        if pattern in normalized:
            return True

    return False


def is_parent_name_anchor(text):
    normalized = normalize_text(text)

    compact = re.sub(
        r"[^A-Z]",
        "",
        normalized
    )

    parent_patterns = {
        "MOTHERSMAIDENNAME",
        "MOTHERMAIDENNAME",
        "NAMEOFMOTHER",
        "MOTHERSNAME",
        "FATHERSNAME",
        "NAMEOFFATHER",
        "FATHERNAME",
        "NAMEOFPARENT",
        "PARENTNAME",
    }

    return any(
        pattern in compact
        for pattern in parent_patterns
    )


def find_parent_section_top(
    items,
    owner_anchor
):
    """
    Find the first parent-name section below the child-name
    anchor. This becomes the lower boundary of child extraction.
    """

    if not owner_anchor or not owner_anchor.get("box"):
        return None

    anchor_bottom = owner_anchor["box"][3]

    parent_sections = []

    for item in items:
        text = item.get("text", "")
        box = item.get("box")

        if not text or box is None:
            continue

        if not is_parent_name_anchor(text):
            continue

        section_top = box[1]

        if section_top > anchor_bottom:
            parent_sections.append(section_top)

    if not parent_sections:
        return None

    boundary = min(parent_sections)

    print(
        f"[OWNER SECTION] Parent section boundary: "
        f"y={boundary:.1f}"
    )

    return boundary


def find_owner_anchor(
    items,
    allow_form102_anchor=False
):
    candidates = []

    for item in items:
        text = item.get("text", "")
        box = item.get("box")

        if not text or box is None:
            continue

        if is_owner_anchor(text):
            candidates.append(item)
            continue

        # Form 102: field "1. NAME" identifies the child's name.
        # Only enabled after birth-certificate identification.
        if allow_form102_anchor:
            compact = re.sub(
                r"[^A-Z0-9]",
                "",
                normalize_text(text)
            )

            if compact in {
                "1NAME",
                "01NAME"
            }:
                candidates.append(item)

    if not candidates:
        print(
            "[OWNER ANCHOR] No child-name section anchor found."
        )

        return None

    candidates.sort(
        key=lambda item: (
            item["box"][1],
            -float(item.get("score", 0))
        )
    )

    selected = candidates[0]

    print(
        f"[OWNER ANCHOR] Selected: "
        f"'{selected['text']}' "
        f"box={selected['box']} "
        f"score={selected.get('score', 0):.3f}"
    )

    return selected


# ============================================================
# OWNER LABEL SELECTION
# ============================================================

def select_owner_labels(
    items,
    owner_anchor=None
):
    """
    Select FIRST / MIDDLE / LAST labels belonging to
    the SAME NAME section.

    The three labels must be grouped together.
    """

    def normalize_label(text):
        t = (text or "").strip().lower()

        t = re.sub(
            r"[^a-z]",
            "",
            t
        )

        first_variants = {
            "first",
            "firstname",
            "frist",
            "firts",
            "firt",
            "firat",
            "fira",
            "frst",
            "firs",
            "fist",
            "firtsname",
            # Common OCR readings of the abbreviated Form 102 label "(First)".
            "fra",
        }

        if t in first_variants:
            return "FIRST"

        middle_variants = {
            "middle",
            "middlename",
            "midle",
            "midele",
            "middie",
            "middlle",
            "middl",
            "mddie",
            "midde",
        }

        if t in middle_variants:
            return "MIDDLE"

        last_variants = {
            "last",
            "lastname",
            "lst",
            "surname",
            "laast",
            "las",
            "lstname",
            "lats",
            # Common OCR reading of the abbreviated Form 102 label "(Last)".
            "laat",
            "lat",
            "lasl",
            "lasi",
            "lest",
            "lasr",
            "lasd",
        }

        if t in last_variants:
            return "LAST"

        try:
            candidates = {
                "FIRST": [
                    "first",
                    "firstname"
                ],
                "MIDDLE": [
                    "middle",
                    "middlename"
                ],
                "LAST": [
                    "last",
                    "lastname",
                    "surname"
                ],
            }

            best_type = None
            best_score = 0.0

            for label_type, variants in candidates.items():
                for variant in variants:
                    similarity = SequenceMatcher(
                        None,
                        t,
                        variant
                    ).ratio()

                    if similarity > best_score:
                        best_score = similarity
                        best_type = label_type

            if best_score >= 0.86 and len(t) >= 4:
                return best_type

            # Short labels printed in parentheses, e.g. "(Lat)" for "(Last)".
            # Slightly more tolerant, because parentheses make a name
            # label far more likely than ordinary text.
            if (
                (text or "").strip().startswith("(")
                and len(t) >= 3
                and best_score >= 0.80
            ):
                return best_type

        except Exception:
            pass

        return None

    def local_box_center(box):
        x1, y1, x2, y2 = box

        return (
            (x1 + x2) / 2.0,
            (y1 + y2) / 2.0
        )

    def local_box_height(box):
        return max(
            1.0,
            float(box[3]) - float(box[1])
        )

    # --------------------------------------------------------
    # 1. Find possible FIRST / MIDDLE / LAST labels
    # --------------------------------------------------------

    labels = []

    for item in items:
        text = str(
            item.get("text", "")
        ).strip()

        box = item.get("box")

        if not text or not box or len(box) != 4:
            continue

        raw_label_lower = re.sub(
            r"[^a-z0-9]+",
            " ",
            text.lower()
        ).strip()

        normalized_compact = re.sub(
            r"[^a-z]",
            "",
            text.lower()
        )

        # Ignore section headers such as "1. NAME".
        if (
            normalized_compact == "name"
            or (
                "name" in raw_label_lower
                and not any(
                    word in raw_label_lower
                    for word in (
                        "first",
                        "middle",
                        "last",
                        "surname",
                    )
                )
            )
        ):
            print(
                "[OWNER LABELS] Ignoring section/header label:",
                repr(text)
            )

            continue

        label_type = normalize_label(text)

        if label_type is None:
            continue

        score = float(
            item.get("score", 0.0)
        )

        labels.append(
            {
                "type": label_type,
                "text": text,
                "box": box,
                "score": score,
                "item": item,
            }
        )

    if not labels:
        print(
            "[OWNER LABELS] No FIRST/MIDDLE/LAST labels found."
        )

        return {
            "FIRST": None,
            "MIDDLE": None,
            "LAST": None,
        }

    # --------------------------------------------------------
    # 2. Filter labels using child section anchor
    # --------------------------------------------------------

    anchor_bottom = None
    anchor_center_y = None

    form102_anchor = False

    if owner_anchor and owner_anchor.get("box"):
        anchor_box = owner_anchor["box"]
        anchor_bottom = anchor_box[3]
        anchor_center_y = local_box_center(anchor_box)[1]

        anchor_text = re.sub(
            r"[^A-Z0-9]",
            "",
            normalize_text(owner_anchor.get("text", ""))
        )

        form102_anchor = anchor_text in {
            "1NAME",
            "01NAME",
        }

    parent_boundary = find_parent_section_top(
        items,
        owner_anchor
    )

    anchor_filtered_labels = []

    for label in labels:
        label_center_y = local_box_center(
            label["box"]
        )[1]

        # In Municipal Form 102, "1. NAME" is printed beside
        # the FIRST/MIDDLE/LAST labels, not above them.
        # Keep only the label row physically aligned with that anchor.
        if form102_anchor and anchor_center_y is not None:
            label_height = local_box_height(label["box"])

            form102_row_tolerance = max(
                45.0,
                label_height * 2.5
            )

            if abs(label_center_y - anchor_center_y) > form102_row_tolerance:
                continue

        elif (
            anchor_bottom is not None
            and label_center_y < anchor_bottom - 5
        ):
            continue

        if (
            parent_boundary is not None
            and label_center_y >= parent_boundary
        ):
            continue

        anchor_filtered_labels.append(label)

    labels = anchor_filtered_labels

    print(
        "[OWNER LABELS] Child section filtering:",
        len(labels),
        "labels remaining."
    )

    # --------------------------------------------------------
    # 3. Print detected labels
    # --------------------------------------------------------

    print(
        f"[OWNER LABELS] Detected label candidates: {len(labels)}"
    )

    for label in labels:
        cx, cy = local_box_center(
            label["box"]
        )

        print(
            f" {label['type']}: "
            f"'{label['text']}' "
            f"box={label['box']} "
            f"center=({cx:.1f},{cy:.1f}) "
            f"score={label['score']:.3f}"
        )

    # --------------------------------------------------------
    # 4. Group labels by vertical row
    # --------------------------------------------------------

    rows = []

    labels_sorted = sorted(
        labels,
        key=lambda x: local_box_center(x["box"])[1]
    )

    for label in labels_sorted:
        _, cy = local_box_center(
            label["box"]
        )

        h = local_box_height(
            label["box"]
        )

        placed = False

        for row in rows:
            row_y = row["y"]

            tolerance = max(
                22.0,
                h * 0.75
            )

            if abs(cy - row_y) <= tolerance:
                row["labels"].append(label)

                ys = [
                    local_box_center(x["box"])[1]
                    for x in row["labels"]
                ]

                row["y"] = sum(ys) / len(ys)

                placed = True

                break

        if not placed:
            rows.append(
                {
                    "y": cy,
                    "labels": [label],
                }
            )

    # --------------------------------------------------------
    # 5. Remove duplicate labels within each row
    # --------------------------------------------------------

    for row in rows:
        by_type = {
            "FIRST": [],
            "MIDDLE": [],
            "LAST": [],
        }

        for label in row["labels"]:
            by_type[label["type"]].append(label)

        cleaned = []

        for label_type in (
            "FIRST",
            "MIDDLE",
            "LAST"
        ):
            candidates = by_type[label_type]

            if not candidates:
                continue

            def label_priority(label):
                label_text = str(
                    label.get("text", "")
                ).strip().lower()

                compact = re.sub(
                    r"[^a-z]",
                    "",
                    label_text
                )

                if label_type == "FIRST":
                    if compact in {
                        "first",
                        "firstname",
                        "frist",
                        "firts"
                    }:
                        return 100

                elif label_type == "MIDDLE":
                    if compact in {
                        "middle",
                        "middlename",
                        "midle",
                        "midele"
                    }:
                        return 100

                elif label_type == "LAST":
                    if compact in {
                        "last",
                        "lastname",
                        "lst",
                        "surname"
                    }:
                        return 100

                if compact == "name":
                    return -100

                if "name" in label_text:
                    return -50

                return 0

            candidates.sort(
                key=lambda x: (
                    label_priority(x),
                    float(x.get("score", 0.0))
                ),
                reverse=True
            )

            cleaned.append(
                candidates[0]
            )

        row["labels"] = cleaned

    # --------------------------------------------------------
    # 6. Show detected rows
    # --------------------------------------------------------

    print("\n[OWNER LABEL ROWS]")

    for index, row in enumerate(rows):
        ordered = sorted(
            row["labels"],
            key=lambda x: local_box_center(x["box"])[0]
        )

        types = [
            label["type"]
            for label in ordered
        ]

        texts = [
            label["text"]
            for label in ordered
        ]

        print(
            f" Row {index}: "
            f"y={row['y']:.1f} "
            f"labels={types} "
            f"text={texts}"
        )

    # --------------------------------------------------------
    # 7. Find complete FIRST + MIDDLE + LAST rows
    # --------------------------------------------------------

    complete_rows = []

    for index, row in enumerate(rows):
        label_map = {
            label["type"]: label
            for label in row["labels"]
        }

        if not all(
            key in label_map
            for key in (
                "FIRST",
                "MIDDLE",
                "LAST"
            )
        ):
            continue

        first = label_map["FIRST"]
        middle = label_map["MIDDLE"]
        last = label_map["LAST"]

        first_x, _ = local_box_center(
            first["box"]
        )

        middle_x, _ = local_box_center(
            middle["box"]
        )

        last_x, _ = local_box_center(
            last["box"]
        )

        if not (
            first_x < middle_x < last_x
        ):
            continue

        y_values = [
            local_box_center(first["box"])[1],
            local_box_center(middle["box"])[1],
            local_box_center(last["box"])[1],
        ]

        vertical_spread = (
            max(y_values) - min(y_values)
        )

        if vertical_spread > 35:
            continue

        gap1 = middle_x - first_x
        gap2 = last_x - middle_x

        if gap1 < 40 or gap2 < 40:
            continue

        complete_rows.append(
            {
                "index": index,
                "row": row,
                "FIRST": first,
                "MIDDLE": middle,
                "LAST": last,
                "vertical_spread": vertical_spread,
                "score_sum": (
                    first["score"]
                    + middle["score"]
                    + last["score"]
                ),
            }
        )

    # --------------------------------------------------------
    # 8. Select the closest complete row below child anchor
    # --------------------------------------------------------

    if complete_rows:
        if owner_anchor and owner_anchor.get("box"):
            anchor_box = owner_anchor["box"]
            anchor_center_y = local_box_center(anchor_box)[1]
            anchor_text = re.sub(
                r"[^A-Z0-9]",
                "",
                normalize_text(owner_anchor.get("text", ""))
            )

            if anchor_text in {"1NAME", "01NAME"}:
                # Form 102 child labels sit on the same horizontal
                # line as "1. NAME". Prefer that row, not later
                # parent-name sections farther down the certificate.
                complete_rows.sort(
                    key=lambda x: abs(
                        x["row"]["y"] - anchor_center_y
                    )
                )
            else:
                anchor_bottom = anchor_box[3]

                complete_rows.sort(
                    key=lambda x: max(
                        0,
                        x["row"]["y"] - anchor_bottom
                    )
                )

        else:
            complete_rows.sort(
                key=lambda x: x["row"]["y"]
            )

        selected = complete_rows[0]

        print("\n[OWNER NAME SECTION]")

        print(
            f"Complete name rows found: {len(complete_rows)}"
        )

        for candidate in complete_rows:
            print(
                f" Row {candidate['index']} "
                f"y={candidate['row']['y']:.1f} "
                f"spread={candidate['vertical_spread']:.1f} "
                f"score={candidate['score_sum']:.3f}"
            )

        print(
            "\n[SELECTED OWNER NAME LABEL GROUP]"
        )

        print(
            f"Row {selected['index']} "
            f"y={selected['row']['y']:.1f}"
        )

        for key in (
            "FIRST",
            "MIDDLE",
            "LAST"
        ):
            print(
                f"{key}: "
                f"'{selected[key]['text']}' "
                f"box={selected[key]['box']} "
                f"score={selected[key]['score']:.3f}"
            )

        return {
            "FIRST": selected["FIRST"],
            "MIDDLE": selected["MIDDLE"],
            "LAST": selected["LAST"],
        }

    # --------------------------------------------------------
    # 9. Strict fallback
    # --------------------------------------------------------

    print(
        "\n[OWNER LABELS] No complete name row found."
    )

    if owner_anchor:
        print(
            "[OWNER LABELS] Strict mode: "
            "No fallback to other name sections."
        )
    else:
        print(
            "[OWNER LABELS] No complete name row. "
            "Partial name extraction is disabled."
        )

    return {
        "FIRST": None,
        "MIDDLE": None,
        "LAST": None,
    }


# ============================================================
# VALUE EXTRACTION
# ============================================================

def find_value_items(
    items,
    label,
    selected_other_labels,
    image_height,
    section_bottom=None
):
    label_box = label.get("box")

    if label_box is None:
        return []

    lx1, ly1, lx2, ly2 = label_box

    label_h = max(
        1.0,
        box_height(label_box)
    )

    label_cx, label_cy = box_center(
        label_box
    )

    candidates = []

    is_middle = (
        label is selected_other_labels.get("MIDDLE")
    )

    for item in items:
        box = item.get("box")

        text = clean_text(
            item.get("text", "")
        )

        if box is None or not text:
            continue

        if (
            classify_label(text)
            or is_non_name_field_text(text)
        ):
            continue

        cx, cy = box_center(box)

        # Never search beyond the child-name section.
        if (
            section_bottom is not None
            and cy >= section_bottom
        ):
            continue

        # The value must be below its own field label.
        if cy <= ly2:
            continue

        distance_y = cy - ly2

        if is_middle:
            max_vertical_distance = max(
                18.0,
                label_h * 1.0
            )
        else:
            max_vertical_distance = max(
                48.0,
                label_h * 3.2
            )

        if distance_y > max_vertical_distance:
            continue

        overlap = horizontal_overlap(
            box,
            label_box
        )

        candidate_width = max(
            1.0,
            box_width(box)
        )

        if is_middle:
            if overlap <= 0:
                continue

            overlap_ratio = (
                overlap / candidate_width
            )

            if overlap_ratio < 0.30:
                continue

            allowed_horizontal_margin = max(
                10.0,
                box_width(label_box) * 0.15
            )

            if (
                cx < lx1 - allowed_horizontal_margin
                or cx > lx2 + allowed_horizontal_margin
            ):
                continue

        else:
            if overlap <= 0:
                if cx < lx1 - candidate_width * 0.35:
                    continue

                if cx > lx2 + candidate_width * 0.35:
                    continue

        # Do not allow another field to claim this candidate.
        belongs_to_other = False

        for other_field, other_label in (
            selected_other_labels.items()
        ):
            if (
                other_label is None
                or other_label is label
            ):
                continue

            other_box = other_label.get("box")

            if other_box is None:
                continue

            other_cx, _ = box_center(other_box)

            current_distance = abs(
                cx - label_cx
            )

            other_distance = abs(
                cx - other_cx
            )

            if other_distance < current_distance * 0.55:
                belongs_to_other = True
                break

        if belongs_to_other:
            continue

        horizontal_distance = abs(
            cx - label_cx
        )

        vertical_score = (
            1.0 / (1.0 + distance_y)
        )

        horizontal_score = (
            1.0 / (1.0 + horizontal_distance)
        )

        geometry_score = (
            vertical_score * 0.65
            + horizontal_score * 0.35
        )

        candidates.append(
            {
                **item,
                "distance_y": distance_y,
                "distance_x": horizontal_distance,
                "geometry_score": geometry_score,
            }
        )

    return candidates


def choose_one_value_line(candidates):
    if not candidates:
        return ""

    # --------------------------------------------------------
    # REMOVE OVERLAPPING OCR DUPLICATES
    # --------------------------------------------------------

    filtered_candidates = []

    candidates_sorted = sorted(
        candidates,
        key=lambda item: float(
            item.get("score", 0)
        ),
        reverse=True
    )

    for candidate in candidates_sorted:
        candidate_box = candidate.get("box")

        if candidate_box is None:
            continue

        candidate_cx, candidate_cy = box_center(
            candidate_box
        )

        candidate_width = max(
            1.0,
            box_width(candidate_box)
        )

        candidate_height = max(
            1.0,
            box_height(candidate_box)
        )

        duplicate_location = False

        for existing in filtered_candidates:
            existing_box = existing.get("box")

            if existing_box is None:
                continue

            existing_cx, existing_cy = box_center(
                existing_box
            )

            existing_width = max(
                1.0,
                box_width(existing_box)
            )

            existing_height = max(
                1.0,
                box_height(existing_box)
            )

            center_distance_x = abs(
                candidate_cx - existing_cx
            )

            center_distance_y = abs(
                candidate_cy - existing_cy
            )

            width_difference = abs(
                candidate_width - existing_width
            )

            height_difference = abs(
                candidate_height - existing_height
            )

            similar_size = (
                width_difference
                <= max(
                    candidate_width,
                    existing_width
                ) * 0.40
                and
                height_difference
                <= max(
                    candidate_height,
                    existing_height
                ) * 0.60
            )

            intersection_left = max(
                candidate_box[0],
                existing_box[0]
            )

            intersection_top = max(
                candidate_box[1],
                existing_box[1]
            )

            intersection_right = min(
                candidate_box[2],
                existing_box[2]
            )

            intersection_bottom = min(
                candidate_box[3],
                existing_box[3]
            )

            intersection_width = max(
                0.0,
                intersection_right - intersection_left
            )

            intersection_height = max(
                0.0,
                intersection_bottom - intersection_top
            )

            intersection_area = (
                intersection_width * intersection_height
            )

            candidate_area = (
                candidate_width * candidate_height
            )

            existing_area = (
                existing_width * existing_height
            )

            union_area = (
                candidate_area
                + existing_area
                - intersection_area
            )

            if union_area > 0:
                iou = (
                    intersection_area / union_area
                )
            else:
                iou = 0.0

            strong_overlap = (
                iou >= 0.45
                and
                center_distance_y
                <= max(
                    candidate_height,
                    existing_height
                ) * 1.00
            )

            almost_same_detection = (
                center_distance_x
                <= max(
                    candidate_width,
                    existing_width
                ) * 0.20
                and
                center_distance_y
                <= max(
                    candidate_height,
                    existing_height
                ) * 0.75
                and
                similar_size
            )

            if (
                strong_overlap
                or almost_same_detection
            ):
                duplicate_location = True

                print(
                    "[VALUE OCR] Duplicate OCR detection removed:"
                )

                print(
                    f" KEPT: "
                    f"'{existing.get('text', '')}' "
                    f"score={existing.get('score', 0):.3f} "
                    f"box={existing_box}"
                )

                print(
                    f" REMOVED: "
                    f"'{candidate.get('text', '')}' "
                    f"score={candidate.get('score', 0):.3f} "
                    f"box={candidate_box}"
                )

                print(
                    f" IoU={iou:.3f} "
                    f"center_dx={center_distance_x:.1f} "
                    f"center_dy={center_distance_y:.1f}"
                )

                break

        if not duplicate_location:
            filtered_candidates.append(candidate)

    print(
        "[VALUE OCR] Candidates before duplicate filtering:",
        len(candidates)
    )

    print(
        "[VALUE OCR] Candidates after duplicate filtering:",
        len(filtered_candidates)
    )

    candidates = filtered_candidates

    if not candidates:
        return ""

    # --------------------------------------------------------
    # CHOOSE THE NEAREST TEXT BELOW THE LABEL
    # --------------------------------------------------------

    candidates.sort(
        key=lambda item: (
            item["distance_y"],
            -float(item.get("score", 0))
        )
    )

    first = candidates[0]

    first_box = first.get("box")

    if first_box is None:
        return ""

    first_cy = box_center(first_box)[1]

    first_height = max(
        1.0,
        box_height(first_box)
    )

    # --------------------------------------------------------
    # KEEP ONLY TEXT ON THE SAME PHYSICAL LINE
    # --------------------------------------------------------

    same_line = []

    for item in candidates:
        box = item.get("box")

        if box is None:
            continue

        cy = box_center(box)[1]

        if abs(cy - first_cy) <= first_height * 0.70:
            same_line.append(item)

    same_line.sort(
        key=lambda item: item["box"][0]
    )

    parts = []

    seen = set()

    for item in same_line:
        text = clean_name(
            item.get("text", "")
        )

        if not text:
            continue

        key = text.upper()

        if key in seen:
            continue

        seen.add(key)

        parts.append(text)

    return " ".join(parts).strip()


def is_valid_middle_name_value(value):
    text = clean_name(value)

    if not text:
        return False

    if is_non_name_field_text(text):
        return False

    if any(
        char.isdigit()
        for char in text
    ):
        return False

    words = text.split()

    if not words or len(words) > 4:
        return False

    if any(
        len(word) < 2
        for word in words
    ):
        return False

    if not all(
        re.fullmatch(
            r"[A-Za-zÀ-ÖØ-öø-ÿ'-]+",
            word
        )
        for word in words
    ):
        return False

    normalized = re.sub(
        r"[^a-z]",
        "",
        text.lower()
    )

    forbidden = {
        "date",
        "dateofbirth",
        "placeofbirth",
        "birth",
        "sex",
        "male",
        "female",
        "month",
        "year",
        "day",
        "first",
        "firstname",
        "middle",
        "middlename",
        "last",
        "lastname",
        "surname",
        "mother",
        "father",
        "mothersname",
        "fathersname",
        "informant",
        "signature",
        "occupation",
        "citizenship",
        "religion",
        "residence",
        "province",
        "hospital",
        "clinic",
        "institution",
    }

    if normalized in forbidden:
        return False

    return True


# ============================================================
# OWNER NAME EXTRACTION
# ============================================================

def extract_owner_name(
    image,
    items,
    strict_child_section=False
):
    image_height, image_width = image.shape[:2]

    owner_anchor = find_owner_anchor(
        items,
        allow_form102_anchor=strict_child_section
    )

    result = {
        "first_name": "",
        "middle_name": "",
        "last_name": "",
        "owner_anchor_found": bool(owner_anchor),
    }

    # Birth certificates must have an identifiable child section.
    if strict_child_section and not owner_anchor:
        print(
            "[OWNER NAME] Child-name anchor missing. "
            "Refusing to extract names from other sections."
        )

        return result

    selected = select_owner_labels(
        items,
        owner_anchor=owner_anchor
    )

    child_section_bottom = (
        find_parent_section_top(
            items,
            owner_anchor
        )
        if owner_anchor
        else None
    )

    print("")
    print("================================================")
    print("[SELECTED OWNER FIELDS]")
    print("================================================")

    for field in (
        "FIRST",
        "MIDDLE",
        "LAST"
    ):
        item = selected.get(field)

        if item:
            print(
                f"{field}: '{item['text']}' "
                f"box={item['box']} "
                f"score={item.get('score', 0):.3f}"
            )
        else:
            print(
                f"{field}: NOT SELECTED"
            )

    result = {
        "first_name": "",
        "middle_name": "",
        "last_name": "",
        "owner_anchor_found": bool(owner_anchor),
    }

    if not any(
        selected.get(field)
        for field in (
            "FIRST",
            "MIDDLE",
            "LAST"
        )
    ):
        print(
            "[OWNER NAME] No owner name labels selected."
        )

        return result

    # --------------------------------------------------------
    # PROCESS EACH FIELD
    # --------------------------------------------------------

    for field in (
        "FIRST",
        "MIDDLE",
        "LAST"
    ):
        label = selected.get(field)

        if label is None:
            continue

        candidates = find_value_items(
            items=items,
            label=label,
            selected_other_labels=selected,
            image_height=image_height,
            section_bottom=child_section_bottom,
        )

        print("")
        print(f"[{field}] Candidates:")

        for candidate in candidates:
            print(
                f" '{candidate['text']}' "
                f"box={candidate['box']} "
                f"score={candidate.get('score', 0):.3f}"
            )

        selected_value = ""

        ranked_candidates = []

        for candidate in candidates:
            text_value = clean_text(
                candidate.get("text", "")
            )

            if not text_value:
                continue

            if field == "MIDDLE":
                if not is_valid_middle_name_value(
                    text_value
                ):
                    continue

            if is_non_name_field_text(text_value):
                continue

            normalized_value = re.sub(
                r"[^a-z]",
                "",
                text_value.lower(),
            )

            forbidden_values = {
                "sex",
                "male",
                "female",
                "date",
                "dateofbirth",
                "birth",
                "placeofbirth",
                "month",
                "year",
                "day",
                "name",
                "firstname",
                "middlename",
                "lastname",
                "first",
                "middle",
                "last",
                "surname",
                "citizenship",
                "religion",
                "occupation",
                "residence",
                "hospital",
                "clinic",
                "institution",
                "province",
                "mother",
                "father",
                "maiden",
                "signature",
                "nameinprint",
            }

            if normalized_value in forbidden_values:
                continue

            alpha_chars = sum(
                ch.isalpha()
                for ch in text_value
            )

            digit_chars = sum(
                ch.isdigit()
                for ch in text_value
            )

            if alpha_chars < 2 or digit_chars > 0:
                continue

            score = float(
                candidate.get("score", 0.0)
            )

            distance_y = float(
                candidate.get("distance_y", 9999.0)
            )

            distance_x = float(
                candidate.get("distance_x", 9999.0)
            )

            geometry_score = float(
                candidate.get("geometry_score", 0.0)
            )

            proximity_score = max(
                0.0,
                1.0 - distance_y / 100.0,
            )

            horizontal_proximity = max(
                0.0,
                1.0 - distance_x / 250.0,
            )

            final_score = (
                score * 0.20
                + geometry_score * 0.35
                + proximity_score * 0.30
                + horizontal_proximity * 0.15
            )

            ranked_candidates.append(
                (final_score, candidate)
            )

        ranked_candidates.sort(
            key=lambda pair: pair[0],
            reverse=True,
        )

        if ranked_candidates:
            best_score, best_candidate = (
                ranked_candidates[0]
            )

            selected_value = clean_name(
                best_candidate.get("text", "")
            )

            print(
                f"[{field}] GEOMETRY-AWARE SELECTED: "
                f"'{selected_value}' "
                f"score={best_candidate.get('score', 0):.3f} "
                f"final={best_score:.4f}"
            )

        # ----------------------------------------------------
        # FALLBACK
        #
        # MIDDLE must remain blank if it cannot be confidently
        # identified. Do not use generic fallback for it.
        # ----------------------------------------------------

        if not selected_value and field == "MIDDLE":
            print(
                "[MIDDLE] No confidently identified middle name. "
                "Keeping the value blank."
            )

            selected_value = ""

        elif not selected_value:
            fallback_value = choose_one_value_line(
                candidates
            )

            fallback_value = clean_name(
                fallback_value
            )

            if (
                fallback_value
                and is_non_name_field_text(fallback_value)
            ):
                print(
                    f"[{field}] FALLBACK REJECTED NON-NAME TEXT: "
                    f"{fallback_value!r}"
                )

                fallback_value = ""

            if fallback_value:
                fallback_normalized = re.sub(
                    r"[^a-z]",
                    "",
                    fallback_value.lower(),
                )

                fallback_forbidden = {
                    "date",
                    "dateofbirth",
                    "placeofbirth",
                    "sex",
                    "male",
                    "female",
                    "month",
                    "year",
                    "day",
                    "first",
                    "middle",
                    "last",
                    "surname",
                    "citizenship",
                    "religion",
                    "occupation",
                    "residence",
                    "hospital",
                    "clinic",
                    "institution",
                    "province",
                    "signature",
                    "nameinprint",
                }

                has_digits = any(
                    ch.isdigit()
                    for ch in fallback_value
                )

                if (
                    fallback_normalized in fallback_forbidden
                    or has_digits
                    or sum(
                        ch.isalpha()
                        for ch in fallback_value
                    ) < 2
                ):
                    print(
                        f"[{field}] FALLBACK REJECTED: "
                        f"{fallback_value!r}"
                    )

                    fallback_value = ""

            selected_value = fallback_value

            if selected_value:
                print(
                    f"[{field}] FALLBACK VALUE SELECTED: "
                    f"'{selected_value}'"
                )
            else:
                print(
                    f"[{field}] No valid name value found."
                )

        # Save result inside the loop.
        if field == "FIRST":
            result["first_name"] = selected_value

        elif field == "MIDDLE":
            result["middle_name"] = selected_value

        elif field == "LAST":
            result["last_name"] = selected_value

    print("")
    print("[OWNER NAME EXTRACTION COMPLETE]")

    print(
        "FIRST :",
        result["first_name"]
    )

    print(
        "MIDDLE:",
        result["middle_name"]
    )

    print(
        "LAST  :",
        result["last_name"]
    )

    return result


# ============================================================
# GENERIC NAME EXTRACTION
# ============================================================

NAME_LABEL_RE = re.compile(
    r"^\s*(?:NAME OF (?:THE )?(?:STUDENT|PUPIL|LEARNER|CHILD)|"
    r"(?:STUDENT|PUPIL|LEARNER|FULL)(?:'?S)? NAME|NAME)\s*[:;\-]?\s*(.*)$",
    re.IGNORECASE,
)


NOT_PERSON_NAME_LABEL_RE = re.compile(
    r"^\s*NAME\s*(?:OF|AND|IN)\s*"
    r"(?:SCHOOL|TEACHER|ADVISER|ADVISOR|PRINCIPAL|HEAD|INSTITUTION|"
    r"COMMUNITY|ADDRESS|PRINT|PARENT|GUARDIAN|MOTHER|FATHER|"
    r"INFORMANT|CENTER|HOSPITAL|CLINIC)",
    re.IGNORECASE,
)


COMMA_NAME_RE = re.compile(
    r"^([A-Za-zÀ-ÿ'\-]+(?: [A-Za-zÀ-ÿ'\-]+)?),\s*"
    r"([A-Za-zÀ-ÿ'\-]+(?: [A-Za-zÀ-ÿ'\-]+)*)\.?\s*([A-Za-zÀ-ÿ'\-\.]*)$"
)


def _split_full_name(full):
    full = clean_name(full)

    if not full:
        return "", "", ""

    match = COMMA_NAME_RE.match(full)

    if match:
        first_name = match.group(2).strip()
        last_name = match.group(1).strip()

        return (
            first_name,
            "",
            last_name
        )

    parts = full.split()

    if len(parts) == 1:
        return parts[0], "", ""

    if len(parts) == 2:
        return (
            parts[0],
            "",
            parts[1]
        )

    return (
        " ".join(parts[:-1]),
        "",
        parts[-1]
    )


def extract_name_generic(items):
    """
    Fallback for non-birth-certificate documents.
    """

    boxed = [
        item
        for item in items
        if item.get("box") and item.get("text")
    ]

    boxed.sort(
        key=lambda item: (
            item["box"][1],
            item["box"][0]
        )
    )

    for item in boxed:
        match = NAME_LABEL_RE.match(
            item["text"]
        )

        if not match:
            continue

        # Skip "Name of School", "Name of Teacher/Adviser",
        # "Name and Address of ...", "Name in Print", etc.
        if NOT_PERSON_NAME_LABEL_RE.match(
            item["text"]
        ):
            continue

        value = clean_name(
            match.group(1)
        )

        # Value is on the same text line as the label.
        if len(value) >= 4:
            return _split_full_name(value)

        # Otherwise: nearest text to the right, then below.
        lb = item["box"]

        lh = max(
            1.0,
            box_height(lb)
        )

        best = None
        best_distance = 1e9

        for other in boxed:
            if other is item:
                continue

            if NAME_LABEL_RE.match(
                other["text"]
            ):
                continue

            ob = other["box"]

            text = clean_name(
                other["text"]
            )

            if sum(
                c.isalpha()
                for c in text
            ) < 3:
                continue

            same_row = (
                vertical_overlap(lb, ob) > lh * 0.5
                and ob[0] >= lb[2] - 5
            )

            below = (
                0 < ob[1] - lb[3] < lh * 3
                and horizontal_overlap(lb, ob) > 0
            )

            if not (
                same_row or below
            ):
                continue

            distance = (
                abs(ob[0] - lb[2])
                + abs(ob[1] - lb[1])
            )

            if distance < best_distance:
                best = text
                best_distance = distance

        if best:
            return _split_full_name(best)

    # No "NAME:" label worked: try the extra strategies.
    return extract_name_extra(items)

# ============================================================
# EXTRA NAME EXTRACTION (Good Moral, Form 137, certifications)
# ============================================================

_FIELD_LABEL_RE = re.compile(
    r"\b(LAST|FAMILY|FIRST|GIVEN|MIDDLE)\s*NAME\b|\bSURNAME\b",
    re.IGNORECASE,
)

_CERTIFY_COMMA_RE = re.compile(
    r"(?i:certif(?:y|ies)(?:\s+that)?)\s+(?:(?:MR|MS|MRS)\.?\s+)?"
    r"([A-ZÑ][A-Za-zÀ-ÿ'\-]+(?:\s[A-ZÑ][A-Za-zÀ-ÿ'\-]+)?\s*,\s*"
    r"[A-ZÑ][A-Za-zÀ-ÿ'\-]+(?:\s+[A-ZÑ][A-Za-zÀ-ÿ'\-]+)*(?:\s+[A-Z]\.?)?)"
)

_CERTIFY_PLAIN_RE = re.compile(
    r"(?i:certify\s+that)\s+(?:(?:MR|MS|MRS)\.?\s+)?"
    r"((?:[A-ZÑ][A-Za-zÀ-ÿ'\-]*\.?\s+){1,4}[A-ZÑ][A-Za-zÀ-ÿ'\-]*\.?)"
    r"(?=\s+[a-z])"
)


def _field_kind(label_text):
    t = label_text.upper()
    if t.startswith(("LAST", "FAMILY", "SURNAME")):
        return "last"
    if t.startswith(("FIRST", "GIVEN")):
        return "first"
    return "middle"


def _clean_field_value(value):
    # Stop at "NAME EXTN. (Jr, Sr)" or any bracket.
    value = re.split(
        r"NAME\s*EXTN|EXTENSION|\(", value or "", flags=re.IGNORECASE
    )[0]
    return clean_name(value)


def _neighbor_value(item, boxed):
    lb = item["box"]
    lh = max(1.0, box_height(lb))
    best, best_d = "", 1e9

    for other in boxed:
        if other is item or not other.get("box"):
            continue
        if _FIELD_LABEL_RE.search(other["text"]):
            continue

        ob = other["box"]
        text = _clean_field_value(other["text"])

        if sum(c.isalpha() for c in text) < 2:
            continue

        same_row = vertical_overlap(lb, ob) > lh * 0.5 and ob[0] >= lb[2] - 5
        below = 0 < ob[1] - lb[3] < lh * 2.5 and horizontal_overlap(lb, ob) > 0

        if not (same_row or below):
            continue

        d = abs(ob[0] - lb[2]) + abs(ob[1] - lb[1])
        if d < best_d:
            best, best_d = text, d

    return best


def _reading_order_text(items):
    boxed = [i for i in items if i.get("box") and i.get("text")]
    boxed.sort(key=lambda i: box_center(i["box"])[1])

    lines = []
    for item in boxed:
        cy = box_center(item["box"])[1]
        h = max(1.0, box_height(item["box"]))
        for line in lines:
            if abs(cy - line["cy"]) <= max(h, line["h"]) * 0.6:
                line["items"].append(item)
                line["cy"] = (line["cy"] + cy) / 2.0
                line["h"] = max(line["h"], h)
                break
        else:
            lines.append({"cy": cy, "h": h, "items": [item]})

    lines.sort(key=lambda l: l["cy"])

    return " ".join(
        i["text"]
        for line in lines
        for i in sorted(line["items"], key=lambda i: i["box"][0])
    )


def _split_comma_name(raw):
    """'DADES, ARIELLE V.' -> (first, middle, last). A lone initial is
    dropped so student matching can compare first + last name."""
    last, _, rest = raw.partition(",")
    last = clean_name(last)
    words = clean_name(rest).split()

    if len(words) > 1 and len(words[-1]) == 1:
        words = words[:-1]

    return " ".join(words), "", last


def extract_name_extra(items):
    """
    Extra name strategies for non-birth-certificate documents:
      1. LAST NAME / FIRST NAME / MIDDLE NAME labels (Form 137, forms)
      2. 'This is to certify that LAST, FIRST M. has ...' sentences
         (Good Moral, certifications)
    Returns (first, middle, last) or ("", "", "").
    """
    boxed = [i for i in items if i.get("text")]

    # --- 1. Labeled fields ---
    found = {}

    for item in boxed:
        text = item["text"]
        matches = list(_FIELD_LABEL_RE.finditer(text))

        for n, m in enumerate(matches):
            kind = _field_kind(m.group(0))

            if kind in found:
                continue

            end = matches[n + 1].start() if n + 1 < len(matches) else len(text)
            value = _clean_field_value(text[m.end():end].lstrip(" :;.-"))

            if not value and n == len(matches) - 1 and item.get("box"):
                value = _neighbor_value(item, boxed)

            if len(value) >= 2 and not is_non_name_field_text(value):
                found[kind] = value

    if found.get("first") and found.get("last"):
        middle = found.get("middle", "")
        if len(middle) == 1:
            middle = ""
        return found["first"], middle, found["last"]

    # --- 2. "certify that ..." sentence ---
    text = _reading_order_text(items) or " ".join(i["text"] for i in boxed)

    m = _CERTIFY_COMMA_RE.search(text)
    if m:
        return _split_comma_name(m.group(1))

    m = _CERTIFY_PLAIN_RE.search(text)
    if m:
        words = [w for w in clean_name(m.group(1)).split() if w]
        if len(words) >= 2:
            if len(words) > 2 and len(words[-2]) == 1:
                del words[-2]
            return " ".join(words[:-1]), "", words[-1]

    return "", "", ""


# ============================================================
# BIRTH CERTIFICATE IDENTIFICATION
# ============================================================

def compact_text(text):
    """Uppercase letters and digits only (ignores spaces/punctuation)."""
    return re.sub(r"[^A-Z0-9]", "", str(text or "").upper())


def is_birth_certificate_document(
    classification,
    raw_text=""
):
    """
    Identify birth certificates using both classifier result
    and OCR text, ignoring spaces (RapidOCR often drops them).
    """

    if not isinstance(classification, dict):
        classification = {}

    values = [
        raw_text,
        classification.get("document_type", "") or "",
        classification.get("document_type_key", "") or "",
        classification.get("document_type_label", "") or "",
        classification.get("header_text", "") or "",
    ]

    combined = compact_text(" ".join(map(str, values)))

    patterns = [
        "BIRTHCERTIFICATE",
        "CERTIFICATEOFLIVEBIRTH",
        "CERTIFICATIONOFLIVEBIRTH",
        "LIVEBIRTH",
        "FORM102",
        "CERTIFICATEOFBIRTH",
    ]

    return any(pattern in combined for pattern in patterns)


# ============================================================
# DOCUMENT OCR
# ============================================================

def extract_document(image_path):
    start = time.perf_counter()

    image = cv2.imread(image_path, cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError(
            "Unable to read uploaded image."
        )

    original_h, original_w = image.shape[:2]

    print("\n================================================")
    print(" REGISSCAN OCR - FAST MODE")
    print("================================================")

    print(
        f"Original: {original_w} x {original_h}"
    )

    image = prepare_image(image)

    h, w = image.shape[:2]

    print(
        f"Processed: {w} x {h}"
    )

    # --------------------------------------------------------
    # INITIAL FULL-PAGE OCR
    # --------------------------------------------------------

    def sorted_boxed_items(source_items):
        result_items = [
            item
            for item in source_items
            if item.get("box") is not None
        ]

        result_items.sort(
            key=lambda item: (
                item["box"][1],
                item["box"][0]
            )
        )

        return result_items

    def analyze_items(source_items):
        """
        Classify the document and extract the owner name
        from one set of OCR detections.
        """

        raw = " ".join(
            item.get("text", "")
            for item in source_items
        ).strip()

        classification = classify_document_type(
            raw,
            source_items,
            h
        )

        strict = is_birth_certificate_document(
            classification,
            raw
        )

        print(
            "[NAME EXTRACTION MODE]",
            "STRICT"
            if strict
            else "GENERIC DOCUMENT MODE"
        )

        owner = extract_owner_name(
            image,
            source_items,
            strict_child_section=strict
        )

        source = "owner_labels"

        # Generic extraction is only allowed for non-birth documents.
        if (
            not strict
            and not (
                owner["first_name"]
                and owner["last_name"]
            )
        ):
            first, middle, last = extract_name_generic(
                source_items
            )

            if first and last:
                owner["first_name"] = (
                    owner["first_name"] or first
                )

                owner["middle_name"] = (
                    owner["middle_name"] or middle
                )

                owner["last_name"] = (
                    owner["last_name"] or last
                )

                source = "generic_label"

        return classification, strict, owner, source

    ocr_start = time.perf_counter()

    items = None
    analysis = None

    if OCR_UPPER_FIRST and OCR_BACKEND != "paddle":
        crop_bottom = max(
            1,
            int(h * OCR_UPPER_FRACTION)
        )

        print(
            f"[OCR] Quick pass: scanning top "
            f"{int(OCR_UPPER_FRACTION * 100)}% of the page "
            f"({w} x {crop_bottom})"
        )

        # The crop starts at y=0, so box coordinates are identical
        # to full-page coordinates and need no shifting.
        quick_items = run_ocr(image[0:crop_bottom, 0:w])

        if quick_items:
            quick_analysis = analyze_items(quick_items)

            quick_classification, _, quick_owner, _ = quick_analysis

            quick_ok = bool(
                quick_owner["first_name"]
                and quick_owner["last_name"]
                and quick_classification.get("document_id") is not None
            )

            if quick_ok:
                items = quick_items
                analysis = quick_analysis

                print("[OCR] Quick pass succeeded. Skipping full page.")

            else:
                print(
                    "[OCR] Quick pass incomplete "
                    "(name or document type missing). "
                    "Scanning the full page."
                )

    if items is None:
        items = run_ocr(image)
        analysis = analyze_items(items)

    (
        initial_classification,
        strict_child_extraction,
        owner_name,
        name_source,
    ) = analysis

    ocr_seconds = (
        time.perf_counter() - ocr_start
    )

    upper_ocr_seconds = 0.0
    enhanced_ocr_seconds = 0.0

    name_start = time.perf_counter()

    # --------------------------------------------------------
    # ENHANCED OCR FALLBACK
    # --------------------------------------------------------

    if OCR_ENABLE_ENHANCED_FALLBACK and not (
        owner_name["first_name"]
        and owner_name["last_name"]
    ):
        if OCR_VERBOSE:
            print("\n[ENHANCED OCR] Running enhanced image pass...")

        enhanced_start = time.perf_counter()

        enhanced_image = enhance_image_for_ocr(
            image
        )

        if (
            enhanced_image is not None
            and enhanced_image.size > 0
        ):
            enhanced_items = run_ocr(
                enhanced_image
            )

            if enhanced_items:
                items = merge_ocr_items(
                    items,
                    enhanced_items
                )

                # Recheck document classification after enhancement.
                enhanced_raw_text = " ".join(
                    item.get("text", "")
                    for item in items
                ).strip()

                enhanced_classification = classify_document_type(
                    enhanced_raw_text,
                    items,
                    h
                )

                # Once identified as a birth certificate,
                # strict mode must remain enabled.
                strict_child_extraction = (
                    strict_child_extraction
                    or is_birth_certificate_document(
                        enhanced_classification,
                        enhanced_raw_text
                    )
                )

                print(
                    "[ENHANCED OCR MODE]",
                    "STRICT"
                    if strict_child_extraction
                    else "GENERIC DOCUMENT MODE"
                )

                owner_name = extract_owner_name(
                    image,
                    items,
                    strict_child_section=strict_child_extraction
                )

                name_source = "enhanced_owner_labels"

                # Generic extraction is disabled for birth certificates.
                if (
                    not strict_child_extraction
                    and not (
                        owner_name["first_name"]
                        and owner_name["last_name"]
                    )
                ):
                    first, middle, last = extract_name_generic(
                        items
                    )

                    if first and last:
                        owner_name["first_name"] = (
                            owner_name["first_name"] or first
                        )

                        owner_name["last_name"] = (
                            owner_name["last_name"] or last
                        )

                        # Do not populate middle name through
                        # generic full-name inference.
                        name_source = "enhanced_generic_label"

        enhanced_ocr_seconds = (
            time.perf_counter() - enhanced_start
        )

        print(
            f"[ENHANCED OCR] Completed in "
            f"{enhanced_ocr_seconds:.3f} seconds."
        )

    # --------------------------------------------------------
    # UPPER SECTION OCR FALLBACK
    # --------------------------------------------------------
    #
    # This fallback is only used for non-strict documents.
    # Birth certificates must not use generic extraction.
    # --------------------------------------------------------

    if (
        OCR_ENABLE_UPPER_FALLBACK
        and not strict_child_extraction
        and not (
            owner_name["first_name"]
            and owner_name["last_name"]
        )
    ):
        upper_start = time.perf_counter()

        upper_items = run_upper_name_ocr(
            image
        )

        upper_ocr_seconds = (
            time.perf_counter() - upper_start
        )

        if upper_items:
            items = merge_ocr_items(
                items,
                upper_items
            )

            owner_name = extract_owner_name(
                image,
                items,
                strict_child_section=False
            )

            name_source = "owner_labels_retry"

            if not (
                owner_name["first_name"]
                and owner_name["last_name"]
            ):
                first, middle, last = extract_name_generic(
                    items
                )

                if first and last:
                    owner_name["first_name"] = (
                        owner_name["first_name"] or first
                    )

                    owner_name["middle_name"] = (
                        owner_name["middle_name"] or middle
                    )

                    owner_name["last_name"] = (
                        owner_name["last_name"] or last
                    )

                    name_source = "generic_label_retry"

    # --------------------------------------------------------
    # FINAL NAME SOURCE AND TIMING
    # --------------------------------------------------------

    if not (
        owner_name["first_name"]
        and owner_name["last_name"]
    ):
        name_source = "none"

    name_seconds = (
        time.perf_counter() - name_start
    )

    # --------------------------------------------------------
    # FINAL OCR DETECTIONS
    # --------------------------------------------------------

    ordered_items = sorted_boxed_items(
        items
    )

    print("\n================================================")
    print("[OCR DETECTIONS]")
    print("================================================")

    if OCR_VERBOSE:
        for index, item in enumerate(ordered_items):
            print(f"{index:03d} | '{item.get('text', '')}' | score={item.get('score', 0):.3f} | box={item.get('box')}")

    raw_text = " ".join(
        item.get("text", "")
        for item in ordered_items
    ).strip()

    print(
        f"[OCR SUMMARY] "
        f"detections={len(ordered_items)}; "
        f"raw_text_chars={len(raw_text)}"
    )

    if OCR_VERBOSE and raw_text:
        print("[OCR RAW TEXT]", raw_text[:2500])
    elif not raw_text:
        print("[OCR WARNING] PaddleOCR produced no parsed text.")

    # Final document classification.
    document_classification = classify_document_type(
        raw_text,
        items,
        h
    )

    print(
        "[CLASSIFIER] type =", document_classification["document_type"],
        "| id =", document_classification["document_id"],
        "| source =", document_classification["document_type_source"],
        "| score =", document_classification["document_type_score"],
    )
    print("[CLASSIFIER] header:", document_classification["header_text"])
    print(
        "[CLASSIFIER] suggestions:",
        document_classification["document_type_suggestions"],
    )

    total_seconds = (
        time.perf_counter() - start
    )

    # --------------------------------------------------------
    # RESPONSE
    # --------------------------------------------------------

    result = {
        "success": bool(raw_text.strip()),

        "first_name": owner_name["first_name"],
        "middle_name": owner_name["middle_name"],
        "last_name": owner_name["last_name"],

        "document_type": document_classification["document_type"],
        "document_type_key": document_classification["document_type_key"],
        "document_type_confidence": document_classification["document_type_confidence"],
        "document_type_score": document_classification["document_type_score"],
        "document_type_source": document_classification["document_type_source"],
        "document_type_matches": document_classification["document_type_matches"],
        "document_type_suggestions": document_classification["document_type_suggestions"],
        "document_id": document_classification["document_id"],
        "header_text": document_classification["header_text"],

        "document_type_label": (
            document_classification["document_type"] or ""
        ),

        "document_type_found": (
            document_classification["document_id"] is not None
        ),

        "raw_text": raw_text,

        "ocr_items": len(ordered_items),

        "timing": {
            "full_ocr_seconds": round(
                ocr_seconds,
                3
            ),

            "enhanced_ocr_seconds": round(
                enhanced_ocr_seconds,
                3
            ),

            "upper_ocr_seconds": round(
                upper_ocr_seconds,
                3
            ),

            "name_extraction_seconds": round(
                name_seconds,
                3
            ),

            "total_seconds": round(
                total_seconds,
                3
            ),
        },

        "debug": {
            "owner_anchor_found": owner_name["owner_anchor_found"],
            "name_source": name_source,
            "header_text": document_classification["header_text"],
            "strict_child_extraction": strict_child_extraction,
        },
    }

    print("\n[FINAL RESULT]")

    print(
        "FIRST NAME :",
        result["first_name"]
    )

    print(
        "MIDDLE NAME:",
        result["middle_name"]
    )

    print(
        "LAST NAME  :",
        result["last_name"]
    )

    print(
        "DOCUMENT   :",
        result["document_type"]
    )

    print(
        "TIMING      :",
        result["timing"]
    )

    print("================================================")

    return result


# ============================================================
# FLASK /OCR
# ============================================================

@app.route("/ocr", methods=["POST"])
def ocr_endpoint():
    temp_path = None

    try:
        if "file" not in request.files:
            return jsonify(
                {
                    "success": False,
                    "error": "No file uploaded."
                }
            ), 400

        uploaded_file = request.files["file"]

        if not uploaded_file.filename:
            return jsonify(
                {
                    "success": False,
                    "error": "No filename provided."
                }
            ), 400

        extension = Path(
            uploaded_file.filename
        ).suffix.lower()

        allowed_extensions = {
            ".jpg",
            ".jpeg",
            ".png",
            ".webp",
            ".bmp",
            ".tif",
            ".tiff"
        }

        if extension not in allowed_extensions:
            return jsonify(
                {
                    "success": False,
                    "error": "Unsupported image format."
                }
            ), 400

        # ----------------------------------------------------
        # SAVE UPLOAD
        # ----------------------------------------------------

        with tempfile.NamedTemporaryFile(
            delete=False,
            suffix=extension
        ) as temp_file:
            uploaded_file.save(
                temp_file.name
            )

            temp_path = temp_file.name

        print(
            "[UPLOAD]",
            temp_path
        )

        # ----------------------------------------------------
        # PROCESS
        # ----------------------------------------------------

        result = extract_document(
            temp_path
        )

        return jsonify(result), 200

    except Exception as exc:
        print("")
        print("================================================")
        print("[OCR ERROR]")
        print("================================================")

        print(str(exc))

        traceback.print_exc()

        print("================================================")

        return jsonify(
            {
                "success": False,
                "error": str(exc)
            }
        ), 500

    finally:
        if temp_path:
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)

            except Exception as exc:
                print(
                    "[CLEANUP ERROR]",
                    str(exc)
                )


# ============================================================
# HEALTH
# ============================================================

@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "success": True,
            "service": "RegisScan OCR Server",
            "status": "running"
        }
    )


# ============================================================
# START SERVER
# ============================================================

if __name__ == "__main__":
    print("")
    print("================================================")
    print(" RegisScan OCR Server - UPDATED VERSION")
    print("================================================")

    print(
        "Build  : 2026-11-07 RapidOCR + quick top-of-page pass"
    )

    print(
        "OCR    : http://127.0.0.1:5001/ocr"
    )

    print(
        "Health : http://127.0.0.1:5001/health"
    )

    print(
        "Target : Owner name + document type"
    )

    print(
        "Fields : First / Middle / Last"
    )

    print("Mode   : Strict child extraction for birth certificates")
    print(f"Engine : {OCR_BACKEND}")
    print(f"Quick  : upper_first={OCR_UPPER_FIRST}, fraction={OCR_UPPER_FRACTION}")
    print(f"Fast   : max_size={OCR_MAX_SIZE}, cpu_threads={OCR_CPU_THREADS}, mkldnn={OCR_ENABLE_MKLDNN} (paddle only)")
    print(f"Fallbacks: enhanced={OCR_ENABLE_ENHANCED_FALLBACK}, upper={OCR_ENABLE_UPPER_FALLBACK}, deskew={OCR_DESKEW}")

    print("================================================")
    print("")

    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5001)),
        debug=False,
        threaded=True
    )