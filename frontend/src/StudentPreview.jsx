import { useState, useEffect } from "react";
import axios from "axios";
import { supabase } from "./supabaseClient";

const requestTypes = [
  { label: "Authentication (₱5/page)", value: "Authentication", price: 5 },
  { label: "CAV Certification (₱125)", value: "CAV Certification", price: 125 },
  { label: "Certification (₱80)", value: "Certification", price: 80 },
  { label: "Correction of Name (₱100)", value: "Correction of Name", price: 100 },
  { label: "Diploma Replacement (₱100)", value: "Diploma Replacement", price: 100 },
  { label: "Evaluation (₱50)", value: "Evaluation", price: 50 },
  { label: "Form 137 (₱100)", value: "Form 137", price: 100 },
  { label: "Honorable Dismissal (₱100)", value: "Honorable Dismissal", price: 100 },
  { label: "Permit to Study (₱100)", value: "Permit to Study", price: 100 },
  { label: "Transcript of Records (₱125/page)", value: "Transcript of Records", price: 125 },
];

const credentialChoices = [
  "Authentication", "CAV Certification", "Certification", "Correction of Name",
  "Diploma Replacement", "Evaluation", "Form 137", "Honorable Dismissal",
  "Permit to Study", "Transcript of Records",
];

const cavChoices = ["BFP", "BJMP", "CHED", "DEP-ED", "DFA", "PNP", "POEA"];

const certificationChoices = [
  "Authorization Letter", "CAR", "Earned Units", "Endorsement",
  "English: Medium of Instruction", "GPA", "Grading System", "Graduated",
  "Letter of No Objection", "Officially Enrolled", "Subjects Enrolled",
  "Subjects with Grade", "USTP Conversion", "Others",
];

// ── Backend config (unchanged) ───────────────────────────────────
const documentIdMap = {
  "Authentication":        1,
  "CAV Certification":     2,
  "Certification":         3,
  "Correction of Name":    4,
  "Diploma Replacement":   5,
  "Evaluation":            6,
  "Form 137":              7,
  "Honorable Dismissal":   8,
  "Permit to Study":       9,
  "Transcript of Records": 10,
};

const yearLevelMap = {
  1: "1st Year", 2: "2nd Year", 3: "3rd Year", 4: "4th Year", 5: "5th Year",
};

// ADDED: USTP e-Clearance site (update this URL if the official address differs)
const ECLEARANCE_URL = "https://clearance.ustp.edu.ph/";

// ── Release date formatter ───────────────────────────────────────
const formatReleaseDate = (d) => {
  if (!d) return "To be announced";
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  if (!y || !m || !day) return "To be announced";
  return new Date(y, m - 1, day).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
};

export default function StudentPreview({ onBack }) {
  // ── Search state ─────────────────────────────────────────────
  const [studentId, setStudentId] = useState("");
  const [requests,  setRequests]  = useState([]);
  const [showForm,  setShowForm]  = useState(false);

  // ── Two-step flow ─────────────────────────────────────────────
  const [step, setStep] = useState("pre"); // "pre" | "main"

  // ── Pre-form state + validation ───────────────────────────────
  const [preForm, setPreForm] = useState({
    contactNumber: "",
    isGraduate: null,
    graduateYear: "",
    lastSem: "",
    lastSY1: "",
    lastSY2: "",
    requestedBefore: null,
    previousCredential: "",
    previousRequestDate: "",
    isCleared: null,
  });
  const [preErrors, setPreErrors] = useState({});

  // ADDED: controls the "settle your clearance" pop up
  const [showClearancePopup, setShowClearancePopup] = useState(false);

  // ── Main form state ──────────────────────────────────────────
  const [formStudentId, setFormStudentId] = useState("");
  const [fullName,      setFullName]      = useState("");
  const [email,         setEmail]         = useState("");
  const [course,        setCourse]        = useState("");
  const [yearLevel,     setYearLevel]     = useState("");
  const [purpose,       setPurpose]       = useState("");

  const [requestType, setRequestType] = useState("");
  const [cavChoice,   setCavChoice]   = useState("");
  const [cavOther,    setCavOther]    = useState("");
  const [certChoice,  setCertChoice]  = useState("");
  const [certOther,   setCertOther]   = useState("");
  const [subjectSem,  setSubjectSem]  = useState("");
  const [subjectSY1,  setSubjectSY1]  = useState("");
  const [subjectSY2,  setSubjectSY2]  = useState("");

  const [mainErrors, setMainErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

    // Back-to-top button: only shows after scrolling down
  const [showTopBtn, setShowTopBtn] = useState(false);

  useEffect(() => {
    const onScroll = () => setShowTopBtn(window.scrollY > 300);
    onScroll();
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  // ── Style helpers (validation-aware) ─────────────────────────
  const inputClass = (hasError) =>
    `border ${hasError ? "border-red-400 bg-red-50" : "border-gray-300"} p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#D4A017] text-sm w-full`;
  const selectClass = (hasError) =>
    `w-full border ${hasError ? "border-red-400 bg-red-50" : "border-gray-300"} p-3 rounded-lg appearance-none focus:outline-none focus:ring-2 focus:ring-[#D4A017] text-sm bg-white`;
  const labelClass = "block text-xs font-bold text-[#0A2342] uppercase tracking-widest mb-1.5";
  const sectionClass = "bg-gray-50 border border-gray-200 rounded-xl p-5 mb-5";

  const Req = () => <span className="text-[#D4A017] ml-0.5">*</span>;
  const ErrMsg = ({ show }) => show
    ? <p className="text-xs text-red-500 mt-1 font-semibold">This field is required.</p>
    : null;

  // ── Pre-form helpers ──────────────────────────────────────────
  const handlePreFormChange = (field, value) => {
    setPreForm(prev => ({ ...prev, [field]: value }));
    setPreErrors(prev => ({ ...prev, [field]: false }));
  };

  // ADDED: choosing "No" on Cleared opens the pop up; choosing "Yes" closes it
  const handleClearedChange = (value) => {
    const newValue = preForm.isCleared === value ? null : value;
    handlePreFormChange("isCleared", newValue);
    setShowClearancePopup(newValue === false);
  };

  const validatePreForm = () => {
    const e = {};
    if (!preForm.contactNumber.trim()) e.contactNumber = true;
    if (preForm.isGraduate === null) e.isGraduate = true;
    if (preForm.isGraduate === true && !preForm.graduateYear.trim()) e.graduateYear = true;
    if (preForm.isGraduate === false && !preForm.lastSem) e.lastSem = true;
    if (preForm.isGraduate === false && !preForm.lastSY1.trim()) e.lastSY1 = true;
    if (preForm.isGraduate === false && !preForm.lastSY2.trim()) e.lastSY2 = true;
    if (preForm.requestedBefore === null) e.requestedBefore = true;
    if (preForm.requestedBefore === true && !preForm.previousCredential) e.previousCredential = true;
    if (preForm.requestedBefore === true && !preForm.previousRequestDate) e.previousRequestDate = true;
    if (preForm.isCleared === null) e.isCleared = true;
    return e;
  };

  const handleProceed = () => {
    // ADDED: not cleared → block proceeding and show the pop up again
    if (preForm.isCleared === false) {
      setShowClearancePopup(true);
      return;
    }
    const e = validatePreForm();
    if (Object.keys(e).length > 0) { setPreErrors(e); return; }
    setPreErrors({});
    setStep("main");
  };

  // ── Reset (includes pre-form + step) ─────────────────────────
  const resetForm = () => {
    setFormStudentId(""); setFullName(""); setEmail("");
    setCourse(""); setYearLevel(""); setPurpose("");
    setRequestType("");
    setCavChoice(""); setCavOther("");
    setCertChoice(""); setCertOther("");
    setSubjectSem(""); setSubjectSY1(""); setSubjectSY2("");
    setMainErrors({});
    setPreForm({
      contactNumber: "",
      isGraduate: null,
      graduateYear: "",
      lastSem: "",
      lastSY1: "",
      lastSY2: "",
      requestedBefore: null,
      previousCredential: "",
      previousRequestDate: "",
      isCleared: null,
    });
    setPreErrors({});
    setShowClearancePopup(false); // ADDED
    setStep("pre");
  };

  // ── Search requests ──────────────────────────────────────────
  const searchRequest = async () => {
    if (!studentId.trim()) return;
    const { data, error } = await supabase
      .from("tbl_request")
      .select(`
        request_id,
        student_id,
        date_request,
        main_doc:tbl_documents!fk_request_document ( document_name ),
        documents:tbl_request_document (
          request_document_id,
          status,
          due_date,
          rejection_reason,
          document:tbl_documents ( document_name )
        )
      `)
      .eq("student_id", Number(studentId))
      .order("date_request", { ascending: false });

    if (error) {
      console.error(error);
      alert("Could not fetch requests: " + error.message);
      return;
    }

    const rows = [];
    (data || []).forEach(r => {
      if (r.documents && r.documents.length > 0) {
        r.documents.forEach(rd => {
          rows.push({
            key: `${r.request_id}-${rd.request_document_id}`,
            student_id: r.student_id,
            date_request: r.date_request,
            document_name: rd.document?.document_name ?? r.main_doc?.document_name ?? "Document",
            status: rd.status || "Pending",
            due_date: rd.due_date,
            rejection_reason: rd.rejection_reason,
          });
        });
      } else {
        rows.push({
          key: `${r.request_id}`,
          student_id: r.student_id,
          date_request: r.date_request,
          document_name: r.main_doc?.document_name ?? "Document",
          status: "Pending",
          due_date: null,
          rejection_reason: null,
        });
      }
    });
    setRequests(rows);
  };

  // ── Validation for the main request form ─────────────────────
  const validateMainForm = () => {
    const e = {};
    if (!formStudentId.trim()) e.studentId = true;
    if (!fullName.trim()) e.fullName = true;
    if (!email.trim()) e.email = true;
    if (!course.trim()) e.course = true;
    if (!yearLevel) e.yearLevel = true;
    if (!requestType) e.requestType = true;
    if (!purpose.trim()) e.purpose = true;
    if (requestType === "CAV Certification" && !cavChoice) e.cavChoice = true;
    if (requestType === "CAV Certification" && cavChoice === "Other" && !cavOther.trim()) e.cavOther = true;
    if (requestType === "Certification" && !certChoice) e.certChoice = true;
    if (requestType === "Certification" && certChoice === "Others" && !certOther.trim()) e.certOther = true;
    if (
      (requestType === "Certification" && (certChoice === "Subjects with Grade" || certChoice === "Subjects Enrolled")) ||
      requestType === "Transcript of Records"
    ) {
      if (!subjectSem.trim()) e.subjectSem = true;
      if (!subjectSY1.trim()) e.subjectSY1 = true;
      if (!subjectSY2.trim()) e.subjectSY2 = true;
    }
    return e;
  };

  // ── Submit request ───────────────────────────────────────────
  const submitRequest = async () => {
    // ADDED: safety net — never submit if the student is not cleared
    if (preForm.isCleared !== true) {
      setStep("pre");
      setShowClearancePopup(true);
      return;
    }

    const e = validateMainForm();
    if (Object.keys(e).length > 0) { setMainErrors(e); return; }
    setMainErrors({});

    if (!formStudentId.trim()) return alert("Please enter a Student ID.");
    if (!purpose.trim())       return alert("Please state the purpose of your request.");

    const docId = documentIdMap[requestType];
    if (!docId) return alert("Unknown request type.");

    const data = {
      student_id:  parseInt(formStudentId, 10),
      document_id: docId,
      documents:   [docId],
      purpose:     purpose,
      contact_number:         preForm.contactNumber || null,
      is_graduate:            preForm.isGraduate,
      graduate_year:          preForm.graduateYear || null,
      last_semester:          preForm.lastSem || null,
      last_sy_start:          preForm.lastSY1 || null,
      last_sy_end:            preForm.lastSY2 || null,
      requested_before:       preForm.requestedBefore,
      previous_credential:    preForm.previousCredential || null,
      previous_request_date:  preForm.previousRequestDate || null,
      is_cleared:             preForm.isCleared,
      agency:                 cavChoice || null,
      agency_other:           cavOther || null,
      certification_type:     certChoice || null,
      certification_other:    certOther || null,
      subject_semester:       subjectSem || null,
      subject_sy_start:       subjectSY1 || null,
      subject_sy_end:         subjectSY2 || null,
    };

    setSubmitting(true);
    try {
      await axios.post("/api/request", data);
      alert("Request submitted successfully!");
      resetForm();
      setShowForm(false);
      if (studentId === formStudentId) searchRequest();
    } catch (error) {
      console.error(error.response?.data ?? error.message);
      alert("Error: " + (error.response?.data?.message ?? "Something went wrong"));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Derived ───────────────────────────────────────────────────
  const studentRequests = requests.filter(
    r => String(r.student_id) === String(studentId)
  );
  const notCleared = preForm.isCleared === false; // ADDED

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-100 px-6 py-12">

      {/* ── RESPONSIVE STYLES ── */}
      <style>{`
        /* Phones (below 640px) */
        @media (max-width: 639px) {
          .min-h-screen.px-6.py-12 { padding: 1.5rem 1rem; }
          .rounded-2xl.p-8 { padding: 1.25rem; }
          .rounded-2xl.p-6 { padding: 1rem; }
          .rounded-2xl.p-5 { padding: 1rem; }
          .section-fix, .bg-gray-50.rounded-xl.p-5 { padding: 1rem; }

          h1.text-4xl { font-size: 1.75rem; line-height: 2.25rem; margin-bottom: 1.5rem; }

          .grid.grid-cols-3,
          .grid.grid-cols-2 { grid-template-columns: 1fr; }

          .flex.gap-3 { flex-direction: column; }
          .flex.gap-3 > input { flex: none; width: 100%; }
          .flex.gap-3 > button { width: 100%; }

          .flex.justify-between.items-center {
            flex-direction: column;
            align-items: flex-start;
            gap: 0.75rem;
          }

          .justify-end > button,
          button.mt-6 { width: 100%; }

          .flex.items-center.gap-6 { flex-wrap: wrap; gap: 1rem; }
        }

        /* Tablets (640px to 1023px) */
        @media (min-width: 640px) and (max-width: 1023px) {
          .min-h-screen.px-6.py-12 { padding: 2rem 1.5rem; }
          h1.text-4xl { font-size: 2.25rem; }
        }

        html, body { overflow-x: hidden; }
        input, select, textarea { max-width: 100%; }
      `}</style>

      {/* ── ADDED: CLEARANCE POP UP ── */}
      {showClearancePopup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="clearance-title"
        >
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-7 text-center">
            <div className="mx-auto mb-4 w-14 h-14 rounded-full bg-red-100 flex items-center justify-center text-2xl">
              ⚠️
            </div>
            <h3 id="clearance-title" className="text-xl font-black text-[#0A2342] mb-2 tracking-tight">
              Clearance Required
            </h3>
            <p className="text-sm text-gray-600 mb-6">
              You must settle your clearance in the USTP e-Clearance site before you can request a document.
            </p>
            <div className="flex flex-col gap-3">
              <a
                href={ECLEARANCE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-[#0A2342] hover:bg-[#081b34] text-white px-6 py-3 rounded-xl font-semibold text-sm transition"
              >
                Go to USTP e-Clearance
              </a>
              <button
                onClick={() => setShowClearancePopup(false)}
                className="border border-gray-300 text-[#0A2342] px-6 py-3 rounded-xl font-semibold text-sm hover:bg-gray-50 transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

            {/* Back to top button (shows while the form is open and the page is scrolled) */}
      {showForm && showTopBtn && (
        <button
          onClick={scrollToTop}
          aria-label="Back to top"
          title="Back to top"
          className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-[#D4A017] text-xl font-bold text-white shadow-lg transition hover:bg-[#b8891a] focus:outline-none focus:ring-2 focus:ring-[#0A2342] focus:ring-offset-2"
        >
          ↑
        </button>
      )}

      <div className="max-w-4xl mx-auto">

        {/* Back */}
        {onBack && (
          <button
            onClick={onBack}
            className="mb-6 text-sm font-semibold text-[#0A2342] hover:text-[#D4A017] transition"
          >
            &larr; Back to Login
          </button>
        )}

        {/* Title */}
        <h1 className="text-4xl font-bold text-center text-[#0A2342] mb-10">
          Track Requests
        </h1>

        {/* Search Card */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-md p-6">
          <label className={labelClass}>Student ID</label>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Enter Student ID"
              value={studentId}
              onChange={e => setStudentId(e.target.value)}
              onKeyDown={e => e.key === "Enter" && searchRequest()}
              className="flex-1 border border-gray-300 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#D4A017] text-sm"
            />
            <button
              onClick={searchRequest}
              className="bg-[#0A2342] text-white px-6 py-3 rounded-xl font-semibold hover:bg-[#0d2e57] transition"
            >
              Search
            </button>
          </div>
          <button
            onClick={() => { resetForm(); setShowForm(!showForm); }}
            className="mt-4 text-[#D4A017] font-semibold text-sm hover:underline"
          >
            {showForm ? "— Hide Form" : "+ Submit Request"}
          </button>
        </div>

        {/* ── PRE-FORM ── */}
        {showForm && step === "pre" && (
          <div className="mt-6 bg-white border border-gray-200 rounded-2xl shadow-md p-8">
            <h2 className="text-xl font-black text-[#0A2342] mb-1 tracking-tight">Before You Proceed</h2>
            <p className="text-xs text-gray-400 mb-6 uppercase tracking-widest font-semibold">
              All fields marked <span className="text-[#D4A017]">*</span> are required
            </p>

            {/* Contact Number */}
            <div className={sectionClass}>
              <label className={labelClass}>Contact Number <Req /></label>
              <input
                className={inputClass(preErrors.contactNumber)}
                placeholder="e.g. 09171234567"
                value={preForm.contactNumber}
                onChange={e => handlePreFormChange("contactNumber", e.target.value)}
              />
              <ErrMsg show={preErrors.contactNumber} />
            </div>

            {/* Graduate or Not */}
            <div className={sectionClass}>
              <p className="text-sm font-black text-[#0A2342] mb-3">Are you a graduate? <Req /></p>
              <div className="flex items-center gap-6 mb-4">
                <label className="flex items-center gap-2 cursor-pointer text-sm font-semibold text-[#0A2342]">
                  <input
                    type="checkbox"
                    checked={preForm.isGraduate === true}
                    onChange={() => handlePreFormChange("isGraduate", preForm.isGraduate === true ? null : true)}
                    className="w-4 h-4 accent-[#D4A017]"
                  />
                  Yes
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-sm font-semibold text-[#0A2342]">
                  <input
                    type="checkbox"
                    checked={preForm.isGraduate === false}
                    onChange={() => handlePreFormChange("isGraduate", preForm.isGraduate === false ? null : false)}
                    className="w-4 h-4 accent-[#D4A017]"
                  />
                  No
                </label>
              </div>
              <ErrMsg show={preErrors.isGraduate} />

              {preForm.isGraduate === true && (
                <div>
                  <label className={labelClass}>Year of Graduation <Req /></label>
                  <input
                    className={inputClass(preErrors.graduateYear)}
                    placeholder="e.g. 2024"
                    value={preForm.graduateYear}
                    onChange={e => handlePreFormChange("graduateYear", e.target.value)}
                  />
                  <ErrMsg show={preErrors.graduateYear} />
                </div>
              )}

              {preForm.isGraduate === false && (
                <div>
                  <label className={labelClass}>Last Semester and School Year of Attendance in USTP <Req /></label>
                  <div className="grid grid-cols-3 gap-3 mt-1">
                    <div>
                      <label className={labelClass}>Semester <Req /></label>
                      <div className="relative">
                        <select
                          className={selectClass(preErrors.lastSem)}
                          value={preForm.lastSem}
                          onChange={e => handlePreFormChange("lastSem", e.target.value)}
                        >
                          <option value="">Select</option>
                          <option>1st Semester</option>
                          <option>2nd Semester</option>
                          <option>Summer</option>
                        </select>
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-xs">▼</div>
                      </div>
                      <ErrMsg show={preErrors.lastSem} />
                    </div>
                    <div>
                      <label className={labelClass}>S.Y. Start <Req /></label>
                      <input
                        className={inputClass(preErrors.lastSY1)}
                        placeholder="e.g. 2023"
                        value={preForm.lastSY1}
                        onChange={e => handlePreFormChange("lastSY1", e.target.value)}
                      />
                      <ErrMsg show={preErrors.lastSY1} />
                    </div>
                    <div>
                      <label className={labelClass}>S.Y. End <Req /></label>
                      <input
                        className={inputClass(preErrors.lastSY2)}
                        placeholder="e.g. 2024"
                        value={preForm.lastSY2}
                        onChange={e => handlePreFormChange("lastSY2", e.target.value)}
                      />
                      <ErrMsg show={preErrors.lastSY2} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Previously Requested */}
            <div className={sectionClass}>
              <p className="text-sm font-black text-[#0A2342] mb-3">
                Have you previously requested credentials? <Req />
              </p>
              <div className="flex items-center gap-6 mb-4">
                <label className="flex items-center gap-2 cursor-pointer text-sm font-semibold text-[#0A2342]">
                  <input
                    type="checkbox"
                    checked={preForm.requestedBefore === true}
                    onChange={() => handlePreFormChange("requestedBefore", preForm.requestedBefore === true ? null : true)}
                    className="w-4 h-4 accent-[#D4A017]"
                  />
                  Yes
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-sm font-semibold text-[#0A2342]">
                  <input
                    type="checkbox"
                    checked={preForm.requestedBefore === false}
                    onChange={() => handlePreFormChange("requestedBefore", preForm.requestedBefore === false ? null : false)}
                    className="w-4 h-4 accent-[#D4A017]"
                  />
                  No
                </label>
              </div>
              <ErrMsg show={preErrors.requestedBefore} />

              {preForm.requestedBefore === true && (
                <div className="grid grid-cols-2 gap-4 mt-2">
                  <div>
                    <label className={labelClass}>Please Specify <Req /></label>
                    <div className="relative">
                      <select
                        className={selectClass(preErrors.previousCredential)}
                        value={preForm.previousCredential}
                        onChange={e => handlePreFormChange("previousCredential", e.target.value)}
                      >
                        <option value="">Select Credential</option>
                        {credentialChoices.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-xs">▼</div>
                    </div>
                    <ErrMsg show={preErrors.previousCredential} />
                  </div>
                  <div>
                    <label className={labelClass}>Date of Request <Req /></label>
                    <input
                      type="date"
                      className={inputClass(preErrors.previousRequestDate)}
                      value={preForm.previousRequestDate}
                      onChange={e => handlePreFormChange("previousRequestDate", e.target.value)}
                    />
                    <ErrMsg show={preErrors.previousRequestDate} />
                  </div>
                </div>
              )}
            </div>

            {/* Cleared */}
            <div className={sectionClass} style={{ marginBottom: 0 }}>
              <p className="text-sm font-black text-[#0A2342] mb-3">Cleared? <Req /></p>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer text-sm font-semibold text-[#0A2342]">
                  <input
                    type="checkbox"
                    checked={preForm.isCleared === true}
                    onChange={() => handleClearedChange(true)} // CHANGED
                    className="w-4 h-4 accent-[#D4A017]"
                  />
                  Yes
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-sm font-semibold text-[#0A2342]">
                  <input
                    type="checkbox"
                    checked={preForm.isCleared === false}
                    onChange={() => handleClearedChange(false)} // CHANGED: opens the pop up
                    className="w-4 h-4 accent-[#D4A017]"
                  />
                  No
                </label>
              </div>
              <ErrMsg show={preErrors.isCleared} />

              {/* ADDED: inline reminder that stays after the pop up is closed */}
              {notCleared && (
                <p className="text-xs text-red-600 font-semibold mt-3">
                  You need to settle your clearance in the{" "}
                  <a
                    href={ECLEARANCE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    USTP e-Clearance site
                  </a>{" "}
                  before you can request a document.
                </p>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={handleProceed}
                disabled={notCleared} // ADDED: cannot proceed while not cleared
                className="bg-[#0A2342] hover:bg-[#081b34] text-white px-8 py-3 rounded-xl font-semibold text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Proceed to Request Form &rarr;
              </button>
            </div>
          </div>
        )}

        {/* ── MAIN REQUEST FORM ── */}
        {showForm && step === "main" && (
          <div className="mt-6 bg-white border border-gray-200 rounded-2xl shadow-md p-8">
            <button onClick={() => setStep("pre")} className="mb-5 text-sm font-semibold text-[#0A2342] hover:text-[#D4A017] transition">
              &larr; Back
            </button>
            <h2 className="text-xl font-black text-[#0A2342] mb-1 tracking-tight">Request Form</h2>
            <p className="text-xs text-gray-400 mb-6 uppercase tracking-widest font-semibold">
              All fields marked <span className="text-[#D4A017]">*</span> are required
            </p>

            <div className="grid md:grid-cols-2 gap-5">

              {/* Student ID (form) */}
              <div className="md:col-span-2">
                <label className={labelClass}>Student ID <Req /></label>
                <div className="flex gap-3">
                  <input
                    className={inputClass(mainErrors.studentId)}
                    placeholder="e.g. 2023301715"
                    value={formStudentId}
                    onChange={e => {
                      setFormStudentId(e.target.value);
                      setMainErrors(p => ({ ...p, studentId: false }));
                    }}
                  />
                </div>
                <ErrMsg show={mainErrors.studentId} />
              </div>

              {/* Full Name */}
              <div>
                <label className={labelClass}>Full Name <Req /></label>
                <input
                  className={inputClass(mainErrors.fullName)}
                  value={fullName}
                  placeholder="Enter your full name"
                  autoComplete="off"
                  onChange={e => { setFullName(e.target.value); setMainErrors(p => ({ ...p, fullName: false })); }}
                />
                <ErrMsg show={mainErrors.fullName} />
              </div>

              {/* Email */}
              <div>
                <label className={labelClass}>Email Address <Req /></label>
                <input
                  type="email"
                  className={inputClass(mainErrors.email)}
                  value={email}
                  placeholder="Enter your email address"
                  autoComplete="off"
                  onChange={e => { setEmail(e.target.value); setMainErrors(p => ({ ...p, email: false })); }}
                />
                <ErrMsg show={mainErrors.email} />
              </div>

              {/* Course */}
              <div>
                <label className={labelClass}>Course <Req /></label>
                <input
                  className={inputClass(mainErrors.course)}
                  value={course}
                  placeholder="Enter your course"
                  autoComplete="off"
                  onChange={e => { setCourse(e.target.value); setMainErrors(p => ({ ...p, course: false })); }}
                />
                <ErrMsg show={mainErrors.course} />
              </div>

              {/* Year Level */}
              <div>
                <label className={labelClass}>Year Level <Req /></label>
                <div className="relative">
                  <select
                    className={selectClass(mainErrors.yearLevel)}
                    value={yearLevel}
                    onChange={e => { setYearLevel(e.target.value); setMainErrors(p => ({ ...p, yearLevel: false })); }}
                  >
                    <option value="">Select Year Level</option>
                    {Object.values(yearLevelMap).map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-xs">▼</div>
                </div>
                <ErrMsg show={mainErrors.yearLevel} />
              </div>

              {/* Request Type */}
              <div className="md:col-span-2">
                <label className={labelClass}>Request Type <Req /></label>
                <div className="relative">
                  <select
                    className={selectClass(mainErrors.requestType)}
                    value={requestType}
                    onChange={e => {
                      setRequestType(e.target.value);
                      setCavChoice(""); setCavOther("");
                      setCertChoice(""); setCertOther("");
                      setSubjectSem(""); setSubjectSY1(""); setSubjectSY2("");
                      setMainErrors({});
                    }}
                  >
                    <option value="">Select Request Type</option>
                    {requestTypes.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-xs">▼</div>
                </div>
                <ErrMsg show={mainErrors.requestType} />
              </div>

              {/* CAV sub-choice */}
              {requestType === "CAV Certification" && (
                <div className="md:col-span-2">
                  <label className={labelClass}>Requesting Agency <Req /></label>
                  <div className="relative">
                    <select
                      className={selectClass(mainErrors.cavChoice)}
                      value={cavChoice}
                      onChange={e => { setCavChoice(e.target.value); setCavOther(""); setMainErrors(p => ({ ...p, cavChoice: false })); }}
                    >
                      <option value="">Select Agency</option>
                      {cavChoices.map(c => <option key={c} value={c}>{c}</option>)}
                      <option value="Other">Other (Please Specify)</option>
                    </select>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-xs">▼</div>
                  </div>
                  <ErrMsg show={mainErrors.cavChoice} />
                  {cavChoice === "Other" && (
                    <div className="mt-3">
                      <label className={labelClass}>Please Specify <Req /></label>
                      <input
                        className={inputClass(mainErrors.cavOther)}
                        placeholder="Specify agency"
                        value={cavOther}
                        onChange={e => { setCavOther(e.target.value); setMainErrors(p => ({ ...p, cavOther: false })); }}
                      />
                      <ErrMsg show={mainErrors.cavOther} />
                    </div>
                  )}
                </div>
              )}

              {/* Certification sub-choice */}
              {requestType === "Certification" && (
                <div className="md:col-span-2">
                  <label className={labelClass}>Certification Type <Req /></label>
                  <div className="relative">
                    <select
                      className={selectClass(mainErrors.certChoice)}
                      value={certChoice}
                      onChange={e => {
                        setCertChoice(e.target.value); setCertOther("");
                        setSubjectSem(""); setSubjectSY1(""); setSubjectSY2("");
                        setMainErrors(p => ({ ...p, certChoice: false }));
                      }}
                    >
                      <option value="">Select Type</option>
                      {certificationChoices.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-xs">▼</div>
                  </div>
                  <ErrMsg show={mainErrors.certChoice} />

                  {(certChoice === "Subjects with Grade" || certChoice === "Subjects Enrolled") && (
                    <div className="mt-3 grid grid-cols-3 gap-3">
                      <div>
                        <label className={labelClass}>Semester <Req /></label>
                        <input className={inputClass(mainErrors.subjectSem)} placeholder="e.g. 1st" value={subjectSem} onChange={e => { setSubjectSem(e.target.value); setMainErrors(p => ({ ...p, subjectSem: false })); }} />
                        <ErrMsg show={mainErrors.subjectSem} />
                      </div>
                      <div>
                        <label className={labelClass}>S.Y. Start <Req /></label>
                        <input className={inputClass(mainErrors.subjectSY1)} placeholder="e.g. 2023" value={subjectSY1} onChange={e => { setSubjectSY1(e.target.value); setMainErrors(p => ({ ...p, subjectSY1: false })); }} />
                        <ErrMsg show={mainErrors.subjectSY1} />
                      </div>
                      <div>
                        <label className={labelClass}>S.Y. End <Req /></label>
                        <input className={inputClass(mainErrors.subjectSY2)} placeholder="e.g. 2024" value={subjectSY2} onChange={e => { setSubjectSY2(e.target.value); setMainErrors(p => ({ ...p, subjectSY2: false })); }} />
                        <ErrMsg show={mainErrors.subjectSY2} />
                      </div>
                    </div>
                  )}

                  {certChoice === "Others" && (
                    <div className="mt-3">
                      <label className={labelClass}>Please Specify <Req /></label>
                      <input
                        className={inputClass(mainErrors.certOther)}
                        placeholder="Specify certification type"
                        value={certOther}
                        onChange={e => { setCertOther(e.target.value); setMainErrors(p => ({ ...p, certOther: false })); }}
                      />
                      <ErrMsg show={mainErrors.certOther} />
                    </div>
                  )}
                </div>
              )}

              {/* Transcript of Records */}
              {requestType === "Transcript of Records" && (
                <div className="md:col-span-2">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className={labelClass}>Semester <Req /></label>
                      <input className={inputClass(mainErrors.subjectSem)} placeholder="e.g. 1st" value={subjectSem} onChange={e => { setSubjectSem(e.target.value); setMainErrors(p => ({ ...p, subjectSem: false })); }} />
                      <ErrMsg show={mainErrors.subjectSem} />
                    </div>
                    <div>
                      <label className={labelClass}>S.Y. Start <Req /></label>
                      <input className={inputClass(mainErrors.subjectSY1)} placeholder="e.g. 2023" value={subjectSY1} onChange={e => { setSubjectSY1(e.target.value); setMainErrors(p => ({ ...p, subjectSY1: false })); }} />
                      <ErrMsg show={mainErrors.subjectSY1} />
                    </div>
                    <div>
                      <label className={labelClass}>S.Y. End <Req /></label>
                      <input className={inputClass(mainErrors.subjectSY2)} placeholder="e.g. 2024" value={subjectSY2} onChange={e => { setSubjectSY2(e.target.value); setMainErrors(p => ({ ...p, subjectSY2: false })); }} />
                      <ErrMsg show={mainErrors.subjectSY2} />
                    </div>
                  </div>
                </div>
              )}

              {/* Purpose */}
              <div className="md:col-span-2">
                <label className={labelClass}>Purpose of Request <Req /></label>
                <textarea
                  className={inputClass(mainErrors.purpose)}
                  rows="4"
                  placeholder="State the purpose of your request"
                  value={purpose}
                  onChange={e => { setPurpose(e.target.value); setMainErrors(p => ({ ...p, purpose: false })); }}
                />
                <ErrMsg show={mainErrors.purpose} />
              </div>

            </div>

            <button
              onClick={submitRequest}
              disabled={submitting}
              className="mt-6 bg-[#D4A017] text-white px-8 py-3 rounded-xl font-semibold hover:bg-[#b8891a] transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? "Submitting…" : "Submit Request"}
            </button>
          </div>
        )}

        {/* Results */}
        <div className="mt-8">
          {studentId && (
            <>
              <h2 className="text-xl font-black text-[#0A2342] mb-4 tracking-tight">
                Current Requests
              </h2>

              {studentRequests.length > 0 ? (
                <div className="space-y-4">
                  {studentRequests.map((request) => (
                    <div
                      key={request.key}
                      className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 flex justify-between items-center"
                    >
                      <div>
                        <p className="font-bold text-[#0A2342] text-sm">{request.document_name}</p>
                        <p className="text-gray-400 text-xs mt-0.5">
                          Submitted: {new Date(request.date_request).toLocaleDateString()}
                        </p>
                        {request.status === "Rejected" ? (
                          <p className="text-xs mt-0.5 font-semibold text-[#0A2342]">
                            Reason:{" "}
                            <span className="text-red-600 font-normal">
                              {request.rejection_reason || "No reason provided"}
                            </span>
                          </p>
                        ) : (
                          <p className="text-xs mt-0.5 font-semibold text-[#0A2342]">
                            Release Date:{" "}
                            <span className={request.due_date ? "text-[#D4A017]" : "text-gray-400 font-normal"}>
                              {formatReleaseDate(request.due_date)}
                            </span>
                          </p>
                        )}
                      </div>
                      <span className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide ${
                        request.status === "Completed" || request.status === "Approved"
                          ? "bg-green-100 text-green-700"
                          : request.status === "Rejected"
                          ? "bg-red-100 text-red-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}>
                        {request.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-10 text-center">
                  <p className="text-gray-400 text-sm">No requests found for this Student ID.</p>
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}