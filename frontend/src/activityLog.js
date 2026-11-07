import { supabase } from "./supabaseClient";

// staff_id of the logged-in staff (saved by App.jsx at login)
function getStaffId() {
  try {
    const saved = JSON.parse(localStorage.getItem("regisscan_staff"));
    return saved?.staff_id ? Number(saved.staff_id) : null;
  } catch {
    return null;
  }
}

// Writes one row to tbl_system_activity (shown in Audit Logs).
// type: Upload | View | Update | Login | Archive | Request | Delete | Export
export async function logActivity({ type, description, module, status = "success" }) {
  const staffId = getStaffId();
  if (!staffId) return;

  const { error } = await supabase.from("tbl_system_activity").insert({
    staff_id: staffId,
    activity_type: type,
    activity_description: description,
    module_name: module,
    date_time: new Date().toISOString(),
    status,
  });

  if (error) console.error("Failed to record activity:", error);
}