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

// Fallback gmraw query untuk forwarder yang rewrite header To (mis. Firefox
// Relay): cari berdasarkan subject AWS + sender domain, bukan To. Recency
// window di pickRecencyMatch (since - slack) tetap melindungi dari match
// OTP lama / tabrakan batch.
function buildGmrawFallbackQuery(subject) {
  return `from:signin.aws subject:"${subject}"`;
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

// Factory default: buat koneksi ImapFlow. imapflow di-lazy-require di sini
// supaya unit test (yang inject opts.clientFactory) jalan tanpa imapflow
// terinstall.
async function defaultClientFactory(imapCfg) {
  const { ImapFlow } = require("imapflow");
  const client = new ImapFlow({
    host: imapCfg.host || "imap.gmail.com",
    port: imapCfg.port || 993,
    secure: imapCfg.tls !== false,
    auth: { user: imapCfg.user, pass: imapCfg.password },
    logger: false,
  });
  await client.connect();
  return client;
}

// Cari path folder Spam via special-use \Junk, fallback [Gmail]/Spam.
async function findSpamPath(client) {
  try {
    const boxes = await client.list();
    const junk = boxes.find((b) => b.specialUse === "\\Junk");
    if (junk && junk.path) return junk.path;
    const namedSpam = boxes.find((b) => /spam/i.test(b.path || ""));
    if (namedSpam) return namedSpam.path;
  } catch {}
  return "[Gmail]/Spam";
}

function formatFrom(envelope) {
  const from = envelope && envelope.from;
  if (Array.isArray(from) && from[0] && from[0].address) return from[0].address;
  return "";
}

// Baca OTP dari Gmail untuk alias tertentu.
// Return: { ok:true, otp, from, subject, received }
//      atau { ok:false, error, debug:{searchedFolders, matchCount, usedGmraw} }
async function getOtpViaImap(imapCfg, alias, opts = {}) {
  const since = Number(opts.since) || 0;
  const slackMs = Number(opts.slackMs) || 60000;
  const pollMs = Number(opts.pollMs) || 5000;
  const maxWaitMs = Number(opts.maxWaitMs) || 120000;
  const subject = opts.subject || "Verify your AWS Builder ID email address";
  const deleteAfterRead = imapCfg && imapCfg.deleteAfterRead !== false; // default true
  const clientFactory = opts.clientFactory || defaultClientFactory;

  const debug = { searchedFolders: [], matchCount: 0, usedGmraw: false };

  if (!imapCfg || !imapCfg.user || !imapCfg.password) {
    return { ok: false, error: "IMAP creds tidak lengkap (user/password)", debug };
  }

  let client;
  try {
    client = await clientFactory(imapCfg);
  } catch (e) {
    return { ok: false, error: `IMAP connect/auth gagal: ${e.message}`, debug };
  }

  const useGmraw = !!(
    client.capabilities && client.capabilities.has && client.capabilities.has("X-GM-EXT-1")
  );
  const folders = useGmraw
    ? ["INBOX"]
    : ["INBOX", await findSpamPath(client)];

  const start = Date.now();
  try {
    while (Date.now() - start < maxWaitMs) {
      for (const folder of folders) {
        const lock = await client.getMailboxLock(folder).catch(() => null);
        if (!lock) continue;
        try {
          // Bangun daftar query: primary (to: alias), fallback (subject + sender)
          // untuk forwarder yang rewrite To header (mis. Firefox Relay).
          let queries;
          if (useGmraw && folder === "INBOX") {
            queries = [
              { q: buildGmrawQuery(alias, subject), type: "to" },
              { q: buildGmrawFallbackQuery(subject), type: "fallback" },
            ];
            debug.usedGmraw = true;
          } else {
            queries = [{ q: null, type: "imap" }]; // use imap {to,subject} below
          }

          let uids = [];
          let usedFallback = false;
          for (const { q, type } of queries) {
            const r = type === "imap"
              ? await client.search({ to: alias, subject }, { uid: true })
              : await client.search({ gmraw: q }, { uid: true });
            if (r && r.length > 0) {
              uids = r;
              if (type === "fallback") usedFallback = true;
              break;
            }
          }
          debug.usedFallback = debug.usedFallback || usedFallback;

          if (!uids || uids.length === 0) {
            if (!debug.searchedFolders.includes(folder)) debug.searchedFolders.push(folder);
            continue;
          }
          debug.matchCount = Math.max(debug.matchCount, uids.length);
          // Ambil maks 3 terbaru untuk recency + extraction.
          const recentUids = uids.slice(-3);
          const messages = [];
          for (const uid of recentUids) {
            const msg = await client.fetchOne(
              uid,
              { source: true, envelope: true, internalDate: true },
              { uid: true }
            );
            if (!msg) continue;
            messages.push({
              uid,
              source: msg.source ? msg.source.toString() : "",
              envelope: msg.envelope || {},
              internalDate: msg.internalDate ? new Date(msg.internalDate) : new Date(0),
            });
          }
          const picked = pickRecencyMatch(messages, { since, slackMs });
          if (picked) {
            const { message, otp } = picked;
            const result = {
              ok: true,
              otp,
              from: formatFrom(message.envelope),
              subject: (message.envelope && message.envelope.subject) || subject,
              received: message.internalDate.toISOString(),
              debug,
            };
            if (deleteAfterRead) {
              try { await client.messageDelete(message.uid, { uid: true }); } catch {}
            }
            return result;
          }
        } finally {
          try { lock.release(); } catch {}
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    try { await client.logout(); } catch {}
  }
  return { ok: false, error: `OTP timeout ${Math.round(maxWaitMs / 1000)}s`, debug };
}

module.exports = {
  extractOtpFromRaw,
  buildGmrawQuery,
  buildGmrawFallbackQuery,
  pickRecencyMatch,
  findSpamPath,
  getOtpViaImap,
};
