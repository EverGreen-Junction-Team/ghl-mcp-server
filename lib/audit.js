// Activity log: one row per sign-in event and per tool call, in Supabase (mcp_audit_log).
// Never blocks or breaks the request: failures are only printed to the server log.
import { db, supabaseConfigured } from "./supabase.js";

const MAX_ARGS_CHARS = 4000;

function trimArgs(args) {
  if (args === undefined || args === null) return null;
  const text = JSON.stringify(args);
  if (text.length <= MAX_ARGS_CHARS) return args;
  return { _truncated: true, preview: text.slice(0, MAX_ARGS_CHARS) };
}

export function clientIp(req) {
  const fwd = req?.headers?.["x-forwarded-for"];
  return (typeof fwd === "string" ? fwd.split(",")[0].trim() : null) || req?.socket?.remoteAddress || null;
}

/**
 * Record an event. Fields: event, user_id, user_email, user_name, location_id, location_name,
 * company_id, tool, ok, error, args, duration_ms, client, ip.
 */
export async function audit(fields) {
  const row = { ...fields, args: trimArgs(fields.args), error: fields.error ? String(fields.error).slice(0, 2000) : null };
  console.log(JSON.stringify({ audit: row.event, ...row, args: undefined }));
  if (!supabaseConfigured()) return;
  try {
    await db.insert("mcp_audit_log", row, { timeoutMs: 3000 });
  } catch (e) {
    console.error("audit log write failed:", e.message);
  }
}
