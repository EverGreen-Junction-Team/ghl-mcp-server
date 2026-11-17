// End-to-end test: real MCP handler against a mock HighLevel API.
import http from "node:http";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Repo root: the first argument (relative is fine), else the directory above this test.
const REPO = pathToFileURL(
  process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(import.meta.dirname),
).href;
process.env.TOKEN_SECRET = "x".repeat(40);
process.env.GHL_API_BASE = "http://127.0.0.1:4010";
process.env.BASE_URL = "http://127.0.0.1:4011";

const all = (on) => Object.fromEntries(["contactsEnabled","opportunitiesEnabled","conversationsEnabled","appointmentsEnabled","invoiceEnabled","paymentsEnabled","settingsEnabled","socialPlanner","marketingEnabled","workflowsEnabled","botService","funnelsEnabled","tagsEnabled","bloggingEnabled","phoneCallEnabled"].map((k) => [k, on]));
const USERS = {
  admin: { id: "admin", roles: { type: "account", role: "admin", locationIds: ["loc1"] }, permissions: all(true), scopes: [] },
  sales: {
    id: "sales", roles: { type: "account", role: "user", locationIds: ["loc1"] },
    permissions: { contactsEnabled: true, opportunitiesEnabled: true, invoiceEnabled: true, paymentsEnabled: false },
    scopes: ["contacts.write", "invoices.readonly"],
  },
  assigned: { id: "assigned", roles: { type: "account", role: "user", locationIds: ["loc1"] }, permissions: { contactsEnabled: true, assignedDataOnly: true }, scopes: ["contacts.write"] },
  assignedOpp: {
    id: "assignedOpp", roles: { type: "account", role: "user", locationIds: ["loc1"] },
    permissions: { contactsEnabled: true, opportunitiesEnabled: true, assignedDataOnly: true },
    scopes: ["contacts.write", "opportunities.write"],
  },
  scoped: {
    id: "scoped", roles: { type: "account", role: "admin", locationIds: ["loc1"] },
    permissions: { contactsEnabled: true },
    scopes: ["contacts.write"],
    scopesAssignedToOnly: ["contacts.write"],
  },
  assignedCal: {
    id: "assignedCal", roles: { type: "account", role: "user", locationIds: ["loc1"] },
    permissions: { appointmentsEnabled: true, assignedDataOnly: true },
    scopes: ["calendars/events.write"],
  },
  shop: { id: "shop", roles: { type: "account", role: "user", locationIds: ["loc1"] }, permissions: { paymentsEnabled: true }, scopes: ["products.readonly", "products.write"] },
  shopdel: { id: "shopdel", roles: { type: "account", role: "user", locationIds: ["loc1"] }, permissions: { paymentsEnabled: true }, scopes: ["products.readonly", "products.write", "products.delete"] },
};

const seen = [];
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), version: req.headers.version, body: b ? JSON.parse(b) : undefined });
    const m = u.pathname.match(/^\/users\/(.+)$/);
    res.setHeader("Content-Type", "application/json");
    if (u.pathname === "/users/" && req.method === "GET") {
      return res.end(JSON.stringify({ users: [
        { id: "admin", name: "Ada Admin", email: "ada@x.test", roles: { role: "admin" } },
        { id: "sales", name: "Sam Sales", email: "sam@x.test", roles: { role: "user" } },
        { id: "gone", name: "Old User", email: "old@x.test", deleted: true },
      ] }));
    }
    if (u.pathname.startsWith("/contacts/c-mine")) return res.end(JSON.stringify({ contact: { id: "c-mine", assignedTo: "assigned" } }));
    if (u.pathname.startsWith("/opportunities/o-mine")) return res.end(JSON.stringify({ opportunity: { id: "o-mine", assignedTo: "assignedOpp", pipelineId: "p1" } }));
    if (u.pathname.startsWith("/opportunities/o-theirs")) return res.end(JSON.stringify({ opportunity: { id: "o-theirs", assignedTo: "someone", pipelineId: "p1" } }));
    if (u.pathname.startsWith("/calendars/events/appointments/ap-mine")) return res.end(JSON.stringify({ appointment: { id: "ap-mine", assignedUserId: "assignedCal", calendarId: "cal1" } }));
    if (u.pathname.startsWith("/calendars/events/appointments/ap-theirs")) return res.end(JSON.stringify({ appointment: { id: "ap-theirs", assignedUserId: "someone", calendarId: "cal1" } }));
    if (m && req.method === "GET") return res.end(JSON.stringify(USERS[m[1]]));
    if (u.pathname.startsWith("/contacts/c-other")) return res.end(JSON.stringify({ contact: { id: "c-other", assignedTo: "someone" } }));
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(4010);

const { seal } = await import(`${REPO}/lib/seal.js`);
const { default: handler } = await import(`${REPO}/api/index.js`);
await new Promise((r) => http.createServer(handler).listen(4011, r));

let n = 0;
async function rpc(user, method, params) {
  const token = seal("access", { at: "ghl-at", uid: user, lid: "loc1", cmp: "comp1" }, 3600);
  const r = await fetch("http://127.0.0.1:4011/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const call = async (user, name, args) => {
  const r = await rpc(user, "tools/call", { name, arguments: args });
  const text = r.content[0].text;
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { err: !!r.isError, data, text };
};
const last = () => seen[seen.length - 1];
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log("  ok -", msg); };

const tl = await rpc("sales", "tools/list", {});
const names = tl.tools.map((t) => t.name);
ok(["search_operations", "describe_operation", "execute_operation"].every((x) => names.includes(x)), "meta tools listed");
ok(!names.includes("create_opportunity"), "sales has no opportunities.write -> create_opportunity hidden (existing behaviour)");
ok(tl.tools.find((t) => t.name === "execute_operation").annotations.destructiveHint === true, "execute_operation is marked destructive");

// Clients connect to this as EverGreen Junction and shouldn't be shown the CRM behind it.
// tools/list is the most visible surface -- its descriptions end up in the approval dialog.
const VENDOR = /highlevel|gohighlevel|leadconnector/i;
const leaky = tl.tools.filter((t) => VENDOR.test(`${t.description || ""} ${JSON.stringify(t.inputSchema)}`));
ok(leaky.length === 0, `no tool description names the CRM behind the connector${leaky.length ? ": " + leaky.map((t) => t.name).join(", ") : ""}`);
const init = await rpc("sales", "initialize", {});
ok(!VENDOR.test(init.instructions || ""), "the server's own instructions don't name it either");

// Upstream error text is the CRM's own words and reaches the client verbatim, so it is the one
// place a vendor name can arrive without passing through any string in this repo.
const { deVendor } = await import(`${REPO}/lib/ghl.js`);
ok(deVendor("Invalid HighLevel location id") === "Invalid EverGreen Junction location id", "an upstream error naming the CRM is relabelled");
ok(!VENDOR.test(deVendor("See https://highlevel.stoplight.io/docs/x for details")), "an upstream error linking to the CRM drops the link");
ok(deVendor("Contact not found") === "Contact not found", "an upstream error that names nothing is left alone");

const areasSales = await call("sales", "search_operations", {});
const areasAdmin = await call("admin", "search_operations", {});
console.log("  sales areas:", JSON.stringify(areasSales.data.areas), "count", areasSales.data.availableOperations, "| admin count", areasAdmin.data.availableOperations);
ok(areasSales.data.areas.invoices.write === 0 && areasSales.data.areas.proposals.write === 0, "sales: invoices and proposals are view-only");
ok(!areasSales.data.areas.payments && !areasSales.data.areas.products, "sales: no payments/products (paymentsEnabled off)");
ok(areasSales.data.areas.contacts.write > 0, "sales: contacts writable via contacts.write");
ok(!areasSales.data.areas.users || areasSales.data.areas.users.write === 0, "sales: cannot change users");
ok(areasAdmin.data.availableOperations > 300, "admin sees most of the catalog");

const s1 = await call("sales", "search_operations", { query: "create invoice" });
ok(s1.data.operations.every((o) => !(o.access === "write" && /^(invoices|proposals)\./.test(o.id))), "sales search create invoice returns no invoice/proposal write ops");
const s2 = await call("admin", "search_operations", { query: "create invoice" });
ok(s2.data.operations.some((o) => o.id === "invoices.create-invoice"), "admin search finds invoices.create-invoice");
const s3 = await call("admin", "search_operations", { query: "move deal to stage" });
console.log("  'move deal to stage' ->", s3.data.operations.slice(0, 4).map((o) => o.id).join(", "));
ok(s3.data.operations[0].id.startsWith("opportunities."), "synonym deal -> opportunities ranked first");

const d1 = await call("sales", "describe_operation", { operation: "invoices.create-invoice" });
ok(d1.err && /edit access/.test(d1.text), "sales describe create-invoice is denied: " + d1.text);
const d2 = await call("sales", "describe_operation", { operation: "invoices.list-invoices" });
ok(!d2.err && d2.data.filledInAutomatically.includes("altId") && !d2.data.queryParameters.some((p) => p.name === "altId"), "describe hides pinned altId");

const e1 = await call("sales", "execute_operation", { operation: "invoices.list-invoices", query: { limit: "5", offset: "0" } });
ok(!e1.err && last().path === "/invoices/" && last().query.altId === "loc1" && last().query.altType === "location" && last().version === "2021-07-28", "list invoices pinned to loc1: " + JSON.stringify(last()));
const e2 = await call("sales", "execute_operation", { operation: "invoices.list-invoices", query: { altId: "loc-evil", limit: "5", offset: "0" } });
ok(e2.err && /only works with sub-account loc1/.test(e2.text), "other sub-account in query refused");
const e3 = await call("sales", "execute_operation", { operation: "invoices.list-invoices", query: { nope: 1 } });
ok(e3.err && /Unknown query parameter/.test(e3.text), "unknown query param refused");

const before = seen.length;
const e4 = await call("admin", "execute_operation", { operation: "contacts.delete-contact", path: { contactId: "c1" } });
ok(e4.err && /confirm/.test(e4.text) && !seen.slice(before).some((r) => r.method === "DELETE"), "delete without confirm refused, nothing sent");
const e5 = await call("admin", "execute_operation", { operation: "contacts.delete-contact", path: { contactId: "c1" }, confirm: true });
ok(!e5.err && last().method === "DELETE" && last().path === "/contacts/c1", "delete with confirm sent");

const e6 = await call("admin", "execute_operation", { operation: "contacts.create-contact", body: { firstName: "A", locationId: "evil" } });
ok(e6.err && /only works with sub-account/.test(e6.text), "body locationId for other sub-account refused");
const e7 = await call("admin", "execute_operation", { operation: "contacts.create-contact", body: { firstName: "A" } });
ok(!e7.err && last().body.locationId === "loc1" && last().method === "POST", "body locationId filled with loc1");

const e8 = await call("admin", "execute_operation", { operation: "locations.get-location", path: { locationId: "other" } });
ok(e8.err, "path locationId for other sub-account refused");
const e9 = await call("admin", "execute_operation", { operation: "locations.get-location" });
ok(!e9.err && last().path === "/locations/loc1", "path locationId filled in");

const a1 = await call("assigned", "execute_operation", { operation: "contacts.get-contact", path: { contactId: "c1" } });
ok(a1.err && /assigned to you/.test(a1.text), "assigned-only user can't use catalog contacts");
const a2 = await call("assigned", "get_contact", { contactId: "c-other" });
ok(a2.err && /assigned to you/.test(a2.text), "built-in get_contact still enforces assignment");

const p1 = await call("shop", "execute_operation", { operation: "products.delete-product-by-id", path: { productId: "p1" }, confirm: true });
ok(p1.err && /products.delete/.test(p1.text), "products.write without products.delete can't delete: " + p1.text);
const p2 = await call("shopdel", "execute_operation", { operation: "products.delete-product-by-id", path: { productId: "p1" }, confirm: true });
ok(!p2.err && last().method === "DELETE" && last().query.locationId === "loc1", "products.delete user can delete");

const w = await call("sales", "whoami", {});
ok(typeof w.data.catalogOperationsAvailable === "number", "whoami reports catalog count: " + w.data.catalogOperationsAvailable);
// There is no agency row to read here. whoami is what people reach for when something is
// already wrong, so a scope check it can't make must not take the whole tool down with it.
ok(w.data.appScopes.granted === null && typeof w.data.appScopes.note === "string", "whoami still answers when the app's scopes can't be read");

// ---------- assigning records to people ----------
const u1 = await call("admin", "list_users", {});
ok(u1.data.users.length === 2 && !u1.data.users.find((x) => x.id === "gone"), "list_users: lists live users only");
ok((await call("admin", "list_users", { query: "sam@" })).data.users.map((x) => x.id).join() === "sales", "list_users: filters by email");

await call("admin", "update_contact", { contactId: "c1", assignedTo: "sales" });
ok(last().method === "PUT" && last().body.assignedTo === "sales", "update_contact: sets the owner");

await call("admin", "create_contact", { firstName: "A", assignedTo: "sales" });
ok(last().body.assignedTo === "sales", "create_contact: sets the owner");

await call("admin", "update_opportunity", { opportunityId: "o-theirs", pipelineStageId: "s2" });
ok(last().method === "PUT" && last().path === "/opportunities/o-theirs" && last().body.pipelineStageId === "s2", "update_opportunity: moves the deal to another stage");
ok(last().body.pipelineId === "p1", "update_opportunity: fills in the pipeline a stage move needs");

await call("admin", "update_opportunity", { opportunityId: "o-theirs", assignedTo: "sales", status: "won" });
ok(last().body.assignedTo === "sales" && last().body.status === "won", "update_opportunity: sets owner and status");

const nothing = await call("admin", "update_opportunity", { opportunityId: "o-theirs" });
ok(nothing.err && /Nothing to change/.test(nothing.text), "update_opportunity: refuses an empty update");

// a user limited to their own records: the limit is which records they can touch,
// not which fields they can set, so they can hand over one they hold.
await call("assigned", "update_contact", { contactId: "c-mine", assignedTo: "sales" });
ok(last().method === "PUT" && last().path === "/contacts/c-mine" && last().body.assignedTo === "sales",
  "assigned-only: can hand a contact they hold to someone else");
const notTheirs = await call("assigned", "update_contact", { contactId: "c1", assignedTo: "sales" });
ok(notTheirs.err && /only change contacts assigned to you/.test(notTheirs.text),
  "assigned-only: still can't touch a contact that isn't theirs");
await call("assigned", "create_contact", { firstName: "A", assignedTo: "sales" });
ok(last().body.assignedTo === "sales", "assigned-only: can create a contact for someone else");
await call("assigned", "create_contact", { firstName: "A" });
ok(last().body.assignedTo === "assigned", "assigned-only: new contacts still come to them by default");
const notMine = await call("assignedOpp", "update_opportunity", { opportunityId: "o-theirs", status: "won" });
ok(notMine.err && /only change opportunities assigned to you/.test(notMine.text), "assigned-only: can't change someone else's deal");
await call("assignedOpp", "update_opportunity", { opportunityId: "o-mine", status: "won" });
ok(last().method === "PUT" && last().body.status === "won", "assigned-only: can change their own deal");
await call("assignedOpp", "update_opportunity", { opportunityId: "o-mine", assignedTo: "sales" });
ok(last().body.assignedTo === "sales", "assigned-only: can hand a deal they hold to someone else");

// ---------- appointments ----------
const calTools = (await rpc("assignedCal", "tools/list")).tools.map((t) => t.name);
ok(calTools.includes("create_appointment") && calTools.includes("update_appointment"),
  "appointments: an assigned-only calendars user gets the write tools");

await call("admin", "create_appointment", { calendarId: "cal1", contactId: "c1", startTime: "2026-11-20T09:00:00+00:00", title: "Survey" });
ok(last().method === "POST" && last().path === "/calendars/events/appointments", "create_appointment: posts to the appointments endpoint");
ok(last().body.locationId === "loc1" && last().body.calendarId === "cal1" && last().body.contactId === "c1" && last().body.title === "Survey",
  "create_appointment: carries the sub-account, calendar, contact and title");

await call("admin", "update_appointment", { appointmentId: "ap-theirs", startTime: "2026-11-21T10:00:00+00:00" });
ok(last().method === "PUT" && last().path === "/calendars/events/appointments/ap-theirs" && last().body.startTime === "2026-11-21T10:00:00+00:00",
  "update_appointment: reschedules");

await call("admin", "update_appointment", { appointmentId: "ap-theirs", appointmentStatus: "cancelled" });
ok(last().method === "PUT" && last().body.appointmentStatus === "cancelled", "update_appointment: cancels by status, not by deleting");

const emptyAppt = await call("admin", "update_appointment", { appointmentId: "ap-theirs" });
ok(emptyAppt.err && /Nothing to change/.test(emptyAppt.text), "update_appointment: refuses an empty update");

const otherAppt = await call("assignedCal", "update_appointment", { appointmentId: "ap-theirs", startTime: "2026-11-21T10:00:00+00:00" });
ok(otherAppt.err && /only change appointments assigned to you/.test(otherAppt.text),
  "assigned-only: can't touch an appointment that isn't theirs");

await call("assignedCal", "update_appointment", { appointmentId: "ap-mine", startTime: "2026-11-21T10:00:00+00:00" });
ok(last().method === "PUT" && last().path === "/calendars/events/appointments/ap-mine", "assigned-only: can reschedule their own appointment");

await call("assignedCal", "update_appointment", { appointmentId: "ap-mine", assignedUserId: "sales" });
ok(last().body.assignedUserId === "sales", "assigned-only: can hand an appointment they hold to someone else");

await call("assignedCal", "create_appointment", { calendarId: "cal1", contactId: "c1", startTime: "2026-11-20T09:00:00+00:00" });
ok(last().body.assignedUserId === "assignedCal", "assigned-only: new appointments come to them by default");

// ---------- what a refusal actually says ----------
const refused = await call("scoped", "update_contact", { contactId: "c-other", firstName: "X" });
ok(refused.err, "scope-limited user: refused on someone else's contact");
ok(/user someone/.test(refused.text), "refusal: names who holds the record");
ok(/contacts\.write/.test(refused.text) && /assigned-only/.test(refused.text), "refusal: names the HighLevel setting behind it");
ok(/list_users/.test(refused.text), "refusal: says how to find out who that is");
ok(/can only change/.test(refused.text) && !/only access/.test(refused.text), "refusal: says change, not access");

const unseen = await call("assigned", "get_contact", { contactId: "c-other" });
ok(/can only see/.test(unseen.text) && /only assigned data/.test(unseen.text),
  "refusal on a read: says see, and names the blanket setting");

console.log(`\n${pass} checks passed`);
await new Promise((r) => process.stdout.write("", r)); // flush before exit
process.exit(0);
