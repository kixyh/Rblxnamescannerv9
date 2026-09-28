// ClientSided's Private Roblox Name Scanner - local server, API proxy, and email sender
// Setup: npm install  ->  copy mail-config.example.json to mail-config.json  ->  node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");

function loadMail() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(__dirname, "mail-config.json"), "utf8")); } catch (e) {}
  const e = process.env;
  return {
    host: e.SMTP_HOST || c.host, port: +(e.SMTP_PORT || c.port || 465),
    user: e.SMTP_USER || c.user, pass: e.SMTP_PASS || c.pass,
    from: e.MAIL_FROM || c.from || e.SMTP_USER || c.user,
  };
}
const configured = () => { const m = loadMail(); return !!(m.host && m.user && m.pass); };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clean = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, 200);
const readBody = (req) => new Promise((ok, no) => {
  let b = "";
  req.on("data", (d) => { b += d; if (b.length > 200000) { no(new Error("Request too large")); req.destroy(); } });
  req.on("end", () => ok(b));
});
let lastSend = 0;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/check") {
    const u = url.searchParams.get("u") || "";
    if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) return json(res, 400, { error: "bad username" });
    try {
      const r = await fetch(
        "https://auth.roblox.com/v1/usernames/validate?request.username=" +
          encodeURIComponent(u) + "&request.birthday=2000-01-01&request.context=Signup"
      );
      const body = r.status === 200 ? await r.json() : {};
      return json(res, 200, { status: r.status, code: body.code, message: body.message });
    } catch (e) { return json(res, 502, { error: "upstream failed" }); }
  }

  if (url.pathname === "/mail-status") return json(res, 200, { configured: configured() });

  if (url.pathname === "/email" && req.method === "POST") {
    try {
      if (Date.now() - lastSend < 5000) return json(res, 429, { error: "Wait a few seconds and try again." });
      const d = JSON.parse(await readBody(req));
      const to = String(d.to || "");
      if (!/^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,}$/.test(to))
        return json(res, 400, { error: "Invalid email address." });
      if (!configured()) return json(res, 500, { error: "Email isn't set up on the server. Create mail-config.json." });

      let subject, text, html;
      if (d.test) {
        subject = "Scanner test email";
        text = "Your ClientSided's Private Roblox Name Scanner can send email.";
        html = "<p>" + esc(text) + "</p>";
      } else {
        const r = d.report || {};
        const names = (Array.isArray(r.names) ? r.names : []).filter((n) => /^[A-Za-z0-9_]{3,20}$/.test(n)).slice(0, 1000);
        if (!names.length) return json(res, 400, { error: "No names to send." });
        const rows = [
          ["Time taken", r.duration], ["Started", r.started], ["Finished", clean(r.finished) + ", " + clean(r.date)],
          ["Names checked", r.checked], ["Taken (skipped)", r.taken], ["Hit rate", r.hitRate], ["Settings", r.settings],
        ].map(([k, v]) => [k, clean(v)]);
        subject = "Your Roblox names: " + names.length + " available";
        text = "Available Roblox usernames:\n\n" + names.join("\n") + "\n\n" + rows.map(([k, v]) => k + ": " + v).join("\n");
        html = '<div style="font-family:Arial,sans-serif;max-width:520px">' +
          '<h2 style="margin:0 0 4px">Scan complete</h2><p style="color:#666;margin:0 0 16px">' + names.length + " available username" + (names.length === 1 ? "" : "s") + " found</p>" +
          names.map((n) => '<div style="font:700 17px monospace;padding:10px 14px;margin:6px 0;background:#eafff3;border-left:4px solid #22c55e;border-radius:6px">' + esc(n) + "</div>").join("") +
          '<table style="margin-top:18px;font-size:14px;border-collapse:collapse">' +
          rows.map(([k, v]) => '<tr><td style="padding:4px 14px 4px 0;color:#666">' + esc(k) + "</td><td>" + esc(v) + "</td></tr>").join("") +
          "</table></div>";
      }
      const m = loadMail();
      const tx = require("nodemailer").createTransport({
        host: m.host, port: m.port, secure: m.port === 465, auth: { user: m.user, pass: m.pass },
      });
      await tx.sendMail({ from: m.from, to, subject, text, html });
      lastSend = Date.now();
      return json(res, 200, { ok: true });
    } catch (e) {
      const msg = e.code === "MODULE_NOT_FOUND" ? "Run npm install in the scanner folder first." : e.message || "Send failed";
      return json(res, 500, { error: msg });
    }
  }

  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    res.writeHead(err ? 500 : 200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(err ? "index.html missing" : data);
  });
}).listen(3000, "127.0.0.1", () => console.log("Scanner running at http://localhost:3000 (email " + (configured() ? "ready" : "not set up") + ")"));
