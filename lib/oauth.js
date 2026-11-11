// OAuth 2.1 authorization server for MCP clients (Claude etc.).
// Users sign in on our own branded pages (lib/signin.js): email -> code -> sub-account.
// HighLevel is only used behind the scenes, through the agency connection saved at install
// time (lib/agency.js). The agency admin installs once via /install.
import { seal, open, sha256url } from "./seal.js";
import { ghlToken, GHL_SCOPES } from "./ghl.js";
import { baseUrl, sendJson, redirect } from "./http.js";
import { page, errorPage, esc, brandName } from "./pages.js";
import { startSignIn } from "./signin.js";
import { saveAgencyToken, getUserById, userCanUseLocation, locationToken } from "./agency.js";
import { audit } from "./audit.js";

// Same address HighLevel uses in the app's installation link.
const CHOOSE_LOCATION_URL =
  process.env.GHL_CHOOSE_LOCATION_URL || "https://marketplace.gohighlevel.com/v2/oauth/chooselocation";
const REFRESH_TTL = 300 * 24 * 3600;

export function protectedResourceMetadata(req, res) {
  const base = baseUrl(req);
  sendJson(res, 200, {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    resource_name: brandName(),
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

/** GET /authorize: check the AI app's request, then show our sign-in page. */
export function authorize(req, res, query) {
  const client = open("client", query.get("client_id"));
  const redirectUri = query.get("redirect_uri");
  if (!client) return errorPage(res, "Unknown client. Remove and re-add the connector.");
  if (!redirectUri || !client.ru.includes(redirectUri)) return errorPage(res, "redirect_uri doesn't match this client.");
  if (query.get("response_type") !== "code") return redirectWithError(res, redirectUri, query.get("state"), "unsupported_response_type");
  const challenge = query.get("code_challenge");
  if (!challenge || (query.get("code_challenge_method") || "S256") !== "S256") {
    return redirectWithError(res, redirectUri, query.get("state"), "invalid_request", "PKCE S256 is required");
  }
  startSignIn(res, { cid: query.get("client_id"), ru: redirectUri, st: query.get("state") || "", cc: challenge, cn: client.n || "" });
}

/** GET /install: the agency admin connects the agency once (HighLevel's install screen). */
export function install(req, res) {
  if (!process.env.GHL_CLIENT_ID) return errorPage(res, "Server is missing GHL_CLIENT_ID.", 500);
  const ghl = new URL(CHOOSE_LOCATION_URL);
  ghl.searchParams.set("response_type", "code");
  ghl.searchParams.set("redirect_uri", `${baseUrl(req)}/callback`);
  ghl.searchParams.set("client_id", process.env.GHL_CLIENT_ID);
  ghl.searchParams.set("scope", GHL_SCOPES.join(" "));
  const versionId = process.env.GHL_VERSION_ID || String(process.env.GHL_CLIENT_ID).split("-")[0];
  if (versionId) ghl.searchParams.set("version_id", versionId);
  redirect(res, ghl.toString());
}

/** GET /callback: HighLevel sends the admin back here after installing the app. */
export async function callback(req, res, query) {
  const code = query.get("code");
  if (!code) return errorPage(res, query.get("error") || "HighLevel didn't send an install code.");
  let t;
  try {
    t = await ghlToken({ grant_type: "authorization_code", code, redirect_uri: `${baseUrl(req)}/callback` });
  } catch (e) {
    return errorPage(res, e.message);
  }
  const mcpUrl = `${baseUrl(req)}/mcp`;
  const howTo =
    `<p>Each user adds this URL as a custom connector in Claude and signs in with their work email. ` +
    `They only get the tools their permissions allow.</p><pre>${esc(mcpUrl)}</pre>`;

  if (t.userType === "Company" || (!t.locationId && t.companyId)) {
    try {
      await saveAgencyToken(t);
    } catch (e) {
      return errorPage(res, `The app was installed, but the agency connection couldn't be saved: ${e.message}`, 500);
    }
    await audit({ event: "agency_installed", user_id: t.userId || null, company_id: t.companyId, ok: true });
    return page(res, {
      title: "Installed",
      body: `<h1>Connected for your agency</h1><p>The connector is ready. Make sure it's installed in every sub-account that should use it.</p>${howTo}`,
    });
  }
  page(res, {
    title: "Installed",
    body:
      `<h1>Installed in this sub-account</h1>` +
      `<p>If users can't sign in yet, an agency admin needs to connect the agency once at ` +
      `<a href="/install">${esc(baseUrl(req))}/install</a> and choose the agency.</p>${howTo}`,
  });
}

/** Tokens for the AI app: the HighLevel sub-account token plus who the user is, encrypted. */
function issueTokens(res, cid, g, cn) {
  const ttl = Math.max(60, Math.min(24 * 3600, g.exp - Math.floor(Date.now() / 1000) - 300));
  const who = { uid: g.uid, lid: g.lid, cmp: g.cmp, em: g.em, nm: g.nm, ln: g.ln, cn };
  const access_token = seal("access", { at: g.at, ...who }, ttl);
  const refresh_token = seal("refresh", { cid, rt: g.rt, ...who }, REFRESH_TTL);
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
    return issueTokens(res, c.cid, c.g, c.cn);
  }

  if (b.grant_type === "refresh_token") {
    const r = open("refresh", b.refresh_token);
    if (!r) return tokenError("invalid_grant", "Refresh token is invalid or expired");
    if (b.client_id && b.client_id !== r.cid) return tokenError("invalid_grant", "Refresh token was issued to another client");

    // Connections made before branded sign-in carry their own HighLevel refresh token.
    if (r.rt) {
      try {
        const t = await ghlToken({ grant_type: "refresh_token", refresh_token: r.rt });
        return issueTokens(res, r.cid, { ...r, at: t.access_token, rt: t.refresh_token, exp: now() + (Number(t.expires_in) || 86400) }, r.cn);
      } catch (e) {
        return tokenError("invalid_grant", e.message);
      }
    }

    // Branded sign-in: re-check the user, then get a fresh sub-account token from the agency.
    try {
      const user = await getUserById(r.uid);
      if (!userCanUseLocation(user, r.lid)) {
        await audit({ event: "reconnect_denied", user_id: r.uid, user_email: r.em, user_name: r.nm, location_id: r.lid, location_name: r.ln, company_id: r.cmp, error: "User removed or lost access to the sub-account", client: r.cn });
        return tokenError("invalid_grant", "You no longer have access to this sub-account. Sign in again.");
      }
      const t = await locationToken(r.lid);
      return issueTokens(res, r.cid, { ...r, at: t.at, exp: t.exp, rt: undefined }, r.cn);
    } catch (e) {
      if (e.status && [400, 401, 403, 404].includes(e.status)) return tokenError("invalid_grant", e.message);
      return tokenError("temporarily_unavailable", e.message, 503);
    }
  }

  tokenError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

const now = () => Math.floor(Date.now() / 1000);

function redirectWithError(res, uri, state, error, description) {
  const u = new URL(uri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  redirect(res, u.toString());
}
