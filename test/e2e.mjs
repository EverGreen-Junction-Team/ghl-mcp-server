// End-to-end test: real MCP handler against a mock HighLevel API.
import http from "node:http";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Repo root: the first argument (relative is fine), else the directory above this test.
const REPO = pathToFileURL(
  process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(import.meta.dirname),
).href;
// "Assigned only" enforcement is off as shipped (see lib/assigned.js), so this file runs twice:
// once as it ships, and once with ENFORCE_ASSIGNED_ONLY=true. Both halves are checked, because
// the gate still exists and turning it back on has to keep working.
const ENFORCING = process.env.ENFORCE_ASSIGNED_ONLY === "true";
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
    // Before the contact routes below, which match any path under a contact id.
    if (/^\/contacts\/[^/]+\/notes/.test(u.pathname) && req.method === "GET") {
      return res.end(JSON.stringify({ notes: [{ id: "n1", body: "Called him back", userId: "sales" }] }));
    }
    if (/^\/contacts\/[^/]+\/tasks/.test(u.pathname) && req.method === "GET") {
      return res.end(JSON.stringify({ tasks: [{ id: "t1", title: "Chase the survey", dueDate: "2026-11-25T11:00:00Z", completed: false, assignedTo: "sales" }] }));
    }
    if (/^\/contacts\/[^/]+\/(notes|tasks)/.test(u.pathname)) return res.end(JSON.stringify({ ok: true }));
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
// Reading a custom field's definition is reading the shape of a record, which HighLevel shows to
// anyone who can open one. Creating or changing a field is still a settings job, and admin-only.
const { checkOperation } = await import(`${REPO}/lib/access.js`);
const { OPERATIONS: CAT } = await import(`${REPO}/lib/catalog.generated.js`);
const op = (id) => CAT.find((o) => o.id === id);
const settingsNotAdmin = { permissions: { settingsEnabled: true }, roles: { role: "user" } };
ok(checkOperation(op("locations.get-custom-fields"), USERS.sales).ok, "custom fields: a user without settings can read the definitions");
const cfWrite = checkOperation(op("locations.create-custom-field"), USERS.sales);
ok(!cfWrite.ok && /settingsEnabled/.test(cfWrite.reason), "custom fields: that same user still can't create one");
ok(!checkOperation(op("locations.delete-custom-field"), USERS.sales).ok, "custom fields: nor delete one");
const cfAdminOnly = checkOperation(op("locations.update-custom-field"), settingsNotAdmin);
ok(!cfAdminOnly.ok && /admins/.test(cfAdminOnly.reason), "custom fields: settings alone isn't enough to change one, still admin-only");
ok(checkOperation(op("locations.create-custom-field"), USERS.admin).ok, "custom fields: an admin with settings can still create one");
// The relaxation is for field definitions only; custom VALUES hold data, not shape.
ok(!checkOperation(CAT.find((o) => o.resource === "locations/customValues" && o.access === "read"), USERS.sales).ok,
  "custom values stay behind settingsEnabled: the relaxation didn't spread");

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
const a2 = await call("assigned", "get_contact", { contactId: "c-other" });
if (ENFORCING) {
  ok(a1.err && /assigned to you/.test(a1.text), "enforced: assigned-only user can't use catalog contacts");
  ok(a2.err && /assigned to you/.test(a2.text), "enforced: built-in get_contact still enforces assignment");
} else {
  // The reason the gate is off: it took the catalog away from a user whose permissions and
  // scopes were in order, on their own records as much as anyone else's.
  ok(!a1.err, "as shipped: an assigned-only user reaches the catalog: " + a1.text);
  ok(!a2.err, "as shipped: an assigned-only user reads a colleague's contact: " + a2.text);
}

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

// Custom fields ride on the same opportunities.write as the rest of the update, so they widen
// nothing -- but they are the only way to set Client type, Product type and the like.
await call("admin", "update_opportunity", {
  opportunityId: "o-theirs",
  customFields: [{ key: "client_type", field_value: "Homeowner" }, { id: "cf1", field_value: ["a", "b"] }],
});
ok(
  last().body.customFields?.[0]?.key === "client_type" && last().body.customFields[0].field_value === "Homeowner",
  "update_opportunity: sets a custom field by key"
);
ok(Array.isArray(last().body.customFields[1].field_value), "update_opportunity: passes a multi-select value through as a list");
ok(last().body.name === undefined && last().body.status === undefined, "update_opportunity: a custom-field update touches nothing else");

const named = await call("admin", "update_opportunity", {
  opportunityId: "o-theirs",
  customFields: [{ field_value: "Homeowner" }],
});
ok(named.err && /names no field/.test(named.text), "update_opportunity: refuses a custom field with no id or key");

const emptyCf = await call("admin", "update_opportunity", { opportunityId: "o-theirs", customFields: [] });
ok(emptyCf.err && /non-empty array/.test(emptyCf.text), "update_opportunity: refuses an empty customFields list");

// The ownership check has to run before the write, not just for the plain fields.
const cfNotMine = await call("assignedOpp", "update_opportunity", {
  opportunityId: "o-theirs",
  customFields: [{ key: "client_type", field_value: "Homeowner" }],
});
const notTheirs = await call("assigned", "update_contact", { contactId: "c1", assignedTo: "sales" });
const notMine = await call("assignedOpp", "update_opportunity", { opportunityId: "o-theirs", status: "won" });
if (ENFORCING) {
  ok(cfNotMine.err && /assigned to/.test(cfNotMine.text), "enforced: can't set custom fields on someone else's deal");
  ok(notTheirs.err && /only change contacts assigned to you/.test(notTheirs.text),
    "enforced: still can't touch a contact that isn't theirs");
  ok(notMine.err && /only change opportunities assigned to you/.test(notMine.text), "enforced: can't change someone else's deal");
} else {
  ok(!cfNotMine.err, "as shipped: sets custom fields on a colleague's deal: " + cfNotMine.text);
  ok(!notTheirs.err, "as shipped: changes a contact that isn't theirs: " + notTheirs.text);
  ok(!notMine.err, "as shipped: changes a colleague's deal: " + notMine.text);
}

// a user limited to their own records: the limit is which records they can touch,
// not which fields they can set, so they can hand over one they hold.
await call("assigned", "update_contact", { contactId: "c-mine", assignedTo: "sales" });
ok(last().method === "PUT" && last().path === "/contacts/c-mine" && last().body.assignedTo === "sales",
  "assigned-only: can hand a contact they hold to someone else");
await call("assigned", "create_contact", { firstName: "A", assignedTo: "sales" });
ok(last().body.assignedTo === "sales", "assigned-only: can create a contact for someone else");
await call("assigned", "create_contact", { firstName: "A" });
ok(last().body.assignedTo === (ENFORCING ? "assigned" : undefined),
  ENFORCING ? "enforced: new contacts come to them by default" : "as shipped: a new contact picks up no owner of its own");
await call("assignedOpp", "update_opportunity", { opportunityId: "o-mine", status: "won" });
ok(last().method === "PUT" && last().body.status === "won", "assigned-only: can change their own deal");
await call("assignedOpp", "update_opportunity", { opportunityId: "o-mine", assignedTo: "sales" });
ok(last().body.assignedTo === "sales", "assigned-only: can hand a deal they hold to someone else");

// ---------- dry run, and telling similar operations apart ----------
// A dry run has to be safe on the most dangerous operation there is: one that needs
// confirmation. Showing the request is how you decide whether to confirm, so it must not
// itself require confirmation -- and it must send nothing.
const sentBefore = seen.length;
const dry = await call("admin", "execute_operation", {
  operation: "contacts.delete-contact", path: { contactId: "c1" }, dryRun: true,
});
ok(!dry.err && dry.data.dryRun === true, "dryRun: works on an operation that needs confirmation, without confirm");
ok(seen.length === sentBefore, "dryRun: nothing was sent to the CRM");
ok(dry.data.wouldSend.method === "DELETE" && dry.data.wouldSend.path === "/contacts/c1",
  "dryRun: shows the exact request it would make");
ok(dry.data.needsConfirmation === true, "dryRun: still says confirmation is needed to run it");
const refusedNoConfirm = await call("admin", "execute_operation", { operation: "contacts.delete-contact", path: { contactId: "c1" } });
ok(refusedNoConfirm.err && /dryRun/.test(refusedNoConfirm.text), "the confirmation refusal points at dryRun");

const found = await call("admin", "search_operations", { query: "contact", limit: 4 });
ok(found.data.operations.every((o) => Array.isArray(o.takes)), "search: says what each operation needs");
ok(found.data.operations.some((o) => o.takes.includes("contactId")) && found.data.operations.some((o) => !o.takes.length),
  "search: which is what tells 'one record' and 'all records' apart");
ok(/match equally well/.test(found.data.choosing || ""), "search: when matches tie, says what to choose on");
// White-labelling: no link anywhere unless the agency's own CRM address is configured.
ok(found.data.operations.every((o) => o.openInCrm === undefined), "search: no CRM link without CRM_APP_URL");

// ---------- reading the shape of the sub-account ----------
// Same rule as custom fields: a user who can open a record can see what shape it is.
const schema = await call("sales", "execute_operation", { operation: "objects.get-object-by-location-id" });
ok(!schema.err, "a user without settingsEnabled can list the objects in the sub-account: " + schema.text);
const schemaWrite = await call("sales", "execute_operation", { operation: "objects.update-custom-object", path: { key: "custom_objects.job" }, body: {}, confirm: true });
ok(schemaWrite.err && /settingsEnabled/.test(schemaWrite.text),
  "but changing an object definition still needs the settings permission");
// And settings alone isn't enough either -- defining objects stays an admin job.
const { checkOperation: canDo } = await import(`${REPO}/lib/access.js`);
const { OPERATIONS: ALL } = await import(`${REPO}/lib/catalog.generated.js`);
const settingsNoAdmin = { roles: { role: "user" }, permissions: { contactsEnabled: true, settingsEnabled: true }, scopes: [] };
const defineObj = ALL.find((o) => o.id === "objects.update-custom-object");
const readObj = ALL.find((o) => o.id === "objects.get-object-schema-by-key");
ok(!canDo(defineObj, settingsNoAdmin).ok && /admin/.test(canDo(defineObj, settingsNoAdmin).reason),
  "settings without admin still can't define an object");
ok(canDo(readObj, settingsNoAdmin).ok, "but reading its schema is fine");

// ---------- scopes the CRM won't grant ----------
// Asking for one of these fails the whole install with invalid_scope, before any consent
// screen, so the install link must never carry them and the operations needing them must
// not be offered as though a permission could fix them.
const { GHL_SCOPES, UNGRANTABLE_SCOPES } = await import(`${REPO}/lib/ghl.js`);
ok(UNGRANTABLE_SCOPES.size > 0 && ![...UNGRANTABLE_SCOPES].some((x) => GHL_SCOPES.includes(x)),
  "install asks for no scope the CRM rejects");
const aiAgent = await call("admin", "execute_operation", { operation: "conversation-ai.get-agent", path: { id: "a1" } });
ok(aiAgent.err && /can't be granted to this app/.test(aiAgent.text),
  "an operation whose only scope is ungrantable is refused, and says why");
const mkUser = await call("admin", "execute_operation", { operation: "users.create-user", body: {}, confirm: true });
ok(mkUser.err && /can't be granted to this app/.test(mkUser.text), "same for creating a user");
// Reading users shares the area but not the scope, so it must be untouched.
const readUser = await call("admin", "execute_operation", { operation: "users.get-user", path: { userId: "sales" } });
ok(!readUser.err, "reading a user, which needs a different scope, still works: " + readUser.text);

// ---------- notes and tasks ----------
// The point of these tools: an assigned-only user was refused every one of these in the
// catalog, on his own contacts as much as anyone's, because the catalog holds ids, not owners.
// Here the contact is loaded first, so ownership is decided on the record itself.
const noteTaskTools = (await rpc("assigned", "tools/list")).tools.map((t) => t.name);
for (const t of ["list_contact_notes", "update_contact_note", "delete_contact_note",
                 "list_contact_tasks", "create_contact_task", "update_contact_task", "delete_contact_task"]) {
  ok(noteTaskTools.includes(t), `tools/list offers ${t}`);
}

const notes = await call("sales", "list_contact_notes", { contactId: "c1" });
ok(notes.data.notes?.[0]?.id === "n1" && last().path === "/contacts/c1/notes", "list_contact_notes: reads the notes");

await call("sales", "add_contact_note", { contactId: "c1", note: "Spoke to him" });
ok(last().method === "POST" && last().body.body === "Spoke to him" && last().body.userId === "sales",
  "add_contact_note: the author defaults to the signed-in user");
await call("sales", "add_contact_note", { contactId: "c1", note: "For Ada", authorId: "admin" });
ok(last().body.userId === "admin", "add_contact_note: the author can be someone else");

await call("sales", "update_contact_note", { contactId: "c1", noteId: "n1", note: "Corrected" });
ok(last().method === "PUT" && last().path === "/contacts/c1/notes/n1" && last().body.body === "Corrected",
  "update_contact_note: edits the text");
const emptyNote = await call("sales", "update_contact_note", { contactId: "c1", noteId: "n1" });
ok(emptyNote.err && /Nothing to change/.test(emptyNote.text), "update_contact_note: refuses an empty update");

await call("sales", "delete_contact_note", { contactId: "c1", noteId: "n1" });
ok(last().method === "DELETE" && last().path === "/contacts/c1/notes/n1", "delete_contact_note: deletes it");

const tasks = await call("sales", "list_contact_tasks", { contactId: "c1" });
ok(tasks.data.tasks?.[0]?.id === "t1" && last().path === "/contacts/c1/tasks", "list_contact_tasks: reads the tasks");

await call("sales", "create_contact_task", { contactId: "c1", title: "Chase survey", dueDate: "2026-11-25T11:00:00Z" });
ok(last().method === "POST" && last().path === "/contacts/c1/tasks", "create_contact_task: posts to the tasks endpoint");
ok(last().body.title === "Chase survey" && last().body.dueDate === "2026-11-25T11:00:00Z" && last().body.completed === false,
  "create_contact_task: carries title, due date and the completed flag the API requires");
ok(last().body.assignedTo === "sales", "create_contact_task: a task with no owner falls to whoever asked");
await call("sales", "create_contact_task", { contactId: "c1", title: "For Ada", dueDate: "2026-11-25T11:00:00Z", assignedTo: "admin" });
ok(last().body.assignedTo === "admin", "create_contact_task: can be raised for someone else");

await call("sales", "update_contact_task", { contactId: "c1", taskId: "t1", completed: true });
ok(last().method === "PUT" && last().path === "/contacts/c1/tasks/t1" && last().body.completed === true,
  "update_contact_task: marks a task done");
await call("sales", "update_contact_task", { contactId: "c1", taskId: "t1", dueDate: "2026-12-01T09:00:00Z", assignedTo: "admin" });
ok(last().body.dueDate === "2026-12-01T09:00:00Z" && last().body.assignedTo === "admin" && last().body.completed === undefined,
  "update_contact_task: moves the date and hands it over, touching nothing else");
const emptyTask = await call("sales", "update_contact_task", { contactId: "c1", taskId: "t1" });
ok(emptyTask.err && /Nothing to change/.test(emptyTask.text), "update_contact_task: refuses an empty update");

await call("sales", "delete_contact_task", { contactId: "c1", taskId: "t1" });
ok(last().method === "DELETE" && last().path === "/contacts/c1/tasks/t1", "delete_contact_task: deletes it");

// The report's actual complaint: refused on his own contact. c-mine belongs to "assigned".
const ownTask = await call("assigned", "create_contact_task", { contactId: "c-mine", title: "Mine", dueDate: "2026-11-25T11:00:00Z" });
ok(!ownTask.err && last().path === "/contacts/c-mine/tasks", "an assigned-only user can raise a task on their own contact: " + ownTask.text);
const ownNote = await call("assigned", "update_contact_note", { contactId: "c-mine", noteId: "n1", note: "Mine" });
ok(!ownNote.err && last().path === "/contacts/c-mine/notes/n1", "an assigned-only user can edit a note on their own contact: " + ownNote.text);

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
if (ENFORCING) {
  ok(otherAppt.err && /only change appointments assigned to you/.test(otherAppt.text),
    "enforced: can't touch an appointment that isn't theirs");
} else {
  ok(!otherAppt.err, "as shipped: reschedules a colleague's appointment: " + otherAppt.text);
}

await call("assignedCal", "update_appointment", { appointmentId: "ap-mine", startTime: "2026-11-21T10:00:00+00:00" });
ok(last().method === "PUT" && last().path === "/calendars/events/appointments/ap-mine", "assigned-only: can reschedule their own appointment");

await call("assignedCal", "update_appointment", { appointmentId: "ap-mine", assignedUserId: "sales" });
ok(last().body.assignedUserId === "sales", "assigned-only: can hand an appointment they hold to someone else");

await call("assignedCal", "create_appointment", { calendarId: "cal1", contactId: "c1", startTime: "2026-11-20T09:00:00+00:00" });
ok(last().body.assignedUserId === (ENFORCING ? "assignedCal" : undefined),
  ENFORCING ? "enforced: new appointments come to them by default" : "as shipped: a new appointment picks up no owner of its own");

// ---------- what a refusal actually says ----------
// Only reachable with the gate on, but the wording is the whole point of these refusals, so
// it stays tested rather than being deleted along with the default behaviour.
const refused = await call("scoped", "update_contact", { contactId: "c-other", firstName: "X" });
const unseen = await call("assigned", "get_contact", { contactId: "c-other" });
if (ENFORCING) {
  ok(refused.err, "scope-limited user: refused on someone else's contact");
  ok(/user someone/.test(refused.text), "refusal: names who holds the record");
  ok(/contacts\.write/.test(refused.text) && /assigned-only/.test(refused.text), "refusal: names the setting behind it");
  ok(/list_users/.test(refused.text), "refusal: says how to find out who that is");
  ok(/can only change/.test(refused.text) && !/only access/.test(refused.text), "refusal: says change, not access");
  ok(/can only see/.test(unseen.text) && /only assigned data/.test(unseen.text),
    "refusal on a read: says see, and names the blanket setting");
} else {
  ok(!refused.err, "as shipped: a scope-limited user changes a colleague's contact: " + refused.text);
  ok(!unseen.err, "as shipped: nothing is withheld on a read: " + unseen.text);
}

// whoami keeps reporting the setting even where it isn't acted on, so it can still be seen.
const wa = await call("assigned", "whoami", {});
ok(wa.data.assignedDataOnly === true && wa.data.assignedOnlyDeclaredForChanging.includes("contacts"),
  "whoami: reports what the CRM says about assigned-only");
ok(wa.data.assignedOnlyEnforcedHere === ENFORCING && wa.data.assignedOnlyForChanging.includes("contacts") === ENFORCING,
  "whoami: says separately whether this server acts on it");

console.log(`\n${pass} checks passed`);
await new Promise((r) => process.stdout.write("", r)); // flush before exit
process.exit(0);
