// ClientSided's Private Roblox Name Scanner - local server + API proxy
// Run: node server.js   (Node 18+)  then open http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/check") {
    const u = url.searchParams.get("u") || "";
    if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "bad username" }));
    }
    try {
      const r = await fetch(
        "https://auth.roblox.com/v1/usernames/validate?request.username=" +
          encodeURIComponent(u) + "&request.birthday=2000-01-01&request.context=Signup"
      );
      const body = r.status === 200 ? await r.json() : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: r.status, code: body.code, message: body.message }));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream failed" }));
    }
    return;
  }
  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    res.writeHead(err ? 500 : 200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(err ? "index.html missing" : data);
  });
}).listen(3000, () => console.log("Scanner running at http://localhost:3000"));
