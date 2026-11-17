// MCP over Streamable HTTP (stateless, JSON responses).
import { open } from "./seal.js";
import { ghlRequest, getUser, GhlError } from "./ghl.js";
import { locationToken, grantLocations, grantCanUseLocation } from "./agency.js";
import { TOOLS, isAllowed, deniedReason, assignedOnlyFor, assignedOnlyReason } from "./tools.js";
import { baseUrl, sendJson } from "./http.js";
import { audit, clientIp } from "./audit.js";
import { isRevoked } from "./revoke.js";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function unauthorized(req, res, description) {
  sendJson(
    res,
    401,
    { error: "invalid_token", error_description: description },
    {
      "WWW-Authenticate": `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${description}"`,
    }
  );
}

export async function handleMcp(req, res, body) {
  if (req.method === "GET") return sendJson(res, 405, { error: "Use POST" }, { Allow: "POST, DELETE" });
  if (req.method === "DELETE") return sendJson(res, 200, {});
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  const auth = req.headers.authorization || "";
  const grant = open("access", auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!grant) return unauthorized(req, res, "Sign in to continue");
  if (await isRevoked(grant)) return unauthorized(req, res, "This connection was disconnected. Sign in again.");

  if (body?.__invalidJson) return sendJson(res, 400, rpcError(null, -32700, "Parse error"));

  const session = new Session(grant, clientIp(req));
  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of messages) {
    const reply = await session.handle(msg);
    if (reply) replies.push(reply);
  }
  if (!replies.length) {
    res.statusCode = 202;
    return res.end();
  }
  sendJson(res, 200, Array.isArray(body) ? replies : replies[0]);
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

class Session {
  constructor(grant, ip) {
    this.grant = grant;
    this.ip = ip;
    this.user = null;
  }

  /** True when this connection covers more than one sub-account. */
  get multiLocation() {
    return !!(this.grant.all || (Array.isArray(this.grant.ls) && this.grant.ls.length > 1));
  }

  /**
   * A HighLevel token for one sub-account. The connection carries its default sub-account's
   * token; the rest are minted from the agency token on demand (and cached in agency.js).
   */
  async tokenFor(locationId) {
    if (!locationId || locationId === this.grant.lid) return this.grant.at;
    const t = await locationToken(locationId);
    return t.at;
  }

  /** The sub-accounts this connection can work in, checked against the user's current access. */
  async locations(user) {
    if (!this.locationList) this.locationList = await grantLocations(this.grant, user);
    return this.locationList;
  }

  /**
   * Which sub-account this call is for. With one connected it's always that one. With several,
   * reads fall back to the default but writes must say which, so the AI can't quietly change
   * the wrong client's data.
   */
  async resolveLocation(tool, wanted, user) {
    if (!wanted) {
      if (this.multiLocation && !tool.readOnly) {
        const names = (await this.locations(user)).slice(0, 12).map((l) => `${l.name} (${l.id})`).join(", ");
        const e = new Error(
          `This connection covers several sub-accounts, so ${tool.name} needs locationId to say which one to change. ` +
            `Ask the user which, don't guess. Options: ${names || "see list_locations"}.`
        );
        e.denied = true;
        throw e;
      }
      return { id: this.grant.lid, name: this.grant.ln || null };
    }
    const id = String(wanted);
    if (!this.multiLocation) {
      if (id !== this.grant.lid) throw new Error(`This connection only works with sub-account ${this.grant.lid}; "${id}" isn't allowed.`);
      return { id: this.grant.lid, name: this.grant.ln || null };
    }
    if (!grantCanUseLocation(this.grant, user, id)) {
      const e = new Error(`This connection can't use sub-account "${id}". Call list_locations to see which ones it covers.`);
      e.denied = true;
      throw e;
    }
    const known = (await this.locations(user)).find((l) => l.id === id);
    return { id, name: known?.name || null };
  }

  /** Load the HighLevel user and confirm they still have access to this sub-account. */
  async loadUser() {
    if (this.user) return this.user;
    let user;
    try {
      user = await getUser(this.grant.at, this.grant.uid);
    } catch (e) {
      if (e instanceof GhlError && [400, 401, 403, 404].includes(e.status)) {
        throw new Error("Your HighLevel user could not be verified (removed, deactivated or signed out). Reconnect to continue.");
      }
      throw e;
    }
    if (user.deleted === true) throw new Error("Your HighLevel user has been removed.");
    const roles = user.roles || {};
    if (roles.type === "account" && Array.isArray(roles.locationIds)) {
      const reachable = this.grant.all
        ? roles.locationIds.length > 0
        : (Array.isArray(this.grant.ls) ? this.grant.ls.map(([id]) => id) : [this.grant.lid]).some((id) => roles.locationIds.includes(id));
      if (!reachable) throw new Error("You no longer have access to the sub-accounts this connection was set up for.");
    }
    this.user = user;
    return user;
  }

  allowedTools(user) {
    return TOOLS.filter((t) => isAllowed(t, user));
  }

  async handle(msg) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return msg && "id" in msg ? rpcError(msg.id ?? null, -32600, "Invalid request") : null;
    }
    const isNotification = !("id" in msg);
    if (isNotification) return null;
    const { id, method, params = {} } = msg;

    try {
      switch (method) {
        case "initialize":
          return rpcResult(id, {
            protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "evergreen-junction", version: "2.0.0" },
            instructions:
              (this.multiLocation
                ? "HighLevel tools covering several sub-accounts. Every tool takes locationId to say which one; call list_locations to see them. " +
                  "Reads fall back to the connection's main sub-account, but anything that changes data must name locationId — ask the user which sub-account and never guess, " +
                  "since the same contact or pipeline name can exist in several of them. "
                : "HighLevel tools for the signed-in user's sub-account. ") +
              "Only what the user's HighLevel permissions allow is available. " +
              "Use the dedicated tools (search_contacts, send_message, ...) when one fits. For anything else in HighLevel " +
              "(invoices, payments, products, social planner, workflows, custom objects, ...) use search_operations, then describe_operation, then execute_operation. " +
              "Never set confirm: true on execute_operation unless the user explicitly confirmed that exact action. Call whoami to see who is signed in and what they can do.",
          });
        case "ping":
          return rpcResult(id, {});
        case "tools/list": {
          const user = await this.loadUser();
          return rpcResult(id, {
            tools: this.allowedTools(user).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: this.multiLocation ? withLocationId(t) : t.inputSchema,
              annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive },
            })),
          });
        }
        case "tools/call":
          return rpcResult(id, await this.callTool(params.name, params.arguments || {}));
        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      return rpcError(id, -32000, e.message);
    }
  }

  /** Who/where for the activity log. */
  who(where) {
    const g = this.grant;
    const u = this.user;
    return {
      user_id: g.uid,
      user_email: g.em || u?.email || null,
      user_name: g.nm || u?.name || null,
      location_id: where?.id || g.lid,
      location_name: where?.name || g.ln || null,
      company_id: g.cmp || null,
      client: g.cn || null,
      ip: this.ip,
    };
  }

  async callTool(name, rawArgs) {
    // locationId is the connection's own argument, not the tool's: take it off before the
    // tool (or a catalog operation's schema) ever sees it.
    const { locationId: wantedLocation, ...args } = rawArgs;
    const tool = TOOLS.find((t) => t.name === name);
    // Log which API operation was run, not just "execute_operation".
    const logName = tool && /^(execute|describe)_operation$/.test(name) && typeof args.operation === "string" ? `${name}:${args.operation}` : name;
    if (!tool) {
      await audit({ event: "tool_denied", ...this.who(), tool: name, ok: false, error: "Unknown tool", args });
      return toolError(`Unknown tool: ${name}`);
    }
    let user;
    try {
      user = await this.loadUser();
    } catch (e) {
      await audit({ event: "tool_denied", ...this.who(), tool: logName, ok: false, error: e.message, args });
      throw e;
    }
    if (!isAllowed(tool, user)) {
      const why = deniedReason(tool, user);
      await audit({ event: "tool_denied", ...this.who(), tool: logName, ok: false, error: `Missing ${why}`, args });
      return toolError(`Your user doesn't have ${why}, which ${name} needs.`);
    }
    let where;
    try {
      where = await this.resolveLocation(tool, wantedLocation, user);
    } catch (e) {
      await audit({ event: "tool_denied", ...this.who(), tool: logName, ok: false, error: e.message, args });
      return toolError(e.message);
    }
    const at = await this.tokenFor(where.id);
    const ctx = {
      ghl: (method, path, opts) => ghlRequest(at, method, path, opts),
      user,
      userId: this.grant.uid,
      locationId: where.id,
      locationName: where.name,
      multiLocation: this.multiLocation,
      listLocations: () => this.locations(user),
      companyId: this.grant.cmp || this.user?.companyId || null,
      assignedOnly: assignedOnlyFor(user, tool.module, !!tool.writeScopes),
      writing: !!tool.writeScopes,
      assignedOnlyBecause: assignedOnlyReason(user, tool.module, !!tool.writeScopes),
      allowedToolNames: this.allowedTools(user).map((t) => t.name),
    };
    const started = Date.now();
    try {
      const result = await tool.run(ctx, args);
      await audit({ event: "tool_call", ...this.who(where), tool: logName, ok: true, args, duration_ms: Date.now() - started });
      return { content: [{ type: "text", text: clipText(JSON.stringify(result, null, 2)) }] };
    } catch (e) {
      await audit({ event: e.denied ? "tool_denied" : "tool_call", ...this.who(where), tool: logName, ok: false, error: e.message, args, duration_ms: Date.now() - started });
      return toolError(e.message);
    }
  }
}

// Keep very large API responses from flooding the AI's context.
const MAX_RESULT_CHARS = 100_000;
const clipText = (text = "") =>
  text.length <= MAX_RESULT_CHARS
    ? text
    : text.slice(0, MAX_RESULT_CHARS) + `\n... [cut: the response was ${text.length} characters. Ask for fewer results, e.g. a smaller limit or a filter.]`;

const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });

// With several sub-accounts connected, every tool takes locationId to say which one to work in.
function withLocationId(tool) {
  const schema = tool.inputSchema || { type: "object", properties: {} };
  return {
    ...schema,
    properties: {
      ...(schema.properties || {}),
      locationId: {
        type: "string",
        description: tool.readOnly
          ? "Which sub-account to read from. Defaults to the connection's main one. Use list_locations to see the options."
          : "Which sub-account to change. Required, because this connection covers several. Ask the user which one — never guess. Use list_locations to see the options.",
      },
    },
    ...(tool.readOnly ? {} : { required: [...(schema.required || []), "locationId"] }),
  };
}
