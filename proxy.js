"use strict";

// Proxy rotation helpers — cycle per account index.
// Sumber: file (proxies.txt, gitignored) atau opsional API rotator.
// Scope: Puppeteer launch (AWS Builder ID). 9router API direct.
//
// Format baris di proxies.txt (one per line):
//   protocol://user:pass@host:port     (auth pakai puppeteer args + page.authenticate)
//   host:port:user:pass                 (legacy 4-field colon)
//   host:port                           (tanpa auth)
//   user:pass@host:port                 (default http)
//
// Lines kosong / `#` di-skip. Parse error per-line di-treat sebagai warning
// dan di-skip — gak menggugurkan seluruh load.

const fs = require("fs");

// Parse satu baris. Return null kalau invalid.
function parseProxyLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  // Format 1: protocol://user:pass@host:port
  const m1 = trimmed.match(/^([a-z0-9]+):\/\/(?:([^:@]+):([^@]+)@)?([^:/]+):(\d+)\/?$/i);
  if (m1) {
    return {
      protocol: m1[1].toLowerCase(),
      host: m1[4],
      port: Number(m1[5]),
      username: m1[2] || null,
      password: m1[3] || null,
      raw: trimmed,
    };
  }

  // Format 2: host:port:user:pass
  const m2 = trimmed.match(/^([^:]+):(\d+):([^:]+):(.+)$/);
  if (m2) {
    return {
      protocol: "http",
      host: m2[1],
      port: Number(m2[2]),
      username: m2[3],
      password: m2[4],
      raw: trimmed,
    };
  }

  // Format 3: user:pass@host:port
  const m3 = trimmed.match(/^(?:([^:@]+):([^@]+)@)?([^:@]+):(\d+)\/?$/);
  if (m3) {
    return {
      protocol: "http",
      host: m3[3],
      port: Number(m3[4]),
      username: m3[1] || null,
      password: m3[2] || null,
      raw: trimmed,
    };
  }

  return null;
}

// Load proxies dari file (gitignored). Returns array of parsed proxies.
// Invalid lines log warning tapi gak throw — biar satu baris rusak gak
// gagalkan seluruh load.
function loadProxies(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    const p = parseProxyLine(line);
    if (p) out.push(p);
    else if (line.trim() && !line.trim().startsWith("#")) {
      console.warn(`[proxy] skip line ${i + 1}: ${String(line).slice(0, 60)}`);
    }
  });
  return out;
}

// Return proxy untuk account index (cycle). Return null kalau pool kosong.
function getProxyForAccount(proxies, accountIndex) {
  if (!Array.isArray(proxies) || proxies.length === 0) return null;
  return proxies[((accountIndex % proxies.length) + proxies.length) % proxies.length];
}

// Build Chromium launch args untuk proxy. Tanpa auth di args (username/password
// dipasang via page.authenticate setelah launch — Puppeteer tidak support
// authenticated proxy di args dengan semua build).
function chromiumArgsForProxy(proxy) {
  if (!proxy) return [];
  return [`--proxy-server=${proxy.protocol}://${proxy.host}:${proxy.port}`];
}

module.exports = {
  parseProxyLine,
  loadProxies,
  getProxyForAccount,
  chromiumArgsForProxy,
};
