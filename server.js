// Local dev server: node server.js (reads .env if present)
import http from "node:http";
import fs from "node:fs";

if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const { default: handler } = await import("./api/index.js");
const port = Number(process.env.PORT) || 3000;
http.createServer((req, res) => handler(req, res)).listen(port, () => console.log(`http://localhost:${port}`));
