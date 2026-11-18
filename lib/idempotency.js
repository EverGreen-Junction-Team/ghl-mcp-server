// Making a write safe to retry.
//
// The problem this solves is narrow and real: a write reaches the CRM, the response is lost on
// the way back, and the AI -- seeing an error -- tries again. Without a key the second attempt
// creates a second record. With one, it returns what the first attempt did.
//
// The claim is written BEFORE the request goes out, so two calls racing with the same key can't
// both run: one inserts, the other sees the claim. A claim is cleared if the request fails, so
// a genuine failure stays retryable rather than being remembered as a result.
import { createHash } from "node:crypto";
import { db } from "./supabase.js";

const TABLE = "mcp_idempotency";
const TTL_MS = 60 * 60 * 1000;

/**
 * Keys are the caller's to choose, so they're scoped to the sub-account, the user and the
 * operation before being hashed. "retry-1" from two different people must never collide.
 */
const idFor = (ctx, op, key) =>
  createHash("sha256").update([ctx.locationId, ctx.userId, op.id, key].join("\u0000")).digest("hex").slice(0, 40);

const fresh = (row) => Date.now() - new Date(row.at).getTime() < TTL_MS;

/** Run `fn` once for this key, or return what it returned the first time. */
export async function onlyOnce(ctx, op, key, fn) {
  const id = idFor(ctx, op, key);

  const claimed = await claim(id, ctx, op);
  if (claimed.replay) return { ...claimed.result, idempotentReplay: true, idempotencyKey: key };
  if (claimed.running) {
    throw new Error(
      `A call with idempotencyKey "${key}" for ${op.id} is already running. Wait for it rather than sending it again; ` +
        `if it failed, the key is released and you can retry.`
    );
  }
  if (!claimed.ok) return fn(); // storage is unavailable; better to run than to refuse

  let result;
  try {
    result = await fn();
  } catch (e) {
    // The write didn't happen, so the key must not be remembered as though it had.
    try {
      await db.delete(TABLE, `id=eq.${encodeURIComponent(id)}`);
    } catch {
      // If the claim can't be cleared it expires on its own; the error below is what matters.
    }
    throw e;
  }
  try {
    await db.update(TABLE, `id=eq.${encodeURIComponent(id)}`, { status: "done", result, at: new Date().toISOString() });
  } catch (e) {
    console.error("couldn't store the idempotent result:", e.message);
  }
  return result;
}

/**
 * Try to claim the key. Returns { replay, result } if this key already ran, { running: true }
 * if another call holds it, { ok: true } if we now hold it, or { ok: false } if the store
 * couldn't be reached -- in which case the caller runs unprotected rather than refusing.
 */
async function claim(id, ctx, op) {
  try {
    const existing = (await db.select(TABLE, `id=eq.${encodeURIComponent(id)}&select=*&limit=1`))?.[0];
    const live = existing && fresh(existing);
    if (live && existing.status === "done") return { replay: true, result: existing.result };
    if (live) return { running: true };
    if (existing) await db.delete(TABLE, `id=eq.${encodeURIComponent(id)}`); // expired

    await db.insert(TABLE, {
      id,
      location_id: ctx.locationId,
      user_id: ctx.userId,
      operation: op.id,
      status: "running",
      at: new Date().toISOString(),
    });
    return { ok: true };
  } catch (e) {
    // A 409 means another request inserted the same key between our read and our write. That is
    // the race this exists for, so it's the one error worth reporting as "someone else has it".
    if (e?.status === 409) return { running: true };
    console.error("idempotency store unavailable:", e.message);
    return { ok: false };
  }
}
