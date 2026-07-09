const http = require("http");
const https = require("https");

function toCookieString(cookies) {
  if (!cookies) return "";
  if (typeof cookies === "string") return cookies;
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function request(config, { method = "GET", path: reqPath, body = null, cookies = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = config.proto === "https" ? https : http;
    const opts = {
      hostname: config.host,
      port: config.port,
      path: reqPath,
      method,
      headers: { ...headers },
    };
    let payload = null;
    if (body !== null && body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      opts.headers["Content-Type"] = opts.headers["Content-Type"] || "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const cookieStr = toCookieString(cookies);
    if (cookieStr) opts.headers["Cookie"] = cookieStr;
    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data })
      );
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request };
