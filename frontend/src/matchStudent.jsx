
import { supabase } from "./supabaseClient";

const norm = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (value) => norm(value).split(" ").filter(Boolean);

function similarity(a, b) {
  a = norm(a);
  b = norm(b);

  if (!a || !b) return 0;
  if (a === b) return 1;

  const m = a.length;
  const n = b.length;

  const previous = Array.from(
    { length: n + 1 },
    (_, index) => index
  );

  for (let i = 1; i <= m; i++) {
    let diagonal = previous[0];
    previous[0] = i;

    for (let j = 1; j <= n; j++) {
      const old = previous[j];

      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );

      diagonal = old;
    }
  }

  return 1 - previous[n] / Math.max(m, n);
}

function getNameScore(input, student) {
  const first = norm(student.first_name);
  const middle = norm(student.middle_name);
  const last = norm(student.last_name);

  const dbTokens = tokens(`${first} ${middle} ${last}`);
  const inputTokens = tokens(
    input.fullName ||
      input.full_name ||
      input.studentName ||
      input.name ||
      [input.first, input.middle, input.last]
        .filter(Boolean)
        .join(" ")
  );

  if (!inputTokens.length || !dbTokens.length) return 0;

  const uniqueInput = [...new Set(inputTokens)];
  const uniqueDb = [...new Set(dbTokens)];

  // Exact match, ignoring word order.
  if (
    uniqueInput.length === uniqueDb.length &&
    uniqueInput.every((word) => uniqueDb.includes(word))
  ) {
    return 1;
  }

  // If OCR omitted the middle name, compare first and last.
  // This is a candidate score, not proof of a unique identity.
  if (
    !input.middle &&
    first &&
    last &&
    uniqueInput.length >= 2 &&
    uniqueInput.includes(first) &&
    uniqueInput.includes(last)
  ) {
    return 0.96;
  }

  // Compare OCR words against database name words.
  const wordScores = uniqueInput.map((word) =>
    Math.max(
      ...uniqueDb.map((dbWord) => similarity(word, dbWord))
    )
  );

  const wordScore =
    wordScores.reduce((sum, score) => sum + score, 0) /
    wordScores.length;

  const inputFull = inputTokens.join(" ");
  const dbFull = dbTokens.join(" ");

  const fullScore = Math.max(
    similarity(inputFull, dbFull),
    similarity(
      [...inputTokens].sort().join(" "),
      [...dbTokens].sort().join(" ")
    )
  );

  return Math.max(wordScore * 0.8, fullScore);
}

export async function matchStudentFromOcr(input = {}) {
  const first = norm(input.first);
  const middle = norm(input.middle);
  const last = norm(input.last);

  const fullName = norm(
    input.fullName ||
      input.full_name ||
      input.studentName ||
      input.student_name ||
      input.name ||
      [first, middle, last].filter(Boolean).join(" ")
  );

  if (!fullName) {
    return { student: null, candidates: [] };
  }

  // Load database names so OCR spelling errors do not prevent
  // a student from being considered by a prefix-only search.
  const { data, error } = await supabase
    .from("tbl_student")
    .select(
      "student_id, first_name, middle_name, last_name, birthdate"
    )
    .limit(5000);

  if (error) {
    console.error("Student matching query failed:", error);
    throw error;
  }

  const scored = (data ?? [])
    .map((student) => ({
      ...student,
      score: getNameScore(
        { first, middle, last, fullName },
        student
      ),
    }))
    .filter((student) => student.score > 0)
    .sort((a, b) => b.score - a.score);

  const candidates = scored.slice(0, 3);
  const best = scored[0];
  const second = scored[1];

  if (!best) {
    return { student: null, candidates: [] };
  }

  // Exact normalized names are safe only if unique.
  const exactMatches = scored.filter(
    (student) => student.score === 1
  );

  if (exactMatches.length === 1) {
    return {
      student: exactMatches[0],
      candidates,
    };
  }

  // Require a strong score and a clear margin over the next match.
  const confident =
    best.score >= 0.92 &&
    (!second || best.score - second.score >= 0.08);

  return {
    student: confident ? best : null,
    candidates,
  };
}
