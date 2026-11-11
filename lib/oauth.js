// OAuth 2.1 authorization server for MCP clients (Claude etc.).
// Identity comes from HighLevel: /authorize sends the user to HighLevel's sign-in and
// sub-account picker, and the HighLevel token tells us which user and sub-account it is.
import { seal, open, sha256url } from "./seal.js";
import { ghlToken, GHL_SCOPES } from "./ghl.js";
import { baseUrl, sendJson, redirect, sendHtml, parseCookies } from "./http.js";

// Same address HighLevel uses in the app's installation link. The old /oauth/chooselocation
// fails with "error.noAppVersionIdFound" for versioned Marketplace apps.
const CHOOSE_LOCATION_URL =
  process.env.GHL_CHOOSE_LOCATION_URL || "https://marketplace.gohighlevel.com/v2/oauth/chooselocation";
const PENDING_COOKIE = "ghl_mcp_pending";
const REFRESH_TTL = 300 * 24 * 3600; // HighLevel refresh tokens last up to a year

export function protectedResourceMetadata(req, res) {
  const base = baseUrl(req);
  sendJson(res, 200, {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    resource_name: "HighLevel (permission-scoped)",
  });
}

export function authServerMetadata(req, res) {
  const base = baseUrl(req);
  sendJson(res, 200, {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["ghl"],
  });
}

// Dynamic client registration. The client ID is an encrypted copy of its redirect URIs,
// so nothing needs to be stored.
export function register(req, res) {
  const body = req.body || {};
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
  if (!uris.length || !uris.every(isAllowedRedirect)) {
    return sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be https (or http://localhost)" });
  }
  const client_id = seal("client", { ru: uris, n: String(body.client_name || "").slice(0, 100) });
  sendJson(res, 201, {
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: body.client_name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

function isAllowedRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

function authError(res, message) {
  sendHtml(res, 400, `<h2>Can't connect to HighLevel</h2><p>${escapeHtml(message)}</p>`);
}

export function authorize(req, res, query) {
  const client = open("client", query.get("client_id"));
  const redirectUri = query.get("redirect_uri");
  if (!client) return authError(res, "Unknown client. Remove and re-add the connector.");
  if (!redirectUri || !client.ru.includes(redirectUri)) return authError(res, "redirect_uri doesn't match this client.");
  if (query.get("response_type") !== "code") return redirectWithError(res, redirectUri, query.get("state"), "unsupported_response_type");
  const challenge = query.get("code_challenge");
  if (!challenge || (query.get("code_challenge_method") || "S256") !== "S256") {
    return redirectWithError(res, redirectUri, query.get("state"), "invalid_request", "PKCE S256 is required");
  }
  if (!process.env.GHL_CLIENT_ID) return authError(res, "Server is missing GHL_CLIENT_ID.");

  // Remember the client's request while the user signs in at HighLevel.
  // Sent both as `state` and as a cookie, in case HighLevel doesn't echo state back.
  const pending = seal(
    "pending",
    { cid: query.get("client_id"), ru: redirectUri, st: query.get("state") || "", cc: challenge },
    15 * 60
  );
  res.setHeader(
    "Set-Cookie",
    `${PENDING_COOKIE}=${pending}; Path=/callback; Max-Age=900; HttpOnly; Secure; SameSite=Lax`
  );

  const ghl = new URL(CHOOSE_LOCATION_URL);
  ghl.searchParams.set("response_type", "code");
  ghl.searchParams.set("redirect_uri", `${baseUrl(req)}/callback`);
  ghl.searchParams.set("client_id", process.env.GHL_CLIENT_ID);
  ghl.searchParams.set("scope", GHL_SCOPES.join(" "));
  ghl.searchParams.set("state", pending);
  // HighLevel needs version_id. Use GHL_VERSION_ID (from the app's installation link) when set,
  // otherwise the app id: the part of the client id before "-", which is what the link uses.
  const versionId = process.env.GHL_VERSION_ID || String(process.env.GHL_CLIENT_ID || "").split("-")[0];
  if (versionId) ghl.searchParams.set("version_id", versionId);
  redirect(res, ghl.toString());
}

// HighLevel sends the user back here after sign-in.
export async function callback(req, res, query) {
  const pending =
    open("pending", query.get("state")) || open("pending", parseCookies(req)[PENDING_COOKIE]);
  if (!pending) return authError(res, "Sign-in session expired. Please start the connection again from your AI app.");
  res.setHeader("Set-Cookie", `${PENDING_COOKIE}=; Path=/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);

  const code = query.get("code");
  if (!code) return redirectWithError(res, pending.ru, pending.st, "access_denied", query.get("error") || "No code from HighLevel");

  let t;
  try {
    t = await ghlToken({ grant_type: "authorization_code", code, redirect_uri: `${baseUrl(req)}/callback` });
  } catch (e) {
    return authError(res, e.message);
  }
  if (!t.locationId || !t.userId) {
    return authError(res, "Please choose a sub-account (not the agency) when signing in.");
  }

  const ourCode = seal(
    "code",
    { cid: pending.cid, ru: pending.ru, cc: pending.cc, g: ghlGrant(t) },
    120
  );
  const back = new URL(pending.ru);
  back.searchParams.set("code", ourCode);
  if (pending.st) back.searchParams.set("state", pending.st);
  redirect(res, back.toString());
}

function ghlGrant(t, previous = {}) {
  return {
    at: t.access_token,
    rt: t.refresh_token,
    exp: Math.floor(Date.now() / 1000) + (Number(t.expires_in) || 86400),
    uid: t.userId || previous.uid,
    lid: t.locationId || previous.lid,
    cmp: t.companyId || previous.cmp,
  };
}

function issueTokens(res, cid, g) {
  // Our access token lives as long as the HighLevel token inside it (minus a margin), max 24h.
  const ttl = Math.max(60, Math.min(24 * 3600, g.exp - Math.floor(Date.now() / 1000) - 300));
  const access_token = seal("access", { at: g.at, uid: g.uid, lid: g.lid, cmp: g.cmp }, ttl);
  const refresh_token = seal("refresh", { cid, rt: g.rt, uid: g.uid, lid: g.lid, cmp: g.cmp }, REFRESH_TTL);
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, { access_token, token_type: "Bearer", expires_in: ttl, refresh_token, scope: "ghl" });
}

export async function token(req, res) {
  const b = req.body || {};
  const tokenError = (error, error_description, status = 400) => sendJson(res, status, { error, error_description });

  if (b.grant_type === "authorization_code") {
    const c = open("code", b.code);
    if (!c) return tokenError("invalid_grant", "Code is invalid or expired");
    if (b.client_id && b.client_id !== c.cid) return tokenError("invalid_grant", "Code was issued to another client");
    if (b.redirect_uri && b.redirect_uri !== c.ru) return tokenError("invalid_grant", "redirect_uri mismatch");
    if (!b.code_verifier || sha256url(b.code_verifier) !== c.cc) return tokenError("invalid_grant", "PKCE verification failed");
    return issueTokens(res, c.cid, c.g);
  }

  if (b.grant_type === "refresh_token") {
    const r = open("refresh", b.refresh_token);
    if (!r) return tokenError("invalid_grant", "Refresh token is invalid or expired");
    if (b.client_id && b.client_id !== r.cid) return tokenError("invalid_grant", "Refresh token was issued to another client");
    try {
      const t = await ghlToken({ grant_type: "refresh_token", refresh_token: r.rt });
      return issueTokens(res, r.cid, ghlGrant(t, r));
    } catch (e) {
      return tokenError("invalid_grant", e.message);
    }
  }

  tokenError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

function redirectWithError(res, uri, state, error, description) {
  const u = new URL(uri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  redirect(res, u.toString());
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
