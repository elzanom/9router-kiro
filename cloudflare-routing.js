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

// Local-part generator — menghasilkan alias yang terlihat seperti nama
// manusia sungguhan (mis. "emma.walker37" bukan "5w0kuqx05p"). Pola: kata
// dari dict (nama depan) + kata keluarga + angka 1-99. Lebih terlihat
// natural untuk AWS fingerprint (which counts alias-like email addresses
// as "looks like real user" signal).
//
// `len` diabaikan (dipertahankan untuk backward-compat dengan CLI signature).
const FIRST_WORDS = [
  "emma", "liam", "olivia", "noah", "ava", "sophia", "mason", "isabella",
  "lucas", "mia", "logan", "harper", "ethan", "amelia", "james", "ella",
  "henry", "scarlett", "benjamin", "grace", "sebastian", "lily", "owen",
  "elena", "jack", "aria", "leo", "nora", "caleb", "ruby", "ryan",
  "sophie", "daniel", "claire", "matthew", "sarah", "andrew", "anna",
  "david", "emma", "chris", "kate", "tom", "liz", "mark", "amy",
  "paul", "jane", "alex", "kim", "luke", "may",
];

const LAST_WORDS = [
  "walker", "turner", "hall", "king", "wright", "lopez", "hill", "green",
  "adams", "baker", "clark", "davis", "evans", "ford", "garcia", "harris",
  "irwin", "jones", "kelly", "lewis", "miller", "nash", "owen", "perry",
  "quinn", "reed", "scott", "taylor", "underwood", "vega", "ward", "young",
  "zimmer", "carter", "fisher", "hughes", "jenkins", "knight", "lawson",
  "morris", "nelson", "palmer", "rice", "spencer", "tucker", "walsh",
];

function randomLocalPart() {
  const first = FIRST_WORDS[Math.floor(Math.random() * FIRST_WORDS.length)];
  const last = LAST_WORDS[Math.floor(Math.random() * LAST_WORDS.length)];
  const num = Math.floor(Math.random() * 90) + 10; // 10-99
  // 2 format yang dipakai keduanya: "emma.walker37" dan "emmaw37" — dipilih
  // random supaya gak semua alias punya struktur sama.
  if (Math.random() < 0.5) return `${first}.${last}${num}`;
  return `${first.slice(0, 4)}${last.slice(0, 2)}${num}`;
}

// Generate N random aliases di domain. Local-part pakai format
// name-like (lihat randomLocalPart).
function generateAliases(domain, count = 1) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`${randomLocalPart()}@${domain}`);
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
