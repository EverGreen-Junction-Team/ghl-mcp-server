// Encrypted, self-contained tokens (AES-256-GCM). Lets the server run with no database:
// client IDs, auth codes, access and refresh tokens all carry their own data.
import crypto from "node:crypto";

function key() {
  const secret = process.env.TOKEN_SECRET;
  if (!secret || secret.length < 32) throw new Error("TOKEN_SECRET must be set (32+ chars)");
  return crypto.createHash("sha256").update(secret).digest();
}

const now = () => Math.floor(Date.now() / 1000);

/** Encrypt `data` with a type tag and optional lifetime in seconds. */
export function seal(typ, data, ttlSeconds) {
  const payload = { ...data, typ };
  if (ttlSeconds) payload.exp = now() + ttlSeconds;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Decrypt a token of the given type. Returns null if invalid, tampered, wrong type or expired. */
export function open(typ, token) {
  if (typeof token !== "string" || token.length < 40) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const payload = JSON.parse(text);
    if (payload.typ !== typ) return null;
    if (payload.exp && payload.exp < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sha256url(text) {
  return crypto.createHash("sha256").update(text).digest("base64url");
}
