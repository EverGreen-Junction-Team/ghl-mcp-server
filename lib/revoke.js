// Disconnecting. Tokens are self-contained (lib/seal.js), so to cut one off we remember its sign-in
// ("grant id", gid: shared by the access and refresh tokens from one sign-in) in mcp_revoked.
// Every MCP call and token refresh checks that list.
//
// If Supabase is unreachable the check lets the call through (and logs it), so an outage
// doesn't sign everyone out; access tokens still expire within 24 hours.
import crypto from "node:crypto";
import { db, supabaseConfigured } from "./supabase.js";

const TABLE = "mcp_revoked";
const CHECK_TTL_MS = 60_000;
const cache = new Map(); // gid -> { revoked, until }

export const newGrantId = () => crypto.randomBytes(12).toString("base64url");

export async function isRevoked(gid) {
  if (!gid || !supabaseConfigured()) return false;
  const hit = cache.get(gid);
  if (hit && (hit.revoked || hit.until > Date.now())) return hit.revoked;
  try {
    const rows = await db.select(TABLE, `gid=eq.${encodeURIComponent(gid)}&select=gid&limit=1`);
    const revoked = Array.isArray(rows) && rows.length > 0;
    cache.set(gid, { revoked, until: Date.now() + CHECK_TTL_MS });
    return revoked;
  } catch (e) {
    console.error("revocation check failed (allowing the call):", e.message);
    return false;
  }
}

/** Remember that this sign-in was disconnected. Returns false if it couldn't be saved. */
export async function revokeGrant(gid, info = {}) {
  if (!gid) return false;
  cache.set(gid, { revoked: true, until: Infinity });
  if (!supabaseConfigured()) return false;
  try {
    await db.upsert(TABLE, {
      gid,
      user_id: info.uid || null,
      location_id: info.lid || null,
      client: info.cn || null,
      revoked_at: new Date().toISOString(),
    });
    return true;
  } catch (e) {
    console.error("couldn't save revocation:", e.message);
    return false;
  }
}
