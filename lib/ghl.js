// Thin HighLevel API client.
const API = () => process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const VERSION = () => process.env.GHL_API_VERSION || "2021-07-28";

export const GHL_SCOPES = [
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
];

export class GhlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Call a HighLevel endpoint with a location access token. */
export async function ghlRequest(accessToken, method, path, { query, body } = {}) {
  const url = new URL(API() + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: VERSION(),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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
    throw new GhlError(res.status, `HighLevel ${method} ${path} failed (${res.status}): ${Array.isArray(msg) ? msg.join(", ") : msg}`);
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
    throw new GhlError(res.status, `HighLevel token request failed (${res.status}): ${data.message || data.error_description || data.error || "unknown error"}`);
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
