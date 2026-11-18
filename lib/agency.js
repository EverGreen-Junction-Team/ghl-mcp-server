// The agency's HighLevel connection: saved once when the agency admin installs the app,
// then used to look up users and to get sub-account (location) tokens. Users never see HighLevel.
import { db } from "./supabase.js";
import { ghlToken, ghlRequest, GhlError, GHL_SCOPES, CRM_NAME } from "./ghl.js";

const TABLE = "mcp_agency";
const LOC_TABLE = "mcp_location";
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
  forgetRow();
  // A reinstall is usually someone fixing the scopes. Sub-account tokens minted from the old
  // grant still carry the old scopes, so they go rather than being handed out for another day.
  forgetLocationTokens();
  try {
    await db.delete(LOC_TABLE, `company_id=eq.${encodeURIComponent(t.companyId)}`);
  } catch (e) {
    console.error("couldn't clear stored sub-account tokens:", e.message);
  }
}

// The row only changes when the token is refreshed or the app is reinstalled, and both of
// those happen here, so it is held in memory until then. Without this every single tool call
// paid a Supabase round trip before it could even start talking to HighLevel.
let rowCache = null;

/** Forget the cached agency row (after a write, or when its token turned out to be stale). */
function forgetRow() {
  rowCache = null;
}

async function loadRow({ fresh = false } = {}) {
  if (!fresh && rowCache) return rowCache;
  const only = process.env.GHL_COMPANY_ID;
  const q = only
    ? `company_id=eq.${encodeURIComponent(only)}&select=*`
    : `select=*&order=updated_at.desc&limit=1`;
  const rows = await db.select(TABLE, q);
  if (!rows?.length) {
    throw new Error("The agency hasn't connected the app yet. An agency admin needs to open /install once.");
  }
  rowCache = rows[0];
  return rowCache;
}

/**
 * Swap this row's refresh token for a new pair and save it.
 *
 * HighLevel refresh tokens are single-use. If two requests refresh at once only one wins, so
 * the write is conditional on the refresh token we started from still being the stored one.
 * Returns true when this call did the rotation (rowCache then holds the new pair), false when
 * it failed or someone else won -- either way the caller must re-read the row.
 */
async function rotate(row) {
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
    if (saved?.length) {
      rowCache = saved[0] ?? { ...row, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: expiresAt(t) };
      return true;
    }
  } catch (e) {
    console.error("agency token refresh failed:", e.message);
  }
  return false;
}

/** A valid agency access token (refreshed and saved when it's about to expire). */
export async function agencyToken() {
  let row = await loadRow();
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60 * 1000) return { token: row.access_token, companyId: row.company_id };

  if (await rotate(row)) return { token: rowCache.access_token, companyId: row.company_id };
  // Either another request won the refresh race or ours failed; in both cases the row we
  // hold is stale, so go back to the database rather than trusting the cache.
  forgetRow();
  row = await loadRow({ fresh: true });
  if (new Date(row.expires_at).getTime() > Date.now()) return { token: row.access_token, companyId: row.company_id };
  throw new Error(`The agency connection to ${CRM_NAME} has expired. An agency admin needs to open /install again.`);
}

/**
 * Rotate the agency token now, whether or not it is close to expiring.
 *
 * Everything else here refreshes lazily, on the next call that needs a token. That is enough
 * while the connector is in daily use, and not enough when it isn't: the connection stays
 * alive only by spending the refresh token, so a quiet stretch -- a holiday, a client who
 * doesn't open Claude for a fortnight -- can end with it lapsed and an agency admin having to
 * reinstall. A daily cron spends it on a schedule instead of on traffic.
 *
 * Safe to run against a token that is still valid: rotating early costs nothing, and losing
 * the race to a real request is an ordinary outcome, not a failure.
 */
export async function renewAgencyToken() {
  forgetRow();
  const row = await loadRow({ fresh: true });
  const rotated = await rotate(row);
  const now = rotated ? rowCache : await loadRow({ fresh: true });
  const expiresIn = Math.round((new Date(now.expires_at).getTime() - Date.now()) / 60000);
  if (!rotated && expiresIn <= 0) {
    throw new Error(`The agency connection to ${CRM_NAME} has expired and couldn't be renewed. An agency admin needs to open /install again.`);
  }
  return {
    rotated,
    companyId: now.company_id,
    expiresAt: now.expires_at,
    expiresInMinutes: expiresIn,
    // Not rotated and still valid means another request refreshed it first, which is fine.
    note: rotated ? "Agency token rotated." : "Already refreshed by another request; the stored token is still valid.",
  };
}

/**
 * Which of the scopes we asked for HighLevel actually granted at install.
 *
 * These are the app's scopes, not the user's permissions: a scope that was never ticked on
 * the Marketplace app is missing for everyone, however complete their HighLevel user looks.
 * Nothing here checks them before a call -- an operation needing a missing scope simply fails
 * upstream -- so this exists to make that visible instead of leaving it to a failed request.
 * A null `granted` means the install didn't report any scopes, not that none were granted.
 */
export async function appScopeStatus() {
  let row;
  try {
    row = await loadRow();
  } catch (e) {
    // whoami is what people reach for when something is already wrong, so it must not fail
    // just because this extra check can't be made.
    return { granted: null, missing: null, note: `The app's scopes couldn't be read (${e.message})` };
  }
  const raw = typeof row.scope === "string" ? row.scope.trim() : "";
  if (!raw) {
    return { granted: null, missing: null, note: `${CRM_NAME} didn't report scopes when the app was installed, so this can't be checked here. If an operation fails with a permission error, the scope is the first thing to check on the Marketplace app.` };
  }
  const granted = new Set(raw.split(/[\s,]+/).filter(Boolean));
  const missing = GHL_SCOPES.filter((s) => !granted.has(s));
  if (!missing.length) {
    return {
      granted: granted.size,
      missingCount: 0,
      missing: [],
      note: `All ${GHL_SCOPES.length} requested scopes are granted, so a refusal is about the user's permissions, not the app's.`,
    };
  }
  // A barely-installed app is missing a hundred of these; listing them all would bury the
  // answer. The count carries that, and a short list is enough to recognise the shape.
  const SHOWN = 25;
  return {
    granted: granted.size,
    missingCount: missing.length,
    missing: missing.slice(0, SHOWN),
    ...(missing.length > SHOWN ? { missingNotShown: missing.length - SHOWN } : {}),
    note:
      `Asked for ${GHL_SCOPES.length} scopes, granted ${granted.size}. Operations needing a missing scope are refused by ${CRM_NAME} ` +
      `however complete the user's permissions are, and nothing on this side checks first. ` +
      `Fix: tick them on the Marketplace app, then reinstall in the agency and each sub-account.`,
  };
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

// Sub-account tokens last about a day. Cache them so a connection spanning several
// sub-accounts doesn't mint a new one on every call.
const tokenCache = new Map(); // locationId -> { at, exp, cmp }

const unexpired = (exp) => exp - 300 > Math.floor(Date.now() / 1000);

/**
 * Drop every cached sub-account token.
 *
 * A token carries the scopes its grant had when it was minted, so after a reinstall the ones
 * in memory are the old grant's -- which is exactly the case where someone has just added the
 * scopes and is waiting for them to take effect.
 */
export function forgetLocationTokens() {
  tokenCache.clear();
}

/**
 * Keep a minted sub-account token where the next container can find it.
 *
 * These are live credentials at rest, one per client sub-account, which the agency row alone
 * was not. They are stored because the owner asked for them to be: the cron below renews them
 * on a schedule, and a stored token means a cold start doesn't pay for a mint. The table is
 * service-role only with RLS on, same as the agency row, and a stored token is still checked
 * against its expiry before use -- but it is a wider surface than before, and deleting the
 * table is all it takes to go back to minting on demand.
 */
async function storeLocationToken(locationId, minted, name) {
  try {
    await db.upsert(LOC_TABLE, {
      location_id: locationId,
      company_id: minted.cmp,
      access_token: minted.at,
      expires_at: new Date(minted.exp * 1000).toISOString(),
      ...(name ? { name } : {}),
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    // The token works whether or not it got saved, so a storage problem must not fail the call.
    console.error(`couldn't store the token for ${locationId}:`, e.message);
  }
}

/** A stored sub-account token, if there is one and it hasn't expired. */
async function storedLocationToken(locationId) {
  try {
    const rows = await db.select(LOC_TABLE, `location_id=eq.${encodeURIComponent(locationId)}&select=*&limit=1`);
    const row = rows?.[0];
    if (!row) return null;
    const exp = Math.floor(new Date(row.expires_at).getTime() / 1000);
    return unexpired(exp) ? { at: row.access_token, exp, cmp: row.company_id } : null;
  } catch (e) {
    console.error(`couldn't read the stored token for ${locationId}:`, e.message);
    return null;
  }
}

/**
 * A sub-account access token.
 *
 * Three places to look, cheapest first: this container's memory, the table the cron keeps
 * warm, then HighLevel. The last one always works as long as the app is installed there, so
 * neither of the first two can leave a request stuck with a stale token.
 */
export async function locationToken(locationId) {
  const hit = tokenCache.get(locationId);
  if (hit && unexpired(hit.exp)) return hit;

  const stored = await storedLocationToken(locationId);
  if (stored) {
    tokenCache.set(locationId, stored);
    return stored;
  }

  const minted = await mintLocationToken(locationId);
  tokenCache.set(locationId, minted);
  await storeLocationToken(locationId, minted);
  return minted;
}

/**
 * Mint and store a token for every sub-account the app is installed in.
 *
 * Run at install and once a day by the cron. One sub-account failing is the normal case worth
 * reporting rather than throwing on -- it means the app isn't installed there -- so each is
 * reported separately and the rest carry on.
 */
export async function primeLocationTokens() {
  const locations = await installedLocations();
  const ok = [];
  const failed = [];
  for (const l of locations) {
    try {
      const minted = await mintLocationToken(l.id);
      tokenCache.set(l.id, minted);
      await storeLocationToken(l.id, minted, l.name);
      ok.push({ id: l.id, name: l.name });
    } catch (e) {
      failed.push({ id: l.id, name: l.name, error: e.message });
    }
  }
  return { installedSubAccounts: locations.length, stored: ok.length, storedSubAccounts: ok, failed };
}

async function mintLocationToken(locationId) {
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

/**
 * The sub-accounts a connection may work in, as [{ id, name }].
 *
 * A connection either names them (`ls`, chosen at sign-in) or covers every sub-account the
 * user can reach (`all`, which follows their HighLevel access as it changes). Either way the
 * user's own access is checked again here, so losing a sub-account in HighLevel takes effect
 * without reconnecting.
 */
export async function grantLocations(grant, user) {
  if (grant.all) return locationsForUser(user);
  const named = Array.isArray(grant.ls) ? grant.ls : [[grant.lid, grant.ln || grant.lid]];
  return named.filter(([id]) => userCanUseLocation(user, id)).map(([id, name]) => ({ id, name: name || id }));
}

/** Can this connection use this sub-account right now? Cheap: no HighLevel call. */
export function grantCanUseLocation(grant, user, locationId) {
  if (!userCanUseLocation(user, locationId)) return false;
  if (grant.all) return true;
  const named = Array.isArray(grant.ls) ? grant.ls.map(([id]) => id) : [grant.lid];
  return named.includes(locationId);
}
