// MCP tools. Each tool names the HighLevel user permission it needs; a user only sees
// (and can only call) tools whose permission is enabled on their HighLevel user.
//
// "Only assigned data" users are limited to records assigned to them: lookups are refused,
// creates are assigned to them, and search results are filtered again on this server
// (we don't rely only on HighLevel honouring the filter).
//
// View-only users: HighLevel lists what a user may change in `user.scopes` (e.g. "contacts.write").
// When that list exists, tools that change data also need the matching write scope.

import { OPERATION_TOOLS, operationCount } from "./operations.js";
import { MODULE_SCOPES, assignedOnlyFor } from "./assigned.js";
export { assignedOnlyFor };

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const limit = { type: "number", description: "Max results (1-100, default 20)" };
const clampLimit = (n) => Math.min(Math.max(Number(n) || 20, 1), 100);

const userScopes = (user) => (Array.isArray(user?.scopes) ? user.scopes : null);

/** Keep only records assigned to the user (defence in depth on search results). */
function keepAssigned(ctx, data, key, field = "assignedTo") {
  if (!ctx.assignedOnly || !data || !Array.isArray(data[key])) return data;
  const kept = data[key].filter((r) => r && r[field] === ctx.userId);
  const out = { ...data, [key]: kept };
  if (kept.length !== data[key].length) {
    for (const t of ["total", "count"]) if (typeof out[t] === "number") out[t] = kept.length;
    if (out.meta && typeof out.meta.total === "number") out.meta = { ...out.meta, total: kept.length };
  }
  return out;
}

function denyIfNotAssigned(ctx, record, what) {
  if (ctx.assignedOnly && record && record.assignedTo !== ctx.userId) {
    throw new Error(`You can only access ${what} assigned to you.`);
  }
}

async function loadContact(ctx, contactId) {
  const data = await ctx.ghl("GET", `/contacts/${encodeURIComponent(contactId)}`);
  const contact = data.contact || data;
  denyIfNotAssigned(ctx, contact, "contacts");
  return contact;
}

const CONTACT_FIELDS = {
  firstName: str("First name"),
  lastName: str("Last name"),
  email: str("Email"),
  phone: str("Phone, E.164 format e.g. +14155550123"),
  companyName: str("Company name"),
  tags: { type: "array", items: { type: "string" }, description: "Tags" },
};

function pickContactFields(args) {
  const out = {};
  for (const k of Object.keys(CONTACT_FIELDS)) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

export const TOOLS = [
  // ---------- always available ----------
  {
    name: "whoami",
    permission: null,
    readOnly: true,
    description: "Show the signed-in HighLevel user, their role, sub-account, and which permissions/tools they have.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      const u = ctx.user;
      return {
        user: { id: u.id, name: u.name || [u.firstName, u.lastName].filter(Boolean).join(" "), email: u.email },
        role: u.roles,
        locationId: ctx.locationId,
        assignedDataOnly: ctx.user.permissions?.assignedDataOnly === true,
        assignedOnlyForViewing: Object.keys(MODULE_SCOPES).filter((m) => assignedOnlyFor(ctx.user, m, false)),
        assignedOnlyForChanging: Object.keys(MODULE_SCOPES).filter((m) => assignedOnlyFor(ctx.user, m, true)),
        scopes: userScopes(u),
        scopesAssignedToOnly: Array.isArray(u.scopesAssignedToOnly) ? u.scopesAssignedToOnly : null,
        enabledPermissions: Object.entries(u.permissions || {}).filter(([, v]) => v === true).map(([k]) => k),
        availableTools: ctx.allowedToolNames,
        catalogOperationsAvailable: operationCount(u),
      };
    },
  },

  // ---------- contacts ----------
  {
    name: "search_contacts",
    module: "contacts",
    permission: "contactsEnabled",
    readOnly: true,
    description: "Search contacts in the sub-account by name, email, phone or other text.",
    inputSchema: { type: "object", properties: { query: str("Search text"), limit } },
    async run(ctx, a) {
      const body = { locationId: ctx.locationId, pageLimit: clampLimit(a.limit) };
      if (a.query) body.query = a.query;
      if (ctx.assignedOnly) body.filters = [{ field: "assignedTo", operator: "eq", value: ctx.userId }];
      return keepAssigned(ctx, await ctx.ghl("POST", "/contacts/search", { body }), "contacts");
    },
  },
  {
    name: "get_contact",
    module: "contacts",
    permission: "contactsEnabled",
    readOnly: true,
    description: "Get one contact by ID.",
    inputSchema: { type: "object", properties: { contactId: str("Contact ID") }, required: ["contactId"] },
    async run(ctx, a) {
      return loadContact(ctx, a.contactId);
    },
  },
  {
    name: "create_contact",
    module: "contacts",
    writeScopes: ["contacts.write"],
    permission: "contactsEnabled",
    description: "Create a new contact.",
    inputSchema: { type: "object", properties: CONTACT_FIELDS },
    async run(ctx, a) {
      const body = { locationId: ctx.locationId, ...pickContactFields(a) };
      if (ctx.assignedOnly) body.assignedTo = ctx.userId;
      return ctx.ghl("POST", "/contacts/", { body });
    },
  },
  {
    name: "update_contact",
    module: "contacts",
    writeScopes: ["contacts.write"],
    permission: "contactsEnabled",
    description: "Update fields on an existing contact.",
    inputSchema: {
      type: "object",
      properties: { contactId: str("Contact ID"), ...CONTACT_FIELDS },
      required: ["contactId"],
    },
    async run(ctx, a) {
      await loadContact(ctx, a.contactId);
      return ctx.ghl("PUT", `/contacts/${encodeURIComponent(a.contactId)}`, { body: pickContactFields(a) });
    },
  },
  {
    name: "add_contact_note",
    module: "contacts",
    writeScopes: ["contacts.write"],
    permission: "contactsEnabled",
    description: "Add a note to a contact.",
    inputSchema: {
      type: "object",
      properties: { contactId: str("Contact ID"), note: str("Note text") },
      required: ["contactId", "note"],
    },
    async run(ctx, a) {
      await loadContact(ctx, a.contactId);
      return ctx.ghl("POST", `/contacts/${encodeURIComponent(a.contactId)}/notes`, {
        body: { body: a.note, userId: ctx.userId },
      });
    },
  },

  // ---------- opportunities ----------
  {
    name: "list_pipelines",
    module: "opportunities",
    permission: "opportunitiesEnabled",
    readOnly: true,
    description: "List opportunity pipelines and their stages.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      return ctx.ghl("GET", "/opportunities/pipelines", { query: { locationId: ctx.locationId } });
    },
  },
  {
    name: "search_opportunities",
    module: "opportunities",
    permission: "opportunitiesEnabled",
    readOnly: true,
    description: "Search opportunities (deals), optionally by text, pipeline or status.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Search text"),
        pipelineId: str("Pipeline ID"),
        status: { type: "string", enum: ["open", "won", "lost", "abandoned", "all"] },
        limit,
      },
    },
    async run(ctx, a) {
      const data = await ctx.ghl("GET", "/opportunities/search", {
        query: {
          location_id: ctx.locationId,
          q: a.query,
          pipeline_id: a.pipelineId,
          status: a.status,
          limit: clampLimit(a.limit),
          assigned_to: ctx.assignedOnly ? ctx.userId : undefined,
        },
      });
      return keepAssigned(ctx, data, "opportunities");
    },
  },
  {
    name: "create_opportunity",
    module: "opportunities",
    writeScopes: ["opportunities.write"],
    permission: "opportunitiesEnabled",
    description: "Create an opportunity (deal) for a contact in a pipeline stage.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("Opportunity name"),
        pipelineId: str("Pipeline ID"),
        pipelineStageId: str("Stage ID"),
        contactId: str("Contact ID"),
        monetaryValue: num("Deal value"),
      },
      required: ["name", "pipelineId", "pipelineStageId", "contactId"],
    },
    async run(ctx, a) {
      if (ctx.assignedOnly) await loadContact(ctx, a.contactId);
      return ctx.ghl("POST", "/opportunities/", {
        body: {
          locationId: ctx.locationId,
          name: a.name,
          pipelineId: a.pipelineId,
          pipelineStageId: a.pipelineStageId,
          contactId: a.contactId,
          monetaryValue: a.monetaryValue,
          status: "open",
          ...(ctx.assignedOnly ? { assignedTo: ctx.userId } : {}),
        },
      });
    },
  },

  // ---------- conversations ----------
  {
    name: "search_conversations",
    module: "conversations",
    permission: "conversationsEnabled",
    readOnly: true,
    description: "Search conversations, optionally for one contact.",
    inputSchema: { type: "object", properties: { contactId: str("Contact ID"), query: str("Search text"), limit } },
    async run(ctx, a) {
      const data = await ctx.ghl("GET", "/conversations/search", {
        query: {
          locationId: ctx.locationId,
          contactId: a.contactId,
          query: a.query,
          limit: clampLimit(a.limit),
          assignedTo: ctx.assignedOnly ? ctx.userId : undefined,
        },
      });
      return keepAssigned(ctx, data, "conversations");
    },
  },
  {
    name: "get_conversation_messages",
    module: "conversations",
    permission: "conversationsEnabled",
    readOnly: true,
    description: "Get recent messages in a conversation.",
    inputSchema: {
      type: "object",
      properties: { conversationId: str("Conversation ID"), limit },
      required: ["conversationId"],
    },
    async run(ctx, a) {
      const id = encodeURIComponent(a.conversationId);
      if (ctx.assignedOnly) {
        const conv = await ctx.ghl("GET", `/conversations/${id}`);
        denyIfNotAssigned(ctx, conv.conversation || conv, "conversations");
      }
      return ctx.ghl("GET", `/conversations/${id}/messages`, { query: { limit: clampLimit(a.limit) } });
    },
  },
  {
    name: "send_message",
    module: "conversations",
    writeScopes: ["conversations/message.write","conversations.write"],
    permission: "conversationsEnabled",
    description: "Send an SMS or email to a contact.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: str("Contact ID"),
        type: { type: "string", enum: ["SMS", "Email"] },
        message: str("Message text"),
        subject: str("Email subject (Email only)"),
      },
      required: ["contactId", "type", "message"],
    },
    async run(ctx, a) {
      if (ctx.assignedOnly) await loadContact(ctx, a.contactId);
      const body = { type: a.type, contactId: a.contactId, message: a.message };
      if (a.type === "Email") {
        body.subject = a.subject || "(no subject)";
        body.html = a.message;
      }
      return ctx.ghl("POST", "/conversations/messages", { body });
    },
  },

  // ---------- calendars ----------
  {
    name: "list_calendars",
    module: "calendars",
    permission: "appointmentsEnabled",
    readOnly: true,
    description: "List calendars in the sub-account.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      return ctx.ghl("GET", "/calendars/", { query: { locationId: ctx.locationId } });
    },
  },
  {
    name: "get_calendar_events",
    module: "calendars",
    permission: "appointmentsEnabled",
    readOnly: true,
    description: "List appointments between two dates (ISO 8601) for a calendar, or your own if no calendar is given.",
    inputSchema: {
      type: "object",
      properties: {
        startTime: str("Start, ISO 8601 e.g. 2026-11-10T00:00:00Z"),
        endTime: str("End, ISO 8601"),
        calendarId: str("Calendar ID (optional)"),
      },
      required: ["startTime", "endTime"],
    },
    async run(ctx, a) {
      const start = Date.parse(a.startTime);
      const end = Date.parse(a.endTime);
      if (Number.isNaN(start) || Number.isNaN(end)) throw new Error("startTime and endTime must be ISO 8601 dates");
      const byUser = ctx.assignedOnly || !a.calendarId;
      const data = await ctx.ghl("GET", "/calendars/events", {
        query: {
          locationId: ctx.locationId,
          startTime: start,
          endTime: end,
          calendarId: byUser ? undefined : a.calendarId,
          userId: byUser ? ctx.userId : undefined,
        },
      });
      return keepAssigned(ctx, data, "events", "assignedUserId");
    },
  },

  // ---------- everything else in the HighLevel API (see operations.js) ----------
  ...OPERATION_TOOLS,
];

/** Is this tool allowed for this HighLevel user? */
export function isAllowed(tool, user) {
  if (!tool.permission) return true;
  if (user?.permissions?.[tool.permission] !== true) return false;
  // View-only: a tool that changes data needs one of its write scopes, when HighLevel
  // gives us the user's scope list. (No list = older role setup: module permission decides.)
  const scopes = userScopes(user);
  if (tool.writeScopes && scopes && scopes.length) return tool.writeScopes.some((s) => scopes.includes(s));
  return true;
}

/** Why a tool isn't allowed, for the error message. */
export function deniedReason(tool, user) {
  if (tool.permission && user?.permissions?.[tool.permission] !== true) return `the "${tool.permission}" permission`;
  if (tool.writeScopes) return `edit access (${tool.writeScopes.join(" or ")})`;
  return "access";
}
