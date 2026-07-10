# Forwarder Aliases + IMAP OTP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ganti mode `email` dari priyo.email (domain diblokir AWS + retry rusak) ke alias forwarder (SimpleLogin + Firefox Relay) yang forward ke Gmail, OTP dibaca via IMAP.

**Architecture:** 1 tab browser (AWS flow saja, tab priyo dihapus). Alias datang dari input (file batch/arg/interactive). OTP dibaca oleh modul baru `imap-otp.js` lewat `imapflow`, pakai Gmail `X-GM-RAW` search lintas semua mail (Inbox+Spam) supaya forwarder yang masuk Spam tetap ketemu, lalu dihapus setelah dibaca.

**Tech Stack:** Node.js (CommonJS), puppeteer-core (AWS flow, tak diubah), imapflow (IMAP Gmail), node:test (unit test bawaan).

**Spec:** `docs/superpowers/specs/2026-07-10-imap-forwarder-otp-design.md`

## Global Constraints

- `"type": "commonjs"` (package.json) — semua modul pakai `require`/`module.exports`.
- **Tidak ada kredensial asli di kode ter-commit.** IMAP creds (alamat Gmail + App Password) HANYA di `config.json` (sudah `.gitignore`). `config.example.json` pakai placeholder.
- **Jangan pernah** set `NODE_TLS_REJECT_UNAUTHORIZED=0`. imapflow pakai TLS native port 993.
- `extractOtpFromRaw` dipertahankan **verbatim** (3 regex berurutan + fallback) — dipindah ke `imap-otp.js`, regex tidak diubah.
- `deleteAfterRead` default `true`; `--no-delete-otp` mematikan.
- `submitTime` dicatat tepat setelah klik **submit NAME** (submit name memicu AWS mengirim code, bukan submit email).
- Gmail `X-GM-RAW` adalah search utama (first-class Spam). Fallback folder (`\Junk`/`[Gmail]/Spam`) hanya kalau server tidak iklan `X-GM-EXT-1`.
- Test runner: `node --test` (script `test` di package.json). File test di `test/`.
- **Unit test tidak boleh `require("../bot.js")`** — bot.js self-invoke `main()` saat di-require. Test hanya `require` modul `imap-otp.js` & `config.js`.
- `imapflow` di-lazy-require di dalam `imap-otp.js` (bukan di top-level) supaya unit test (inject fake client) jalan tanpa `imapflow` terinstall.

---

## File Structure

| File | Aksi | Tanggung jawab |
|------|------|----------------|
| `imap-otp.js` | **Create** | Pure helpers (`extractOtpFromRaw`, `buildGmrawQuery`, `pickRecencyMatch`, `findSpamPath`) + `getOtpViaImap(imapCfg, alias, opts)`. Lazy-require imapflow. |
| `test/test-imap-otp.js` | **Create** | Unit test pure helpers + `getOtpViaImap` (fake client ter-inject). |
| `config.js` | **Modify** | Tambah resolusi `cfg.imap` (flag → env → `file.imap` → default). |
| `test/test-config-imap.js` | **Create** | Unit test resolusi `cfg.imap`. |
| `bot.js` | **Modify** | Hapus region priyo (346-793); refactor `automateKiroEmailLogin` (alias + `getOtpViaImap` + `submitTime`); update `processAccount`, `interactiveRun`, `main`/`add`, label/komentar, `printHelp`. |
| `config.example.json` | **Modify** | Tambah block `imap` (placeholder). |
| `package.json` | **Modify** | Tambah dependency `imapflow`. |
| `README.md` | **Modify** | Rewrite bagian priyo → alias forwarder + IMAP. |

---

## Task 1: `imap-otp.js` — pure helpers + unit test

**Files:**
- Create: `imap-otp.js`
- Create: `test/test-imap-otp.js`

**Interfaces:**
- Produces: `extractOtpFromRaw(raw: string): string|null`, `buildGmrawQuery(alias, subject): string`, `pickRecencyMatch(messages: Array<{uid,internalDate:Date,source:string,envelope}>, {since,slackMs}): {message,otp}|null`. Dipakai Task 2 & 4.

- [ ] **Step 1: Tulis file `imap-otp.js` (pure helpers saja dulu)**

```js
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
```

- [ ] **Step 2: Tulis test `test/test-imap-otp.js`**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractOtpFromRaw, buildGmrawQuery, pickRecencyMatch } = require("../imap-otp.js");

test("extractOtpFromRaw: pola 'Verification code' + tag + 6 digit", () => {
  const raw = `<p>Verification code:</p><strong>573868</strong>`;
  assert.equal(extractOtpFromRaw(raw), "573868");
});

test("extractOtpFromRaw: kata 'verification' dalam 300 char sebelum digit", () => {
  const raw = `Your verification code is 344535. Valid for 10 minutes.`;
  assert.equal(extractOtpFromRaw(raw), "344535");
});

test("extractOtpFromRaw: fallback konteks 'code' menangkap 6 digit", () => {
  const raw = `some text code: 481030 here`;
  assert.equal(extractOtpFromRaw(raw), "481030");
});

test("extractOtpFromRaw: null kalau tidak ada OTP", () => {
  assert.equal(extractOtpFromRaw("Welcome to AWS"), null);
  assert.equal(extractOtpFromRaw(null), null);
});

test("buildGmrawQuery: format to: + subject:", () => {
  assert.equal(
    buildGmrawQuery("abc@aleeas.com", "Verify your AWS Builder ID email address"),
    `to:abc@aleeas.com subject:"Verify your AWS Builder ID email address"`
  );
});

test("pickRecencyMatch: pilih match terbaru dalam window + ber-OTP", () => {
  const since = 1000000;
  const messages = [
    { uid: 1, internalDate: new Date(since - 120000), source: "verification 111111" }, // luar window (slack 60s)
    { uid: 2, internalDate: new Date(since - 10000), source: "verification 222222" }, // dalam window
    { uid: 3, internalDate: new Date(since - 5000), source: "Welcome to AWS" },       // dalam window, no OTP
  ];
  const r = pickRecencyMatch(messages, { since, slackMs: 60000 });
  assert.equal(r.otp, "222222");
  assert.equal(r.message.uid, 2);
});

test("pickRecencyMatch: null kalau tidak ada match dalam window ber-OTP", () => {
  const since = 1000000;
  const messages = [
    { uid: 1, internalDate: new Date(since - 120000), source: "verification 111111" },
  ];
  assert.equal(pickRecencyMatch(messages, { since, slackMs: 60000 }), null);
});
```

- [ ] **Step 3: Run test — harus PASS**

Run: `node --test`
Expected: PASS, 7 tests. (`imap-otp.js` tidak butuh imapflow terinstall karena helper pure.)

- [ ] **Step 4: Commit**

```bash
git add imap-otp.js test/test-imap-otp.js
git commit -m "feat: add imap-otp pure helpers (extractOtpFromRaw, gmraw query, recency match)"
```

---

## Task 2: `imap-otp.js` — `getOtpViaImap` + unit test (fake client)

**Files:**
- Modify: `imap-otp.js` (tambah `findSpamPath`, `getOtpViaImap`, default client factory)
- Modify: `test/test-imap-otp.js` (tambah 4 test)

**Interfaces:**
- Consumes: `buildGmrawQuery`, `pickRecencyMatch`, `extractOtpFromRaw` (dari Task 1).
- Produces: `getOtpViaImap(imapCfg, alias, opts)` → `{ok, otp, from, subject, received}` atau `{ok:false, error, debug:{searchedFolders, matchCount, usedGmraw}}`. `opts.clientFactory` (async => client) untuk test injection. Dipakai Task 4.
- imapflow client API yang dipakai: `connect()` (di factory), `capabilities` (Set), `getMailboxLock(path)→{release()}`, `search(criteria,{uid:true})→number[]`, `fetchOne(uid,{source,envelope,internalDate},{uid:true})→{source:Buffer,envelope,internalDate:Date}`, `messageDelete(uid,{uid:true})`, `list()→[{path,specialUse}]`, `logout()`.

- [ ] **Step 1: Tambah kode ke `imap-otp.js` (sebelum `module.exports` terakhir)**

Ganti baris akhir `module.exports = { extractOtpFromRaw, buildGmrawQuery, pickRecencyMatch };` dengan blok berikut + export baru:

```js
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
          let uids;
          if (useGmraw && folder === "INBOX") {
            // gmraw global: cari lintas semua mail. Lock INBOX cuma supaya
            // ada mailbox terpilih.
            uids = await client.search({ gmraw: buildGmrawQuery(alias, subject) }, { uid: true });
            debug.usedGmraw = true;
          } else {
            uids = await client.search({ to: alias, subject }, { uid: true });
          }
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
  pickRecencyMatch,
  findSpamPath,
  getOtpViaImap,
};
```

- [ ] **Step 2: Tambah 4 test ke akhir `test/test-imap-otp.js`** (ubah baris require jadi ambil `getOtpViaImap` juga)

Ubah baris require atas menjadi:
```js
const { extractOtpFromRaw, buildGmrawQuery, pickRecencyMatch, getOtpViaImap } = require("../imap-otp.js");
```
Lalu tambahkan di akhir file:

```js
test("getOtpViaImap: gmraw path nemu OTP + delete-after-read", async () => {
  const since = Date.now() - 5000;
  let deleted = null;
  const fakeClient = {
    capabilities: new Set(["X-GM-EXT-1"]),
    async getMailboxLock() { return { async release() {} }; },
    async search() { return [100]; },
    async fetchOne() {
      return {
        source: Buffer.from("Your verification code is 573868. Valid 10 min."),
        envelope: { subject: "Verify your AWS Builder ID email address", from: [{ address: "no-reply@signin.aws" }] },
        internalDate: new Date(since + 1000),
      };
    },
    async messageDelete(uid) { deleted = uid; },
    async logout() {},
  };
  const res = await getOtpViaImap(
    { user: "u@gmail.com", password: "p", deleteAfterRead: true },
    "abc@aleeas.com",
    { since, maxWaitMs: 1000, pollMs: 10, clientFactory: async () => fakeClient }
  );
  assert.equal(res.ok, true);
  assert.equal(res.otp, "573868");
  assert.equal(res.from, "no-reply@signin.aws");
  assert.equal(deleted, 100);
});

test("getOtpViaImap: fallback folder (tanpa X-GM-EXT-1), no-delete", async () => {
  const since = Date.now() - 5000;
  let deleted = null;
  let searchCalls = 0;
  const fakeClient = {
    capabilities: new Set([]),
    async list() { return [{ path: "INBOX", specialUse: "\\Inbox" }, { path: "[Gmail]/Spam", specialUse: "\\Junk" }]; },
    async getMailboxLock() { return { async release() {} }; },
    async search() { searchCalls++; return searchCalls >= 2 ? [200] : []; },
    async fetchOne() {
      return {
        source: Buffer.from("verification code 209910"),
        envelope: { subject: "Verify your AWS Builder ID email address", from: [{ address: "x@signin.aws" }] },
        internalDate: new Date(since + 2000),
      };
    },
    async messageDelete(uid) { deleted = uid; },
    async logout() {},
  };
  const res = await getOtpViaImap(
    { user: "u@gmail.com", password: "p", deleteAfterRead: false },
    "xyz@mozmail.com",
    { since, maxWaitMs: 3000, pollMs: 10, clientFactory: async () => fakeClient }
  );
  assert.equal(res.ok, true);
  assert.equal(res.otp, "209910");
  assert.equal(deleted, null); // deleteAfterRead false
});

test("getOtpViaImap: timeout -> {ok:false} + debug", async () => {
  const fakeClient = {
    capabilities: new Set(["X-GM-EXT-1"]),
    async getMailboxLock() { return { async release() {} }; },
    async search() { return []; },
    async fetchOne() { return null; },
    async logout() {},
  };
  const res = await getOtpViaImap(
    { user: "u", password: "p" },
    "a@b.com",
    { since: Date.now(), maxWaitMs: 50, pollMs: 10, clientFactory: async () => fakeClient }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /timeout/i);
  assert.equal(res.debug.usedGmraw, true);
});

test("getOtpViaImap: creds hilang -> gagal cepat", async () => {
  const res = await getOtpViaImap({}, "a@b.com", { clientFactory: async () => { throw new Error("x"); } });
  assert.equal(res.ok, false);
  assert.match(res.error, /tidak lengkap/i);
});
```

- [ ] **Step 3: Run test — harus PASS (11 tests total)**

Run: `node --test`
Expected: PASS, 11 tests. (gmraw path, fallback folder, timeout, creds-missing + 7 dari Task 1.)

- [ ] **Step 4: Commit**

```bash
git add imap-otp.js test/test-imap-otp.js
git commit -m "feat: add getOtpViaImap (gmail gmraw + spam fallback + delete-after-read) with injected-client tests"
```

---

## Task 3: `config.js` — resolve `cfg.imap` + unit test

**Files:**
- Modify: `config.js` (sisipkan blok imap ke objek `cfg`)
- Create: `test/test-config-imap.js`

**Interfaces:**
- Produces: `cfg.imap = { host, port, user, password, tls:true, deleteAfterRead }`. Prioritas flag → env → `file.imap` → default. Dipakai Task 4 (`getOtpViaImap(config.imap, ...)`) & Task 6 (`processAccount` cek `config.imap.user/password`).

- [ ] **Step 1: Tulis test dulu `test/test-config-imap.js` (harus fail: cfg.imap undefined)**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../config.js");

test("imap: flag user/password/host dipakai + default port/delete", async () => {
  const cfg = await loadConfig(
    ["--imap-user", "flag@gmail.com", "--imap-password", "flagpw", "--imap-host", "imap.gmail.com"],
    { interactive: false }
  );
  assert.equal(cfg.imap.user, "flag@gmail.com");
  assert.equal(cfg.imap.password, "flagpw");
  assert.equal(cfg.imap.host, "imap.gmail.com");
  assert.equal(cfg.imap.port, 993);
  assert.equal(cfg.imap.deleteAfterRead, true);
});

test("imap: --no-delete-otp mematikan deleteAfterRead", async () => {
  const cfg = await loadConfig(["--imap-user", "u", "--no-delete-otp"], { interactive: false });
  assert.equal(cfg.imap.deleteAfterRead, false);
});

test("imap: env user menang (tanpa flag user)", async () => {
  process.env.NINEROUTER_IMAP_USER = "env@gmail.com";
  try {
    const cfg = await loadConfig(["--imap-host", "imap.gmail.com"], { interactive: false });
    assert.equal(cfg.imap.user, "env@gmail.com");
  } finally {
    delete process.env.NINEROUTER_IMAP_USER;
  }
});
```

- [ ] **Step 2: Run test — harus FAIL**

Run: `node --test test/test-config-imap.js`
Expected: FAIL — `cfg.imap is undefined`.

- [ ] **Step 3: Implement — sisipkan ke `config.js`**

Di `config.js`, temukan akhir literal objek `cfg` (baris dengan `password: pick("password", "NINEROUTER_PASSWORD"),` lalu `};`). Sisipkan **tepat setelah** baris `password: pick(...)` itu dan sebelum `};` penutup objek cfg:

```js
    password: pick("password", "NINEROUTER_PASSWORD"),
  };

  // IMAP (mode email: baca OTP dari Gmail via forwarder alias).
  const imapFile = file.imap || {};
  const pickImap = (flagKey, envKey, fileKey) => {
    if (flags[flagKey] !== undefined && flags[flagKey] !== true) return String(flags[flagKey]);
    if (process.env[envKey] !== undefined) return process.env[envKey];
    if (imapFile[fileKey] !== undefined) return String(imapFile[fileKey]);
    return undefined;
  };
  const noDelete = flags["no-delete-otp"] === true;
  const fileDelete = imapFile.deleteAfterRead;
  cfg.imap = {
    host: pickImap("imap-host", "NINEROUTER_IMAP_HOST", "host") || "imap.gmail.com",
    port: Number(pickImap("imap-port", "NINEROUTER_IMAP_PORT", "port") || 993),
    user: pickImap("imap-user", "NINEROUTER_IMAP_USER", "user"),
    password: pickImap("imap-password", "NINEROUTER_IMAP_PASSWORD", "password"),
    tls: true,
    deleteAfterRead: noDelete ? false : fileDelete !== undefined ? Boolean(fileDelete) : true,
  };
```

(Catatan: edit ini menambah `};` penutup asli tetap utuh — blok baru disisipkan antara baris `password:` dan `};`. Implementer: ganti baris tunggal `    password: pick("password", "NINEROUTER_PASSWORD"),\n  };` dengan blok di atas.)

- [ ] **Step 4: Run test — harus PASS (3 tests)**

Run: `node --test test/test-config-imap.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run semua test untuk pastikan tak ada regresi**

Run: `node --test`
Expected: PASS, 14 tests total (11 + 3).

- [ ] **Step 6: Commit**

```bash
git add config.js test/test-config-imap.js
git commit -m "feat(config): resolve cfg.imap (flag>env>file.imap>default) + --no-delete-otp"
```

---

## Task 4: `bot.js` — refactor `automateKiroEmailLogin` ke alias + IMAP

**Files:**
- Modify: `bot.js` (header require + fungsi `automateKiroEmailLogin` ~1042-1446, plus baris ~1681, ~1787)

**Interfaces:**
- Consumes: `getOtpViaImap` dari `imap-otp.js`, `config.imap` dari Task 3.
- Produces: `automateKiroEmailLogin` menerima `account.email` = alias (validasi di dalam); catat `submitTime` di name-submit; panggil `getOtpViaImap(config.imap, alias, {since: submitTime})`.

Verifikasi tugas ini: `node -c bot.js` (syntax ok). Tidak ada unit test (Puppeteer E2E — diuji Task 8).

- [ ] **Step 1: Tambah require `imap-otp` di atas `bot.js`**

Temukan baris 28-30:
```js
const { loadConfig, parseCliFlags } = require("./config");
const { resolveAuthHeaders } = require("./auth");
const { request } = require("./http-client");
```
Tambahkan setelahnya:
```js
const { getOtpViaImap } = require("./imap-otp");
```

- [ ] **Step 2: Header fungsi — ganti label + buka validasi alias + deklarasi `submitTime`**

Ganti (saat ini baris 1042-1052):
```js
async function automateKiroEmailLogin(config, deviceData, account) {
  const label = account.priyoUsername || account.email || "priyo";
  console.log(`\n[${label}] Memulai Kiro OAuth flow (email via priyo.email)...`);

  const browser = await launchStealthBrowser(config);
  let approved = false;
  let resolvedEmail = account.email;

  try {
    // Tab 1: AWS / Kiro flow
    const page = await newStealthPage(browser);
```
dengan:
```js
async function automateKiroEmailLogin(config, deviceData, account) {
  const alias = account.email;
  if (!alias || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alias)) {
    throw new Error(
      `Method 'email' butuh field 'email' berisi alias forwarder yang valid (dapat: "${alias || ""}")`
    );
  }
  const label = alias;
  console.log(`\n[${label}] Memulai Kiro OAuth flow (email via alias forwarder + IMAP)...`);

  const browser = await launchStealthBrowser(config);
  let approved = false;
  let resolvedEmail = alias;
  let submitTime = 0;

  try {
    // Hanya 1 tab: AWS / Kiro flow. OTP dibaca via IMAP (imap-otp.js).
    const page = await newStealthPage(browser);
```

- [ ] **Step 3: Hapus blok Tab 2 priyo (saat ini 1142-1158) + ubah submit email pakai alias**

Ganti:
```js
    // Tab 2: priyo.email
    console.log(`[${label}] 3/6 Membuka priyo.email untuk alamat email...`);
    const priyoPage = await openPriyoTab(browser);

    // Selalu pakai create custom mail dengan domain priyomail.org (yang AWS terima).
    // Username di-generate unik jika user tidak specify — supaya tidak konflik
    // dengan akun yang sudah dibuat di run sebelumnya.
    // PENTING: priyo hanya izinkan 3-15 karakter.
    const useUsername = (account.priyoUsername && /^[a-z0-9.]{3,15}$/i.test(account.priyoUsername))
      ? account.priyoUsername
      : `k${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
    console.log(`[${label}]    Membuat custom username: ${useUsername}@priyomail.org`);
    const chosenDomain = await createCustomPriyoUsername(priyoPage, useUsername, "priyomail.org");
    console.log(`[${label}]    Domain: ${chosenDomain}`);
    let priyoInfo = await getPriyoEmail(priyoPage);
    console.log(`[${label}]    Email priyo: ${priyoInfo.email}`);
    resolvedEmail = priyoInfo.email;

    // Submit email ke AWS
    console.log(`[${label}] 4/6 Submit email ke AWS Builder ID...`);
```
dengan:
```js
    // Alias sudah diberikan via account.email (dari file/arg/interactive).
    console.log(`[${label}] 3/6 Alias forwarder: ${alias} (OTP dibaca via IMAP)`);

    // Submit email ke AWS
    console.log(`[${label}] 4/6 Submit email ke AWS Builder ID...`);
```

Kemudian temukan baris `await emailInput.type(priyoInfo.email, { delay: 60 });` dan ganti `priyoInfo.email` → `alias`:
```js
    await emailInput.type(alias, { delay: 60 });
```

- [ ] **Step 4: Catat `submitTime` tepat setelah klik submit NAME**

Temukan:
```js
      const clickResult = await clickByText(page, ["Next", "Continue", "Send code", "Submit", "Create account"]);
      console.log(`[${label}]    Name submit click result: ${clickResult || "(none, falling back to Enter)"}`);
      if (!clickResult) await page.keyboard.press("Enter");
      // Tunggu AWS selesai transisi setelah submit nama (code akan di-trigger)
```
Sisipkan baris `submitTime = Date.now();` antara `if (!clickResult)...` dan komentar, menjadi:
```js
      const clickResult = await clickByText(page, ["Next", "Continue", "Send code", "Submit", "Create account"]);
      console.log(`[${label}]    Name submit click result: ${clickResult || "(none, falling back to Enter)"}`);
      if (!clickResult) await page.keyboard.press("Enter");
      // Submit name inilah yang memicu AWS mengirim kode verifikasi.
      submitTime = Date.now();
      // Tunggu AWS selesai transisi setelah submit nama (code akan di-trigger)
```

- [ ] **Step 5: Ganti blok retry ERR-837 yang rusak dengan throw jelas**

Temukan:
```js
        if (awsErr) {
          console.log(`[${label}]    ⚠️  AWS error: ${awsErr} — kemungkinan domain priyo diblokir, ganti email...`);
          // Refresh priyo untuk dapetin domain baru
          if (priyoPage) {
            await focusPage(priyoPage);
            await clickRandomPriyoEmail(priyoPage).catch(() => null);
            await new Promise((r) => setTimeout(r, 1500));
            priyoInfo = await getPriyoEmail(priyoPage);
            console.log(`[${label}]    Retry dengan email baru: ${priyoInfo.email}`);
            // Reload halaman AWS — back ke email entry
            await focusPage(page);
            await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
```
ganti dengan:
```js
        if (awsErr) {
          // Alias forwarder tetap (tidak ada domain rotation). Kalau ditolak,
          // akun ini gagal -> batch lanjut alias berikutnya.
          throw new Error(`AWS menolak alias "${alias}" (${awsErr}) — ganti alias di list.`);
        }
```

- [ ] **Step 6: Ganti blok tunggu OTP priyo (reload + getPriyoOtp) dengan `getOtpViaImap`**

Temukan:
```js
    // Tunggu kode verifikasi dari AWS via priyo inbox
    console.log(`[${label}] 5/6 Menunggu verifikasi code dari AWS di priyo.email (max 120s)...`);
    // Kembalikan fokus ke priyo untuk inbox polling (BUKAN ke AWS)
    if (priyoPage) await focusPage(priyoPage);
    // Refresh halaman priyo supaya inbox baru (email verifikasi AWS yang baru
    // dikirim setelah submit name) langsung ke-fetch. priyo.email kadang tidak
    // auto-update inbox lewat polling internal, jadi reload full paling reliable
    // (ini yang dilakukan manual saat testing).
    if (priyoPage) {
      try {
        await priyoPage.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
        await new Promise((r) => setTimeout(r, 1500));
        console.log(`[${label}]    Priyo page di-refresh untuk ambil inbox baru`);
      } catch (e) {
        console.log(`[${label}]    Priyo reload gagal (${String(e).slice(0, 80)}), lanjut pakai polling`);
      }
    }
    const otpResult = await getPriyoOtp(
      priyoPage,
      "Verify your AWS Builder ID email address",
      { maxWaitMs: 120000 }
    );
    if (!otpResult.ok) {
      const ssPath = `/tmp/kiro-priyo-msg-${Date.now()}.png`;
      await priyoPage.screenshot({ path: ssPath }).catch(() => {});
      console.log(`[${label}]    getPriyoOtp error: ${otpResult.error}`);
      console.log(`[${label}]    debug: ${JSON.stringify(otpResult.debug).slice(0, 500)}`);
      throw new Error(`Tidak bisa ekstrak verification code. ${otpResult.error}. Screenshot: ${ssPath}`);
    }
    const code = otpResult.otp;
    console.log(
      `[${label}]    Code diterima: ${code} ` +
        `(from="${otpResult.from}" subject="${otpResult.subject}" received="${otpResult.received}")`
    );
```
ganti dengan:
```js
    // Tunggu kode verifikasi dari AWS via IMAP (Gmail, alias forwarder).
    if (!submitTime) submitTime = Date.now();
    console.log(`[${label}] 5/6 Menunggu verification code via IMAP (max 120s)...`);
    const otpResult = await getOtpViaImap(config.imap, alias, {
      since: submitTime,
      maxWaitMs: 120000,
    });
    if (!otpResult.ok) {
      console.log(`[${label}]    IMAP error: ${otpResult.error}`);
      console.log(`[${label}]    debug: ${JSON.stringify(otpResult.debug).slice(0, 500)}`);
      throw new Error(`Tidak bisa baca verification code via IMAP. ${otpResult.error}`);
    }
    const code = otpResult.otp;
    console.log(
      `[${label}]    Code diterima: ${code} ` +
        `(from="${otpResult.from}" subject="${otpResult.subject}" received="${otpResult.received}")`
    );
```

- [ ] **Step 7: Hapus `priyoPage.close()` (tidak ada lagi priyoPage)**

Temukan:
```js
    // Tutup tab priyo agar tidak mengganggu loop approval berikutnya
    try { await priyoPage.close(); } catch {}
```
Hapus kedua baris itu sepenuhnya.

- [ ] **Step 8: Update komentar "resolved email (priyo address)"**

Temukan:
```js
  // Return resolved email (priyo address) agar dipakai untuk rename connection
```
ganti dengan:
```js
  // Return resolved email (alias) agar dipakai untuk rename connection
```

- [ ] **Step 9: Syntax check**

Run: `node -c bot.js`
Expected: no output (syntax OK).

- [ ] **Step 10: Commit**

```bash
git add bot.js
git commit -m "refactor(bot): automateKiroEmailLogin uses alias + getOtpViaImap; drop ERR-837 retry"
```

---

## Task 5: `bot.js` — hapus dead code priyo (helpers + `getPriyoOtp` + `extractOtpFromRaw`)

**Files:**
- Modify: `bot.js` (hapus region 346-793 + update komentar header 1040)

Setelah Task 4, fungsi priyo tak punya pemanggil. `extractOtpFromRaw` sudah pindah ke `imap-otp.js` (Task 1).

- [ ] **Step 1: Hapus blok PRIYO HELPERS + PRIYO OTP + extractOtpFromRaw lama**

Hapus **seluruh** region dari baris komentar `// PRIYO.EMAIL HELPERS` (mulai ~346, `const PRIYO_HOST = "https://priyo.email";`) sampai akhir fungsi `extractOtpFromRaw` (penutup `}` di ~793). Ini mencakup: `PRIYO_HOST`, `openPriyoTab`, `getPriyoEmail`, `clickRandomPriyoEmail`, `createCustomPriyoUsername`, blok komentar "PRIYO OTP via DOM only", `getPriyoOtp`, dan `extractOtpFromRaw`.

Implementer: hapus dari baris `// PRIYO.EMAIL HELPERS` (atau `const PRIYO_HOST` — mana yang lebih dulu) sampai baris tepat sebelum komentar `// KIRO OAUTH AUTOMATION`. Setelah hapus, baris terakhir sebelum `// KIRO OAUTH AUTOMATION` harus fungsi sebelumnya (`randomRealisticName`) yang utuh.

- [ ] **Step 2: Update komentar header section OAuth**

Temukan:
```js
// KIRO OAUTH AUTOMATION (Priyo email + AWS email sign-in)
```
ganti dengan:
```js
// KIRO OAUTH AUTOMATION (Alias forwarder + AWS email sign-in)
```

- [ ] **Step 3: Verifikasi bersih dari priyo**

Run: `grep -in priyo bot.js`
Expected: **no output** (tak ada lagi referensi priyo di bot.js).

Run: `node -c bot.js`
Expected: syntax OK.

Run: `node --test`
Expected: PASS, 14 tests (regresi: tak ada yang require bot.js).

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "chore(bot): remove dead priyo.email helpers + getPriyoOtp (replaced by imap-otp)"
```

---

## Task 6: `bot.js` — `processAccount` + `interactiveRun` + `main`/`add` + help/labels

**Files:**
- Modify: `bot.js` (`processAccount` ~1839-1856; `interactiveRun` ~1995, ~2003-2016; `main` add-case ~2190-2202; `printHelp` ~2134-2160)

- [ ] **Step 1: `processAccount` — label + cek IMAP creds + drop `priyoUsername`**

Temukan:
```js
  const method = (account.method || "google").toLowerCase();
  const label = account.priyoUsername || account.email || `account-${Date.now()}`;
```
ganti dengan:
```js
  const method = (account.method || "google").toLowerCase();
  const label = account.email || `account-${Date.now()}`;
```

Temukan:
```js
  } else if (method === "email" || method === "priyo") {
    const result = await automateKiroEmailLogin(config, deviceData, account);
    resolvedEmail = result.email || account.priyoUsername || account.email || label;
```
ganti dengan:
```js
  } else if (method === "email" || method === "priyo") {
    if (method === "priyo") {
      console.log(`⚠️  method "priyo" deprecated → diperlakukan sebagai "email".`);
    }
    if (!config.imap || !config.imap.user || !config.imap.password) {
      throw new Error(
        "Method 'email' butuh config IMAP (user + password). Isi block 'imap' di config.json atau --imap-user/--imap-password."
      );
    }
    const result = await automateKiroEmailLogin(config, deviceData, account);
    resolvedEmail = result.email || account.email || label;
```

- [ ] **Step 2: `interactiveRun` — menu label + ganti prompt prefix-priyo jadi file alias**

Temukan:
```js
    console.log("  1) Email via priyo.email   → akun AWS Builder ID baru, otomatis");
```
ganti dengan:
```js
    console.log("  1) Email via alias forwarder  → akun AWS Builder ID baru (OTP via IMAP Gmail)");
```

Temukan blok:
```js
    if (method === "email") {
      const prefix = await askPrompt(rl, "Prefix username priyo? (kosong = random tiap akun)", "");
      const customName = await askPrompt(rl, "Nama tampilan AWS? (kosong = random realistis)", "");
      for (let i = 0; i < count; i++) {
        const acc = { method: "email" };
        if (prefix) {
          // prefix + nomor urut, validasi 3-15 char alfanumerik
          let u = `${prefix}${count > 1 ? i + 1 : ""}`.toLowerCase().replace(/[^a-z0-9.]/g, "");
          if (u.length < 3) u = (u + Math.random().toString(36).slice(2, 6)).slice(0, 15);
          acc.priyoUsername = u.slice(0, 15);
        }
        if (customName) acc.name = customName;
        accounts.push(acc);
      }
    } else {
```
ganti dengan:
```js
    if (method === "email") {
      // Minta file berisi list alias forwarder (one-per-line atau JSON array).
      const aliasFile = await askPrompt(rl, "Path file list alias forwarder? (one-per-line atau JSON array)", "");
      let aliases = [];
      if (aliasFile && fs.existsSync(aliasFile)) {
        const raw = fs.readFileSync(aliasFile, "utf8").trim();
        aliases = raw.startsWith("[")
          ? JSON.parse(raw).map((x) => String(x).trim()).filter(Boolean)
          : raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      } else {
        console.log(`⚠️  File tidak ditemukan ("${aliasFile}"). Masukkan alias manual satu per satu.`);
      }
      while (aliases.length < count) {
        const a = await askPrompt(rl, `Alias ke-${aliases.length + 1} (Enter = selesai)`, "");
        if (!a) break;
        aliases.push(a.trim());
      }
      const customName = await askPrompt(rl, "Nama tampilan AWS? (kosong = random realistis)", "");
      const useAliases = aliases.slice(0, count);
      if (useAliases.length === 0) {
        console.log("⚠️  Tidak ada alias. Batal.");
        return;
      }
      for (const alias of useAliases) {
        const acc = { method: "email", email: alias };
        if (customName) acc.name = customName;
        accounts.push(acc);
      }
    } else {
```

- [ ] **Step 3: `main` add-case — dukung `add <alias> --method email`**

Temukan:
```js
    case "add":
    case "browser": {
      const arg2 = positional[1];
      const arg3 = positional[2];
      if (arg2 && arg3) {
        await processAccount(config, { email: arg2, password: arg3 });
      } else if (arg2 && fs.existsSync(arg2)) {
        await batchFromFile(config, arg2);
      } else {
        console.log("Usage: node bot.js add <email> <password> | <accounts.json>");
      }
      break;
    }
```
ganti dengan:
```js
    case "add":
    case "browser": {
      const arg2 = positional[1];
      const arg3 = positional[2];
      const mFlag = (flags.method || "").toLowerCase();
      if (arg2 && (mFlag === "email" || mFlag === "priyo")) {
        // add <alias> --method email [password] [--name "..."]
        const acc = { method: "email", email: arg2 };
        if (arg3) acc.password = arg3;
        if (flags.name && flags.name !== true) acc.name = String(flags.name);
        await processAccount(config, acc);
      } else if (arg2 && arg3) {
        await processAccount(config, { email: arg2, password: arg3 });
      } else if (arg2 && fs.existsSync(arg2)) {
        await batchFromFile(config, arg2);
      } else {
        console.log("Usage: node bot.js add <email> <password> | add <alias> --method email | <accounts.json>");
      }
      break;
    }
```

- [ ] **Step 4: `printHelp` — update deskripsi method, contoh batch, flag imap, contoh**

Temukan:
```js
  - "email"            — daftar via AWS email + priyo.email inbox (verifikasi via 6-digit code)
      priyoUsername (optional) — custom username; default: random
```
ganti dengan:
```js
  - "email"            — daftar via AWS email + alias forwarder (OTP dibaca via IMAP Gmail)
      email (wajib)       — alias forwarder (mis. abc@aleeas.com, xyz@mozmail.com)
      name (optional)     — nama tampilan AWS; default: random realistis
```

Temukan:
```js
Contoh batch-accounts.json:
  [
    { "email": "txn1@fvcksuite.com", "password": "your-google-password", "method": "google" },
    { "method": "email" },
    { "method": "email", "priyoUsername": "mybuildera" }
  ]
```
ganti dengan:
```js
Contoh batch-accounts.json:
  [
    { "email": "txn1@fvcksuite.com", "password": "your-google-password", "method": "google" },
    { "method": "email", "email": "abc@aleeas.com" },
    { "method": "email", "email": "xyz@mozmail.com", "name": "Sandra Costa" }
  ]
```

Temukan baris:
```js
  --chromium / NINEROUTER_CHROMIUM  default /usr/bin/chromium
```
tambahkan tepat setelahnya (masih di blok "Config flags"):
```js
  --imap-user / NINEROUTER_IMAP_USER          alamat Gmail (mode email)
  --imap-password / NINEROUTER_IMAP_PASSWORD  Gmail App Password (mode email)
  --imap-host / NINEROUTER_IMAP_HOST          default imap.gmail.com
  --no-delete-otp                             jangan hapus email OTP setelah dibaca
```

Temukan:
```js
  # Batch JSON (campuran Google + email via priyo):
  node bot.js add accounts.json
```
ganti dengan:
```js
  # 1 akun via alias forwarder (OTP IMAP):
  node bot.js add abc@aleeas.com --method email
  # Batch JSON (campuran Google + email via alias):
  node bot.js add accounts.json
```

- [ ] **Step 5: Syntax check + smoke**

Run: `node -c bot.js`
Expected: syntax OK.

Run: `node bot.js help`
Expected: help tercetak, menyebut "alias forwarder", flag imap, contoh `add <alias> --method email`. Tanpa kata "priyo".

Run: `node --test`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add bot.js
git commit -m "feat(bot): alias-file interactive prompt, add <alias> --method email, IMAP creds gate, help update"
```

---

## Task 7: `config.example.json` + `package.json` + `README.md`

**Files:**
- Modify: `config.example.json`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: `config.example.json` — tambah block `imap`**

Ganti seluruh isi `config.example.json` dengan:
```json
{
  "host": "localhost",
  "proto": "http",
  "port": 20128,
  "mode": "auto",
  "password": "REPLACE_WITH_DASHBOARD_PASSWORD_IF_REMOTE",
  "chromiumPath": "/usr/bin/chromium",
  "imap": {
    "host": "imap.gmail.com",
    "port": 993,
    "user": "REPLACE_WITH_GMAIL_ADDRESS",
    "password": "REPLACE_WITH_GMAIL_APP_PASSWORD",
    "tls": true,
    "deleteAfterRead": true
  }
}
```

- [ ] **Step 2: `package.json` — tambah dependency imapflow**

Temukan blok `dependencies`, tambahkan entri `imapflow`:
```json
  "dependencies": {
    "imapflow": "^1.0.0",
    "puppeteer-core": "^25.3.0",
    "puppeteer-extra": "^3.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2",
    "sqlite3": "^6.0.1"
  },
```

- [ ] **Step 3: Install dependency**

Run: `npm install`
Expected: imapflow terinstall di `node_modules/`; `package.json` & `package-lock.json` terupdate.

- [ ] **Step 4: `README.md` baris 6 — ganti bullet mode email**

Temukan:
```md
- **Email via priyo.email** — bikin akun AWS Builder ID baru dengan alamat priyo.email (random atau custom), verifikasi 6-digit code dibaca otomatis dari tab kedua.
```
ganti dengan:
```md
- **Email via alias forwarder** — bikin akun AWS Builder ID baru dengan alamat alias (SimpleLogin / Firefox Relay) yang forward ke Gmail; verifikasi 6-digit code dibaca otomatis via IMAP.
```

- [ ] **Step 5: `README.md` — contoh batch (sekitar baris 190-197)**

Temukan:
```json
[
  { "email": "txn1@fvcksuite.com", "password": "your-google-password", "method": "google" },
  { "email": "txn2@fvcksuite.com", "password": "your-google-password", "method": "google" },
  { "method": "email" },
  { "method": "email", "priyoUsername": "mybuildera" },
  { "method": "email", "name": "John Doe", "password": "CustomKiroPass!1" }
]
```
ganti dengan:
```json
[
  { "email": "txn1@fvcksuite.com", "password": "your-google-password", "method": "google" },
  { "email": "txn2@fvcksuite.com", "password": "your-google-password", "method": "google" },
  { "method": "email", "email": "abc@aleeas.com" },
  { "method": "email", "email": "xyz@mozmail.com", "name": "Sandra Costa" },
  { "method": "email", "email": "def@aleeas.com", "password": "CustomKiroPass!1" }
]
```

- [ ] **Step 6: `README.md` — tabel field (sekitar 205-209)**

Temukan:
```md
| `email`/`password` | email | — | override password AWS Builder ID (default: di-generate random kuat) |
| `priyoUsername` | email | — | custom username priyo (`username@priyomail.org`); kosong = random |
| `name` | email | — | nama tampilan AWS Builder ID; kosong = nama realistis random |

> Mode `email`: domain default `priyomail.org` (yang diterima AWS). Username random dibuat 3–15 karakter. Nama default di-generate dari daftar nama realistis (mis. "Sandra Costa").
```
ganti dengan:
```md
| `email` | email | ya | alias forwarder (mis. `abc@aleeas.com`, `xyz@mozmail.com`) |
| `password` | email | — | override password AWS Builder ID (default: di-generate random kuat) |
| `name` | email | — | nama tampilan AWS Builder ID; kosong = nama realistis random |

> Mode `email`: butuh alias forwarder yang forward ke Gmail penerima. OTP dibaca via IMAP Gmail (`X-GM-RAW`, mencakup Spam). Isi block `imap` di `config.json`. Nama default dari daftar nama realistis (mis. "Sandra Costa").
```

- [ ] **Step 7: `README.md` — tabel opsi konfigurasi (sekitar 224)**

Temukan baris:
```md
| `chromiumPath` | `--chromium` | `NINEROUTER_CHROMIUM` | `/usr/bin/chromium` | — |
```
tambahkan tepat setelahnya baris-baris:
```md
| `imap.user` | `--imap-user` | `NINEROUTER_IMAP_USER` | — | mode email |
| `imap.password` | `--imap-password` | `NINEROUTER_IMAP_PASSWORD` | — | mode email |
| `imap.host` | `--imap-host` | `NINEROUTER_IMAP_HOST` | `imap.gmail.com` | — |
| `imap.deleteAfterRead` | `--no-delete-otp` | — | `true` | — |
```

- [ ] **Step 8: `README.md` — bagian "Mode email" (251-259)**

Temukan:
```md
### Mode `email` (priyo.email)
1. Meminta *device code* dari 9router.
2. Buka 2 tab: AWS verifikasi (tab 1) + priyo.email (tab 2).
3. Tab 1: pilih "Sign in with email" / form email AWS Builder ID.
4. Tab 2: ambil alamat random atau bikin custom username (`priyoUsername`).
5. Submit email ke AWS → AWS kirim kode verifikasi ke priyo.email.
6. Bot fokus tab priyo, **reload** untuk ambil inbox baru, lalu baca inbox & ekstrak 6-digit code dari DOM.
7. Submit code ke AWS, isi password baru, lanjut konfirmasi device + Kiro consent.
8. Poll 9router sampai koneksi tersimpan.
```
ganti dengan:
```md
### Mode `email` (alias forwarder + IMAP)
1. Meminta *device code* dari 9router.
2. Buka 1 tab: AWS verifikasi. Alias forwarder sudah disediakan via input (file/arg/interactive).
3. Pilih "Sign in with email" / form email AWS Builder ID, isi alias, submit.
4. Isi field nama (nama random realistis kalau kosong) → **submit nama** (memicu AWS mengirim kode).
5. Bot baca kode verifikasi via IMAP Gmail — search `X-GM-RAW` lintas semua mail (`to:<alias> subject:"Verify your AWS Builder ID email address"`), mencakup Spam. Setelah dibaca, email dihapus (`deleteAfterRead`, bisa dimatikan `--no-delete-otp`).
6. Submit code ke AWS, isi password baru, lanjut konfirmasi device + Kiro consent.
7. Poll 9router sampai koneksi tersimpan; koneksi di-rename = alias.

> **Prasyarat IMAP:** akun Gmail penerima wajib 2FA + App Password. Isi block `imap` di `config.json` (lihat `config.example.json`). Disarankan filter Gmail `from:(signin.aws) → Never send it to Spam` biar cepat (walau bot tetap cari Spam).
```

- [ ] **Step 9: `README.md` — troubleshooting (272)**

Temukan:
```md
- **Domain priyo ditolak AWS (ERR-837)** — bot otomatis ganti ke email priyo lain; domain `priyomail.org` sudah diverifikasi diterima AWS.
```
ganti dengan:
```md
- **Alias ditolak AWS (ERR-837)** — alias forwarder tertentu bisa kena blocklist AWS. Ganti alias di list. Kalau satu provider (mis. domain SimpleLogin) mulai ditolak massal, campur dengan provider lain (mis. Firefox Relay).
- **OTP tidak ketemu via IMAP (timeout 120s)** — cek: (a) App Password benar + 2FA aktif; (b) email forwarder benar-benar diteruskan ke Gmail penerima; (c) `to:` header di-rewrite provider (jarang) — lihat `debug.searchedFolders`. Tambah filter Gmail `from:(signin.aws) → Never send it to Spam`.
```

- [ ] **Step 10: Verifikasi dokumen bebas priyo + commit**

Run: `grep -in priyo README.md config.example.json`
Expected: **no output**.

Run: `node --test && node -c bot.js`
Expected: 14 tests PASS; syntax OK.

```bash
git add config.example.json package.json package-lock.json README.md
git commit -m "docs+deps: imapflow dep, imap block in config.example, README forwarder/IMAP rewrite"
```

---

## Task 8: E2E — 1 akun email-mode via alias forwarder

**Files:** (tidak ada; verifikasi runtime)

- [ ] **Step 1: Pastikan unit test hijau**

Run: `node --test`
Expected: 14 tests PASS.

- [ ] **Step 2: Isi `config.json` dengan IMAP creds penerima**

Buka `config.json` (gitignored), pastikan ada block `imap` dengan alamat Gmail penerima + App Password (BUKAN password Google biasa). Contoh (isi nilai asli, jangan commit):
```json
"imap": {
  "host": "imap.gmail.com",
  "port": 993,
  "user": "<gmail-penerima>@gmail.com",
  "password": "<16-char-app-password>",
  "tls": true,
  "deleteAfterRead": true
}
```
> ⚠️ App Password butuh 2FA aktif. Jangan ketik App Password di chat; taruh di `config.json` saja.

- [ ] **Step 3: Siapkan file alias (campur SL + Relay)**

Buat `aliases.txt` (gitignored manual, atau cukup untuk satu run), contoh isi one-per-line:
```
abc@aleeas.com
xyz@mozmail.com
```
Pastikan alias-alias itu sudah dibuat di SimpleLogin/Firefox Relay dan forward ke Gmail penerima di Step 2.

- [ ] **Step 4: Jalankan 1 akun interaktif**

Run: `node bot.js interactive`
Jawab: mode `1` (Email via alias forwarder) → loop `1` → path file alias (`aliases.txt`) → nama (Enter=random) → jeda `5` → konfirmasi `y`.

Atau single: `node bot.js add abc@aleeas.com --method email`

- [ ] **Step 5: Verifikasi sukses**

Expected di console:
- `[<alias>] Memulai Kiro OAuth flow (email via alias forwarder + IMAP)...`
- `[<alias>] 5/6 Menunggu verification code via IMAP (max 120s)...`
- `[<alias>]    Code diterima: NNNNNN (from="no-reply@signin.aws" ... received="...")`
- Pesan sukses `Akun Kiro berhasil terdaftar` (atau setara) + koneksi tersimpan.

Run: `node bot.js inspect`
Expected: alias muncul sebagai akun Kiro terdaftar.

- [ ] **Step 6: Verifikasi email OTP terhapus dari Gmail**

Cek Gmail penerima (Inbox + Spam): email "Verify your AWS Builder ID email address" untuk alias itu sudah hilang (deleteAfterRead=true).

- [ ] **Step 7: Catat hasil + commit jika ada perbaikan kecil**

Catat log run ke `/tmp/kiro-imap-e2e.log` (bukan git). Kalau ada fix kecil selama E2E, commit terpisah:
```bash
git commit -am "fix(bot): <perbaikan dari temuan E2E>"
```

---

## Self-Review (dijalankan penulis plan)

**1. Spec coverage** — setiap seksi spec punya task:
- "1 tab, tab priyo dihapus" → Task 4 Step 3 + Task 5.
- "alias dari input" → Task 6 (interactive file, `add --method email`, batch).
- "getOtpViaImap X-GM-RAW lintas semua mail" → Task 2.
- "Spam first-class" → Task 2 (gmraw global) + fallback `findSpamPath`.
- "deleteAfterRead default true" → Task 2 + Task 3 (`--no-delete-otp`).
- "submitTime di name-submit" → Task 4 Step 4.
- "config imap block + flag/env" → Task 3.
- "batch shape email=alias, priyoUsername deprecated" → Task 6 + README Task 7.
- "hapus PRIYO_HOST/openPriyoTab/getPriyoEmail/clickRandomPriyoEmail/createCustomPriyoUsername/getPriyoOtp/reload/retry-ERR837; KEEP extractOtpFromRaw" → Task 4+5 (extractOtpFromRaw dipindah, bukan dihapus dari proyek).
- "tambah imapflow" → Task 7.
- Risiko (rewrite To, X-GM-EXT fallback, latency) → Task 2 + README troubleshooting Task 7.

**2. Placeholder scan** — tak ada TBD/TODO/"handle edge cases". Semua step berisi kode/command lengkap.

**3. Type/name consistency** — `getOtpViaImap(config.imap, alias, {since})` konsisten di Task 2 (definisi) & Task 4 (pemanggilan). `cfg.imap.user/password` konsisten di Task 3 & Task 6. `buildGmrawQuery`/`pickRecencyMatch`/`findSpamPath`/`formatFrom` didefinisikan & dipakai dalam modul yang sama. `submitTime` dideklarasi (Task 4 Step 2), diisi (Step 4), dipakai (Step 6).

**4. Ambigu** — satu titik diperhatikan: Task 3 Step 3 menyisipkan blok di antara `password:` dan `};` penutup objek cfg — implementer diberi instruksi eksplisit ganti baris tunggal tsb. Diterangkan.
