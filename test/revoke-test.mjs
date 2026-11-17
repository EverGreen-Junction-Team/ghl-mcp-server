// Disconnect flow: real handler, mock HighLevel (4020) and mock Supabase (4022).
import http from "node:http";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Repo root: the first argument (relative is fine), else the directory above this test.
const REPO = pathToFileURL(
  process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(import.meta.dirname),
).href;
Object.assign(process.env, {
  TOKEN_SECRET: "y".repeat(40),
  GHL_API_BASE: "http://127.0.0.1:4020",
  BASE_URL: "http://127.0.0.1:4021",
  SUPABASE_URL: "http://127.0.0.1:4022",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
});

const user = { id: "u1", roles: { type: "account", role: "admin", locationIds: ["loc1"] }, permissions: { contactsEnabled: true }, scopes: [] };
http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url.startsWith("/users/")) return res.end(JSON.stringify(user));
  if (req.url.startsWith("/oauth/locationToken")) return res.end(JSON.stringify({ access_token: "fresh-at", expires_in: 86400 }));
  res.end("{}");
}).listen(4020);

const revoked = new Map();
const events = [];
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    res.setHeader("Content-Type", "application/json");
    if (u.pathname === "/rest/v1/mcp_revoked" && req.method === "GET") {
      const gid = (u.searchParams.get("gid") || "").replace(/^eq\./, "");
      return res.end(JSON.stringify(revoked.has(gid) ? [{ gid }] : []));
    }
    if (u.pathname === "/rest/v1/mcp_revoked" && req.method === "POST") {
      const row = JSON.parse(b);
      revoked.set(row.gid, row);
      res.statusCode = 201;
      return res.end("");
    }
    if (u.pathname === "/rest/v1/mcp_audit_log") { events.push(JSON.parse(b).event); res.statusCode = 201; return res.end(""); }
    if (u.pathname === "/rest/v1/mcp_agency") return res.end(JSON.stringify([{ company_id: "c1", access_token: "agency", refresh_token: "r", expires_at: new Date(Date.now() + 864e5).toISOString() }]));
    res.end("[]");
  });
}).listen(4022);

const { seal, sha256url } = await import(`${REPO}/lib/seal.js`);
const { default: handler } = await import(`${REPO}/api/index.js`);
await new Promise((r) => http.createServer(handler).listen(4021, r));
const B = "http://127.0.0.1:4021";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok -", m); };

async function signIn() {
  const reg = await fetch(B + "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" }) }).then((r) => r.json());
  const verifier = crypto.randomBytes(32).toString("base64url");
  const code = seal("code", { cid: reg.client_id, ru: "https://claude.ai/api/mcp/auth_callback", cc: sha256url(verifier), cn: "Claude",
    g: { at: "ghl-at", exp: Math.floor(Date.now() / 1000) + 86400, uid: "u1", lid: "loc1", cmp: "c1", em: "a@b.c", nm: "A", ln: "Loc" } }, 300);
  const t = await fetch(B + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback" }) }).then((r) => r.json());
  return { ...t, client_id: reg.client_id };
}
const mcp = (at) => fetch(B + "/mcp", { method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
const refresh = (t) => fetch(B + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id }) });
const revoke = (body, form = true) => fetch(B + "/revoke", { method: "POST", headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" }, body: form ? new URLSearchParams(body) : JSON.stringify(body) });

const meta = await fetch(B + "/.well-known/oauth-authorization-server").then((r) => r.json());
ok(meta.revocation_endpoint === B + "/revoke", "metadata advertises revocation_endpoint");

// 1. Revoke with the refresh token (what clients normally send)
const t1 = await signIn();
ok((await mcp(t1.access_token)).status === 200, "signed-in connection works");
const r2 = await refresh(t1);
const t1b = { ...(await r2.json()), client_id: t1.client_id };
ok(r2.status === 200 && t1b.access_token, "refresh works before disconnect");
const rv = await revoke({ token: t1.refresh_token, token_type_hint: "refresh_token", client_id: t1.client_id });
ok(rv.status === 200, "revoke answers 200");
ok(revoked.size === 1, "sign-in saved in mcp_revoked");
ok((await mcp(t1.access_token)).status === 401, "old access token now 401");
ok((await mcp(t1b.access_token)).status === 401, "access token from an earlier refresh also 401 (same sign-in)");
const r3 = await refresh(t1);
ok(r3.status === 400 && (await r3.json()).error === "invalid_grant", "refresh after disconnect -> invalid_grant");
ok(events.includes("disconnected"), "audit log has a 'disconnected' event");

// 2. Revoke with the access token, JSON body
const t2 = await signIn();
ok((await revoke({ token: t2.access_token, token_type_hint: "access_token" }, false)).status === 200, "revoke by access token (JSON) -> 200");
ok((await mcp(t2.access_token)).status === 401 && (await refresh(t2)).status === 400, "access + refresh cut off");

// 3. Another server instance revoked it (only in the DB): still blocked
const t3 = await signIn();
const { open } = await import(`${REPO}/lib/seal.js`);
revoked.set(open("access", t3.access_token).gid, {});
ok((await mcp(t3.access_token)).status === 401, "revocation saved by another instance is honoured");

// 4. Other sign-ins unaffected; junk and old tokens are fine
const t4 = await signIn();
ok((await mcp(t4.access_token)).status === 200, "other sign-ins keep working");
ok((await revoke({ token: "garbage" })).status === 200, "unknown token -> 200 (RFC 7009)");
ok((await revoke({})).status === 200, "no token -> 200");
const legacy = seal("access", { at: "ghl-at", uid: "u1", lid: "loc1" }, 3600);
ok((await revoke({ token: legacy })).status === 200 && (await mcp(legacy)).status === 401, "connection made before grant ids can still be disconnected");
const legacy2 = seal("access", { at: "ghl-at", uid: "u2", lid: "loc1" }, 3600);
ok((await mcp(legacy2)).status === 200, "another user's old connection is unaffected");
ok((await fetch(B + "/revoke")).status === 404, "GET /revoke not allowed");

console.log(`\n${pass} checks passed`);
await new Promise((r) => process.stdout.write("", r)); // flush before exit
process.exit(0);
