// Connections spanning several sub-accounts: real handler, mock HighLevel (4030), mock Supabase (4032).
import http from "node:http";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Repo root: the first argument (relative is fine), else the directory above this test.
const REPO = pathToFileURL(
  process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(import.meta.dirname),
).href;
Object.assign(process.env, {
  TOKEN_SECRET: "z".repeat(40),
  GHL_API_BASE: "http://127.0.0.1:4030",
  BASE_URL: "http://127.0.0.1:4031",
  SUPABASE_URL: "http://127.0.0.1:4032",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  GHL_CLIENT_ID: "app123-xyz",
});

const perms = { contactsEnabled: true, opportunitiesEnabled: true, paymentsEnabled: true, settingsEnabled: true };
const USERS = {
  // Reaches three sub-accounts.
  multi: { id: "multi", roles: { type: "account", role: "admin", locationIds: ["loc1", "loc2", "loc3"] }, permissions: perms, scopes: [] },
  // Same connection, but access to loc2 was taken away in HighLevel.
  shrunk: { id: "shrunk", roles: { type: "account", role: "admin", locationIds: ["loc1"] }, permissions: perms, scopes: [] },
};
const NAMES = { loc1: "Acme", loc2: "Globex", loc3: "Initech" };

const seen = [];
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body: b });
    res.setHeader("Content-Type", "application/json");
    const m = u.pathname.match(/^\/users\/(.+)$/);
    if (m && req.method === "GET") return res.end(JSON.stringify(USERS[m[1]]));
    if (u.pathname === "/oauth/locationToken") {
      const lid = new URLSearchParams(b).get("locationId");
      return res.end(JSON.stringify({ access_token: `at-${lid}`, expires_in: 86400 }));
    }
    if (u.pathname === "/oauth/installedLocations") {
      return res.end(JSON.stringify({ locations: Object.entries(NAMES).map(([id, name]) => ({ _id: id, name, isInstalled: true })) }));
    }
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(4030);

http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    res.setHeader("Content-Type", "application/json");
    if (u.pathname === "/rest/v1/mcp_agency") {
      return res.end(JSON.stringify([{ company_id: "comp1", access_token: "agency-at", refresh_token: "r", expires_at: new Date(Date.now() + 864e5).toISOString() }]));
    }
    if (req.method === "POST") { res.statusCode = 201; return res.end(""); }
    res.end("[]");
  });
}).listen(4032);

const { seal } = await import(`${REPO}/lib/seal.js`);
const { default: handler } = await import(`${REPO}/api/index.js`);
await new Promise((r) => http.createServer(handler).listen(4031, r));

let pass = 0, n = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok -", m); };

// `extra` is what sign-in put in the grant: nothing (one sub-account), `ls` (a chosen set) or `all`.
const tokenFor = (uid, extra = {}) =>
  seal("access", { at: "at-loc1", uid, lid: "loc1", ln: "Acme", cmp: "comp1", ...extra }, 3600);

async function rpc(token, method, params) {
  const r = await fetch("http://127.0.0.1:4031/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const call = async (token, name, args) => {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const text = r.content[0].text;
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { err: !!r.isError, data, text };
};
const lastTo = (pathPart) => [...seen].reverse().find((s) => s.path.includes(pathPart));

const PAIR = { ls: [["loc1", "Acme"], ["loc2", "Globex"]] };

// ---------- one sub-account: unchanged ----------
const single = tokenFor("multi");
const singleTools = (await rpc(single, "tools/list")).tools;
ok(!singleTools.find((t) => t.name === "search_contacts").inputSchema.properties.locationId,
  "one sub-account: tools take no locationId");
ok((await call(single, "search_contacts", { query: "a" })).err === false, "one sub-account: read works");
ok((await call(single, "search_contacts", { query: "a", locationId: "loc2" })).text.includes("only works with sub-account loc1"),
  "one sub-account: another locationId is refused");

// ---------- several sub-accounts ----------
const pair = tokenFor("multi", PAIR);
const pairTools = (await rpc(pair, "tools/list")).tools;
const readTool = pairTools.find((t) => t.name === "search_contacts");
const writeTool = pairTools.find((t) => t.name === "create_contact");
ok(readTool.inputSchema.properties.locationId && !(readTool.inputSchema.required || []).includes("locationId"),
  "several: reads offer locationId, optional");
ok((writeTool.inputSchema.required || []).includes("locationId"),
  "several: writes require locationId in the schema");

await call(pair, "search_contacts", { query: "a" });
ok(lastTo("/contacts").auth === "Bearer at-loc1", "several: a read with no locationId uses the main sub-account");

await call(pair, "search_contacts", { query: "a", locationId: "loc2" });
ok(lastTo("/contacts").auth === "Bearer at-loc2", "several: a read names another sub-account and gets its token");

const noWhere = await call(pair, "create_contact", { firstName: "A", email: "a@b.c" });
ok(noWhere.err && /needs locationId/.test(noWhere.text) && /Globex/.test(noWhere.text),
  "several: a write with no locationId is refused, and names the options");

const wrote = await call(pair, "create_contact", { firstName: "A", email: "a@b.c", locationId: "loc2" });
ok(!wrote.err && lastTo("/contacts").auth === "Bearer at-loc2", "several: a write in a named sub-account works");
ok(JSON.parse(lastTo("/contacts").body).locationId === "loc2", "several: the body carries the chosen sub-account");

const outside = await call(pair, "search_contacts", { query: "a", locationId: "loc3" });
ok(outside.err && /can't use sub-account "loc3"/.test(outside.text), "several: a sub-account outside the connection is refused");

// ---------- all sub-accounts ----------
const every = tokenFor("multi", { all: true });
await call(every, "search_contacts", { query: "a", locationId: "loc3" });
ok(lastTo("/contacts").auth === "Bearer at-loc3", "all: reaches a sub-account that was never named at sign-in");

const lost = tokenFor("shrunk", { all: true });
const gone = await call(lost, "search_contacts", { query: "a", locationId: "loc2" });
ok(gone.err && /can't use sub-account/.test(gone.text), "all: follows the user losing access in HighLevel");

// ---------- listing ----------
const listed = (await call(pair, "list_locations")).data;
ok(listed.subAccounts.map((l) => l.id).join(",") === "loc1,loc2" && listed.default === "loc1",
  "list_locations: names the connection's sub-accounts and its default");
const listedAll = (await call(every, "list_locations")).data;
ok(listedAll.subAccounts.length === 3, "list_locations: 'all' lists every installed sub-account the user reaches");
const shrunkList = (await call(tokenFor("shrunk", PAIR), "list_locations")).data;
ok(shrunkList.subAccounts.map((l) => l.id).join(",") === "loc1", "list_locations: leaves out ones the user lost");

const me = (await call(pair, "whoami")).data;
ok(me.connectedSubAccounts.length === 2 && me.locationName === "Acme", "whoami: reports the connected sub-accounts");
ok(!(await call(single, "whoami")).data.connectedSubAccounts, "whoami: says nothing extra for one sub-account");

// ---------- catalog operations ----------
const exec = await call(pair, "execute_operation", {
  operation: "contacts.get-contacts", query: { limit: 1 }, locationId: "loc2",
});
ok(!exec.err && lastTo("/contacts").auth === "Bearer at-loc2", "execute_operation: runs in the named sub-account");
ok(lastTo("/contacts").query.locationId === "loc2", "execute_operation: pins the query to that sub-account, not the default");

const execCross = await call(pair, "execute_operation", {
  operation: "contacts.get-contacts", query: { limit: 1, locationId: "loc1" }, locationId: "loc2",
});
ok(execCross.err && /isn't allowed/.test(execCross.text), "execute_operation: a mismatched locationId inside the call is refused");

// ---------- the sign-in page: picking the set ----------
const { open } = await import(`${REPO}/lib/seal.js`);
const verified = (locs) => seal("verified", {
  p: { cid: "c1", ru: "https://claude.ai/api/mcp/auth_callback", cc: "x", cn: "Claude" },
  em: "a@b.c", uid: "multi", nm: "Multi", cmp: "comp1", locs,
}, 600);
const ALL3 = Object.entries(NAMES).map(([id, name]) => ({ id, name }));

async function pick(form) {
  const r = await fetch("http://127.0.0.1:4031/authorize", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const loc = r.headers.get("location");
  const code = loc && new URL(loc).searchParams.get("code");
  return { status: r.status, grant: code ? open("code", code).g : null, html: code ? "" : await r.text() };
}

const two = await pick(`step=location&v=${encodeURIComponent(verified(ALL3))}&lid=loc1&lid=loc3`);
ok(two.grant && JSON.stringify(two.grant.ls) === JSON.stringify([["loc1", "Acme"], ["loc3", "Initech"]]),
  "sign-in: ticking two sub-accounts puts both in the connection");
ok(two.grant.lid === "loc1" && two.grant.at === "at-loc1", "sign-in: the first ticked one becomes the default");

const one = await pick(`step=location&v=${encodeURIComponent(verified(ALL3))}&lid=loc2`);
ok(one.grant && !one.grant.ls && !one.grant.all && one.grant.lid === "loc2",
  "sign-in: ticking one keeps the old single-sub-account shape");

const everyPick = await pick(`step=location&v=${encodeURIComponent(verified(ALL3))}&all=1`);
ok(everyPick.grant && everyPick.grant.all === true && !everyPick.grant.ls,
  "sign-in: 'all' stores a flag, not a list");

const none = await pick(`step=location&v=${encodeURIComponent(verified(ALL3))}`);
ok(none.status === 400 && /Choose at least one/.test(none.html), "sign-in: ticking nothing asks again");

const sneaky = await pick(`step=location&v=${encodeURIComponent(verified([{ id: "loc1", name: "Acme" }]))}&lid=loc1&lid=loc2`);
ok(sneaky.grant && !sneaky.grant.ls && sneaky.grant.lid === "loc1",
  "sign-in: a sub-account the user can't reach is dropped, not connected");

console.log(`\n${pass} checks passed`);
await new Promise((r) => process.stdout.write("", r)); // flush before exit
process.exit(0);
