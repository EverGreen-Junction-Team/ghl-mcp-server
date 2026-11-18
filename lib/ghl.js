// Thin HighLevel API client.
//
// Clients connect to this as EverGreen Junction and shouldn't be shown the CRM behind it, so
// everything a client can read -- tool descriptions, errors, page text -- says CRM_NAME instead.
// Internal names (GHL_*, GhlError, this comment) are ours and stay as they are.
export const CRM_NAME = process.env.CRM_NAME || "EverGreen Junction";

/**
 * Upstream error text is the CRM's own words and sometimes names or links to it. These messages
 * are passed to the client as-is, so the name is swapped and any link to it dropped.
 */
export const deVendor = (s) =>
  String(s ?? "")
    .replace(/\bhttps?:\/\/[^\s"'<>)]*\b(?:leadconnectorhq|gohighlevel|highlevel)\b[^\s"'<>)]*/gi, "")
    .replace(/\b(?:go)?high\s*level\b/gi, CRM_NAME)
    .replace(/[ \t]{2,}/g, " ")
    .trim();

const API = () => process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const VERSION = () => process.env.GHL_API_VERSION || "2021-07-28";

import { CATALOG_SCOPES } from "./catalog.scopes.generated.js";

// Scopes the server needs for its own work (users, sub-accounts, agency connection).
const BASE_SCOPES = [
  "contacts.readonly",
  "contacts.write",
  "opportunities.readonly",
  "opportunities.write",
  "conversations.readonly",
  "conversations.write",
  "conversations/message.readonly",
  "conversations/message.write",
  "calendars.readonly",
  "calendars/events.readonly",
  "users.readonly",
  "locations.readonly",
  // Agency connection: list installed sub-accounts and get sub-account tokens.
  "oauth.readonly",
  "oauth.write",
];

/**
 * Scopes the published API specs name but the CRM's install screen rejects.
 *
 * Asking for even one of these fails the whole install with
 * `invalid_scope`, before any consent screen -- so they can't be left in
 * hopefully. Found the only way they can be: from the 400 the install returned.
 *
 * Operations that need one of these are hidden rather than offered and left to fail; see
 * access.js. If the CRM starts accepting one, deleting it here is the whole change.
 */
export const UNGRANTABLE_SCOPES = new Set([
  "conversation-ai.readonly",
  "conversation-ai.write",
  "users.write",
]);

// Requested at install. Default: everything the operation catalog uses, so the AI can reach every
// area (each user is still limited to their own permissions). The Marketplace app must have these
// scopes turned on. To request fewer, set GHL_SCOPES to a space-separated list.
export const GHL_SCOPES = (
  process.env.GHL_SCOPES
    ? [...new Set([...BASE_SCOPES, ...process.env.GHL_SCOPES.split(/[\s,]+/).filter(Boolean)])]
    : [...new Set([...BASE_SCOPES, ...CATALOG_SCOPES])]
).filter((s) => !UNGRANTABLE_SCOPES.has(s));

export class GhlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Call a HighLevel endpoint with a location access token. */
export async function ghlRequest(accessToken, method, path, { query, body, version } = {}) {
  const url = new URL(API() + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: version || VERSION(),
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || text || res.statusText;
    throw new GhlError(res.status, `${CRM_NAME} ${method} ${path} failed (${res.status}): ${deVendor(Array.isArray(msg) ? msg.join(", ") : msg)}`);
  }
  return data;
}

/** Exchange an auth code or refresh token with HighLevel's OAuth endpoint. */
export async function ghlToken(params) {
  const form = new URLSearchParams({
    client_id: process.env.GHL_CLIENT_ID || "",
    client_secret: process.env.GHL_CLIENT_SECRET || "",
    user_type: "Location",
    ...params,
  });
  const res = await fetch(API() + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new GhlError(res.status, `${CRM_NAME} token request failed (${res.status}): ${deVendor(data.message || data.error_description || data.error || "unknown error")}`);
  }
  return data;
}

// Short in-memory cache so a burst of calls doesn't refetch the user every time.
const userCache = new Map();
const USER_TTL_MS = 60_000;

/** The signed-in user's HighLevel record (permissions, role, locations). */
export async function getUser(accessToken, userId) {
  const hit = userCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.user;
  const user = await ghlRequest(accessToken, "GET", `/users/${encodeURIComponent(userId)}`);
  userCache.set(userId, { user, until: Date.now() + USER_TTL_MS });
  return user;
}
