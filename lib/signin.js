// EverGreen-branded sign-in: email -> one-time code -> pick sub-account -> back to the AI app.
// No HighLevel page is shown. State between steps travels in encrypted form fields.
import { seal, open } from "./seal.js";
import { page, errorPage, esc, brandName, productName } from "./pages.js";
import { sendEmailCode, verifyEmailCode } from "./supabase.js";
import { findUserByEmail, getUserById, locationsForUser, locationToken } from "./agency.js";
import { audit, clientIp } from "./audit.js";
import { redirect } from "./http.js";

const STEP_TTL = 15 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const userName = (u) => u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;

// ---------- pages ----------
function emailPage(res, p, { email = "", error } = {}) {
  page(res, {
    title: "Sign in",
    status: error ? 400 : 200,
    body:
      `<h1>Sign in to ${esc(productName())}</h1>` +
      `<p>Sign in with the email you use for ${esc(brandName())}. We'll send you a code.</p>` +
      (error ? `<div class="err">${esc(error)}</div>` : "") +
      `<form method="post" action="/authorize">${hidden("step", "email")}${hidden("p", p)}` +
      `<label for="email">Work email</label>` +
      `<input id="email" name="email" type="email" autocomplete="email" required autofocus value="${esc(email)}">` +
      `<button type="submit">Send code</button></form>`,
  });
}

function codePage(res, s, email, { error, resent } = {}) {
  page(res, {
    title: "Enter code",
    status: error ? 400 : 200,
    body:
      `<h1>Check your email</h1>` +
      `<p>We sent a 6-digit code to <b>${esc(email)}</b>. It expires in a few minutes.</p>` +
      (error ? `<div class="err">${esc(error)}</div>` : resent ? `<p>A new code is on its way.</p>` : "") +
      `<form method="post" action="/authorize">${hidden("step", "code")}${hidden("s", s)}` +
      `<label for="code">Code</label>` +
      `<input id="code" class="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required autofocus>` +
      `<button type="submit">Continue</button></form>` +
      `<form method="post" action="/authorize">${hidden("step", "resend")}${hidden("s", s)}` +
      `<button type="submit" class="link">Send a new code</button></form>`,
  });
}

function pickPage(res, v, name, locations) {
  page(res, {
    title: "Choose sub-account",
    body:
      `<h1>Choose a sub-account</h1>` +
      `<div class="who">Signed in as ${esc(name)}</div>` +
      `<p>Your AI assistant will work in this sub-account, with your permissions.</p>` +
      `<form method="post" action="/authorize">${hidden("step", "location")}${hidden("v", v)}<div class="list">` +
      locations.map((l) => `<button type="submit" name="lid" value="${esc(l.id)}">${esc(l.name)}</button>`).join("") +
      `</div></form>`,
  });
}

// ---------- steps ----------
/** GET /authorize, after the OAuth request was validated. `pending` = what to send back to the AI app. */
export function startSignIn(res, pending) {
  emailPage(res, seal("pending", pending, STEP_TTL));
}

/** POST /authorize */
export async function signInStep(req, res, body) {
  const step = body.step;

  if (step === "email") {
    const p = open("pending", body.p);
    if (!p) return errorPage(res, "This sign-in page expired.");
    const email = String(body.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return emailPage(res, body.p, { email, error: "Enter a valid email address." });

    const { user, companyId } = await findUserByEmail(email);
    if (!user) {
      await audit({ event: "sign_in_denied", user_email: email, company_id: companyId, error: "No active user with this email", client: p.cn, ip: clientIp(req) });
      return emailPage(res, body.p, { email, error: `This email isn't an active ${brandName()} user. Use the email from your account, or ask your admin.` });
    }
    try {
      await sendEmailCode(email);
    } catch (e) {
      console.error("send code failed:", e.message);
      const busy = e.status === 429;
      return emailPage(res, body.p, { email, error: busy ? "Too many codes requested. Wait a minute and try again." : "We couldn't send the code. Try again in a moment." });
    }
    const s = seal("signin", { p, em: email, uid: user.id, nm: userName(user), cmp: companyId }, STEP_TTL);
    await audit({ event: "code_sent", user_id: user.id, user_email: email, user_name: userName(user), company_id: companyId, client: p.cn, ip: clientIp(req) });
    return codePage(res, s, email);
  }

  if (step === "resend") {
    const s = open("signin", body.s);
    if (!s) return errorPage(res, "This sign-in page expired.");
    try {
      await sendEmailCode(s.em);
    } catch (e) {
      return codePage(res, body.s, s.em, { error: e.status === 429 ? "Too many codes requested. Wait a minute and try again." : "We couldn't send the code. Try again in a moment." });
    }
    return codePage(res, body.s, s.em, { resent: true });
  }

  if (step === "code") {
    const s = open("signin", body.s);
    if (!s) return errorPage(res, "This sign-in page expired.");
    const code = String(body.code || "").replace(/\D/g, "");
    let ok = false;
    try {
      ok = code.length >= 6 && (await verifyEmailCode(s.em, code));
    } catch (e) {
      console.error("verify code failed:", e.message);
      return codePage(res, body.s, s.em, { error: e.status === 429 ? "Too many attempts. Wait a minute and try again." : "We couldn't check the code. Try again." });
    }
    if (!ok) {
      await audit({ event: "code_failed", user_id: s.uid, user_email: s.em, user_name: s.nm, company_id: s.cmp, client: s.p.cn, ip: clientIp(req) });
      return codePage(res, body.s, s.em, { error: "That code is wrong or expired." });
    }

    // Fresh copy of the user, in case access changed since the email step.
    const user = await getUserById(s.uid);
    const locations = user && user.deleted !== true ? await locationsForUser(user) : [];
    if (!locations.length) {
      await audit({ event: "sign_in_denied", user_id: s.uid, user_email: s.em, user_name: s.nm, company_id: s.cmp, error: "No sub-account with the app installed", client: s.p.cn, ip: clientIp(req) });
      return errorPage(res, "Your user doesn't have access to any sub-account where this connector is installed. Ask your admin.", 403);
    }
    if (locations.length === 1) return finish(req, res, s, locations[0]);
    locations.sort((a, b) => a.name.localeCompare(b.name));
    const v = seal("verified", { ...s, locs: locations }, STEP_TTL);
    return pickPage(res, v, s.nm, locations);
  }

  if (step === "location") {
    const v = open("verified", body.v);
    if (!v) return errorPage(res, "This sign-in page expired.");
    const loc = (v.locs || []).find((l) => l.id === body.lid);
    if (!loc) return errorPage(res, "You don't have access to that sub-account.", 403);
    return finish(req, res, v, loc);
  }

  errorPage(res, "Unknown step.");
}

async function finish(req, res, s, loc) {
  let t;
  try {
    t = await locationToken(loc.id);
  } catch (e) {
    await audit({ event: "sign_in_denied", user_id: s.uid, user_email: s.em, user_name: s.nm, location_id: loc.id, location_name: loc.name, company_id: s.cmp, error: e.message, client: s.p.cn, ip: clientIp(req) });
    return errorPage(res, e.message, 502);
  }
  const g = { at: t.at, exp: t.exp, uid: s.uid, lid: loc.id, cmp: t.cmp || s.cmp, em: s.em, nm: s.nm, ln: loc.name };
  const ourCode = seal("code", { cid: s.p.cid, ru: s.p.ru, cc: s.p.cc, cn: s.p.cn, g }, 120);
  await audit({ event: "sign_in", user_id: s.uid, user_email: s.em, user_name: s.nm, location_id: loc.id, location_name: loc.name, company_id: g.cmp, ok: true, client: s.p.cn, ip: clientIp(req) });

  const back = new URL(s.p.ru);
  back.searchParams.set("code", ourCode);
  if (s.p.st) back.searchParams.set("state", s.p.st);
  redirect(res, back.toString());
}
