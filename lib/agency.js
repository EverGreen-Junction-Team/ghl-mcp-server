// The agency's HighLevel connection: saved once when the agency admin installs the app,
// then used to look up users and to get sub-account (location) tokens. Users never see HighLevel.
import { db } from "./supabase.js";
import { ghlToken, ghlRequest, GhlError } from "./ghl.js";

const TABLE = "mcp_agency";
const API = () => process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const VERSION = () => process.env.GHL_API_VERSION || "2021-07-28";
const appId = () => String(process.env.GHL_CLIENT_ID || "").split("-")[0];

const expiresAt = (t) => new Date(Date.now() + (Number(t.expires_in) || 86400) * 1000).toISOString();

/** Save the agency (Company) token from an agency-level install. */
export async function saveAgencyToken(t) {
  // Only one agency may own this connector: GHL_COMPANY_ID if set, otherwise the first one saved.
  const owner = process.env.GHL_COMPANY_ID || (await db.select(TABLE, "select=company_id&limit=1"))?.[0]?.company_id;
  if (owner && owner !== t.companyId) {
    throw new Error("This connector belongs to a different agency.");
  }
  await db.upsert(TABLE, {
    company_id: t.companyId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: expiresAt(t),
    scope: t.scope || null,
    installed_by: t.userId || null,
    updated_at: new Date().toISOString(),
  });
}

async function loadRow() {
  const only = process.env.GHL_COMPANY_ID;
  const q = only
    ? `company_id=eq.${encodeURIComponent(only)}&select=*`
    : `select=*&order=updated_at.desc&limit=1`;
  const rows = await db.select(TABLE, q);
  if (!rows?.length) {
    throw new Error("The agency hasn't connected the app yet. An agency admin needs to open /install once.");
  }
  return rows[0];
}

/** A valid agency access token (refreshed and saved when it's about to expire). */
export async function agencyToken() {
  let row = await loadRow();
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60 * 1000) return { token: row.access_token, companyId: row.company_id };

  // HighLevel refresh tokens are single-use. If two requests refresh at once, only one wins;
  // the other re-reads the row the winner saved.
  try {
    const t = await ghlToken({ grant_type: "refresh_token", refresh_token: row.refresh_token, user_type: "Company" });
    const saved = await db.update(
      TABLE,
      `company_id=eq.${encodeURIComponent(row.company_id)}&refresh_token=eq.${encodeURIComponent(row.refresh_token)}`,
      {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: expiresAt(t),
        scope: t.scope || row.scope,
        updated_at: new Date().toISOString(),
      }
    );
    if (saved?.length) return { token: t.access_token, companyId: row.company_id };
  } catch (e) {
    console.error("agency token refresh failed:", e.message);
  }
  row = await loadRow();
  if (new Date(row.expires_at).getTime() > Date.now()) return { token: row.access_token, companyId: row.company_id };
  throw new Error("The agency connection to HighLevel has expired. An agency admin needs to open /install again.");
}

/** Find an active agency user by email (exact, case-insensitive). */
export async function findUserByEmail(email) {
  const { token, companyId } = await agencyToken();
  const data = await ghlRequest(token, "GET", "/users/search", { query: { companyId, query: email, limit: 25 } });
  const want = email.trim().toLowerCase();
  const user = (data.users || []).find((u) => String(u.email || "").toLowerCase() === want && u.deleted !== true);
  return user ? { user, companyId } : { user: null, companyId };
}

/** A user's HighLevel record, fetched with the agency token. */
export async function getUserById(userId) {
  const { token } = await agencyToken();
  return ghlRequest(token, "GET", `/users/${encodeURIComponent(userId)}`);
}

/** Sub-accounts where the app is installed, as [{ id, name }]. */
export async function installedLocations() {
  const { token, companyId } = await agencyToken();
  const out = [];
  for (let skip = 0; skip < 5000; skip += 100) {
    const data = await ghlRequest(token, "GET", "/oauth/installedLocations", {
      query: { companyId, appId: appId(), isInstalled: true, limit: 100, skip },
    });
    const page = data.locations || [];
    for (const l of page) if (l.isInstalled !== false) out.push({ id: l._id || l.id, name: l.name || l._id || l.id });
    if (page.length < 100) break;
  }
  return out;
}

/** The sub-accounts this user may connect to (only ones with the app installed). */
export async function locationsForUser(user) {
  const all = await installedLocations();
  const roles = user.roles || {};
  if (roles.type === "agency" && roles.role === "admin" && !(roles.locationIds || []).length) return all;
  const allowed = new Set(roles.locationIds || []);
  return all.filter((l) => allowed.has(l.id));
}

/** True if the user may still use this sub-account. */
export function userCanUseLocation(user, locationId) {
  if (!user || user.deleted === true) return false;
  const roles = user.roles || {};
  if (roles.type === "agency" && roles.role === "admin" && !(roles.locationIds || []).length) return true;
  return (roles.locationIds || []).includes(locationId);
}

/** A sub-account access token, minted from the agency token. */
export async function locationToken(locationId) {
  const { token, companyId } = await agencyToken();
  const res = await fetch(API() + "/oauth/locationToken", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: VERSION(),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ companyId, locationId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new GhlError(res.status, `Couldn't open this sub-account (${res.status}): ${data.message || data.error || "is the app installed there?"}`);
  }
  return { at: data.access_token, exp: Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 86400), cmp: companyId };
}
