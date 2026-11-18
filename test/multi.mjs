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

// An install that was set up properly except for one scope -- the shape of a real report,
// where every user permission looked right and sub-account task search still failed.
const WITHHELD_SCOPE = "locations/tasks.readonly";
const { GHL_SCOPES } = await import(`${REPO}/lib/ghl.js`);
const GRANTED_SCOPES = GHL_SCOPES.filter((s) => s !== WITHHELD_SCOPE).join(" ");

const perms = { contactsEnabled: true, opportunitiesEnabled: true, paymentsEnabled: true, settingsEnabled: true };
const USERS = {
  // Reaches three sub-accounts.
  multi: { id: "multi", roles: { type: "account", role: "admin", locationIds: ["loc1", "loc2", "loc3"] }, permissions: perms, scopes: [] },
  // Same connection, but access to loc2 was taken away in HighLevel.
  shrunk: { id: "shrunk", roles: { type: "account", role: "admin", locationIds: ["loc1"] }, permissions: perms, scopes: [] },
};
const NAMES = { loc1: "Acme", loc2: "Globex", loc3: "Initech" };

const seen = [];
const locRows = new Map(); // what the server stored in mcp_location
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
    // Both of these refuse the same way. The difference is that the app was granted the scope
    // one of them needs, and not the scope the other needs.
    if (/\/tasks\/search$/.test(u.pathname) || /\/customFields$/.test(u.pathname)) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ message: "This location does not have access" }));
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
      return res.end(JSON.stringify([{ company_id: "comp1", access_token: "agency-at", refresh_token: "r", scope: GRANTED_SCOPES, expires_at: new Date(Date.now() + 864e5).toISOString() }]));
    }
    // The sub-account token store, kept in memory here so a test can see what was written.
    if (u.pathname === "/rest/v1/mcp_location") {
      if (req.method === "POST") {
        for (const row of [].concat(JSON.parse(b))) locRows.set(row.location_id, row);
        res.statusCode = 201;
        return res.end("");
      }
      const want = (u.searchParams.get("location_id") || "").replace(/^eq\./, "");
      const row = locRows.get(want);
      return res.end(JSON.stringify(row ? [row] : []));
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

// The app's granted scopes are a separate gate from the user's permissions, and a missing one
// fails upstream at HighLevel with nothing on this side to explain it. whoami should say so.
ok(me.appScopes.granted === GHL_SCOPES.length - 1, "whoami: counts the scopes HighLevel actually granted");
ok(
  me.appScopes.missingCount === 1 && me.appScopes.missing[0] === WITHHELD_SCOPE,
  `whoami: names the one requested scope the install didn't grant (${me.appScopes.missing[0]})`
);
ok(!("missingNotShown" in me.appScopes), "whoami: a short missing list isn't truncated");
ok(/Marketplace app/.test(me.appScopes.note), "whoami: says where to fix a missing scope");

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

// ---------- a 401 caused by a scope the app never got ----------
// Both calls below are refused by the CRM with the same 401. Only one of them needs a scope this
// install wasn't granted, and only that one should be explained as an app problem -- otherwise the
// explanation would be noise on every unrelated 401.
const blocked = await call(single, "execute_operation", { operation: "locations.task-search", path: { locationId: "loc1" }, body: {} });
ok(blocked.err && new RegExp(WITHHELD_SCOPE).test(blocked.text), `401 on a scope the app lacks: names ${WITHHELD_SCOPE}`);
ok(/Marketplace app/.test(blocked.text) && /reinstall/.test(blocked.text), "401 on a scope the app lacks: says where it's fixed");
ok(/does not have access/.test(blocked.text), "401 on a scope the app lacks: keeps the CRM's own words too");

const granted = await call(single, "execute_operation", {
  operation: "locations.get-custom-fields",
  path: { locationId: "loc1" },
});
// Assert it really reached the CRM and got the 401, or the next check would pass for free.
ok(granted.err && /does not have access/.test(granted.text), "401 on a scope the app HAS: the call did reach the CRM");
ok(!/wasn't granted/.test(granted.text), "401 on a scope the app HAS: left as it is, not blamed on the app");

// ---------- the sub-account token store ----------
// Tokens are stored so a cold container and a quiet week don't each cost a mint. What matters
// is that the store can never hold a request back: a miss, a stale row or a dead database all
// have to end with a freshly minted token rather than an error.
const { forgetLocationTokens } = await import(`${REPO}/lib/agency.js`);
const mints = (lid) => seen.filter((r) => r.path === "/oauth/locationToken" && new URLSearchParams(r.body).get("locationId") === lid).length;

locRows.clear();
forgetLocationTokens();
const before = mints("loc2");
await call(every, "search_contacts", { query: "a", locationId: "loc2" });
ok(mints("loc2") === before + 1, "store: a sub-account with nothing stored is minted");
ok(locRows.get("loc2")?.access_token === "at-loc2", "store: and the minted token is written to mcp_location");
ok(new Date(locRows.get("loc2").expires_at).getTime() > Date.now(), "store: with the expiry it was minted with");

// A stored token is only worth having if it is actually used, and only safe if its expiry is
// honoured. Both are checked here by making the stored value something a mint would never give.
locRows.set("loc3", { location_id: "loc3", company_id: "comp1", access_token: "stored-loc3", expires_at: new Date(Date.now() + 864e5).toISOString() });
forgetLocationTokens();
const beforeStored = mints("loc3");
await call(every, "search_contacts", { query: "a", locationId: "loc3" });
ok(mints("loc3") === beforeStored, "store: a stored token that is still valid is used, not re-minted");

locRows.set("loc3", { location_id: "loc3", company_id: "comp1", access_token: "stale-loc3", expires_at: new Date(Date.now() - 1000).toISOString() });
forgetLocationTokens();
const beforeStale = mints("loc3");
await call(every, "search_contacts", { query: "a", locationId: "loc3" });
ok(mints("loc3") === beforeStale + 1, "store: an expired stored token is replaced, not handed out");
ok(locRows.get("loc3").access_token === "at-loc3", "store: and the replacement is what got written back");

// ---------- the daily cron ----------
const cron = (headers) => fetch("http://127.0.0.1:4031/cron/refresh", { headers });
delete process.env.CRON_SECRET;
ok((await cron({})).status === 503, "cron: shut, not open, when no secret is configured");
process.env.CRON_SECRET = "s3cret";
ok((await cron({})).status === 401, "cron: refuses a call with no secret");
ok((await cron({ Authorization: "Bearer wrong" })).status === 401, "cron: refuses the wrong secret");

locRows.clear();
forgetLocationTokens();
const ran = await cron({ Authorization: "Bearer s3cret" });
const body = await ran.json();
ok(ran.status === 200 && body.ok === true, "cron: runs with the right secret");
ok(body.subAccounts.installedSubAccounts === 3 && body.subAccounts.stored === 3,
  "cron: stores a token for every sub-account the app is installed in");
ok(["loc1", "loc2", "loc3"].every((l) => locRows.get(l)?.access_token === `at-${l}`),
  "cron: and each one is the sub-account's own token, not the agency's");
ok(typeof body.agency.expiresAt === "string", "cron: reports where the agency token now stands");
delete process.env.CRON_SECRET;

console.log(`\n${pass} checks passed`);
await new Promise((r) => process.stdout.write("", r)); // flush before exit
process.exit(0);
