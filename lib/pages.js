// EverGreen-branded pages for sign-in and install. Self-contained HTML, no external assets
// except an optional logo (BRAND_LOGO_URL).
export const brandName = () => process.env.BRAND_NAME || "EverGreen Junction";
export const productName = () => process.env.PRODUCT_NAME || "EverGreen MCP Connector";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const MARK = `<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#1f9d55"/><path d="M15 24h18M19 18h-3a6 6 0 0 0 0 12h3M29 18h3a6 6 0 0 1 0 12h-3" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round"/></svg>`;

function logo() {
  const src = process.env.BRAND_LOGO_URL;
  return src ? `<img src="${esc(src)}" alt="" width="40" height="40" style="border-radius:10px">` : MARK;
}

const CSS = `
:root{--bg:#f3f6f4;--card:#fff;--ink:#0f1f17;--muted:#5b6b62;--line:#dbe4de;--brand:#1f9d55;--brand-ink:#fff;--err:#b42318;--err-bg:#fef3f2}
@media (prefers-color-scheme:dark){:root{--bg:#0c1511;--card:#13201a;--ink:#e8f1ec;--muted:#9db0a5;--line:#24372d;--err:#fda29b;--err-bg:#3a1513}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px 16px}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 28px;box-shadow:0 8px 30px rgba(15,31,23,.06)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:24px;font-weight:600;font-size:17px}
h1{font-size:22px;line-height:1.3;margin:0 0 8px}
p{margin:0 0 16px;color:var(--muted)}
label{display:block;font-size:14px;font-weight:600;margin:0 0 6px}
input[type=email],input[type=text]{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink)}
input:focus{outline:2px solid var(--brand);outline-offset:1px;border-color:var(--brand)}
input.code{font-size:24px;letter-spacing:.4em;text-align:center;font-variant-numeric:tabular-nums}
button,.btn{display:block;width:100%;margin-top:16px;padding:12px 16px;font:inherit;font-weight:600;border:0;border-radius:10px;background:var(--brand);color:var(--brand-ink);cursor:pointer;text-align:center;text-decoration:none}
button:hover{filter:brightness(1.05)}
button:disabled{opacity:.6;cursor:default;filter:none}
.link{background:none;color:var(--brand);padding:0;margin-top:12px;font-weight:500;width:auto}
.err{background:var(--err-bg);color:var(--err);padding:10px 12px;border-radius:10px;font-size:14px;margin:0 0 16px}
.list{display:flex;flex-direction:column;gap:8px;margin-top:8px;max-height:360px;overflow:auto}
.list button{margin:0;background:transparent;color:var(--ink);border:1px solid var(--line);text-align:left;font-weight:500}
.list button:hover{border-color:var(--brand);filter:none}
.who{font-size:14px;color:var(--muted);margin-bottom:16px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow:auto;font-size:14px}
.foot{margin-top:24px;font-size:12px;color:var(--muted);text-align:center}
`;

// One click per submit: show "Sending…" and block double-clicks. "Send a new code" waits out
// Supabase's 60-second limit with a countdown.
const SCRIPT = `
document.querySelectorAll("form").forEach(function (f) {
  f.addEventListener("submit", function (e) {
    var b = e.submitter;
    if (f.dataset.sent) { e.preventDefault(); return; }
    f.dataset.sent = "1";
    if (b && b.name) { var h = document.createElement("input"); h.type = "hidden"; h.name = b.name; h.value = b.value; f.appendChild(h); }
    f.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
    if (b && b.dataset.busy) b.textContent = b.dataset.busy;
  });
});
document.querySelectorAll("button[data-cooldown]").forEach(function (b) {
  var left = +b.dataset.cooldown, label = b.textContent;
  b.disabled = true;
  var t = setInterval(function () {
    left--;
    if (left <= 0) { clearInterval(t); b.disabled = false; b.textContent = label; }
    else b.textContent = label + " (" + left + "s)";
  }, 1000);
  b.textContent = label + " (" + left + "s)";
});
`;

export function page(res, { title, body, status = 200 }) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)} · ${esc(productName())}</title><style>${CSS}</style></head><body><main class="card">` +
      `<div class="brand">${logo()}<span>${esc(productName())}</span></div>${body}` +
      `<div class="foot">Secure sign-in by ${esc(brandName())}</div></main><script>${SCRIPT}</script></body></html>`
  );
}

export function errorPage(res, message, status = 400) {
  page(res, { title: "Can't connect", status, body: `<h1>Can't connect</h1><div class="err">${esc(message)}</div><p>Close this window and start the connection again from your AI app.</p>` });
}
