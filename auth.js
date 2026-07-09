const crypto = require("crypto");
const fs = require("fs");
const { request } = require("./http-client");

function cliToken(config) {
  const machineId = fs.readFileSync(config.machineIdPath, "utf8").trim();
  const cliSecret = fs.readFileSync(config.cliSecretPath, "utf8").trim();
  return crypto
    .createHash("sha256")
    .update(machineId + "9r-cli-auth" + cliSecret)
    .digest("hex")
    .substring(0, 16);
}

function cliTokenHeaders(config) {
  return { "x-9r-cli-token": cliToken(config) };
}

function parseSetCookie(setCookie) {
  const cookies = {};
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const entry of list) {
    const pair = entry.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq !== -1) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

function sessionHeaders(cookies) {
  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return cookieStr ? { Cookie: cookieStr } : {};
}

async function dashboardSession(config) {
  const res = await request(config, {
    method: "POST",
    path: "/api/auth/login",
    body: { password: config.password },
    headers: { "Content-Type": "application/json" },
  });
  if (res.statusCode >= 400) {
    const bodySnippet = (res.body || "").slice(0, 200);
    throw new Error(`Dashboard login failed (HTTP ${res.statusCode}): ${bodySnippet}`);
  }
  const cookies = parseSetCookie(res.headers["set-cookie"]);
  if (Object.keys(cookies).length === 0) {
    throw new Error("Dashboard login succeeded but no auth cookie was returned");
  }
  return cookies;
}

async function resolveAuthHeaders(config) {
  if (config.mode === "local") return cliTokenHeaders(config);
  if (config.mode === "remote") return sessionHeaders(await dashboardSession(config));
  throw new Error(`Unknown auth mode: ${config.mode}`);
}

module.exports = {
  cliToken,
  cliTokenHeaders,
  parseSetCookie,
  sessionHeaders,
  dashboardSession,
  resolveAuthHeaders,
};
