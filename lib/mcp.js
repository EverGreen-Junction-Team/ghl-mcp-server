// MCP over Streamable HTTP (stateless, JSON responses).
import { open } from "./seal.js";
import { ghlRequest, getUser, GhlError } from "./ghl.js";
import { TOOLS, isAllowed } from "./tools.js";
import { baseUrl, sendJson } from "./http.js";

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
  if (!grant) return unauthorized(req, res, "Sign in to HighLevel to continue");

  if (body?.__invalidJson) return sendJson(res, 400, rpcError(null, -32700, "Parse error"));

  const session = new Session(grant);
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
  constructor(grant) {
    this.grant = grant;
    this.user = null;
  }

  ghl = (method, path, opts) => ghlRequest(this.grant.at, method, path, opts);

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
    if (roles.type === "account" && Array.isArray(roles.locationIds) && !roles.locationIds.includes(this.grant.lid)) {
      throw new Error("You no longer have access to this sub-account.");
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
            serverInfo: { name: "highlevel-scoped", version: "1.0.0" },
            instructions:
              "HighLevel CRM tools for the signed-in user's sub-account. Only tools the user's HighLevel permissions allow are available. Call whoami to see who is signed in and what they can do.",
          });
        case "ping":
          return rpcResult(id, {});
        case "tools/list": {
          const user = await this.loadUser();
          return rpcResult(id, {
            tools: this.allowedTools(user).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false },
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

  async callTool(name, args) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return toolError(`Unknown tool: ${name}`);
    const user = await this.loadUser();
    if (!isAllowed(tool, user)) {
      return toolError(`Your HighLevel user doesn't have the "${tool.permission}" permission needed for ${name}.`);
    }
    const ctx = {
      ghl: this.ghl,
      user,
      userId: this.grant.uid,
      locationId: this.grant.lid,
      assignedOnly: user.permissions?.assignedDataOnly === true,
      allowedToolNames: this.allowedTools(user).map((t) => t.name),
    };
    try {
      const result = await tool.run(ctx, args);
      console.log(JSON.stringify({ event: "tool_call", tool: name, userId: ctx.userId, locationId: ctx.locationId, ok: true }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      console.log(JSON.stringify({ event: "tool_call", tool: name, userId: ctx.userId, locationId: ctx.locationId, ok: false, error: e.message }));
      return toolError(e.message);
    }
  }
}

const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });
