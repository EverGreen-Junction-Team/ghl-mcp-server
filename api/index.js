// Single entry point; vercel.json rewrites every path here.
import { handleMcp } from "../lib/mcp.js";
import { protectedResourceMetadata, authServerMetadata, register, authorize, install, callback, token, revoke } from "../lib/oauth.js";
import { signInStep } from "../lib/signin.js";
import { page, errorPage, productName } from "../lib/pages.js";
import { baseUrl, readBody, sendJson } from "../lib/http.js";
import { LOGO_SVG, LOGO_PNG } from "../lib/brand.js";

function sendAsset(res, type, data) {
  res.statusCode = 200;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.end(data);
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  // On Vercel every path is rewritten to /api; the original path arrives as ?__path= (see vercel.json).
  const original = url.searchParams.get("__path");
  url.searchParams.delete("__path");
  const path = (original ?? url.pathname).replace(/\/+$/, "") || "/";

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
        if (req.method === "POST") {
          try {
            return await signInStep(req, res, await readBody(req));
          } catch (e) {
            console.error(e);
            return errorPage(res, e.message, 500);
          }
        }
        return authorize(req, res, url.searchParams);
      case "/revoke":
        if (req.method !== "POST") break;
        req.body = await readBody(req);
        return await revoke(req, res);
      case "/install":
        return install(req, res);
      case "/callback":
        return await callback(req, res, url.searchParams);
      case "/token":
        if (req.method !== "POST") break;
        req.body = await readBody(req);
        return await token(req, res);
      case "/":
        return page(res, {
          title: "Connect",
          body:
            `<h1>${productName()}</h1><p>Add this URL as a custom connector in Claude:</p><pre>${baseUrl(req)}/mcp</pre>` +
            `<p>You'll sign in with your work email, and only the tools your permissions allow will be available.</p>`,
        });
      case "/logo.svg":
        return sendAsset(res, "image/svg+xml", LOGO_SVG);
      case "/logo.png":
        return sendAsset(res, "image/png", LOGO_PNG);
      case "/health":
        return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: "server_error", error_description: e.message });
  }
}
