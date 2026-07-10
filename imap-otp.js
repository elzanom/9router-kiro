"use strict";

// Helpers untuk membaca OTP dari Gmail (forwarder alias -> Gmail) via IMAP.
// Menggantikan scraping priyo.email. Dipakai oleh bot.js mode `email`.

// Extract OTP dari raw email content. (Dipindah dari bot.js, dipertahankan
// verbatim: 3 regex berurutan + fallback konteks "code".)
function extractOtpFromRaw(raw) {
  if (!raw || typeof raw !== "string") return null;
  const patterns = [
    /<div[^>]*class=["'][^"']*code[^"']*["'][^>]*>\s*(\d{4,8})\s*<\/div>/i,
    /Verification code:\s*(?:<\/[^>]+>\s*)*<[^>]+>\s*(\d{4,8})/i,
    /(?:verification|verify|code)[\s\S]{0,300}?(\d{4,8})/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) return m[1];
  }
  // Fallback: cari digit 6 (umum AWS) di area dekat kata "code"
  const ctxMatch = raw.match(/(?:code|verification)[^<]{0,500}?(\d{6})/i);
  if (ctxMatch) return ctxMatch[1];
  return null;
}

// Bangun query Gmail X-GM-RAW: cari email To alias + subject spesifik.
// gmraw mencari lintas SEMUA mail Gmail (Inbox + Spam + All) -> forwarder
// yang masuk Spam tetap ke-cover.
function buildGmrawQuery(alias, subject) {
  return `to:${alias} subject:"${subject}"`;
}

// Dari daftar match (sudah di-fetch: punya internalDate + source), pilih
// yang TERBARU dalam window recency (internalDate >= since - slack) dan
// mengandung OTP. Return { message, otp } atau null.
function pickRecencyMatch(messages, { since = 0, slackMs = 60000 } = {}) {
  const floor = since - slackMs;
  const sorted = [...messages].sort(
    (a, b) => Number(a.internalDate) - Number(b.internalDate)
  );
  for (let i = sorted.length - 1; i >= 0; i--) {
    const msg = sorted[i];
    if (Number(msg.internalDate) < floor) continue;
    const otp = extractOtpFromRaw(String(msg.source || ""));
    if (otp) return { message: msg, otp };
  }
  return null;
}

module.exports = { extractOtpFromRaw, buildGmrawQuery, pickRecencyMatch };
