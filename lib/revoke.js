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
const cache = new Map(); // key -> { revoked, until }

export const newGrantId = () => crypto.randomBytes(12).toString("base64url");

// Connections made before grant ids existed carry no gid, so there is nothing to name them by
// one at a time. They are disconnected together, per user and sub-account, under this key.
// Every token issued since has a gid of its own, so this key only ever cuts off those older
// sign-ins — a later reconnect is unaffected.
const legacyKey = (who) => (who?.uid ? `u:${who.uid}:${who.lid || "-"}` : null);

const keysFor = (grant) => (grant?.gid ? [grant.gid] : [legacyKey(grant)]).filter(Boolean);

async function lookup(key) {
  const hit = cache.get(key);
  if (hit && (hit.revoked || hit.until > Date.now())) return hit.revoked;
  try {
    const rows = await db.select(TABLE, `gid=eq.${encodeURIComponent(key)}&select=gid&limit=1`);
    const revoked = Array.isArray(rows) && rows.length > 0;
    cache.set(key, { revoked, until: Date.now() + CHECK_TTL_MS });
    return revoked;
  } catch (e) {
    console.error("revocation check failed (allowing the call):", e.message);
    return false;
  }
}

/** Was this sign-in disconnected? `grant` is an opened access or refresh token. */
export async function isRevoked(grant) {
  if (!supabaseConfigured()) return false;
  for (const key of keysFor(grant)) if (await lookup(key)) return true;
  return false;
}

/** Remember that this sign-in was disconnected. Returns false if it couldn't be saved. */
export async function revokeGrant(grant) {
  const keys = keysFor(grant);
  if (!keys.length) return false;
  for (const key of keys) cache.set(key, { revoked: true, until: Infinity });
  if (!supabaseConfigured()) return false;
  try {
    for (const key of keys) {
      await db.upsert(TABLE, {
        gid: key,
        user_id: grant.uid || null,
        location_id: grant.lid || null,
        client: grant.cn || null,
        revoked_at: new Date().toISOString(),
      });
    }
    return true;
  } catch (e) {
    console.error("couldn't save revocation:", e.message);
    return false;
  }
}
