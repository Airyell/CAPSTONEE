import os
import re
import json
import time
import urllib.request
from difflib import SequenceMatcher
from statistics import median

# ------------------------------------------------------------
# Supabase credentials
#
# Python cannot import supabaseClient.js, so this reads the same values from
# where that file gets them. Lookup order:
#   1. environment variables (SUPABASE_URL / SUPABASE_KEY)
#   2. a .env file in this folder or any parent folder (the project's .env),
#      using VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY etc.
#   3. hardcoded strings inside a supabaseClient.js found in the project
# ------------------------------------------------------------

_URL_NAMES = ("SUPABASE_URL", "VITE_SUPABASE_URL")
_KEY_NAMES = (
    "SUPABASE_KEY",
    "SUPABASE_ANON_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "VITE_SUPABASE_KEY",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
)


def _parent_folders():
    here = os.path.dirname(os.path.abspath(__file__))
    folders = [here]
    for _ in range(5):
        here = os.path.dirname(here)
        if here and here not in folders:
            folders.append(here)
    return folders


def _read_env_file(path):
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return values


def _load_credentials():
    url, key = "", ""

    for n in _URL_NAMES:
        url = url or os.environ.get(n, "")
    for n in _KEY_NAMES:
        key = key or os.environ.get(n, "")

    if not (url and key):
        for folder in _parent_folders():
            for name in (".env", ".env.local"):
                path = os.path.join(folder, name)
                if os.path.isfile(path):
                    vals = _read_env_file(path)
                    for n in _URL_NAMES:
                        url = url or vals.get(n, "")
                    for n in _KEY_NAMES:
                        key = key or vals.get(n, "")

    if not (url and key):
        # Last resort: hardcoded strings inside supabaseClient.js
        for folder in _parent_folders():
            for root, dirs, files in os.walk(folder):
                dirs[:] = [d for d in dirs if d not in
                           ("node_modules", ".git", "vendor", "dist", "build")]
                if "supabaseClient.js" in files:
                    try:
                        with open(os.path.join(root, "supabaseClient.js"),
                                  "r", encoding="utf-8") as f:
                            text = f.read()
                        m_url = re.search(
                            r"https://[a-z0-9-]+\.supabase\.co", text)
                        m_key = re.search(
                            r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+",
                            text)
                        url = url or (m_url.group(0) if m_url else "")
                        key = key or (m_key.group(0) if m_key else "")
                    except Exception:
                        pass
                    break
            if url and key:
                break

    return url.rstrip("/"), key


SUPABASE_URL, SUPABASE_KEY = _load_credentials()
print("[CLASSIFIER] Supabase credentials:",
      "found" if (SUPABASE_URL and SUPABASE_KEY) else "NOT FOUND")

CACHE_SECONDS = 300
HEADER_THRESHOLD = 0.75   # minimum score to accept a header match
HEADER_MARGIN = 0.05      # best must beat the runner-up by this much

# Optional extra header wordings, keyed by the exact tbl_documents.document_name.
# Only needed when the printed header differs a lot from the stored name.
ALIASES = {
    "Form 137": [
        "permanent record",
        "student permanent record",
        "learner permanent record",
        "school form 10",
        "sf10",
    ],
    "Good Moral": [
        "good moral certificate",
        "certificate of good moral character",
        "good moral character",
    ],
}

# Words that should count as the same word
SYNONYMS = {
    "certification": "certificate",
    "certificates": "certificate",
    "certifications": "certificate",
    "records": "record",
    "transcripts": "transcript",
    "grades": "grade",
}
STOP = {"the", "of", "and", "for", "a", "an", "to", "in"}


# ============================================================
# DOCUMENT TYPES FROM THE DATABASE
# ============================================================

_cache = {"t": 0.0, "docs": []}


def get_document_types():
    """Returns [{'document_id': int, 'document_name': str}, ...]."""
    if _cache["docs"] and time.time() - _cache["t"] < CACHE_SECONDS:
        return _cache["docs"]

    if not SUPABASE_URL or not SUPABASE_KEY:
        return _cache["docs"]

    def fetch(columns):
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/tbl_documents?select={columns}",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
            },
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        try:
            # Optional column: tbl_documents.aliases (comma-separated header
            # wordings). Lets the registrar teach the system new wordings
            # without touching code.
            docs = fetch("document_id,document_name,aliases")
        except Exception:
            docs = fetch("document_id,document_name")

        _cache["docs"] = [d for d in docs if d.get("document_name")]
        _cache["t"] = time.time()

    except Exception as exc:
        print("[CLASSIFIER] Could not load tbl_documents:", exc)

    return _cache["docs"]


# ============================================================
# TEXT MATCHING
# ============================================================

# ------------------------------------------------------------
# OCR sometimes drops the spaces between words, e.g.
# "GOOD MORALCERTIFICATE", "FORM137-SHS" or
# "SENIORHIGHSCHOOLSTUDENTPERMANENTRECORD". These helpers put the spaces
# back, using the words that appear in the document names and aliases.
# ------------------------------------------------------------

_GLUE_MIN_LEN = 8          # only long, space-less words are split
_vocab_cache = {"sig": None, "words": ()}


def _vocabulary():
    """Document-related words (longest first), built from tbl_documents."""
    docs = _cache.get("docs") or []
    sig = tuple(sorted(
        d["document_name"] + "|" + str(d.get("aliases") or "")
        for d in docs
    ))

    if _vocab_cache["sig"] == sig:
        return _vocab_cache["words"]

    words = set(SYNONYMS.keys()) | set(SYNONYMS.values())

    for d in docs:
        for name in _names_for(d):
            for w in re.sub(r"[^a-z]", " ", name.lower()).split():
                words.add(w)
                words.add(SYNONYMS.get(w, w))

    words = sorted(
        (w for w in words if len(w) >= 4 and w not in STOP),
        key=len,
        reverse=True,
    )

    _vocab_cache["sig"] = sig
    _vocab_cache["words"] = tuple(words)

    return _vocab_cache["words"]


_SMALL_JOINERS = {"of", "and", "for", "the"}


def _split_piece(word, vocab):
    """Split one space-less word around known document words."""
    if word in vocab:
        return [word]

    def acceptable(piece):
        # A leftover must be a known word, a small joiner like "of", or a
        # real chunk of 6+ letters. This keeps ordinary words such as
        # "information", "uniform" or "transformation" from being split.
        return (
            piece in vocab
            or piece in _SMALL_JOINERS
            or len(piece) >= 6
        )

    for v in vocab:
        i = word.find(v)

        if i < 0:
            continue

        left, right = word[:i], word[i + len(v):]

        if all(acceptable(p) for p in (left, right) if p):
            parts = []

            if left:
                parts += _split_piece(left, vocab)

            parts.append(v)

            if right:
                parts += _split_piece(right, vocab)

            return parts

    return [word]


def _split_glued(word, vocab):
    """'moralcertificate' -> ['moral', 'certificate']."""
    if len(word) < _GLUE_MIN_LEN:
        return [word]

    return _split_piece(word, vocab)


def _tokens(text):
    text = re.sub(r"[^a-z0-9 ]", " ", str(text).lower())

    # "form137" -> "form 137", "may2005" -> "may 2005"
    text = re.sub(r"(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])", " ", text)

    vocab = _vocabulary()
    words = []

    for w in text.split():
        words += _split_glued(w, vocab) if w.isalpha() else [w]

    words = [SYNONYMS.get(w, w) for w in words]
    return [w for w in words if w not in STOP]


def _token_in(token, candidates):
    """True if token (fuzzily) appears among candidate tokens."""
    for c in candidates:
        # Numbers like 137 / 138 must match exactly.
        if token.isdigit() or c.isdigit():
            if token == c:
                return True
            continue

        if SequenceMatcher(None, token, c).ratio() >= 0.8:
            return True

    return False


def _score(name_tokens, cand_tokens):
    """
    Best score of the document name against any short window of the
    candidate text, so extra words elsewhere on the line don't hurt.
    """
    if not name_tokens or not cand_tokens:
        return 0.0

    n = len(name_tokens)
    best = 0.0
    max_w = min(len(cand_tokens), n + 2)

    for w in range(1, max_w + 1):
        for i in range(0, len(cand_tokens) - w + 1):
            window = cand_tokens[i:i + w]

            matched = sum(1 for t in name_tokens if _token_in(t, window))
            if matched == 0:
                continue

            coverage = matched / n
            precision = matched / len(window)
            best = max(best, coverage * (0.6 + 0.4 * precision))

    return best


# ============================================================
# HEADER EXTRACTION
# ============================================================

def header_candidates(items, image_height, top_frac=0.40):
    """
    Builds candidate header strings from OCR items (dicts with 'text' and
    'box' = (x1, y1, x2, y2)): the top lines of the page plus any
    larger-than-normal text in the upper part. Returns lines, plus joined
    pairs and triples of consecutive lines, because headers often wrap.
    """
    rows = []

    for item in items or []:
        box = item.get("box")
        text = str(item.get("text", "")).strip()

        if not box or not text:
            continue

        rows.append(
            {
                "y": float(box[1]),
                "x": float(box[0]),
                "h": max(1.0, float(box[3]) - float(box[1])),
                "text": text,
            }
        )

    if not rows:
        return []

    med_h = median(r["h"] for r in rows)

    header_rows = [
        r
        for r in rows
        if r["y"] <= image_height * top_frac
        or (r["h"] >= med_h * 1.4 and r["y"] <= image_height * 0.60)
    ]

    header_rows.sort(key=lambda r: (r["y"], r["x"]))

    # Group into lines
    lines = []
    for r in header_rows:
        if lines and abs(r["y"] - lines[-1]["y"]) <= max(12.0, r["h"] * 0.6):
            lines[-1]["parts"].append(r)
        else:
            lines.append({"y": r["y"], "parts": [r]})

    texts = []
    for line in lines[:14]:
        parts = sorted(line["parts"], key=lambda r: r["x"])
        texts.append(" ".join(p["text"] for p in parts))

    pairs = [f"{a} {b}" for a, b in zip(texts, texts[1:])]
    triples = [
        f"{a} {b} {c}" for a, b, c in zip(texts, texts[1:], texts[2:])
    ]

    return texts + pairs + triples


def _slug(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def _confidence_label(score):
    if score >= 0.90:
        return "high"
    if score >= HEADER_THRESHOLD:
        return "medium"
    return "low"


def _names_for(doc):
    """document_name + aliases from the database column and the ALIASES dict."""
    names = [doc["document_name"]] + ALIASES.get(doc["document_name"], [])
    extra = doc.get("aliases")
    if extra:
        names += [a.strip() for a in str(extra).split(",") if a.strip()]
    return names


def _phrase_match(raw_text, docs):
    """
    Generic full-text fallback for ANY document type in tbl_documents:
    finds names/aliases that appear as an exact phrase in the page text.
    Longer phrases win. Returns (doc, matched_phrase) or (None, None).
    """
    text = " " + " ".join(_tokens(raw_text)) + " "
    best_doc, best_phrase = None, None

    for d in docs:
        for n in _names_for(d):
            phrase = " ".join(_tokens(n))
            if len(phrase) < 4:
                continue
            if f" {phrase} " in text:
                if best_phrase is None or len(phrase) > len(best_phrase):
                    best_doc, best_phrase = d, phrase

    return best_doc, best_phrase


def _rank_documents(candidate_texts, docs):
    cands = [_tokens(c) for c in candidate_texts]
    ranked = []

    for d in docs:
        names = _names_for(d)
        best = 0.0

        for n in names:
            nt = _tokens(n)
            for c in cands:
                best = max(best, _score(nt, c))

        ranked.append((best, len(_tokens(d["document_name"])), d))

    # Highest score first; on a tie prefer the more specific (longer) name.
    ranked.sort(key=lambda r: (r[0], r[1]), reverse=True)
    return ranked


# ============================================================
# KEYWORD FALLBACK (full text)
# ============================================================

KEYWORD_RULES = {
    "Birth Certificate": {
        "strong": [
            "CERTIFICATE OF LIVE BIRTH", "CERTIFICATE OF BIRTH",
            "BIRTH CERTIFICATE", "LIVE BIRTH",
        ],
        "normal": [
            "LOCAL CIVIL REGISTRAR", "PHILIPPINE STATISTICS AUTHORITY", "PSA",
        ],
    },
    "Form 137": {
        "strong": [
            "FORM 137", "SCHOOL FORM 10", "SF10", "PERMANENT RECORD",
            "SECONDARY STUDENT S PERMANENT RECORD",
        ],
        "normal": [
            "STUDENT S PERMANENT RECORD", "LEARNER S PERMANENT RECORD",
        ],
    },
    "Form 138": {
        "strong": [
            "FORM 138", "SCHOOL FORM 9", "SF9", "REPORT CARD",
            "LEARNER S PROGRESS REPORT CARD",
        ],
        "normal": ["PROGRESS REPORT"],
    },
    "Good Moral": {
        "strong": [
            "CERTIFICATE OF GOOD MORAL CHARACTER", "GOOD MORAL CHARACTER",
            "GOOD MORAL",
        ],
        "normal": ["MORAL CHARACTER"],
    },
    "Transcript of Records": {
        "strong": ["TRANSCRIPT OF RECORDS", "OFFICIAL TRANSCRIPT"],
        "normal": ["TRANSCRIPT", "ACADEMIC RECORD"],
    },
    "Grades": {
        "strong": ["REPORT OF GRADES", "GRADE REPORT"],
        "normal": ["FINAL GRADES", "SEMESTER GRADES"],
    },
    "Leave of Absence": {
        "strong": ["LEAVE OF ABSENCE", "LEAVE OF ABSENCE FORM"],
        "normal": ["LOA"],
    },
    "Withdrawal": {
        "strong": [
            "WITHDRAWAL FORM", "WITHDRAWAL", "WITHDRAWAL OF ENROLLMENT",
        ],
        "normal": ["HONORABLE DISMISSAL"],
    },
}


def _keyword_classify(raw_text):
    """Returns (label, matches, score) or (None, [], 0)."""
    if not raw_text:
        return None, [], 0

    text = re.sub(r"[^A-Z0-9 ]+", " ", raw_text.upper())
    text = re.sub(r"\s+", " ", text).strip()

    best_label, best_matches, best_score = None, [], 0

    for label, rules in KEYWORD_RULES.items():
        score, matches = 0, []

        for phrase in rules["strong"]:
            if phrase in text:
                score += 5
                matches.append(phrase)

        for phrase in rules["normal"]:
            if phrase in text:
                score += 2
                matches.append(phrase)

        if score > best_score:
            best_label, best_matches, best_score = label, matches, score

    return best_label, best_matches, best_score


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def classify_document_type(raw_text, items=None, image_height=None):
    """
    Drop-in replacement for the old classify_document_type(raw_text).
    Keeps the old keys and adds document_id, header_text, source and
    suggestions. If nothing is detected, document_type is "Unknown" and
    document_id is None, so the UI should ask the registrar to pick one.
    """
    docs = get_document_types()

    result = {
        "document_type": "Unknown",
        "document_type_key": "unknown",
        "document_type_confidence": "low",
        "document_type_score": 0.0,
        "document_type_source": None,
        "document_type_matches": [],
        "document_type_suggestions": [],
        "document_id": None,
        "header_text": "",
    }

    # ---------- 1. HEADER MATCH ----------
    header_texts = []
    if items and image_height and docs:
        header_texts = header_candidates(items, image_height)
        result["header_text"] = " | ".join(header_texts[:6])

        ranked = _rank_documents(header_texts, docs)

        result["document_type_suggestions"] = [
            {
                "document_id": d["document_id"],
                "document_name": d["document_name"],
                "score": round(s, 2),
            }
            for s, _, d in ranked[:3]
            if s >= 0.4
        ]

        if ranked:
            top_score, _, top_doc = ranked[0]
            runner_up = ranked[1][0] if len(ranked) > 1 else 0.0

            if (
                top_score >= HEADER_THRESHOLD
                and top_score - runner_up >= HEADER_MARGIN
            ):
                result.update(
                    document_type=top_doc["document_name"],
                    document_type_key=_slug(top_doc["document_name"]),
                    document_type_confidence=_confidence_label(top_score),
                    document_type_score=round(top_score, 2),
                    document_type_source="header",
                    document_id=top_doc["document_id"],
                    document_type_matches=header_texts[:1],
                )
                return result

    # ---------- 2. EXACT PHRASE ANYWHERE ON THE PAGE (any DB document) ----------
    if docs:
        doc, phrase = _phrase_match(raw_text, docs)
        if doc:
            result.update(
                document_type=doc["document_name"],
                document_type_key=_slug(doc["document_name"]),
                document_type_confidence="medium",
                document_type_score=0.8,
                document_type_source="body",
                document_id=doc["document_id"],
                document_type_matches=[phrase],
            )
            return result

    # ---------- 3. LEGACY KEYWORD FALLBACK ----------
    label, matches, kw_score = _keyword_classify(raw_text)

    if label:
        result["document_type_matches"] = matches

        # Map the keyword label onto a real tbl_documents row if possible.
        if docs:
            ranked = _rank_documents([label], docs)
            if ranked and ranked[0][0] >= HEADER_THRESHOLD:
                doc = ranked[0][2]
                result.update(
                    document_type=doc["document_name"],
                    document_type_key=_slug(doc["document_name"]),
                    document_type_confidence=(
                        "high" if kw_score >= 5 else "medium"
                    ),
                    document_type_score=round(ranked[0][0], 2),
                    document_type_source="body",
                    document_id=doc["document_id"],
                )
                return result

        # No database row matched (or database unreachable): keep the label
        # but leave document_id empty so the UI asks for confirmation.
        result.update(
            document_type=label,
            document_type_key=_slug(label),
            document_type_confidence="low" if docs else (
                "high" if kw_score >= 5 else "medium"
            ),
            document_type_source="body",
        )

    return result