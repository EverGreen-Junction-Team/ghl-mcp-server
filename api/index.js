// Single entry point; vercel.json rewrites every path here.
import { handleMcp } from "../lib/mcp.js";
import { protectedResourceMetadata, authServerMetadata, register, authorize, callback, token } from "../lib/oauth.js";
import { baseUrl, readBody, sendJson, sendHtml } from "../lib/http.js";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  try {
    if (path.startsWith("/.well-known/oauth-protected-resource")) return protectedResourceMetadata(req, res);
    if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration")) {
      return authServerMetadata(req, res);
    }

    switch (path) {
      case "/mcp":
        return await handleMcp(req, res, req.method === "POST" ? await readBody(req) : undefined);
      case "/register":
        if (req.method !== "POST") break;
        req.body = await readBody(req);
        return register(req, res);
      case "/authorize":
        return authorize(req, res, url.searchParams);
      case "/callback":
        return await callback(req, res, url.searchParams);
      case "/token":
        if (req.method !== "POST") break;
        req.body = await readBody(req);
        return await token(req, res);
      case "/":
        return sendHtml(
          res,
          200,
          `<h2>HighLevel MCP</h2><p>Add this URL as a custom connector in Claude:</p><pre>${baseUrl(req)}/mcp</pre>` +
            `<p>You'll sign in with HighLevel, and only the tools your HighLevel user is allowed to use will be available.</p>`
        );
      case "/health":
        return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: "server_error", error_description: e.message });
  }
}
