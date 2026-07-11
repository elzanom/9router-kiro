"use strict";

// Cloudflare Email Routing helpers — generate aliases di domain yang user
// kontrol (e.g. minom.my.id). Semua alias auto-forward ke Gmail tujuan
// via catch-all rule yang diset 1x di Cloudflare dashboard.
//
// Kenapa CF Email Routing > third-party forwarder:
// - Domain milik user → AWS tidak akan pernah blocklist (tidak ada signal
//   disposable-email yang bisa di-push ke AWS blocklist).
// - Unlimited aliases, free tier CF cukup (200+ dest, unlimited rules).
// - Tidak perlu signup / API ke provider lain.
//
// Prasyarat (1x setup, di Cloudflare dashboard):
// 1. Domain minom.my.id sudah ada di Cloudflare DNS.
// 2. Buka Email > Email Routing > Enable. Set destination address
//    (Gmail tujuan) dan klik link verifikasi.
// 3. Tambah catch-all rule: "Catch all addresses that route to my destination".
// 4. Setelah setup, semua *@minom.my.id akan di-forward ke Gmail tujuan.
//
// Module ini generate random local-part + append ke aliases.txt. Bot IMAP
// cukup membaca Gmail — tidak ada API call ke CF di hot path.

const fs = require("fs");
const path = require("path");

// Random local-part, default 10 char alphanumeric (62^10 ≈ 8.4e17 options).
function randomLocalPart(len = 10) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

// Generate N random aliases di domain.
function generateAliases(domain, count = 1, len = 10) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`${randomLocalPart(len)}@${domain}`);
  }
  return out;
}

// Append aliases ke file (gitignored). Dedupe otomatis (existing entries
// ignored). Return jumlah alias yang sebenarnya baru ditambah.
function appendAliasesToFile(filePath, aliases) {
  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf8");
  }
  const seen = new Set(
    existing.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  const fresh = [];
  for (const a of aliases) {
    const lower = a.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    fresh.push(a);
  }
  if (fresh.length === 0) return 0;
  fs.appendFileSync(filePath, fresh.join("\n") + "\n");
  return fresh.length;
}

module.exports = {
  randomLocalPart,
  generateAliases,
  appendAliasesToFile,
};
