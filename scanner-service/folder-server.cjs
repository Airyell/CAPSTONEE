const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const app = express();
const PORT = 3001;
const VERSION = "6";

// ------------------------------------------------------------
// Base folder: C:\StudentRecords (same path on every PC)
// Layout: C:\StudentRecords\<College>\<ID>_<Name>
// Optional override: set STUDENT_BASE_FOLDER on a PC
// ------------------------------------------------------------
function expandEnvVars(value) {
  return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
}

function resolveBaseFolder() {
  if (process.env.STUDENT_BASE_FOLDER?.trim()) {
    return path.resolve(expandEnvVars(process.env.STUDENT_BASE_FOLDER.trim()));
  }

  if (process.platform === "win32") {
    return path.join(process.env.SystemDrive || "C:", "\\", "StudentRecords");
  }

  return path.join(os.homedir(), "StudentRecords");
}

const BASE_FOLDER = resolveBaseFolder();

// ------------------------------------------------------------
// OLD locations. Folders found here are moved into the new layout.
// ------------------------------------------------------------
function getWindowsDocumentsFolder() {
  if (process.platform !== "win32") return null;

  try {
    const output = execFileSync(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
        "/v",
        "Personal",
      ],
      { encoding: "utf8", windowsHide: true }
    );

    const match = output.match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
    if (match) return expandEnvVars(match[1].trim());
  } catch {
    // ignore
  }

  return null;
}

function getLegacyRoots() {
  const docs = getWindowsDocumentsFolder();
  const roots = [
    docs && path.join(docs, "student"),
    path.join(os.homedir(), "Documents", "student"),
  ].filter(Boolean);

  const seen = new Set();
  return roots.filter((r) => {
    const key = path.resolve(r).toLowerCase();
    if (seen.has(key) || key === path.resolve(BASE_FOLDER).toLowerCase()) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const LEGACY_ROOTS = getLegacyRoots();

// ------------------------------------------------------------
// Middleware
// ------------------------------------------------------------
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// Chrome/Edge Private Network Access (website -> 127.0.0.1). Before cors().
app.use((req, res, next) => {
  if (req.headers["access-control-request-private-network"]) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
});

app.use(cors({ origin: true }));
// Large limit: scanned files are sent as base64
app.use(express.json({ limit: "50mb" }));

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function safeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
}

function joinedName(first, middle, last) {
  return safeName(
    [first, middle, last].filter((part) => String(part || "").trim()).join(" ")
  );
}

// Student folder = "<ID>_<First_Middle_Last>"
function buildFolderName(studentId, first, middle, last) {
  return `${safeName(studentId)}_${joinedName(first, middle, last).replace(/ /g, "_")}`;
}

// College folder = college name with underscores ("Unassigned" if empty)
function buildCollegeFolder(collegeName) {
  return safeName(collegeName).replace(/ /g, "_") || "Unassigned";
}

// Full target: BASE\<College>\<ID>_<Name>
function buildTarget(collegeName, studentId, first, middle, last) {
  return path.join(
    BASE_FOLDER,
    buildCollegeFolder(collegeName),
    buildFolderName(studentId, first, middle, last)
  );
}

// "Birth Certificate" -> "birth_certificate"
function docSlug(name) {
  return (
    String(name || "other")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "other"
  );
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// Creates the folder (and parents) and CONFIRMS it exists.
// Returns true if newly created.
async function ensureFolder(target) {
  const existedBefore = await pathExists(target);

  await fs.mkdir(target, { recursive: true });

  const stat = await fs.stat(target);
  if (!stat.isDirectory()) {
    throw new Error(`${target} exists but is not a folder`);
  }

  if (!existedBefore) console.log(`  + created: ${target}`);
  return !existedBefore;
}

// Move a folder; creates the parent (college) folder first.
// If rename fails (e.g. different drive), copy then delete.
async function moveFolder(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });

  try {
    await fs.rename(from, to);
  } catch (error) {
    if (["EXDEV", "EPERM", "EACCES"].includes(error.code)) {
      await fs.cp(from, to, { recursive: true, errorOnExist: true });
      await fs.rm(from, { recursive: true, force: true });
    } else {
      throw error;
    }
  }
  console.log(`  ~ moved: ${from} -> ${to}`);
}

// All folders directly inside BASE (college folders + old flat folders)
async function listBaseDirs() {
  try {
    const entries = await fs.readdir(BASE_FOLDER, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(BASE_FOLDER, e.name));
  } catch {
    return [];
  }
}

// Where an existing folder of this student might currently be.
// Only the folder NAME is taken from the saved path, so a path saved
// on another PC (or in an old location) still works here.
function candidateSources(student, target, baseDirs) {
  const targetName = path.basename(target);
  const names = [targetName];

  if (typeof student.folder_path === "string" && student.folder_path.trim()) {
    const saved = path.win32.basename(
      student.folder_path.trim().replace(/[\\/]+$/, "")
    );
    if (saved) names.push(saved);
  }

  const plain = joinedName(
    student.first_name,
    student.middle_name,
    student.last_name
  );
  if (plain) {
    names.push(plain.replace(/ /g, "_")); // "Juan_Santos_Dela_Cruz"
    names.push(plain); // "Juan Santos Dela Cruz"
  }

  // Search: flat BASE (old layout), every college folder (college changed),
  // then the old Documents\student locations.
  const roots = [BASE_FOLDER, ...baseDirs, ...LEGACY_ROOTS];
  const list = [];

  for (const name of names) {
    for (const root of roots) {
      const candidate = path.join(root, name);
      if (!samePath(candidate, target)) list.push(candidate);
    }
  }

  return list;
}

// ------------------------------------------------------------
// Health check
// ------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    base_folder: BASE_FOLDER,
    layout: "<base>\\<College>\\<ID>_<Name>\\<document_type>",
    legacy_folders: LEGACY_ROOTS,
  });
});

// ------------------------------------------------------------
// Create a folder for a NEW student
// ------------------------------------------------------------
app.post("/create-folder", async (req, res) => {
  try {
    const {
      student_id,
      first_name,
      middle_name = "",
      last_name,
      college_name = "",
    } = req.body;

    if (student_id == null || !first_name?.trim() || !last_name?.trim()) {
      return res.status(400).json({
        message: "Student ID, first name, and last name are required.",
      });
    }

    const folderPath = buildTarget(
      college_name,
      student_id,
      first_name,
      middle_name,
      last_name
    );

    await ensureFolder(folderPath);

    return res.json({ folder_path: folderPath });
  } catch (error) {
    console.error("Folder creation error:", error);
    return res.status(500).json({
      message: `Could not create the student folder: ${error.code || error.message}`,
    });
  }
});

// ------------------------------------------------------------
// Save a scanned document into the student's folder:
// BASE\<College>\<ID>_<Name>\<document_type>\<timestamp>_<file>
// ------------------------------------------------------------
app.post("/save-document", async (req, res) => {
  try {
    const {
      student_id,
      first_name,
      middle_name = "",
      last_name,
      college_name = "",
      document_name = "other",
      file_name = "document",
      data_base64,
    } = req.body;

    if (
      student_id == null ||
      !first_name?.trim() ||
      !last_name?.trim() ||
      !data_base64
    ) {
      return res.status(400).json({
        message: "Student, name and file data are required.",
      });
    }

    // The folder is always built here from the student's data, never from
    // a path sent by the browser.
    const studentDir = buildTarget(
      college_name,
      student_id,
      first_name,
      middle_name,
      last_name
    );
    const dir = path.join(studentDir, docSlug(document_name));
    await fs.mkdir(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const cleanName =
      safeName(String(file_name).replace(/^.*[\\/]/, "")).replace(/ /g, "_") ||
      "document";
    const fullPath = path.join(dir, `${stamp}_${cleanName}`);

    await fs.writeFile(fullPath, Buffer.from(data_base64, "base64"));
    console.log(`  + saved document: ${fullPath}`);

    return res.json({ file_path: fullPath });
  } catch (error) {
    console.error("Save document error:", error);
    return res.status(500).json({
      message: `Could not save the document: ${error.code || error.message}`,
    });
  }
});

// ------------------------------------------------------------
// Sync EXISTING students.
// Each student's folder must be BASE\<College>\<ID>_<Name>:
//  - already there                      -> nothing to do
//  - found elsewhere (old/flat/other college) -> moved there
//  - not found anywhere                 -> created
// "updates" lists students whose saved folder_path must change.
// ------------------------------------------------------------
app.post("/sync-folders", async (req, res) => {
  const { students } = req.body;

  if (!Array.isArray(students)) {
    return res.status(400).json({ message: "students must be an array." });
  }

  console.log(`  syncing ${students.length} student(s) into ${BASE_FOLDER}`);

  const result = {
    created: 0,
    existing: 0,
    renamed: 0,
    skipped: [],
    failed: [],
    updates: [],
  };

  for (const s of students) {
    const label = s?.student_id ?? "unknown";

    try {
      if (s?.student_id == null || !s.first_name?.trim() || !s.last_name?.trim()) {
        result.skipped.push({ student_id: label, reason: "Missing ID or name" });
        continue;
      }

      const target = buildTarget(
        s.college_name,
        s.student_id,
        s.first_name,
        s.middle_name,
        s.last_name
      );

      if (await pathExists(target)) {
        result.existing++;
      } else {
        const baseDirs = await listBaseDirs();

        let source = null;
        for (const candidate of candidateSources(s, target, baseDirs)) {
          if (await pathExists(candidate)) {
            source = candidate;
            break;
          }
        }

        if (source) {
          await moveFolder(source, target);
          result.renamed++;
        } else {
          await ensureFolder(target);
          result.created++;
        }
      }

      // Save the path in the database if it is different
      if (!s.folder_path || !samePath(s.folder_path, target)) {
        result.updates.push({ student_id: s.student_id, folder_path: target });
      }
    } catch (error) {
      console.error("Sync error:", label, error);
      result.failed.push({
        student_id: label,
        reason: error.code || error.message,
      });
    }
  }

  console.log(
    `  sync done: ${result.created} created, ${result.renamed} moved/renamed, ` +
      `${result.existing} existing, ${result.skipped.length} skipped, ` +
      `${result.failed.length} failed, ${result.updates.length} paths to save`
  );

  return res.json(result);
});

// ------------------------------------------------------------
// Start
// ------------------------------------------------------------
const server = app.listen(PORT, "127.0.0.1", async () => {
  try {
    await fs.mkdir(BASE_FOLDER, { recursive: true });
  } catch (error) {
    console.error(
      `\nCould not create ${BASE_FOLDER}: ${error.code || error.message}\n` +
        `Create the folder by hand, or run as administrator once.\n`
    );
    process.exit(1);
  }

  console.log(`Student folder server v${VERSION} running at http://127.0.0.1:${PORT}`);
  console.log(`Layout: ${BASE_FOLDER}\\<College>\\<ID>_<Name>\\<document_type>`);
  if (LEGACY_ROOTS.length) {
    console.log(`Old folders will be moved from: ${LEGACY_ROOTS.join(", ")}`);
  }
  console.log("Waiting for requests from the app...");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use. An OLD copy of the server is still running.\n` +
        `Close it, or run start-folder-server.bat, then try again.\n`
    );
  } else {
    console.error("Server error:", error);
  }
  process.exit(1);
});