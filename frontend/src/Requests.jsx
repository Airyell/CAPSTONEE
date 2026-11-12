import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient"; 
import { logActivity } from "./activityLog"; // ADDED
import { authHeaders } from "./rbac"; // ADDED: sends the login token to Laravel
import "./styles/Requests.css";

const PAGE_SIZE = 10;

// ADDED: Laravel API (same default as rbac.js / Login.jsx)
const API_BASE =
  import.meta.env?.VITE_API_BASE_URL || "https://regisscan.onrender.com/api";


function deriveStatus(docs) {
  if (docs.length === 0) return "Pending";
  if (docs.every(d => d.status === "Rejected")) return "Rejected";
  if (docs.every(d => d.status === "Completed" || d.status === "Rejected")) return "Completed";
  return "Pending";
}

function deriveRemarks(docs) {
  const pending = docs.filter(d => d.status !== "Completed" && d.status !== "Rejected");
  if (pending.length === 0) {
    if (docs.length > 0 && docs.every(d => d.status === "Rejected")) return "Request rejected";
    return "Ready for claiming";
  }
  return pending.map(d => `${d.name}: ${d.status || "Pending"}`).join(", ");
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}


function isDocDue(doc) {
  if (!doc.dueDate) return false;
  if (doc.status === "Completed" || doc.status === "Rejected") return false;
  return doc.dueDate <= todayStr();
}

function isDocOverdue(doc) {
  if (!doc.dueDate) return false;
  if (doc.status === "Completed" || doc.status === "Rejected") return false;
  return doc.dueDate < todayStr();
}

function isDocDueToday(doc) {
  if (!doc.dueDate) return false;
  if (doc.status === "Completed" || doc.status === "Rejected") return false;
  return String(doc.dueDate).slice(0, 10) === todayStr();
}

function earliestDueDate(docs) {
  const dates = docs.map(d => d.dueDate).filter(Boolean).sort();
  return dates[0] || null;
}

// ADDED: helpers for the "Filter by due" dropdown
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function matchesDueFilter(request, filter) {
  if (!filter) return true;
  const today = todayStr();
  // Only documents still waiting to be released count as "due"
  const active = request.docs.filter(d => d.status !== "Completed" && d.status !== "Rejected");
  const dates = active.map(d => d.dueDate).filter(Boolean).map(d => String(d).slice(0, 10));

  if (filter === "none") return active.some(d => !d.dueDate);

  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const endThisWeek = addDays(today, (7 - dow) % 7);      // this Sunday
  const startNextWeek = addDays(endThisWeek, 1);          // next Monday
  const endNextWeek = addDays(endThisWeek, 7);            // next Sunday
  const [y, m] = today.split("-").map(Number);
  const endThisMonth = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  switch (filter) {
    case "overdue":  return dates.some(d => d < today);
    case "today":    return dates.some(d => d === today);
    case "week":     return dates.some(d => d >= today && d <= endThisWeek);
    case "nextweek": return dates.some(d => d >= startNextWeek && d <= endNextWeek);
    case "month":    return dates.some(d => d >= today && d <= endThisMonth);
    default:         return true;
  }
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toISOString().slice(0, 10);
}

function parseTimestamp(value) {
  if (!value) return null;
  const s = String(value).replace(" ", "T");
  const hasZone = /([zZ]|[+-]\d{2}(:?\d{2})?)$/.test(s);
  return new Date(hasZone ? s : s + "Z");
}

function formatDateTime(value) {
  const d = parseTimestamp(value);
  if (!d) return "—";
  return d.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// CHANGED: uses the year of the request itself (same as the Laravel email),
// so the ID shown here always matches the ID in the email.
function formatRequestId(id, dateRequest) {
  const parsed = dateRequest ? new Date(dateRequest) : null;
  const year =
    parsed && !isNaN(parsed.getTime()) ? parsed.getFullYear() : new Date().getFullYear();
  return `REQ-${year}-${String(id).padStart(3, "0")}`;
}

function studentFullName(student) {
  if (!student) return "Unknown Student";
  const { first_name, middle_name, last_name } = student;
  return [first_name, middle_name, last_name].filter(Boolean).join(" ");
}

const yearLevelMap = {
  1: "1st Year", 2: "2nd Year", 3: "3rd Year", 4: "4th Year", 5: "5th Year",
};

function yearLevelLabel(value) {
  if (value === null || value === undefined || value === "") return null;
  return yearLevelMap[value] || String(value);
}

function yesNo(value) {
  if (value === null || value === undefined) return "—";
  return value ? "Yes" : "No";
}

const statusClass = (status) => {
  switch (status) {
    case "Pending": return "req-status-pending";
    case "Completed": return "req-status-completed";
    case "Rejected": return "req-status-cancelled";
    default: return "req-status-pending";
  }
};


function DetailRow({ label, value }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </span>
      <span className="text-sm text-gray-800">{value}</span>
    </div>
  );
}

const formLabel = "block text-xs font-bold text-[#0A2342] uppercase tracking-widest mb-1.5";

function FormSection({ title, children }) {
  return (
    <div className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-6">
      {title && <p className="mb-4 text-sm font-black text-[#0A2342]">{title}</p>}
      {children}
    </div>
  );
}

function FormField({ label, value, className = "" }) {
  return (
    <div className={className}>
      <label className={formLabel}>{label}</label>
      <div className="min-h-[46px] w-full whitespace-pre-wrap rounded-lg border border-gray-300 bg-white p-3 text-sm text-gray-800">
        {value || "—"}
      </div>
    </div>
  );
}

function YesNoField({ label, value, children }) {
  return (
    <FormSection title={label}>
      <div className="flex items-center gap-6">
        {[["Yes", true], ["No", false]].map(([text, val]) => (
          <label key={text} className="flex items-center gap-2 text-sm font-semibold text-[#0A2342]">
            <input type="checkbox" checked={value === val} disabled readOnly className="h-4 w-4 accent-[#D4A017]" />
            {text}
          </label>
        ))}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </FormSection>
  );
}

// ADDED: modal that opens after clicking "Reject Request".
// The email field is auto-filled with the student's email; staff can still edit it.
function RejectEmailModal({ request, sending, errorMessage, onBack, onSend }) {
  const [email, setEmail] = useState(request.email || "");
  const [reason, setReason] = useState("");

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSend = emailOk && reason.trim() !== "" && !sending;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4"
      onClick={(e) => {
        e.stopPropagation();
        if (!sending) onBack();
      }}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-100 px-6 py-4">
          <h3 className="text-base font-semibold text-[#1f1d70]">
            Reject {request.displayId}
          </h3>
          <p className="text-xs text-gray-500">
            The student will be notified by email.
          </p>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              To
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={sending}
              placeholder="student@email.com"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:border-[#1f1d70] focus:outline-none disabled:opacity-50"
            />
            {email.trim() !== "" && !emailOk && (
              <p className="mt-1 text-xs text-red-600">Enter a valid email address.</p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Subject
            </label>
            <input
              type="text"
              value={`Your document request ${request.displayId} was rejected`}
              disabled
              readOnly
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Reason for rejection
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              disabled={sending}
              autoFocus
              placeholder="e.g. Missing requirement: Form 137 (Permanent Record)."
              className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:border-[#1f1d70] focus:outline-none disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-gray-400">
              This message will appear in the email. Please write it in a formal tone.
              No need to include a greeting such as &quot;Dear ...&quot;.
            </p>
          </div>

          {errorMessage && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <button
            onClick={onBack}
            disabled={sending}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-gray-200 bg-white px-4 text-xs font-semibold text-gray-600 shadow-sm transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Back
          </button>
          <button
            onClick={() => onSend(reason.trim(), email.trim())}
            disabled={!canSend}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-red-200 bg-white px-4 text-xs font-semibold text-red-600 shadow-sm transition hover:border-red-400 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Sending…" : "Reject & Send Email"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RequestDetailsModal({ request, onClose, onSetDueDate, onCancel, cancelling }) {
  // CHANGED: opens the reject + email modal instead of an inline reason field
  const [showReason, setShowReason] = useState(false);
  const [rejectError, setRejectError] = useState("");
  const [notice, setNotice] = useState(null); // { ok, text } shown after rejecting

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== "Escape") return;
      if (showReason) {
        if (!cancelling) setShowReason(false);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, showReason, cancelling]);

  if (!request) return null;
  const r = request;

  const handleSend = async (reason, email) => {
    setRejectError("");
    const result = await onCancel(r.id, reason, email);

    if (result?.saved) {
      setShowReason(false);
      setNotice({ ok: !!result.emailSent, text: result.message });
    } else {
      // Keep the modal open so staff can try again
      setRejectError(result?.message || "Could not reject the request.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white shadow-xl [scrollbar-gutter:stable_both-edges]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-100 px-8 py-6">
          <div>
            <h3 className="text-lg font-semibold text-[#1f1d70]">{r.displayId}</h3>
            <p className="text-sm text-gray-500">{r.studentName} · ID {r.studentId}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={statusClass(r.status)}>{r.status}</span>
            <button
              onClick={onClose}
              aria-label="Close"
              className="ml-2 flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-8 py-6">
          {/* Requested documents */}
          <div className="mb-4">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Requested Documents
            </span>
            <div className="mt-2 flex flex-col gap-2">
              {r.docs.length === 0 ? (
                <span className="text-sm text-gray-500">No documents on this request.</span>
              ) : (
                r.docs.map(doc => {
                  const overdue = isDocOverdue(doc);
                  const dueSoon = !overdue && isDocDue(doc);
                  return (
                    <div
                      key={doc.requestDocumentId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-100 px-3 py-2"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-gray-800">{doc.name}</span>
                        <span className="text-xs text-gray-500">{doc.status || "Pending"}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {overdue && (
                          <span className="text-[11px] font-semibold text-red-600">Overdue</span>
                        )}
                        {dueSoon && !overdue && (
                          <span className="text-[11px] font-semibold text-amber-600">Due today</span>
                        )}
                        <label className="flex items-center gap-1.5 text-xs text-gray-500">
                          Due
                          <input
                            type="date"
                            value={doc.dueDate || ""}
                            onChange={(e) =>
                              onSetDueDate(request.id, doc.requestDocumentId, e.target.value)
                            }
                            className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 focus:border-[#1f1d70] focus:outline-none"
                          />
                        </label>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* ── Student's submitted form (read-only) ── */}
          <div className="mb-5 mt-8">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-[#D4A017]">
              Submitted · {formatDateTime(r.requestDate)}
            </p>
            <h4 className="text-lg font-black text-[#1f1d70]">Request Form</h4>
          </div>

          <FormSection>
            <FormField label="Contact Number" value={r.contactNumber} />
          </FormSection>

          <YesNoField label="Are you a graduate?" value={r.isGraduate}>
            {r.isGraduate === true && (
              <FormField label="Year of Graduation" value={r.graduateYear} />
            )}
            {r.isGraduate === false && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <FormField label="Last Semester" value={r.lastSemester} />
                <FormField label="S.Y. Start" value={r.lastSyStart} />
                <FormField label="S.Y. End" value={r.lastSyEnd} />
              </div>
            )}
          </YesNoField>

          <YesNoField label="Have you previously requested credentials?" value={r.requestedBefore}>
            {r.requestedBefore === true && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label="Credential" value={r.previousCredential} />
                <FormField label="Date of Request" value={r.previousRequestDate ? formatDate(r.previousRequestDate) : null} />
              </div>
            )}
          </YesNoField>

          <YesNoField label="Cleared?" value={r.isCleared} />


          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <FormField label="Student ID" value={r.studentId} />
            <FormField label="Full Name" value={r.studentName} />
            <FormField label="Email Address" value={r.email} />
            <FormField label="Course" value={r.course} />
            <FormField label="Year Level" value={r.yearLevel} />
            <FormField
              label="Request Type"
              value={r.docs.map(d => d.name).join(", ")}
              className="sm:col-span-2"
            />

            {r.agency && (
              <FormField
                label="Requesting Agency"
                value={r.agency === "Other" ? (r.agencyOther || "Other") : r.agency}
                className="sm:col-span-2"
              />
            )}
            {r.certificationType && (
              <FormField
                label="Certification Type"
                value={r.certificationType === "Others" ? (r.certificationOther || "Others") : r.certificationType}
                className="sm:col-span-2"
              />
            )}
            {(r.subjectSemester || r.subjectSyStart || r.subjectSyEnd) && (
              <div className="grid grid-cols-1 gap-3 sm:col-span-2 sm:grid-cols-3">
                <FormField label="Semester" value={r.subjectSemester} />
                <FormField label="S.Y. Start" value={r.subjectSyStart} />
                <FormField label="S.Y. End" value={r.subjectSyEnd} />
              </div>
            )}

            <FormField label="Purpose of Request" value={r.purpose} className="sm:col-span-2" />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 px-8 py-5">
          {/* Result of the last reject / email attempt */}
          {notice && (
            <p
              className={`mb-3 rounded-lg px-3 py-2 text-xs ${
                notice.ok
                  ? "bg-green-50 text-green-700"
                  : "bg-amber-50 text-amber-800"
              }`}
            >
              {notice.text}
            </p>
          )}

          <div className="flex justify-end gap-2">
            {r.status === "Pending" && (
              <button
                onClick={() => {
                  setRejectError("");
                  setNotice(null);
                  setShowReason(true);
                }}
                disabled={cancelling}
                className="inline-flex h-9 items-center justify-center rounded-lg border border-red-200 bg-white px-4 text-xs font-semibold text-red-600 shadow-sm transition hover:border-red-400 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Reject Request
              </button>
            )}
            <button
              onClick={onClose}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-gray-200 bg-white px-4 text-xs font-semibold text-[#1f1d70] shadow-sm transition hover:border-[#1f1d70] hover:bg-[#f7f7fc]"
            >
              Close
            </button>
          </div>

          {r.status === "Pending" && showReason && (
            <RejectEmailModal
              request={r}
              sending={cancelling}
              errorMessage={rejectError}
              onBack={() => setShowReason(false)}
              onSend={handleSend}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default function Requests() {
  const [rawRequests, setRawRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterDue, setFilterDue] = useState(""); // ADDED
  const [page, setPage] = useState(1);
  const [updatingId, setUpdatingId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  // Debounce ref for the realtime-triggered refetch below.
  const refetchTimeoutRef = useRef(null);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);

    
    const { data, error: fetchError } = await supabase
      .from("tbl_request")
      .select(`
        request_id,
        student_id,
        date_request,
        purpose,
        contact_number,
        is_graduate,
        graduate_year,
        last_semester,
        last_sy_start,
        last_sy_end,
        requested_before,
        previous_credential,
        previous_request_date,
        is_cleared,
        agency,
        agency_other,
        certification_type,
        certification_other,
        subject_semester,
        subject_sy_start,
        subject_sy_end,
        student:tbl_student (
          student_id,
          first_name,
          middle_name,
          last_name,
          email,
          year_level,
          program:tbl_program ( program_name )
        ),
        documents:tbl_request_document (
          request_document_id,
          status,
          due_date,
          document:tbl_documents ( document_id, document_name )
        )
      `)
      .order("date_request", { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }

    setRawRequests(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // ============================================================
  // REALTIME: reflect changes made anywhere else (another staff
  // member completing a request, the public-facing request form
  // creating a new one, a due date being set from another tab).
  //
  // Because each row here is built from a request joined with its
  // student and multiple request-document rows, patching individual
  // fields from a raw realtime payload would mean re-deriving that
  // join by hand. Instead, any change to either tbl_request or
  // tbl_request_document simply triggers a debounced refetch of the
  // full list via fetchRequests() — simple and always consistent,
  // and cheap enough for a request queue of this size. The debounce
  // (400ms) coalesces bursts of events (e.g. a request plus several
  // of its documents changing together) into a single refetch.
  //
  // Requires realtime to be enabled for tbl_request and
  // tbl_request_document in Supabase (Database → Replication), and
  // that RLS (if enabled) allows the current user to SELECT the rows
  // involved.
  // ============================================================

  useEffect(() => {
    const scheduleRefetch = () => {
      if (refetchTimeoutRef.current) clearTimeout(refetchTimeoutRef.current);
      refetchTimeoutRef.current = setTimeout(() => {
        fetchRequests();
      }, 400);
    };

    const channel = supabase
      .channel("realtime:tbl_request-and-documents")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tbl_request" },
        scheduleRefetch
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tbl_request_document" },
        scheduleRefetch
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (refetchTimeoutRef.current) clearTimeout(refetchTimeoutRef.current);
    };
  }, [fetchRequests]);

  const requests = useMemo(() => {
    return rawRequests.map(r => {
      const docs = (r.documents || []).map(rd => ({
        requestDocumentId: rd.request_document_id,
        name: rd.document?.document_name || "Document",
        status: rd.status || "Pending",
        dueDate: rd.due_date,
      }));
      return {
        id: r.request_id,
        // CHANGED: pass the request date so the year matches the email
        displayId: formatRequestId(r.request_id, r.date_request),
        studentId: r.student?.student_id ?? r.student_id,
        studentName: studentFullName(r.student),
        email: r.student?.email,
        course: r.student?.program?.program_name,
        yearLevel: yearLevelLabel(r.student?.year_level),
        docs,
        requestDate: r.date_request,
        remarks: deriveRemarks(docs),
        status: deriveStatus(docs),
        dueToday: docs.some(isDocDueToday),
        overdue: docs.some(isDocOverdue),
        earliestDueDate: earliestDueDate(docs),


        purpose: r.purpose,
        contactNumber: r.contact_number,
        isGraduate: r.is_graduate,
        graduateYear: r.graduate_year,
        lastSemester: r.last_semester,
        lastSyStart: r.last_sy_start,
        lastSyEnd: r.last_sy_end,
        requestedBefore: r.requested_before,
        previousCredential: r.previous_credential,
        previousRequestDate: r.previous_request_date,
        isCleared: r.is_cleared,
        agency: r.agency,
        agencyOther: r.agency_other,
        certificationType: r.certification_type,
        certificationOther: r.certification_other,
        subjectSemester: r.subject_semester,
        subjectSyStart: r.subject_sy_start,
        subjectSyEnd: r.subject_sy_end,
      };
    });
  }, [rawRequests]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return requests.filter(r => {
      const matchSearch =
        r.displayId.toLowerCase().includes(q) ||
        r.studentName.toLowerCase().includes(q) ||
        String(r.studentId).includes(search);
      const matchStatus = filterStatus ? r.status === filterStatus : true;
      const matchDue = matchesDueFilter(r, filterDue); // ADDED
      return matchSearch && matchStatus && matchDue;
    });
  }, [requests, search, filterStatus, filterDue]);

  const totalRequests = requests.length;
  const pendingRequests = requests.filter(r => r.status === "Pending").length;
  const dueTodayRequests = requests.filter(r => r.dueToday && r.status === "Pending").length;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [search, filterStatus, filterDue]);

  const handleComplete = async (id) => {
    setUpdatingId(id);
    const request = requests.find(r => r.id === id);
    const idsToComplete = (request?.docs || [])
      .filter(d => d.status !== "Completed" && d.status !== "Rejected")
      .map(d => d.requestDocumentId);

    if (idsToComplete.length > 0) {
      const { error: updateError } = await supabase
        .from("tbl_request_document")
        .update({ status: "Completed" })
        .in("request_document_id", idsToComplete);

      if (updateError) {
        // ADDED: record the failure in Audit Logs
        logActivity({
          type: "Update",
          description: `Failed to complete request ${request?.displayId} (${request?.studentName}): ${updateError.message}`,
          module: "Requests Module",
          status: "failed",
        });
        setError(updateError.message);
        setUpdatingId(null);
        return;
      }

      // ADDED: record in Audit Logs
      logActivity({
        type: "Update",
        description: `Completed request ${request?.displayId} (${request?.studentName})`,
        module: "Requests Module",
      });
    }

    // Reflect the change locally instead of a full refetch. The
    // realtime subscription above will also schedule a refetch from
    // this same write, which just re-confirms the same state.
    setRawRequests(prev =>
      prev.map(r =>
        r.request_id === id
          ? {
              ...r,
              documents: r.documents.map(rd =>
                idsToComplete.includes(rd.request_document_id)
                  ? { ...rd, status: "Completed" }
                  : rd
              ),
            }
          : r
      )
    );
    setUpdatingId(null);
  };

  // CHANGED: takes a rejection reason (saved to tbl_request_document.rejection_reason)
  // and the email typed in the modal, then asks Laravel to email the student.
  // Returns { saved, emailSent, message } so the modal can show the result.
  const handleCancel = async (id, rejectedReason, toEmail) => {
    setUpdatingId(id);
    const request = requests.find(r => r.id === id);
    const idsToCancel = (request?.docs || [])
      .filter(d => d.status !== "Completed" && d.status !== "Rejected")
      .map(d => d.requestDocumentId);

    let outcome = { saved: true, emailSent: false, message: "" };

    if (idsToCancel.length > 0) {
      const { error: updateError } = await supabase
        .from("tbl_request_document")
        .update({ status: "Rejected", rejection_reason: rejectedReason })
        .in("request_document_id", idsToCancel);

      if (updateError) {
        // ADDED: record the failure in Audit Logs
        logActivity({
          type: "Update",
          description: `Failed to reject request ${request?.displayId} (${request?.studentName}): ${updateError.message}`,
          module: "Requests Module",
          status: "failed",
        });
        setError(updateError.message);
        setUpdatingId(null);
        return { saved: false, emailSent: false, message: updateError.message };
      }

      // ADDED: record in Audit Logs
      logActivity({
        type: "Update",
        description: `Rejected request ${request?.displayId} (${request?.studentName})`,
        module: "Requests Module",
      });

      // ADDED: email the student about the rejection
      try {
        const res = await fetch(`${API_BASE}/requests/${id}/notify-rejection`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ email: toEmail }),
        });
        const out = await res.json().catch(() => ({}));

        if (!res.ok) {
          const detail = out.detail
            ? ` (${typeof out.detail === "string" ? out.detail : JSON.stringify(out.detail)})`
            : "";
          throw new Error(
            out.message ? `${out.message}${detail}` : `HTTP ${res.status}`
          );
        }

        logActivity({
          type: "Update",
          description: `Sent rejection email to ${request?.studentName} (${toEmail}) for request ${request?.displayId}`,
          module: "Requests Module",
        });

        outcome = {
          saved: true,
          emailSent: true,
          message: `Request rejected. Email sent to ${toEmail}.`,
        };
      } catch (emailErr) {
        logActivity({
          type: "Update",
          description: `Rejection email failed for request ${request?.displayId}: ${emailErr.message}`,
          module: "Requests Module",
          status: "failed",
        });

        outcome = {
          saved: true,
          emailSent: false,
          message: `Request rejected, but the email was not sent: ${emailErr.message}`,
        };
        setError(outcome.message);
      }
    }

    // Reflect the change locally instead of a full refetch. The
    // realtime subscription above will also schedule a refetch from
    // this same write, which just re-confirms the same state.
    setRawRequests(prev =>
      prev.map(r =>
        r.request_id === id
          ? {
              ...r,
              documents: r.documents.map(rd =>
                idsToCancel.includes(rd.request_document_id)
                  ? { ...rd, status: "Rejected", rejection_reason: rejectedReason }
                  : rd
              ),
            }
          : r
      )
    );
    setUpdatingId(null);
    return outcome;
  };

  const handleSetDueDate = async (requestId, requestDocumentId, dateValue) => {
    const { error: updateError } = await supabase
      .from("tbl_request_document")
      .update({ due_date: dateValue || null })
      .eq("request_document_id", requestDocumentId);

    if (updateError) {
      // ADDED: record the failure in Audit Logs
      const failedRequest = requests.find(r => r.id === requestId);
      logActivity({
        type: "Update",
        description: `Failed to update due date for request ${failedRequest?.displayId}: ${updateError.message}`,
        module: "Requests Module",
        status: "failed",
      });
      setError(updateError.message);
      return;
    }

    // ADDED: record in Audit Logs
    const loggedRequest = requests.find(r => r.id === requestId);
    logActivity({
      type: "Update",
      description: dateValue
        ? `Set due date to ${dateValue} for request ${loggedRequest?.displayId}`
        : `Cleared due date for request ${loggedRequest?.displayId}`,
      module: "Requests Module",
    });

    setRawRequests(prev =>
      prev.map(r =>
        r.request_id === requestId
          ? {
              ...r,
              documents: r.documents.map(rd =>
                rd.request_document_id === requestDocumentId
                  ? { ...rd, due_date: dateValue || null }
                  : rd
              ),
            }
          : r
      )
    );
  };

  const goToPage = (p) => setPage(Math.min(Math.max(1, p), totalPages));

  const selectedRequest = useMemo(
    () => requests.find(r => r.id === selectedId) || null,
    [requests, selectedId]
  );

  return (
    <>
      {/* Header */}
      <div className="req-page-header">
        <div>
          <h2 className="req-page-title">Requests</h2>
          <p className="req-page-sub">Document request management</p>
        </div>
      </div>

      {error && (
        <div className="req-error-banner">
          {error} <button onClick={fetchRequests}>Retry</button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="req-summary-grid">
        <div className="req-summary-card">
          <p className="req-summary-label">Total Requests</p>
          <p className="req-summary-value">{totalRequests}</p>
          <div className="req-summary-accent" />
        </div>
        <div className="req-summary-card">
          <p className="req-summary-label">Pending Requests</p>
          <p className="req-summary-value">{pendingRequests}</p>
          <div className="req-summary-accent" />
        </div>
        <div className="req-summary-card-gold">
          <p className="req-summary-label-gold">Due Today</p>
          <p className="req-summary-value-white">{dueTodayRequests}</p>
          <div className="req-summary-accent-white" />
        </div>
      </div>

      {/* Filter Bar */}
      <div className="req-filter-bar">
        <input
          type="text"
          placeholder="Search by request ID, student name or ID..."
          className="req-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="req-select"
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
        >
          <option value="">All Status</option>
          <option value="Pending">Pending</option>
          <option value="Completed">Completed</option>
          <option value="Rejected">Rejected</option>
        </select>
        {/* ADDED: filter by due date */}
        <select
          className="req-select"
          value={filterDue}
          onChange={e => setFilterDue(e.target.value)}
        >
          <option value="">All Due Dates</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due Today</option>
          <option value="week">Due This Week</option>
          <option value="nextweek">Due Next Week</option>
          <option value="month">Due This Month</option>
          <option value="none">No Due Date</option>
        </select>
      </div>

      {/* Table (scrolls horizontally on smaller screens) */}
      <div
        className="req-table-wrapper"
        style={{ overflowX: "auto", maxWidth: "100%" }}
      >
        <table className="req-table" style={{ minWidth: "1100px" }}>
          <thead>
            <tr className="req-thead">
              <th className="req-th-first">Request ID</th>
              <th className="req-th">Student ID</th>
              <th className="req-th">Student Name</th>
              <th className="req-th">Requested Docs</th>
              <th className="req-th">Request Date</th>
              <th className="req-th">Due Date</th>
              <th className="req-th">Remarks</th>
              <th className="req-th">Status</th>
              <th className="req-th">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="req-empty">Loading requests…</td>
              </tr>
            ) : paged.length === 0 ? (
              <tr>
                <td colSpan={9} className="req-empty">No requests found.</td>
              </tr>
            ) : (
              paged.map((r, i) => (
                <tr
                  key={r.id}
                  className={`cursor-pointer ${i % 2 === 0 ? "req-row-even" : "req-row-odd"}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <td className="req-td-first">{r.displayId}</td>
                  <td className="req-td-id">{r.studentId}</td>
                  <td className="req-td-name">{r.studentName}</td>
                  <td className="req-td-docs">
                    {r.docs.map(doc => (
                      <span key={doc.requestDocumentId} className="req-doc-tag">{doc.name}</span>
                    ))}
                  </td>
                  <td className="req-td">{formatDate(r.requestDate)}</td>
                  <td className="req-td">{r.earliestDueDate ? formatDate(r.earliestDueDate) : "—"}</td>
                  <td className="req-td-remarks">{r.remarks}</td>
                  <td className="req-td">
                    <span className={statusClass(r.status)}>{r.status}</span>
                  </td>
                  <td className="req-td" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2">
                      
                      {r.status === "Pending" ? (
                        <button
                          className="req-complete-btn"
                          disabled={updatingId === r.id}
                          onClick={() => handleComplete(r.id)}
                        >
                          {updatingId === r.id ? "Saving…" : "Complete"}
                        </button>
                      ) : (
                        <span className="req-completed-label">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {!loading && filtered.length > 0 && (
        <div className="mt-4 flex flex-col gap-3 border-t border-gray-100 px-1 pt-4 sm:flex-row sm:items-center sm:justify-between">

          {/* Pagination Info */}
          <span className="text-xs font-medium text-gray-500">
            Showing{" "}
            <span className="font-semibold text-[#1f1d70]">
              {(currentPage - 1) * PAGE_SIZE + 1}
            </span>
            {" "}–{" "}
            <span className="font-semibold text-[#1f1d70]">
              {Math.min(currentPage * PAGE_SIZE, filtered.length)}
            </span>
            {" "}of{" "}
            <span className="font-semibold text-[#1f1d70]">
              {filtered.length}
            </span>
          </span>

          {/* Pagination Controls */}
          <div className="flex items-center gap-1.5">
            {/* Previous */}
            <button
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage === 1}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-gray-200 bg-white px-3 text-xs font-semibold text-[#1f1d70] shadow-sm transition-all duration-200 hover:border-[#1f1d70] hover:bg-[#f7f7fc] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-200 disabled:hover:bg-white"
            >
              Prev
            </button>

            {/* Current page number only (changes as you go Prev/Next) */}
            <span className="inline-flex h-9 min-w-9 items-center justify-center rounded-lg border border-[#1f1d70] bg-[#1f1d70] px-3 text-xs font-semibold text-white shadow-sm">
              {currentPage}
            </span>

            {/* Next */}
            <button
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-gray-200 bg-white px-3 text-xs font-semibold text-[#1f1d70] shadow-sm transition-all duration-200 hover:border-[#1f1d70] hover:bg-[#f7f7fc] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-200 disabled:hover:bg-white"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {selectedRequest && (
        <RequestDetailsModal
          request={selectedRequest}
          onClose={() => setSelectedId(null)}
          onSetDueDate={handleSetDueDate}
          onCancel={handleCancel}
          cancelling={updatingId === selectedRequest.id}
        />
      )}
    </>
  );
}