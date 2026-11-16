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
      `<button type="submit" data-busy="Sending code…">Send code</button></form>`,
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
      `<button type="submit" data-busy="Checking…">Continue</button></form>` +
      `<form method="post" action="/authorize">${hidden("step", "resend")}${hidden("s", s)}` +
      `<button type="submit" class="link" data-busy="Sending…" data-cooldown="60">Send a new code</button></form>`,
  });
}

// Naming every sub-account makes the connection's token bigger, so past this many we ask the
// user to pick "all" instead, which stores a flag rather than a list.
const MAX_NAMED_LOCATIONS = 40;

function pickPage(res, v, name, locations, { error } = {}) {
  page(res, {
    title: "Choose sub-accounts",
    status: error ? 400 : 200,
    body:
      `<h1>Choose sub-accounts</h1>` +
      `<div class="who">Signed in as ${esc(name)}</div>` +
      `<p>Pick each sub-account your AI assistant should work in. You can choose more than one — it works in every one with your own permissions.</p>` +
      (error ? `<div class="err">${esc(error)}</div>` : "") +
      `<form method="post" action="/authorize">${hidden("step", "location")}${hidden("v", v)}` +
      `<div class="list" id="picks">` +
      locations.map((l) => `<label><input type="checkbox" name="lid" value="${esc(l.id)}">${esc(l.name)}</label>`).join("") +
      `</div>` +
      `<label class="every"><input type="checkbox" name="all" value="1" id="every">All sub-accounts, including any added later</label>` +
      `<button type="submit" data-busy="Connecting…">Connect</button></form>` +
      // Ticking "all" makes the individual picks moot; grey them out so that is obvious.
      `<script>(function(){var e=document.getElementById("every"),l=document.getElementById("picks");` +
      `if(!e||!l)return;e.addEventListener("change",function(){l.querySelectorAll("input").forEach(function(i){i.disabled=e.checked});` +
      `l.querySelectorAll("label").forEach(function(x){x.classList.toggle("off",e.checked)})})})();</script>`,
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
    if (locations.length === 1) return finish(req, res, s, locations);
    locations.sort((a, b) => a.name.localeCompare(b.name));
    const v = seal("verified", { ...s, locs: locations }, STEP_TTL);
    return pickPage(res, v, s.nm, locations);
  }

  if (step === "location") {
    const v = open("verified", body.v);
    if (!v) return errorPage(res, "This sign-in page expired.");
    const available = v.locs || [];
    const every = body.all === "1" || body.all === "on";
    const wanted = new Set([].concat(body.lid || []).filter(Boolean).map(String));
    const chosen = every ? available : available.filter((l) => wanted.has(l.id));

    if (!chosen.length) {
      return pickPage(res, body.v, v.nm, available, { error: "Choose at least one sub-account." });
    }
    if (!every && chosen.length > MAX_NAMED_LOCATIONS) {
      return pickPage(res, body.v, v.nm, available, {
        error: `That's more than ${MAX_NAMED_LOCATIONS} sub-accounts to name one by one. Tick "All sub-accounts" instead.`,
      });
    }
    return finish(req, res, v, chosen, every);
  }

  errorPage(res, "Unknown step.");
}

async function finish(req, res, s, locs, every = false) {
  // The first sub-account is the connection's default: the one tools use when the AI doesn't
  // name another, and the one whose token the connection carries. The rest are minted on demand.
  const primary = locs[0];
  let t;
  try {
    t = await locationToken(primary.id);
  } catch (e) {
    await audit({ event: "sign_in_denied", user_id: s.uid, user_email: s.em, user_name: s.nm, location_id: primary.id, location_name: primary.name, company_id: s.cmp, error: e.message, client: s.p.cn, ip: clientIp(req) });
    return errorPage(res, e.message, 502);
  }
  const g = {
    at: t.at, exp: t.exp, uid: s.uid, cmp: t.cmp || s.cmp, em: s.em, nm: s.nm,
    lid: primary.id, ln: primary.name,
    // Only carried when the connection spans more than one sub-account, so single-sub-account
    // connections keep exactly the shape (and token size) they had before.
    ...(every ? { all: true } : locs.length > 1 ? { ls: locs.map((l) => [l.id, l.name]) } : {}),
  };
  const ourCode = seal("code", { cid: s.p.cid, ru: s.p.ru, cc: s.p.cc, cn: s.p.cn, g }, 120);
  await audit({
    event: "sign_in", user_id: s.uid, user_email: s.em, user_name: s.nm,
    location_id: primary.id, location_name: every ? "All sub-accounts" : locs.map((l) => l.name).join(", ").slice(0, 200),
    company_id: g.cmp, ok: true, client: s.p.cn, ip: clientIp(req),
  });

  const back = new URL(s.p.ru);
  back.searchParams.set("code", ourCode);
  if (s.p.st) back.searchParams.set("state", s.p.st);
  redirect(res, back.toString());
}
