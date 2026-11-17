// Logs the real error to the browser console (for you) and returns a safe message (for the user).
export function friendlyError(
  error,
  fallback = "Something went wrong. Please try again or contact the Registrar's Office."
) {
  console.error(error);

  const status = error?.response?.status ?? error?.status;

  if (status === 401 || status === 403) {
    return "You are not allowed to do this. Please log out and log in again.";
  }

  // Validation messages written by us (e.g. "That ID number is already in use.") are safe to show
  if (status === 422) {
    const msg = error?.response?.data?.message;
    if (typeof msg === "string" && msg && !/sql|constraint|violat|exception/i.test(msg)) {
      return msg;
    }
  }

  if (error?.message === "Network Error") {
    return "Cannot reach the server. Please check your connection.";
  }

  return fallback;
}