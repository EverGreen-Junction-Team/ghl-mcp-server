// Who may run which catalog operation.
//
// Each HighLevel API operation needs an OAuth scope, e.g. "invoices.write". The sub-account token
// this server holds has every scope, so the limits for the signed-in *user* are applied here:
//
//   1. Area rule (AREAS below, longest matching prefix of the operation's scope resource):
//        permission  - the user permission flag that turns the area on (e.g. invoiceEnabled)
//        readOnlyFlag - a flag that makes the area view-only (e.g. workflowsReadOnly)
//        adminOnly   - "all" or "write": only admins (role "admin") may use it
//      Areas not listed are admin-only (deny by default).
//   2. User scopes (user.scopes, set on the user's role in HighLevel), when the user has a list:
//        - If HighLevel has user scopes for this area, viewing needs one of them and changing
//          needs a non-readonly one ("contacts.write"). HighLevel has no "contacts.readonly" user
//          scope, so viewing contacts is governed by contactsEnabled alone.
//        - If HighLevel has no user scopes for this area, the area rule decides.
//   3. Assigned-only users (assignedDataOnly or scopesAssignedToOnly) can't use catalog
//      operations in contacts/opportunities/conversations/calendars: the catalog can't tell which
//      records are theirs. The built-in tools (search_contacts, ...) filter to their records instead.
import { USER_SCOPE_VOCABULARY } from "./catalog.generated.js";
import { assignedOnlyFor } from "./assigned.js";

export const AREAS = {
  contacts: { permission: "contactsEnabled" },
  businesses: { permission: "contactsEnabled" },
  associations: { permission: "contactsEnabled" },
  "objects/record": { permission: "contactsEnabled" },
  "objects/schema": { permission: "settingsEnabled", adminOnly: "write" },
  "locations/tasks": { permission: "contactsEnabled" },
  "locations/tags": { permission: "tagsEnabled" },
  "locations/customFields": { permission: "settingsEnabled", adminOnly: "write" },
  "locations/customValues": { permission: "settingsEnabled", adminOnly: "write" },
  "locations/templates": { permission: "settingsEnabled" },
  locations: { adminOnly: "write" },
  users: { adminOnly: "write" },

  opportunities: { permission: "opportunitiesEnabled" },
  conversations: { permission: "conversationsEnabled" },
  calendars: { permission: "appointmentsEnabled" },

  invoices: { permission: "invoiceEnabled" },
  proposals: { permission: "invoiceEnabled" },
  payments: { permission: "paymentsEnabled" },
  "payments/custom-provider": { permission: "paymentsEnabled", adminOnly: "all" },
  "payments/integration": { permission: "paymentsEnabled", adminOnly: "all" },
  products: { permission: "paymentsEnabled" },
  store: { permission: "paymentsEnabled" },

  socialplanner: { permission: "socialPlanner" },
  blogs: { permission: "bloggingEnabled" },
  funnels: { permission: "funnelsEnabled" },
  forms: { permission: "funnelsEnabled" },
  surveys: { permission: "funnelsEnabled" },
  "brand-boards": { permission: "marketingEnabled" },
  links: { permission: "marketingEnabled" },
  emails: { permission: "marketingEnabled" },
  "email-isv": { permission: "marketingEnabled" },
  adPublishing: { permission: "marketingEnabled" },
  "ad-manager": { permission: "marketingEnabled" },
  campaigns: { permission: "campaignsEnabled", readOnlyFlag: "campaignsReadOnly" },
  workflows: { permission: "workflowsEnabled", readOnlyFlag: "workflowsReadOnly" },
  "affiliate-manager": { permission: "affiliateManagerEnabled" },
  courses: { permission: "membershipEnabled" },
  medias: {},

  "conversation-ai": { permission: "botService", adminOnly: "write" },
  "agent-studio": { permission: "botService", adminOnly: "write" },
  "knowledge-base": { permission: "botService", adminOnly: "write" },
  "voice-ai-agents": { permission: "botService", adminOnly: "write" },
  "voice-ai-agent-goals": { permission: "botService", adminOnly: "write" },
  "voice-ai-dashboard": { permission: "botService" },

  phonenumbers: { permission: "phoneCallEnabled", adminOnly: "write" },
  numberpools: { permission: "phoneCallEnabled", adminOnly: "write" },
};

// Modules whose records can be assigned to a user, by resource prefix.
const ASSIGNABLE = {
  contacts: "contacts",
  businesses: "contacts",
  associations: "contacts",
  "objects/record": "contacts",
  "locations/tasks": "contacts",
  opportunities: "opportunities",
  conversations: "conversations",
  calendars: "calendars",
};

const parentsOf = (resource) => resource.split("/").map((_, i, parts) => parts.slice(0, parts.length - i).join("/"));

function lookup(table, resource) {
  for (const r of parentsOf(resource)) if (table[r] !== undefined) return { key: r, value: table[r] };
  return null;
}

const resourceOf = (scope) => scope.replace(/\.[^.]+$/, "");
const isReadScope = (scope) => /\.(readonly|read)$/.test(scope);

// User scopes for agency-level actions (creating/deleting sub-accounts), not sub-account settings.
const AGENCY_USER_SCOPE_RESOURCES = new Set(["locations"]);

// Areas without user scopes of their own that sit under another area in HighLevel's settings:
// documents & contracts follow invoices, the store follows products.
const USER_SCOPE_ALIAS = { proposals: "invoices", store: "products" };

/** HighLevel user scopes that belong to this resource (most specific resource that has any). */
function userScopeFamily(resource) {
  const top = resource.split("/")[0];
  if (USER_SCOPE_ALIAS[top]) resource = USER_SCOPE_ALIAS[top];
  for (const r of parentsOf(resource)) {
    if (AGENCY_USER_SCOPE_RESOURCES.has(r)) continue;
    const family = USER_SCOPE_VOCABULARY.filter((s) => resourceOf(s) === r);
    if (family.length) return family;
  }
  return [];
}

export const isAdmin = (user) => user?.roles?.role === "admin";

/**
 * Can this user run this operation? Returns { ok: true } or { ok: false, reason }.
 * `reason` finishes the sentence "You can't run this operation because ...".
 */
export function checkOperation(op, user) {
  const write = op.access === "write";
  const area = lookup(AREAS, op.resource);
  const perms = user?.permissions || {};

  if (!area) {
    if (!isAdmin(user)) return { ok: false, reason: `"${op.resource}" is only available to admins` };
  } else {
    const rule = area.value;
    if (rule.permission && perms[rule.permission] !== true) {
      return { ok: false, reason: `your user doesn't have the "${rule.permission}" permission` };
    }
    if (write && rule.readOnlyFlag && perms[rule.readOnlyFlag] === true) {
      return { ok: false, reason: `your access to ${area.key} is view-only` };
    }
    if ((rule.adminOnly === "all" || (write && rule.adminOnly === "write")) && !isAdmin(user)) {
      return { ok: false, reason: `${write ? "changing" : "using"} ${area.key} is only available to admins` };
    }
  }

  const scopes = Array.isArray(user?.scopes) ? user.scopes : null;
  if (scopes && scopes.length) {
    const family = userScopeFamily(op.resource);
    if (family.length) {
      const has = family.filter((s) => scopes.includes(s));
      // The operation's exact scope is a user scope too (e.g. payments/orders.collectPayment).
      let exact = op.scopes.find((s) => family.includes(s) && !isReadScope(s));
      // Deleting needs the area's delete scope when HighLevel has one (e.g. products.delete).
      const del = family.find((s) => s.endsWith(".delete"));
      const strict = op.method === "DELETE" && del;
      if (strict) exact = del;
      if (write) {
        const ok = strict
          ? scopes.includes(del)
          : exact
            ? scopes.includes(exact) || has.some((s) => s.endsWith(".write"))
            : has.some((s) => !isReadScope(s));
        if (!ok) return { ok: false, reason: `your user doesn't have edit access (${exact || family.filter((s) => !isReadScope(s)).join(" or ")})` };
      } else if (family.some(isReadScope) && !has.length) {
        return { ok: false, reason: `your user doesn't have view access (${family.join(" or ")})` };
      }
    }
  }

  const assignable = lookup(ASSIGNABLE, op.resource);
  if (assignable && assignedOnlyFor(user, assignable.value, write)) {
    return {
      ok: false,
      reason: `you can only ${write ? "change" : "see"} ${assignable.value} assigned to you; use the built-in ${assignable.value} tools, which only show your records`,
    };
  }
  return { ok: true };
}
