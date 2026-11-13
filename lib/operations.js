// The full HighLevel API as three tools, like HighLevel's own MCP server:
//   search_operations  -> find operations by intent
//   describe_operation -> inputs, scopes and whether confirmation is needed
//   execute_operation  -> run it
// Every step only sees operations the signed-in user is allowed to run (see access.js), and
// every request is pinned to the user's sub-account: the AI can't pick a different one.
import { OPERATIONS } from "./catalog.generated.js";
import { checkOperation } from "./access.js";

const BY_ID = new Map(OPERATIONS.map((op) => [op.id, op]));
const LOCATION_PARAMS = new Set(["locationId", "location_id", "locationID", "altId"]);
const COMPANY_PARAMS = new Set(["companyId", "company_id"]);

const STOP_WORDS = new Set(["to", "the", "an", "of", "for", "in", "on", "by", "my", "me", "with", "from", "and", "or", "all", "into", "at", "is", "it", "this", "that", "some", "any", "api", "id", "ids"]);
const words = (s) =>
  String(s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

// Words people use vs words in the API.
const SYNONYMS = {
  deal: ["opportunity", "opportunities"],
  deals: ["opportunity", "opportunities"],
  appointment: ["event", "events", "calendar"],
  appointments: ["event", "events", "calendar"],
  sms: ["message", "messages"],
  email: ["message", "messages", "email", "emails"],
  lead: ["contact", "contacts"],
  leads: ["contact", "contacts"],
  people: ["contact", "contacts"],
  customer: ["contact", "contacts"],
  customers: ["contact", "contacts"],
  team: ["user", "users"],
  staff: ["user", "users"],
  post: ["post", "posts", "social"],
  quote: ["estimate", "estimates"],
  quotes: ["estimate", "estimates"],
  move: ["update", "status"],
  change: ["update"],
  edit: ["update"],
  set: ["update"],
  remove: ["delete"],
  find: ["search", "get", "list"],
  show: ["get", "list"],
  list: ["get", "search"],
  view: ["get", "list"],
  add: ["create"],
  new: ["create"],
};

// Where a word appears decides how much it counts: name > area > path > description.
const FIELDS = [
  [4, (op) => `${op.id} ${op.summary}`],
  [3, (op) => `${op.area} ${op.tag} ${op.resource}`],
  [2, (op) => op.path],
  [1, (op) => op.description || ""],
];
const stem = (w) => w.replace(/(ies)$/, "y").replace(/(s)$/, "");
const INDEX = new Map(
  OPERATIONS.map((op) => [op.id, FIELDS.map(([weight, get]) => ({ weight, words: new Set(words(get(op)).map(stem)) }))])
);

function score(op, terms) {
  const fields = INDEX.get(op.id);
  let s = 0;
  let areaHit = false;
  for (const t of terms) {
    let best = 0;
    for (const a of [t, ...(SYNONYMS[t] || [])].map(stem)) {
      for (const f of fields) if (f.words.has(a)) best = Math.max(best, f.weight);
      if (fields[1].words.has(a)) areaHit = true;
    }
    s += best;
  }
  // The thing asked about (invoices, workflows...) matters more than the verb (list, get...).
  return s && areaHit ? s + 2 : s;
}

const summaryLength = (op) => words(op.summary).length;

/** Operations this user may run (cached per call context). */
function allowedOps(ctx) {
  if (!ctx._allowedOps) ctx._allowedOps = OPERATIONS.filter((op) => checkOperation(op, ctx.user).ok);
  return ctx._allowedOps;
}

function getAllowed(ctx, id) {
  const op = BY_ID.get(id);
  if (!op) throw new Error(`Unknown operation "${id}". Use search_operations to find the right id.`);
  const check = checkOperation(op, ctx.user);
  if (!check.ok) throw Object.assign(new Error(`You can't run ${id} because ${check.reason}.`), { denied: true });
  return op;
}

const summaryOf = (op) => ({
  id: op.id,
  summary: op.summary,
  method: op.method,
  path: op.path,
  access: op.access,
  ...(op.confirm ? { needsConfirmation: true } : {}),
});

const isPinned = (name) => LOCATION_PARAMS.has(name) || COMPANY_PARAMS.has(name);

function pinnedValue(ctx, name) {
  if (LOCATION_PARAMS.has(name)) return ctx.locationId;
  if (COMPANY_PARAMS.has(name)) return ctx.companyId;
  return undefined;
}

/** Use the connection's sub-account/agency id; refuse a different one. */
function pin(ctx, name, given) {
  const value = pinnedValue(ctx, name);
  if (value === undefined || value === null) throw new Error(`This connection has no ${name} to use.`);
  if (given !== undefined && given !== null && given !== "" && String(given) !== String(value)) {
    throw new Error(`This connection only works with ${LOCATION_PARAMS.has(name) ? "sub-account" : "agency"} ${value}; ${name} "${given}" isn't allowed.`);
  }
  return value;
}

function buildRequest(ctx, op, args) {
  const pathArgs = args.path && typeof args.path === "object" ? args.path : {};
  const queryArgs = args.query && typeof args.query === "object" ? args.query : {};
  const known = new Set(op.params.map((p) => p.name));

  let url = op.path;
  for (const p of op.params.filter((x) => x.in === "path")) {
    const value = isPinned(p.name) ? pin(ctx, p.name, pathArgs[p.name]) : pathArgs[p.name];
    if (value === undefined || value === null || value === "") throw new Error(`Missing path parameter "${p.name}".`);
    url = url.replace(`{${p.name}}`, encodeURIComponent(String(value)));
  }
  for (const k of Object.keys(pathArgs)) {
    if (!op.params.some((p) => p.in === "path" && p.name === k)) throw new Error(`Unknown path parameter "${k}".`);
  }

  const query = {};
  for (const [k, v] of Object.entries(queryArgs)) {
    if (!known.has(k)) throw new Error(`Unknown query parameter "${k}". Use describe_operation to see the inputs.`);
    query[k] = Array.isArray(v) ? v.join(",") : v;
  }
  for (const p of op.params.filter((x) => x.in === "query")) {
    if (isPinned(p.name)) query[p.name] = pin(ctx, p.name, queryArgs[p.name]);
    else if (p.name === "altType") query.altType = "location";
    else if (p.required && (query[p.name] === undefined || query[p.name] === "")) {
      throw new Error(`Missing query parameter "${p.name}".`);
    }
  }

  let body;
  if (op.body) {
    if (args.body !== undefined && (typeof args.body !== "object" || args.body === null)) throw new Error("body must be a JSON object or array.");
    body = args.body ?? (op.bodyRequired ? {} : undefined);
    if (body && !Array.isArray(body)) {
      const props = op.body.properties || {};
      body = { ...body };
      for (const name of Object.keys(props)) {
        if (isPinned(name)) body[name] = pin(ctx, name, body[name]);
        else if (name === "altType") body.altType = "location";
      }
      // Pinned names the schema doesn't list may still be read by HighLevel: check them too.
      for (const name of Object.keys(body)) if (isPinned(name)) body[name] = pin(ctx, name, body[name]);
    }
  } else if (args.body !== undefined && Object.keys(args.body || {}).length) {
    throw new Error(`${op.id} doesn't take a body.`);
  }
  return { url, query, body };
}

export const OPERATION_TOOLS = [
  {
    name: "search_operations",
    permission: null,
    readOnly: true,
    description:
      "Find HighLevel API operations you can run, by what you want to do (e.g. 'send invoice', 'list products', 'update opportunity stage'). " +
      "Covers contacts, conversations, opportunities, calendars, invoices, estimates, payments, products, store, social planner, blogs, emails, forms, surveys, funnels, workflows, Voice AI, knowledge base, media, custom objects and fields, users and more. " +
      "Only operations your HighLevel user is allowed to run are returned. Call with no query to see the areas you have. Then call describe_operation, then execute_operation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do, in a few words" },
        area: { type: "string", description: "Only this area, e.g. 'invoices' (see the areas from a search with no query)" },
        access: { type: "string", enum: ["read", "write"], description: "Only operations that read, or that change data" },
        limit: { type: "number", description: "Max results (1-50, default 15)" },
      },
    },
    async run(ctx, a) {
      let ops = allowedOps(ctx);
      if (a.area) ops = ops.filter((op) => op.area === a.area || op.resource.startsWith(a.area));
      if (a.access) ops = ops.filter((op) => op.access === a.access);
      if (!a.query) {
        const areas = {};
        for (const op of ops) {
          areas[op.area] ||= { read: 0, write: 0 };
          areas[op.area][op.access]++;
        }
        return {
          availableOperations: ops.length,
          areas,
          hint: "Search with a query (and optionally area) to find operations.",
        };
      }
      const terms = words(a.query);
      const limit = Math.min(Math.max(Number(a.limit) || 15, 1), 50);
      const ranked = ops
        .map((op) => ({ op, s: score(op, terms) }))
        .filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s || summaryLength(x.op) - summaryLength(y.op) || x.op.id.localeCompare(y.op.id));
      return {
        matches: ranked.length,
        operations: ranked.slice(0, limit).map((x) => summaryOf(x.op)),
        hint: ranked.length
          ? "Call describe_operation with an id to see its inputs."
          : "Nothing matched among the operations you're allowed to run. Try other words, or search with no query to see your areas.",
      };
    },
  },
  {
    name: "describe_operation",
    permission: null,
    readOnly: true,
    description: "Show an operation's inputs (path, query and body), the HighLevel scope it uses, and whether it needs the user's confirmation. Call before execute_operation.",
    inputSchema: {
      type: "object",
      properties: { operation: { type: "string", description: "Operation id from search_operations" } },
      required: ["operation"],
    },
    async run(ctx, a) {
      const op = getAllowed(ctx, a.operation);
      const describe = (where) =>
        op.params
          .filter((p) => p.in === where && !isPinned(p.name) && p.name !== "altType")
          .map((p) => ({ name: p.name, required: p.required, description: p.description, schema: p.schema }));
      const filled = [
        ...op.params.filter((p) => isPinned(p.name) || p.name === "altType").map((p) => p.name),
        ...Object.keys(op.body?.properties || {}).filter((n) => isPinned(n) || n === "altType"),
      ];
      return {
        id: op.id,
        summary: op.summary,
        description: op.description,
        method: op.method,
        path: op.path,
        access: op.access,
        scopes: op.scopes,
        needsConfirmation: op.confirm,
        pathParameters: describe("path"),
        queryParameters: describe("query"),
        body: op.body || null,
        bodyRequired: op.bodyRequired,
        filledInAutomatically: [...new Set(filled)],
        howToRun: {
          operation: op.id,
          path: "{ name: value } for the path parameters",
          query: "{ name: value } for the query parameters",
          body: op.body ? "JSON matching body" : "none",
          ...(op.confirm ? { confirm: "true, only after the user has confirmed this exact action" } : {}),
        },
      };
    },
  },
  {
    name: "execute_operation",
    permission: null,
    destructive: true,
    description:
      "Run a HighLevel API operation in the signed-in user's sub-account. Use describe_operation first. " +
      "Operations marked needsConfirmation (deleting, sending, charging, refunding, bulk changes...) only run with confirm: true, " +
      "which you may only set after the user has explicitly confirmed that exact action.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Operation id" },
        path: { type: "object", description: "Path parameters" },
        query: { type: "object", description: "Query parameters" },
        body: { description: "Request body (JSON)" },
        confirm: { type: "boolean", description: "The user confirmed this action (required for operations marked needsConfirmation)" },
      },
      required: ["operation"],
    },
    async run(ctx, a) {
      const op = getAllowed(ctx, a.operation);
      if (op.confirm && a.confirm !== true) {
        throw new Error(
          `${op.id} (${op.summary}) changes or sends something that can't easily be undone. ` +
            "Tell the user exactly what will happen, ask them to confirm, then call again with confirm: true."
        );
      }
      const { url, query, body } = buildRequest(ctx, op, a);
      return ctx.ghl(op.method, url, { query, body, version: op.version });
    },
  },
];

export const operationCount = (user) => OPERATIONS.filter((op) => checkOperation(op, user).ok).length;
