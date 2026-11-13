#!/usr/bin/env node
// Builds lib/catalog.generated.js from HighLevel's public OpenAPI specs.
//
//   git clone --depth 1 https://github.com/GoHighLevel/highlevel-api-docs /tmp/hl-docs
//   node scripts/build-catalog.js /tmp/hl-docs
//
// Only operations that accept a sub-account (Location) token are kept. Agency-only areas
// (OAuth, SaaS, snapshots, companies, custom menus, marketplace billing) are left out, and so are
// file uploads (multipart), since the AI can only send JSON.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2];
if (!root) {
  console.error("Usage: node scripts/build-catalog.js <path to highlevel-api-docs checkout>");
  process.exit(1);
}
const appsDir = path.join(root, "apps");
const outFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "catalog.generated.js");

const EXCLUDED_FILES = new Set(["oauth", "saas-api", "snapshots", "companies", "custom-menus", "marketplace"]);
const LOCATION_SCHEMES = new Set(["bearer", "Location-Access", "Location-Access-Only"]);
const METHODS = ["get", "post", "put", "patch", "delete"];
const MAX_DEPTH = 6;
const MAX_TEXT = 400;

// Operations HighLevel documents without a scope: which permission area they belong to.
function inferResource(area, p) {
  if (area === "locations") {
    if (p.includes("/tags")) return "locations/tags";
    if (p.includes("/customFields")) return "locations/customFields";
    if (p.includes("/customValues")) return "locations/customValues";
    if (p.includes("/templates")) return "locations/templates";
    if (p.includes("/recurring-tasks") || p.includes("/tasks")) return "locations/tasks";
    return "locations";
  }
  if (area === "social-media-posting") {
    if (p.includes("/csv")) return "socialplanner/csv";
    if (p.includes("/accounts")) return "socialplanner/account";
    if (p.includes("/categories")) return "socialplanner/category";
    if (p.includes("/tags")) return "socialplanner/tag";
    return "socialplanner/post";
  }
  if (area === "objects") return "objects/record";
  if (area === "payments") return "payments/orders";
  return area; // brand-boards, courses, funnels, invoices, knowledge-base, medias, products, proposals, store
}

const CONFIRM_WORDS = /(delete|remove|send|refund|cancel|void|charge|collect|bulk|merge|publish|import|train|crawl)/i;

const clip = (s) => (typeof s === "string" && s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s);

const fileCache = new Map();
function loadJson(file) {
  if (!fileCache.has(file)) fileCache.set(file, JSON.parse(fs.readFileSync(file, "utf8")));
  return fileCache.get(file);
}

function resolveRef(ref, baseFile) {
  const [filePart, pointer = ""] = ref.split("#");
  const file = filePart ? path.resolve(path.dirname(baseFile), filePart) : baseFile;
  let node = loadJson(file);
  for (const key of pointer.split("/").filter(Boolean)) node = node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")];
  return { node, file };
}

const KEEP = ["type", "format", "enum", "default", "example", "description", "required", "nullable", "minimum", "maximum", "maxLength", "minLength", "maxItems"];

/** Inline $refs and keep only what the AI needs to fill in a request. */
function simplify(schema, file, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    if (seen.has(schema.$ref) || depth > MAX_DEPTH) return { type: "object", description: "(nested object)" };
    const { node, file: f } = resolveRef(schema.$ref, file);
    return simplify(node, f, depth, new Set([...seen, schema.$ref]));
  }
  if (depth > MAX_DEPTH) return { type: schema.type || "object" };
  const out = {};
  for (const k of KEEP) if (schema[k] !== undefined) out[k] = k === "description" ? clip(schema[k]) : schema[k];
  if (schema.properties) {
    out.type = out.type || "object";
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = simplify(v, file, depth + 1, seen);
  }
  if (schema.items) out.items = simplify(schema.items, file, depth + 1, seen);
  for (const k of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(schema[k])) out[k] = schema[k].map((s) => simplify(s, file, depth + 1, seen));
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    out.additionalProperties = simplify(schema.additionalProperties, file, depth + 1, seen);
  }
  return out;
}

const operations = [];
const scopes = new Set();
let userScopes = [];
const skipped = { agencyOnly: 0, excludedArea: 0, multipart: 0 };

for (const name of fs.readdirSync(appsDir).filter((f) => f.endsWith(".json")).sort()) {
  const area = name.replace(/\.json$/, "");
  const file = path.join(appsDir, name);
  const spec = loadJson(file);
  if (area === "users") userScopes = spec.components?.schemas?.CreateUserDto?.properties?.scopes?.items?.enum || [];

  for (const [p, methods] of Object.entries(spec.paths || {})) {
    for (const method of METHODS) {
      const op = methods[method];
      if (!op) continue;
      const security = op.security || spec.security || [];
      if (!security.flatMap(Object.keys).some((k) => LOCATION_SCHEMES.has(k))) {
        skipped.agencyOnly++;
        continue;
      }
      if (EXCLUDED_FILES.has(area)) {
        skipped.excludedArea++;
        continue;
      }
      const content = op.requestBody?.content || {};
      if (op.requestBody && !content["application/json"]) {
        skipped.multipart++;
        continue;
      }

      const opScopes = [...new Set(security.flatMap((s) => Object.values(s).flat()))];
      opScopes.forEach((s) => scopes.add(s));
      const first = opScopes[0];
      const resource = first ? first.replace(/\.[^.]+$/, "") : inferResource(area === "social-media-posting" ? area : area, p);
      const read = first ? /\.(readonly|read)$/.test(first) : method === "get";

      let version;
      const params = [];
      for (const raw of [...(methods.parameters || []), ...(op.parameters || [])]) {
        const prm = raw.$ref ? resolveRef(raw.$ref, file).node : raw;
        if (!prm) continue;
        if (prm.in === "header") {
          if (prm.name.toLowerCase() === "version") version = prm.schema?.enum?.[0] || prm.schema?.default;
          continue; // Authorization and Version are set by the server
        }
        params.push({
          name: prm.name,
          in: prm.in,
          required: !!prm.required || prm.in === "path",
          description: clip(prm.description),
          schema: simplify(prm.schema || {}, file),
        });
      }

      const bodySchema = content["application/json"]?.schema;
      const summary = op.summary || op.operationId;
      operations.push({
        id: `${area}.${op.operationId || `${method}-${p}`}`,
        area,
        tag: (op.tags || [])[0] || area,
        method: method.toUpperCase(),
        path: p,
        summary: clip(summary),
        description: op.description && op.description !== op.summary ? clip(op.description) : undefined,
        scopes: opScopes,
        resource,
        access: read ? "read" : "write",
        confirm: method === "delete" || (!read && CONFIRM_WORDS.test(`${op.operationId} ${summary}`)),
        version: version || "2021-07-28",
        params,
        body: bodySchema ? simplify(bodySchema, file) : undefined,
        bodyRequired: !!op.requestBody?.required,
      });
    }
  }
}

const ids = new Set();
for (const op of operations) {
  if (ids.has(op.id)) throw new Error(`Duplicate operation id ${op.id}`);
  ids.add(op.id);
}

const header = `// GENERATED by scripts/build-catalog.js from https://github.com/GoHighLevel/highlevel-api-docs.
// Do not edit by hand: re-run the script to update.
`;
fs.writeFileSync(
  outFile,
  header +
    `export const CATALOG_SCOPES = ${JSON.stringify([...scopes].sort())};\n` +
    `export const USER_SCOPE_VOCABULARY = ${JSON.stringify(userScopes)};\n` +
    `export const OPERATIONS = ${JSON.stringify(operations)};\n`
);
console.log(
  `Wrote ${operations.length} operations (${scopes.size} scopes) to ${path.relative(process.cwd(), outFile)}.`,
  `Skipped: ${skipped.agencyOnly} agency-only, ${skipped.excludedArea} in excluded areas, ${skipped.multipart} file uploads.`
);
