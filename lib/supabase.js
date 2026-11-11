// Minimal Supabase client (REST + Auth), no dependencies. Uses the service role key,
// so it must only ever run on the server.
const url = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const supabaseConfigured = () => !!(url() && key());

function headers(extra = {}) {
  return { apikey: key(), Authorization: `Bearer ${key()}`, "Content-Type": "application/json", ...extra };
}

async function call(method, path, { body, headers: extra, timeoutMs = 8000 } = {}) {
  if (!supabaseConfigured()) throw new Error("Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  const res = await fetch(url() + path, {
    method,
    headers: headers(extra),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`Supabase ${method} ${path.split("?")[0]} failed (${res.status}): ${data?.msg || data?.message || data?.error_description || text}`);
    err.status = res.status;
    err.code = data?.error_code || data?.code;
    throw err;
  }
  return data;
}

// ---------- tables (PostgREST) ----------
export const db = {
  select: (table, query) => call("GET", `/rest/v1/${table}?${query}`),
  insert: (table, row, opts = {}) =>
    call("POST", `/rest/v1/${table}`, { body: row, headers: { Prefer: "return=minimal" }, ...opts }),
  upsert: (table, row) =>
    call("POST", `/rest/v1/${table}`, { body: row, headers: { Prefer: "resolution=merge-duplicates,return=minimal" } }),
  /** PATCH rows matching `query`; returns the updated rows. */
  update: (table, query, patch) =>
    call("PATCH", `/rest/v1/${table}?${query}`, { body: patch, headers: { Prefer: "return=representation" } }),
};

// ---------- email codes (Supabase Auth) ----------
/** Email a one-time 6-digit code. Uses the "Magic Link" / "Confirm signup" email templates. */
export function sendEmailCode(email) {
  return call("POST", "/auth/v1/otp", { body: { email, create_user: true } });
}

/** True if the code is right. Throws on rate limits / server errors. */
export async function verifyEmailCode(email, code) {
  try {
    await call("POST", "/auth/v1/verify", { body: { type: "email", email, token: code } });
    return true;
  } catch (e) {
    if (e.status === 400 || e.status === 401 || e.status === 403 || e.status === 422) return false;
    throw e;
  }
}
