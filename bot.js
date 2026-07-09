#!/usr/bin/env node
/**
 * 9router Kiro Bot — Automasi registrasi akun Kiro AI ke 9router.
 *
 * FLOW:
 *   1. Minta device code dari 9router (/api/oauth/kiro/device-code).
 *   2. Buka browser ke verification_uri_complete.
 *   3. Login via Google OAuth otomatis.
 *   4. Konfirmasi device code & beri izin aplikasi Kiro.
 *   5. Poll /api/oauth/kiro/poll sampai 9router menyimpan koneksi.
 *
 * Usage:
 *   node bot.js add <email> <password>                    # daftar 1 akun
 *   node bot.js add <accounts.json>                       # batch dari file JSON
 *   node bot.js inspect                                   # lihat akun Kiro terdaftar
 *   node bot.js delete <id>                               # hapus akun
 */

const puppeteer = require("puppeteer-core");
const { addExtra } = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const puppeteerExtra = addExtra(puppeteer);
puppeteerExtra.use(StealthPlugin());
const sqlite3 = require("sqlite3");
const fs = require("fs");

const { loadConfig, parseCliFlags } = require("./config");
const { resolveAuthHeaders } = require("./auth");
const { request } = require("./http-client");

// ============================================================
// 9ROUTER API
// ============================================================
async function apiCall(config, method, reqPath, body = null) {
  const headers = await resolveAuthHeaders(config);
  const res = await request(config, { method, path: reqPath, body, headers });
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = res.body;
  }
  if (res.statusCode >= 400) {
    const msg = parsed && parsed.error ? parsed.error : `HTTP ${res.statusCode}`;
    throw new Error(`${msg} (at ${method} ${reqPath})`);
  }
  return parsed;
}

async function requestDeviceCode(config) {
  return apiCall(config, "GET", "/api/oauth/kiro/device-code");
}

async function pollForToken(config, deviceCode, extraData) {
  return apiCall(config, "POST", "/api/oauth/kiro/poll", {
    deviceCode,
    extraData: {
      _clientId: extraData._clientId,
      _clientSecret: extraData._clientSecret,
      _region: extraData._region,
      _authMethod: extraData._authMethod,
      _startUrl: extraData._startUrl,
    },
  });
}

async function updateConnectionName(config, id, name) {
  return apiCall(config, "PUT", `/api/providers/${encodeURIComponent(id)}`, { name });
}

// ============================================================
// DATABASE HELPERS (local mode only)
// ============================================================
function openDb(config) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(config.dbPath, (err) => (err ? reject(err) : resolve(db)));
  });
}

async function listAccounts(config) {
  const db = await openDb(config);
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, name, email, provider, isActive, data, createdAt, updatedAt
       FROM providerConnections WHERE provider = 'kiro' ORDER BY createdAt DESC`,
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows.map((r) => ({ ...r, parsedData: r.data ? JSON.parse(r.data) : null })));
      }
    );
  });
}

async function deleteAccount(config, id) {
  const db = await openDb(config);
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM providerConnections WHERE id = ?", [id], function (err) {
      db.close();
      if (err) reject(err);
      else resolve({ deleted: this.changes });
    });
  });
}

// ============================================================
// BROWSER AUTOMATION HELPERS
// ============================================================
function safeUrl(page) {
  try {
    return page.url() || "";
  } catch {
    return "";
  }
}

async function clickByText(page, texts) {
  return page.evaluate((targets) => {
    const all = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], input[type="submit"], span'));
    // Sortir: prefer yang visible, prefer yang DI DALAM form, prefer tag BUTTON
    const score = (el) => {
      let s = 0;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) s += 100;
      if (el.tagName === "BUTTON") s += 50;
      if (el.closest && el.closest("form")) s += 30;
      const cls = ((el.className || "").toString() + " " + (el.getAttribute("type") || "")).toLowerCase();
      if (/primary|cta|submit|awsui_button/i.test(cls)) s += 20;
      // cookie-banner detection: ID/class awsccc-*
      if (/(awsccc|cookie)/i.test(cls) || el.closest && el.closest("[id*='awsccc']")) s -= 200;
      return s;
    };
    const visible = all.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    visible.sort((a, b) => score(b) - score(a));
    for (const t of targets) {
      const btn = visible.find((b) => {
        const text = (b.innerText || b.textContent || "").trim();
        return text === t || text.includes(t);
      });
      if (btn) {
        let el = btn;
        while (el && el.tagName !== "BUTTON" && el.getAttribute("role") !== "button" && el.tagName !== "A" && el.tagName !== "BODY") {
          el = el.parentElement;
        }
        if (el && el.tagName !== "BODY") {
          el.click();
          return t + " (ancestor)";
        }
        btn.click();
        return t;
      }
    }
    return null;
  }, texts);
}

async function clickBySelector(page, selector) {
  try {
    const el = await page.$(selector);
    if (el) {
      await el.click();
      return selector;
    }
  } catch {}
  return null;
}

// Dismiss AWS cookie banner if visible (klik "Accept cookies" / "Dismiss" / "Decline").
// Banner ini sering nutup form dan bikin clickByText salah target.
async function dismissCookieBanner(page) {
  try {
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, a[role='button'], div[role='button']"));
      const labels = [
        /accept cookies/i,
        /^accept$/i,
        /^accept all$/i,
        /^dismiss$/i,
        /^ok$/i,
        /^got it$/i,
        /^decline$/i,
        /^decline all$/i,
        /^reject all$/i,
        /^i decline$/i,
      ];
      for (const b of buttons) {
        const rect = b.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const txt = (b.innerText || b.textContent || "").trim();
        if (!txt) continue;
        if (labels.some((p) => p.test(txt))) {
          b.click();
          return txt;
        }
      }
      return null;
    });
    if (clicked) {
      await new Promise((r) => setTimeout(r, 500));
      console.log(`Dismiss cookie banner: ${clicked}`);
    }
    return clicked;
  } catch {
    return null;
  }
}

async function clickPrimaryButton(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button")).filter((b) => {
      if (b.disabled) return false;
      const rect = b.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const primary = buttons.find((b) => {
      const cls = (b.className || "").toLowerCase();
      return cls.includes("primary") || cls.includes("cta") || cls.includes("allow") || cls.includes("confirm");
    });
    const target = primary || buttons[buttons.length - 1];
    if (target) {
      target.click();
      return target.innerText.trim();
    }
    return null;
  });
}

// Click button via real mouse event pada koordinatnya. Lebih reliable dari
// .click() programmatic untuk komponen custom AWS Builder ID (yang sering
// tidak respon ke synthetic click). Mencari button/button[role] yang visible,
// tidak disabled, tidak di cookie banner, dan teksnya cocok salah satu `texts`.
// Return label text yang di-click, atau null.
async function clickPrimaryButtonMouse(page, texts, opts = {}) {
  const preferLargest = opts.preferLargest !== false;
  const coord = await page.evaluate(
    (targets, wantLargest) => {
      const all = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
      const candidates = all.filter((b) => {
        if (b.disabled) return false;
        const t = (b.innerText || b.textContent || b.value || "").trim().toLowerCase();
        const match = targets.some((tg) => t === tg || t.includes(tg));
        if (!match) return false;
        const r = b.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (b.closest && b.closest("[id*='awsccc']")) return false; // skip cookie banner
        return true;
      });
      const list = candidates;
      if (wantLargest) {
        list.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
      } else {
        list.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return ra.y - rb.y; // paling atas dulu
        });
      }
      const pick = list[0];
      if (pick) {
        const r = pick.getBoundingClientRect();
        return {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          label: (pick.innerText || pick.textContent || "").trim().slice(0, 40),
        };
      }
      return null;
    },
    texts,
    preferLargest
  );
  if (!coord) return null;
  await page.mouse.click(coord.x, coord.y);
  return coord.label;
}

// Generate nama orang realistis (first + last) supaya akun tidak kelihatan
// semua "User Kiro". Dipakai untuk field "Your name" di AWS Builder ID.
const REALISTIC_FIRST_NAMES = [
  "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda",
  "William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
  "Thomas", "Sarah", "Chris", "Karen", "Daniel", "Nancy", "Matthew", "Lisa",
  "Anthony", "Betty", "Mark", "Sandra", "Donald", "Ashley", "Steven", "Kimberly",
  "Andrew", "Donna", "Paul", "Emily", "Joshua", "Michelle", "Kenneth", "Carol",
  "Kevin", "Amanda", "Brian", "Melissa", "George", "Deborah", "Edward", "Stephanie",
  "Ronald", "Rebecca", "Carlos", "Laura", "Diego", "Helen", "Ahmed", "Maria",
  "Wei", "Sofia", "Hassan", "Yuki", "Omar", "Mei", "Raj", "Priya",
  "Lucas", "Chloe", "Felix", "Nina", "Ivan", "Ana", "Mateo", "Elena",
];
const REALISTIC_LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
  "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
  "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
  "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
  "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
  "Carter", "Roberts", "Kumar", "Singh", "Khan", "Patel", "Tanaka", "Suzuki",
  "Müller", "Novak", "Rossi", "Dubois", "Andersen", "Larsen", "Costa", "Silva",
];
function randomRealisticName() {
  const first = REALISTIC_FIRST_NAMES[Math.floor(Math.random() * REALISTIC_FIRST_NAMES.length)];
  const last = REALISTIC_LAST_NAMES[Math.floor(Math.random() * REALISTIC_LAST_NAMES.length)];
  return `${first} ${last}`;
}

async function launchStealthBrowser(config) {
  const browser = await puppeteerExtra.launch({
    executablePath: config.chromiumPath,
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,900",
    ],
  });
  return browser;
}

async function newStealthPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  return page;
}

// Bring a specific puppeteer page/tab to the front (focus) so user-agent
// key events and clicks land on it, not the most recently opened tab.
async function focusPage(page) {
  try {
    await page.bringToFront();
  } catch {}
}

// ============================================================
// PRIYO.EMAIL HELPERS
// ============================================================
const PRIYO_HOST = "https://priyo.email";

async function openPriyoTab(browser) {
  const page = await newStealthPage(browser);
  await page.goto(PRIYO_HOST, { waitUntil: "networkidle2", timeout: 30000 });
  // Tunggu sampai textbox email address muncul
  await page.waitForSelector('input[readonly]', { timeout: 15000 }).catch(() => null);
  return page;
}

async function getPriyoEmail(page) {
  // Baca dari: 1) input[name="email"] di halaman inbox, 2) readonly input,
  // 3) hidden token URL di #token_email.
  const val = await page.evaluate(() => {
    const priority = [
      'input[name="email"]',
      'input#token_email',
      'input[readonly]',
    ];
    for (const sel of priority) {
      const inp = document.querySelector(sel);
      if (inp) {
        const v = (inp.value || "").trim();
        if (v && v.includes("@") && !/^https?:/.test(v)) return v;
      }
    }
    // Fallback: scan semua input yang punya @ dan BUKAN URL
    const all = Array.from(document.querySelectorAll("input"));
    for (const inp of all) {
      const v = (inp.value || "").trim();
      if (v && v.includes("@") && !/^https?:/.test(v) && !/priyo\.email\/email\//.test(v)) {
        return v;
      }
    }
    return null;
  });
  if (!val) {
    const ss = `/tmp/kiro-priyo-noemail-${Date.now()}.png`;
    await page.screenshot({ path: ss, fullPage: true }).catch(() => {});
    throw new Error(`Tidak bisa membaca alamat email dari priyo.email. Screenshot: ${ss}`);
  }
  const [username, domain] = val.split("@");
  return { email: val, username, domain };
}

async function clickRandomPriyoEmail(page) {
  // Klik tombol Random untuk mendapatkan email baru
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const random = buttons.find((b) => {
      const t = (b.innerText || "").trim().toLowerCase();
      return t === "random";
    });
    if (random) {
      random.click();
      return true;
    }
    return false;
  });
}

async function createCustomPriyoUsername(page, username, domain = "priyomail.org") {
  // Buka halaman create custom mail, pilih domain (default priyomail.org),
  // isi username + password, submit dengan click tombol (bukan form.submit()
  // yang default GET dan cuma reload halaman).
  await page.goto(`${PRIYO_HOST}/create-account`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  // Pilih domain dari dropdown. Domain "not_allowed" = premium, skip.
  const domainPicked = await page.evaluate((wanted) => {
    const sel = document.querySelector('select[name="domain"]');
    if (!sel) return null;
    const opt = Array.from(sel.options).find((o) => o.value === wanted && o.value !== "not_allowed");
    if (!opt) {
      const free = Array.from(sel.options).find((o) => o.value && o.value !== "not_allowed");
      if (!free) return null;
      sel.value = free.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return free.value;
    }
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.value;
  }, domain);
  if (!domainPicked) throw new Error(`Tidak ada domain gratis tersedia di priyo.email`);
  await new Promise((r) => setTimeout(r, 500));
  // Username
  const usernameInput = await page.$('input[name="username"]');
  if (!usernameInput) throw new Error("Field username tidak ditemukan");
  await usernameInput.focus();
  await page.keyboard.type(username, { delay: 30 });
  // Password (wajib — tanpa ini submit gagal/redirect balik).
  // Pakai password yang jelas kuat: huruf besar + kecil + angka + simbol + panjang.
  const password = "Ki" + Math.random().toString(36).slice(2, 6) + "Ro" + Math.random().toString(36).slice(2, 6) + "!1";
  const pwInput = await page.$('input[name="password"]');
  if (pwInput) {
    await pwInput.focus();
    await page.keyboard.type(password, { delay: 30 });
  }
  // Recovery mail (optional di UI tapi sepertinya divalidasi server-side,
  // kalau kosong form submit gagal tanpa error message jelas).
  const recoveryInput = await page.$('input[name="recoveryMail"]');
  if (recoveryInput) {
    await recoveryInput.focus();
    // Pakai noreply@example.com — domain example.com reserved untuk testing.
    await page.keyboard.type("noreply@example.com", { delay: 20 });
  }
  await new Promise((r) => setTimeout(r, 500));
  // Click tombol "Create Account" (yang sebenarnya adalah <span> di dalam styled
  // button — jadi kita scan semua elemen, bukan hanya button/a).
  const submitted = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"));
    // Cari leaf element (no children) yang innerText persis "Create Account"
    const target = all.find((el) => {
      const t = (el.innerText || el.textContent || "").trim();
      return /^create account$/i.test(t) && el.children.length === 0;
    });
    if (target) {
      target.click();
      return "span-leaf";
    }
    // Fallback: button/a dengan teks
    const btn = Array.from(document.querySelectorAll("button, a, input[type='submit'], div[role='button']")).find((b) => {
      const t = (b.innerText || b.textContent || b.value || "").trim().toLowerCase();
      return t === "create account" || t === "create";
    });
    if (btn) {
      btn.click();
      return "btn";
    }
    // Last resort: form.requestSubmit()
    const form = document.querySelector("form");
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return "form-requestSubmit";
    }
    return null;
  });
  if (!submitted) throw new Error("Tidak bisa klik tombol Create Account");
  // Tunggu URL benar-benar berubah dari /create-account
  try {
    await page.waitForFunction(
      () => !/\/create-account/.test(location.pathname),
      { timeout: 15000, polling: 500 }
    );
  } catch {
    // Mungkin tetap di /create-account (form error) — log
    console.log(`[priyo] URL tidak berubah setelah klik Create, masih di: ${page.url()}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
  const afterUrl = page.url();
  console.log(`[priyo] URL setelah create: ${afterUrl}`);
  // Kalau masih di /create-account, kemungkinan form gagal submit.
  if (/\/create-account/.test(afterUrl)) {
    // Cek error message di halaman
    const errMsg = await page.evaluate(() => {
      const errs = Array.from(document.querySelectorAll(
        ".alert, .error, .text-danger, [role='alert'], .invalid-feedback, .help-block, .alert-danger, .alert-warning, .text-error"
      ));
      return errs.map((e) => (e.innerText || "").trim()).filter(Boolean).join(" | ");
    }).catch(() => "");
    if (errMsg) console.log(`[priyo] Form error: ${errMsg}`);
    // Capture state untuk debug
    const state = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input")).map((i) => ({
        name: i.name,
        type: i.type,
        value: i.value ? i.value.slice(0, 30) : "",
        valid: i.checkValidity ? i.checkValidity() : true,
        msg: i.validationMessage || "",
      }));
      return { inputs };
    }).catch(() => null);
    if (state) console.log(`[priyo] Input state: ${JSON.stringify(state.inputs)}`);
    throw new Error(`Create account gagal — masih di ${afterUrl}. ${errMsg}`);
  }
  return domainPicked;
}

// ============================================================
// PRIYO OTP via DOM only (no Livewire/cookie/session reliance)
// ============================================================
// Selector yang dipakai (semua DOM-only, bukan Livewire internal):
//   - .mailbox.rounded-lg        → container inbox yang sudah ready
//   - #refresh                    → tombol refresh inbox
//   - .mailbox .inbox-list        → item email di list
//   - .mailbox .inbox-list[data-id] → messageId per row
//   - textarea#content-${id}      → raw email body untuk row tsb
//
// Return shape:
//   sukses: { ok: true,  messageId, from, subject, received, otp }
//   gagal : { ok: false, error, debug: { messageCount, matchedSubject, hasTextarea } }
async function getPriyoOtp(page, subjectFilter = "Verify your AWS Builder ID email address", opts = {}) {
  const maxWaitMs = opts.maxWaitMs ?? 120000; // 120 detik sesuai spec
  const refreshEveryMs = 5000;                // klik refresh tiap 5 detik
  const start = Date.now();
  const subjectRe = new RegExp(subjectFilter, "i");

  // 1) Tunggu inbox siap: container spec (.mailbox.rounded-lg) ATAU muncul row ATAU
  //    marker text "Inbox"/"Default Sender". Kita tidak hard-fail kalau container
  //    spec tidak ada karena struktur DOM priyo bisa berbeda dari spec.
  await page
    .waitForFunction(
      () =>
        !!document.querySelector(".mailbox.rounded-lg") ||
        document.querySelectorAll(".mailbox .inbox-list").length > 0 ||
        /default sender|verify your aws/i.test(document.body?.innerText || ""),
      { timeout: 30000, polling: 1000 }
    )
    .catch(() => null);

  let lastDebug = { messageCount: 0, matchedSubject: false, hasTextarea: false };
  let refreshClickedAt = 0;

  while (Date.now() - start < maxWaitMs) {
    // 2) Klik tombol refresh setiap refreshEveryMs.
    //    Selector utama: #refresh. Fallback: elemen dengan class/icon "refresh".
    const now = Date.now();
    if (now - refreshClickedAt >= refreshEveryMs) {
      await page
        .evaluate(() => {
          const sel = ["#refresh", '[id*="refresh" i]', '[aria-label*="refresh" i]', 'button[class*="refresh" i]'];
          for (const s of sel) {
            const el = document.querySelector(s);
            if (el) {
              el.click();
              return s;
            }
          }
          // Fallback: SVG refresh icon (priyo pakai lucide) — klik parent button-nya
          const svg = Array.from(document.querySelectorAll('svg[class*="refresh" i], svg path[d*="M21"]')).pop();
          if (svg) {
            const btn = svg.closest("button, a, [role='button']") || svg;
            btn.click();
            return "svg-icon";
          }
          return null;
        })
        .catch(() => null);
      refreshClickedAt = now;
      await new Promise((r) => setTimeout(r, 1500));
    }

    // 3) Snapshot inbox. Strategi ganda:
    //    A) Selector spec user: .mailbox .inbox-list[data-id] + textarea#content-${id}
    //    B) Fallback teks: scan row apa pun yang mengandung "Default Sender" + subject,
    //       karena struktur DOM priyo berbasis Livewire bisa berubah-ubah.
    const snap = await page.evaluate(
      (subjectRegexSrc) => {
        const subjectRegex = new RegExp(subjectRegexSrc, "i");
        const out = { messageCount: 0, matchedSubject: false, matchedItem: null, items: [], strategy: null };

        // --- Strategi A: selector spec user ---
        const specRows = Array.from(document.querySelectorAll(".mailbox .inbox-list"));
        if (specRows.length > 0) {
          out.strategy = "spec-selectors";
          const items = specRows.map((row) => {
            const messageId = row.getAttribute("data-id") || "";
            const h2 = row.querySelector("h2");
            const p = row.querySelector("p");
            const span = row.querySelector("span");
            const ta = messageId ? document.getElementById(`content-${messageId}`) : null;
            return {
              messageId,
              from: (h2?.innerText || h2?.textContent || "").trim(),
              subject: (p?.innerText || p?.textContent || "").trim(),
              received: (span?.innerText || span?.textContent || "").trim(),
              textareaLen: ta ? (ta.value || ta.innerHTML || "").length : 0,
              rowSelector: `.mailbox .inbox-list[data-id="${messageId}"]`,
            };
          });
          out.items = items;
          out.messageCount = items.length;
          const matched = items.find((it) => subjectRegex.test(it.subject));
          out.matchedSubject = !!matched;
          out.matchedItem = matched || null;
          return out;
        }

        // --- Strategi B: fallback teks (row mengandung "Default Sender" + subject) ---
        const allClickables = Array.from(
          document.querySelectorAll("a, button, [role='button'], div, li, tr")
        );
        const candidates = [];
        for (const el of allClickables) {
          const t = (el.innerText || "").trim();
          if (!t) continue;
          if (el.children.length > 30) continue;
          if (!/default sender/i.test(t) && !subjectRegex.test(t)) continue;
          const rect = el.getBoundingClientRect();
          if (!rect || rect.width < 100 || rect.height < 30) continue;
          if (t.length < 10 || t.length > 500) continue;
          candidates.push({
            text: t.slice(0, 300),
            childCount: el.querySelectorAll("*").length,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            // coba ambil teks sender/subject/time kasar dari row
            from: (t.match(/default sender/i)?.[0] || "Default Sender"),
            subject: subjectRegex.test(t) ? t.match(new RegExp(subjectRegex, "i"))?.[0] : "",
            received: (t.match(/\d+\s+(second|minute|hour|day)s?\s+ago/i)?.[0] || ""),
            rowSelector: null, // pakai koordinat x/y
          });
        }
        if (candidates.length > 0) {
          out.strategy = "text-fallback";
          // Ambil row container terbesar (bukan leaf)
          candidates.sort((a, b) => b.childCount - a.childCount);
          out.messageCount = candidates.length;
          out.matchedSubject = candidates.some((c) => subjectRegex.test(c.text));
          out.matchedItem = candidates[0];
          return out;
        }

        out.messageCount = 0;
        out.matchedSubject = false;
        return out;
      },
      subjectRe.source
    ).catch((e) => ({ messageCount: 0, matchedSubject: false, matchedItem: null, items: [], strategy: "error:" + String(e) }));

    lastDebug = {
      messageCount: snap.messageCount,
      matchedSubject: !!snap.matchedSubject,
      hasTextarea: snap.matchedItem ? !!snap.matchedItem.textareaLen : false,
      strategy: snap.strategy || null,
    };

    // 4) Kalau ada row match → buka & ambil raw content
    if (snap.matchedItem) {
      const item = snap.matchedItem;
      const messageId = item.messageId || "";
      const from = item.from || "";
      const subject = item.subject || "";
      const received = item.received || "";

      // Klik row: pakai selector spec kalau ada, kalau tidak pakai koordinat teks
      if (item.rowSelector) {
        const rowHandle = await page.$(item.rowSelector).catch(() => null);
        if (rowHandle) {
          try {
            await rowHandle.click({ delay: 20 });
          } catch {
            const box = await rowHandle.boundingBox().catch(() => null);
            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          }
        }
      } else if (typeof item.x === "number") {
        await page.mouse.click(item.x, item.y);
      }

      // 5) Coba ambil raw content dari beberapa sumber:
      //    A) textarea#content-${messageId} (spec user)
      //    B) textarea[id^="content-"] mana pun yang berisi digit (Livewire pre-render)
      //    C) body innerText setelah row dibuka (fallback terakhir)
      let rawContent = "";
      if (messageId) {
        try {
          await page.waitForFunction(
            (id) => {
              const ta = document.getElementById(`content-${id}`);
              if (!ta) return false;
              const v = ta.value || ta.innerHTML || "";
              return v && v.length > 20;
            },
            { timeout: 12000 },
            messageId
          );
        } catch {
          /* textarea mungkin tidak ada → fallback di bawah */
        }
        rawContent = await page
          .evaluate((id) => {
            const ta = document.getElementById(`content-${id}`);
            return ta ? ta.value || ta.innerHTML || "" : "";
          }, messageId)
          .catch(() => "");
      }

      // Fallback B: textarea mana pun dengan content 4-8 digit
      if (!rawContent) {
        rawContent = await page.evaluate(() => {
          const tas = Array.from(document.querySelectorAll('textarea[id^="content-"]'));
          const found = tas.find((ta) => /\d{4,8}/.test(ta.value || ""));
          return found ? found.value || found.innerHTML || "" : "";
        }).catch(() => "");
        lastDebug.hasTextarea = !!rawContent;
      }

      // Fallback C: body innerText (beberapa UI render body langsung ke DOM setelah click)
      if (!rawContent) {
        await new Promise((r) => setTimeout(r, 2500));
        rawContent = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      }

      if (!rawContent) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      // 6) Extract OTP
      const otp = extractOtpFromRaw(rawContent);
      if (otp) {
        return { ok: true, messageId, from, subject, received, otp };
      }

      // 7) OTP regex gagal → kembalikan debug + snippet supaya bisa diagnosa
      return {
        ok: false,
        error: "OTP regex tidak cocok pada raw content",
        debug: { ...lastDebug, rawSnippet: rawContent.slice(0, 600) },
      };
    }

    // 8) Belum ada row match → tunggu lalu iterasi lagi
    await new Promise((r) => setTimeout(r, 2000));
  }

  return {
    ok: false,
    error: `Timeout ${Math.round(maxWaitMs / 1000)}s menunggu email dengan subject mengandung "${subjectFilter}"`,
    debug: lastDebug,
  };
}

// Extract OTP dari raw email content.
// Regex berurutan (sesuai spec user):
//   1) <div ... class="...code...">NNNNNN</div>
//   2) "Verification code:" lalu tag HTML, lalu digit
//   3) "verification/verify/code" dalam 300 char sebelum digit
// Fallback: blok 4-8 digit terisolasi yang dekat dengan kata "code"
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

// ============================================================
// KIRO OAUTH AUTOMATION (Google login)
// ============================================================
async function automateKiroGoogleLogin(config, email, password, deviceData) {
  console.log(`\n[${email}] Memulai Kiro OAuth flow...`);

  console.log(`[${email}] 1/5 Membuka browser...`);
  const browser = await puppeteerExtra.launch({
    executablePath: config.chromiumPath,
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,900",
    ],
  });

  let approved = false;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    console.log(`[${email}] 2/5 Buka halaman verifikasi AWS...`);
    await page.goto(deviceData.verification_uri_complete, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 3000));

    console.log(`[${email}] 3/5 Klik 'Continue with Google'...`);
    let clicked = await clickByText(page, ["Continue with Google"]);
    if (!clicked) {
      // Fallback: cari tombol/link Google berdasarkan atribut
      const googleFallback = await page.$("a[href*='google'], button[data-provider='google']");
      if (googleFallback) await googleFallback.click();
    }
    await new Promise((r) => setTimeout(r, 5000));

    console.log(`[${email}] 4/5 Login Google otomatis...`);
    const currentUrl = safeUrl(page);
    if (currentUrl.includes("accounts.google.com")) {
      const emailField = await page.waitForSelector("#identifierId", { timeout: 15000 }).catch(() => null);
      if (emailField) {
        console.log(`[${email}]    Memasukkan email...`);
        await emailField.type(email, { delay: 60 });
        await new Promise((r) => setTimeout(r, 1000));
        await page.keyboard.press("Enter");
        await new Promise((r) => setTimeout(r, 4000));
      }

      const pwField = await page.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => null);
      if (pwField) {
        console.log(`[${email}]    Memasukkan password...`);
        await pwField.type(password, { delay: 40 });
        await new Promise((r) => setTimeout(r, 1000));
        await page.keyboard.press("Enter");
        await new Promise((r) => setTimeout(r, 6000));
      }
    }

    console.log(`[${email}] 5/5 Menunggu approval device & consent (max 120s)...`);
    const maxWait = 120000;
    const checkInterval = 3000;
    let waited = 0;
    let lastLogUrl = "";

    while (waited < maxWait) {
      const url = safeUrl(page);
      const body = await page.evaluate(() => document.body.innerText).catch(() => "");

      if (url !== lastLogUrl) {
        console.log(`[${email}]    URL: ${url.slice(0, 100)}`);
        lastLogUrl = url;
      }

      let sel = null;

      if (body.includes("Authorization requested") || body.includes("Confirm this code")) {
        console.log(`[${email}]    Halaman konfirmasi device code terdeteksi`);
        sel = await clickByText(page, ["Confirm and continue"]);
        if (!sel) sel = await clickBySelector(page, 'button[class*="primary" i]');
        if (!sel) sel = await clickPrimaryButton(page);
      } else if (body.includes("Allow kiro-oauth-client") || body.includes("access your data")) {
        console.log(`[${email}]    Halaman consent Kiro terdeteksi`);
        sel = await clickByText(page, ["Allow access", "Allow"]);
        if (!sel) sel = await clickBySelector(page, 'button[class*="allow" i]');
        if (!sel) sel = await clickPrimaryButton(page);
      } else if (
        url.includes("view.awsapps.com") &&
        (body.includes("AWS Customer Agreement") ||
          body.includes("AWS Builder ID") ||
          body.includes("Accept agreement") ||
          body.includes("Accept terms") ||
          body.includes("Accept Terms") ||
          body.includes("confirm agreement") ||
          body.includes("user agreement"))
      ) {
        console.log(`[${email}]    Halaman AWS agreement/TOS terdeteksi`);
        // Cek scrollable agreement container lalu scroll ke bawah sebelum accept
        await page.evaluate(() => {
          const containers = Array.from(document.querySelectorAll('div, section, article'));
          const box = containers.find((el) => {
            const style = window.getComputedStyle(el);
            return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
          });
          if (box) {
            box.scrollTop = box.scrollHeight;
          } else {
            window.scrollTo(0, document.body.scrollHeight);
          }
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));

        // Cek checkbox agreement
        const checkbox = await page.$(
          'input[type="checkbox"][name*="agree" i], input[type="checkbox"][id*="agree" i], input[type="checkbox"][id*="terms" i], input[type="checkbox"][id*="accept" i]'
        );
        if (checkbox) {
          await checkbox.click().catch(() => {});
          await new Promise((r) => setTimeout(r, 500));
        }

        sel = await clickByText(page, [
          "Accept and continue",
          "Agree and continue",
          "I agree",
          "Accept terms",
          "Accept agreement",
          "Accept",
          "Agree",
          "Confirm",
          "Continue",
        ]);
        if (!sel) sel = await clickBySelector(page, 'button[class*="accept" i], button[class*="agree" i], button[class*="primary" i]');
        if (!sel) sel = await clickPrimaryButton(page);
      } else if (
        url.includes("workspacetermsofservice") ||
        (url.includes("accounts.google.com") &&
          (body.includes("Workspace Terms of Service") ||
            body.includes("Google Workspace Terms") ||
            body.includes("I agree to the Workspace Terms") ||
            body.includes("I accept the Terms")))
      ) {
        console.log(`[${email}]    Halaman Google Workspace Terms of Service terdeteksi`);

        // Tombol Google Workspace ToS biasanya "I understand" / "I accept"
        sel = await clickByText(page, [
          "I understand",
          "I accept",
          "I agree",
          "Accept",
          "Agree",
          "Continue",
          "Aceptar",
          "Acepto",
          "Aceitar",
          "Accetto",
          "J'accepte",
        ]);
        if (!sel) {
          // Fallback: cari tombol dengan class primary/submit
          sel = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
            for (const b of buttons) {
              if (b.disabled) continue;
              const cls = (b.className || "").toString().toLowerCase();
              if (
                cls.includes("submit") ||
                cls.includes("primary") ||
                cls.includes("accept") ||
                cls.includes("agree") ||
                b.type === "submit"
              ) {
                b.click();
                return (b.innerText || b.value || "submit") + " (submit)";
              }
            }
            return null;
          });
        }
        if (!sel) sel = await clickBySelector(page, 'button[type="submit"], input[type="submit"]');
        if (!sel) sel = await clickPrimaryButton(page);
      } else if (url.includes("accounts.google.com") && url.includes("challenge/pwd")) {
        // Halaman password challenge Google: jangan klik apapun, tunggu user mengetik atau auto-submit
        // Hanya klik Next jika ada tombol Next dan field password sudah ada (artinya sudah selesai diketik)
        const pwdActive = await page.$('input[type="password"]:focus');
        if (pwdActive) {
          await page.keyboard.press("Enter");
        }
      } else if (url.includes("accounts.google.com")) {
        // Google consent pages
        sel = await clickByText(page, ["Continue", "Allow"]);
      }

      if (sel) console.log(`[${email}]    Clicked: ${sel}`);

      if (
        body.includes("Request approved") ||
        body.includes("You can close this window") ||
        body.includes("device approved")
      ) {
        console.log(`[${email}] ✅ Device approved!`);
        approved = true;
        break;
      }

      // Deteksi jika Google menolak sign-in
      if (body.includes("Couldn't sign you in") || body.includes("could not be found")) {
        const ssPath = `/tmp/kiro-rejected-${Date.now()}.png`;
        await page.screenshot({ path: ssPath }).catch(() => {});
        throw new Error(`Google rejected sign-in for ${email}. Screenshot: ${ssPath}`);
      }

      await new Promise((r) => setTimeout(r, checkInterval));
      waited += checkInterval;
    }

    if (!approved) {
      throw new Error(`Timeout: Device tidak di-approve dalam ${maxWait / 1000}s`);
    }
  } catch (err) {
    console.error(`[${email}] ❌ Gagal: ${err.message}`);
    throw err;
  } finally {
    try {
      const pages = await browser.pages();
      await Promise.all(pages.map((p) => p.close()));
      await browser.close();
      console.log(`[${email}]    Browser ditutup`);
    } catch (e) {
      // ignore
    }
  }

  return approved;
}

// ============================================================
// KIRO OAUTH AUTOMATION (Priyo email + AWS email sign-in)
// ============================================================
async function automateKiroEmailLogin(config, deviceData, account) {
  const label = account.priyoUsername || account.email || "priyo";
  console.log(`\n[${label}] Memulai Kiro OAuth flow (email via priyo.email)...`);

  const browser = await launchStealthBrowser(config);
  let approved = false;
  let resolvedEmail = account.email;

  try {
    // Tab 1: AWS / Kiro flow
    const page = await newStealthPage(browser);

    console.log(`[${label}] 1/6 Membuka halaman verifikasi AWS...`);
    // Gunakan domcontentloaded (networkidle2 tidak pernah resolve untuk AWS SPA).
    await page.goto(deviceData.verification_uri_complete, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    // AWS SPA lambat render. Poll body text sampai muncul tombol / input, max 30s.
    await page
      .waitForFunction(
        () => {
          const txt = (document.body.innerText || "").trim();
          if (txt.length < 5) return false;
          if (/continue with google|sign in with email|use my email/i.test(txt)) return true;
          const inputs = Array.from(document.querySelectorAll('input[type="email"], input[name="email"]'));
          if (inputs.length > 0 && inputs[0].offsetParent !== null) return true;
          // Fallback: tunggu minimal 200 char body text
          return txt.length > 200;
        },
        { timeout: 30000, polling: 1500 }
      )
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 2000));

    // Pilih sign-in via email
    console.log(`[${label}] 2/6 Pilih sign-in via email...`);
    // Ambil screenshot untuk debug
    const ssStep2 = `/tmp/kiro-step2-${Date.now()}.png`;
    await page.screenshot({ path: ssStep2, fullPage: true }).catch(() => {});
    const pageState = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyLen: (document.body.innerText || "").length,
      bodyPreview: (document.body.innerText || "").slice(0, 500),
      emailInputs: document.querySelectorAll('input[type="email"], input[name="email"], input[autocomplete*="email" i]').length,
      buttons: Array.from(document.querySelectorAll("button, a, div[role='button'], span[role='button']"))
        .slice(0, 20)
        .map((b) => (b.innerText || b.textContent || "").trim())
        .filter((t) => t && t.length < 80),
    }));
    console.log(`[${label}]    step2 screenshot: ${ssStep2}`);
    console.log(`[${label}]    state: ${JSON.stringify(pageState)}`);
    const emailEntry = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll("button, a, div[role='button'], span[role='button']")
      );
      const patterns = [
        /sign in with email/i,
        /use my email/i,
        /continue with email/i,
        /email$/i,
        /email me a code/i,
      ];
      for (const el of candidates) {
        const t = (el.innerText || el.textContent || "").trim();
        if (!t) continue;
        if (patterns.some((p) => p.test(t))) {
          let target = el;
          while (target && target.tagName !== "BUTTON" && target.tagName !== "A" && target.tagName !== "BODY") {
            target = target.parentElement;
          }
          if (target && target.tagName !== "BODY") {
            target.click();
            return t;
          }
          el.click();
          return t;
        }
      }
      return null;
    });
    if (!emailEntry) {
      // Fallback: cari input email langsung
      const hasEmailInput = await page.$('input[type="email"], input[name="email"], input[autocomplete*="email" i]');
      if (!hasEmailInput) {
        const url = safeUrl(page);
        const body = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "");
        const ss = `/tmp/kiro-aws-noemail-${Date.now()}.png`;
        await page.screenshot({ path: ss, fullPage: true }).catch(() => {});
        throw new Error(
          `Tidak menemukan opsi 'Sign in with email' di halaman AWS. URL: ${url} Body: ${body.replace(/\s+/g, " ").slice(0, 200)} Screenshot: ${ss}`
        );
      }
      console.log(`[${label}]    Field email ditemukan langsung di halaman`);
    } else {
      console.log(`[${label}]    Clicked: ${emailEntry}`);
    }
    await new Promise((r) => setTimeout(r, 2000));

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
    await focusPage(page);
    await dismissCookieBanner(page);
    const emailInput = await page.waitForSelector(
      'input[type="email"], input[name="email"], input[autocomplete*="email" i]',
      { timeout: 15000 }
    ).catch(() => null);
    if (!emailInput) {
      const ssPath = `/tmp/kiro-email-input-${Date.now()}.png`;
      await page.screenshot({ path: ssPath }).catch(() => {});
      throw new Error(`Field email tidak ditemukan. Screenshot: ${ssPath}`);
    }
    await emailInput.focus();
    await emailInput.type(priyoInfo.email, { delay: 60 });
    await new Promise((r) => setTimeout(r, 800));
    // Submit via Enter atau tombol Next/Continue
    let submitted = await clickByText(page, ["Next", "Continue", "Send code", "Submit"]);
    if (!submitted) {
      await page.keyboard.press("Enter");
    }
    // Tunggu halaman AWS transisi ke step nama. AWS SPA render lambat, jadi
    // tunggu URL hash berubah ke /signup/enter-email ATAU name input muncul, max 30s.
    await focusPage(page);
    await page
      .waitForFunction(
        () => {
          const hash = location.hash || "";
          if (/enter-email|enter-name/i.test(hash)) return true;
          const inputs = Array.from(document.querySelectorAll("input"));
          for (const inp of inputs) {
            if (inp.offsetParent === null) continue;
            const name = (inp.name || "").toLowerCase();
            const id = (inp.id || "").toLowerCase();
            const ac = (inp.getAttribute("autocomplete") || "").toLowerCase();
            const ph = (inp.placeholder || "").toLowerCase();
            if (name.includes("name") || id.includes("name") || ac.includes("name") || ph.includes("name")) return true;
          }
          return false;
        },
        { timeout: 30000, polling: 1500 }
      )
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 2500));

    // Step 4b: AWS menampilkan field NAMA setelah email (Builder ID registration).
    // FOKUS TETAP DI AWS sampai nama terisi & ter-submit.
    console.log(`[${label}] 4b/6 Cek & isi field nama AWS Builder ID...`);
    await focusPage(page);
    await dismissCookieBanner(page);
    // Dump DOM untuk diagnosa — siapa tahu nama field pakai attribute non-standar.
    async function dumpNamePageState(tag) {
      try {
        const dump = await page.evaluate(() => {
          const collect = (root, out) => {
            const inputs = Array.from(root.querySelectorAll("input,textarea,[contenteditable='true'],[contenteditable='']"));
            for (const inp of inputs) {
              if (inp.offsetParent === null && inp.tagName !== "INPUT") continue;
              const rect = inp.getBoundingClientRect ? inp.getBoundingClientRect() : { width: 0, height: 0 };
              out.push({
                tag: inp.tagName,
                type: inp.getAttribute("type") || "",
                name: inp.getAttribute("name") || "",
                id: inp.id || "",
                placeholder: inp.getAttribute("placeholder") || "",
                autocomplete: inp.getAttribute("autocomplete") || "",
                ariaLabel: inp.getAttribute("aria-label") || "",
                cls: (inp.className || "").toString().slice(0, 80),
                visible: rect.width > 0 && rect.height > 0,
                w: Math.round(rect.width || 0),
                h: Math.round(rect.height || 0),
              });
            }
            // Piercing shadow DOM
            const all = Array.from(root.querySelectorAll("*"));
            for (const el of all) {
              if (el.shadowRoot) collect(el.shadowRoot, out);
            }
          };
          const out = [];
          collect(document, out);
          return {
            url: location.href,
            hash: location.hash,
            bodyLen: (document.body.innerText || "").length,
            bodyPreview: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300),
            inputs: out,
          };
        });
        console.log(`[${label}]    [dump:${tag}] url=${dump.url} hash=${dump.hash} bodyLen=${dump.bodyLen}`);
        console.log(`[${label}]    [dump:${tag}] body: ${dump.bodyPreview}`);
        console.log(`[${label}]    [dump:${tag}] inputs (${dump.inputs.length}):`);
        for (const inp of dump.inputs) {
          console.log(
            `[${label}]      <${inp.tag}${inp.type ? ` type="${inp.type}"` : ""}${inp.name ? ` name="${inp.name}"` : ""}${inp.id ? ` id="${inp.id}"` : ""}${inp.placeholder ? ` ph="${inp.placeholder}"` : ""}${inp.autocomplete ? ` ac="${inp.autocomplete}"` : ""}${inp.ariaLabel ? ` lb="${inp.ariaLabel}"` : ""} cls="${inp.cls}" vis=${inp.visible} ${inp.w}x${inp.h}>`
          );
        }
        return dump;
      } catch (e) {
        console.log(`[${label}]    [dump:${tag}] error: ${e.message}`);
        return null;
      }
    }

    // Poll untuk name input — handle beberapa signature: input[name*="name"],
    // input[autocomplete="name"], input dengan placeholder nama, atau input
    // teks visible di halaman enter-email (heuristic). Cek shadow DOM juga.
    const nameInputInfo = await page
      .waitForFunction(
        () => {
          const collectAll = (root) => {
            const list = Array.from(root.querySelectorAll("input,textarea,[contenteditable='true'],[contenteditable='']"));
            const allEls = Array.from(root.querySelectorAll("*"));
            for (const el of allEls) {
              if (el.shadowRoot) list.push(...collectAll(el.shadowRoot));
            }
            return list;
          };
          const hash = location.hash || "";
          const onNameStep = /enter-name|enter-email|signup|name/i.test(hash) ||
            /enter your name|your name/i.test(document.body.innerText || "");
          const nodes = collectAll(document);
          for (const inp of nodes) {
            const rect = inp.getBoundingClientRect ? inp.getBoundingClientRect() : { width: 0, height: 0 };
            const visible = rect.width > 0 && rect.height > 0;
            if (!visible) continue;
            const attrs = [
              inp.getAttribute("name") || "",
              inp.id || "",
              inp.getAttribute("autocomplete") || "",
              inp.getAttribute("placeholder") || "",
              inp.getAttribute("aria-label") || "",
              (inp.className || "").toString(),
              inp.getAttribute("data-testid") || "",
            ].join(" ").toLowerCase();
            // 1) Attribute match eksplisit
            if (
              attrs.includes("name") ||
              /first|last|given|family|fullname|full-name|full_name|display/i.test(attrs)
            ) {
              return {
                name: inp.getAttribute("name") || "",
                id: inp.id || "",
                placeholder: inp.getAttribute("placeholder") || "",
                tag: inp.tagName,
                type: inp.getAttribute("type") || "",
              };
            }
            // 2) Heuristic: kalau sudah di step nama dan ada input teks visible (selain email & password)
            if (onNameStep && inp.tagName === "INPUT") {
              const t = (inp.getAttribute("type") || "text").toLowerCase();
              if (t === "text" || t === "") {
                return {
                  name: inp.getAttribute("name") || "",
                  id: inp.id || "",
                  placeholder: inp.getAttribute("placeholder") || "",
                  tag: inp.tagName,
                  type: t,
                };
              }
            }
          }
          return null;
        },
        { timeout: 25000, polling: 1000 }
      )
      .catch(() => null);
    if (nameInputInfo) {
      const info = await nameInputInfo.jsonValue();
      const userName = account.name || randomRealisticName();
      // Bangun selector terbaik: id > name > placeholder-based
      const sel =
        (info.id && `#${info.id}`) ||
        (info.name && `input[name="${info.name}"]`) ||
        (info.placeholder && `input[placeholder="${info.placeholder}"]`) ||
        `input[type="${info.type || "text"}"]`;
      console.log(`[${label}]    Field nama ditemukan (${sel} tag=${info.tag} type=${info.type}), isi: ${userName}`);
      await focusPage(page);
      await page.focus(sel).catch(async () => {
        // Fallback: pakai evaluate handle
        const handle = await page.evaluateHandle((selector) => {
          const el = document.querySelector(selector);
          if (el) {
            el.focus();
            return el;
          }
          return null;
        }, sel);
        const isElement = await handle.evaluate((e) => !!e);
        if (!isElement) {
          console.log(`[${label}]    Selector ${sel} tidak bisa di-focus, coba dengan keyboard.type langsung`);
          await page.keyboard.type(userName, { delay: 40 });
        }
      });
      if (await page.$(sel)) {
        // Kosongkan dulu kalau ada nilai, baru ketik
        await page.click(sel, { clickCount: 3 }).catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
        await page.focus(sel).catch(() => {});
        await page.keyboard.type(userName, { delay: 40 });
      }
      await new Promise((r) => setTimeout(r, 800));
      const clickResult = await clickByText(page, ["Next", "Continue", "Send code", "Submit", "Create account"]);
      console.log(`[${label}]    Name submit click result: ${clickResult || "(none, falling back to Enter)"}`);
      if (!clickResult) await page.keyboard.press("Enter");
      // Tunggu AWS selesai transisi setelah submit nama (code akan di-trigger)
      const submittedOk = await page
        .waitForFunction(
          () => {
            const txt = (document.body.innerText || "").trim();
            return txt.length > 50 && !/enter-name|enter-email/i.test(location.hash);
          },
          { timeout: 15000 }
        )
        .catch(() => null);
      if (!submittedOk) {
        // Dump state — kemungkinan nama kosong / tombol tidak aktif
        console.log(`[${label}]    ⚠️  Tidak ada transisi setelah submit nama`);
        await dumpNamePageState("post-submit");
        const ssPostSubmit = `/tmp/kiro-aws-postname-${Date.now()}.png`;
        await page.screenshot({ path: ssPostSubmit, fullPage: true }).catch(() => {});
        console.log(`[${label}]    Screenshot: ${ssPostSubmit}`);
        // Cek apakah AWS reject domain (ERR-837 dll)
        const awsErr = await page.evaluate(() => {
          const t = document.body.innerText || "";
          const m = t.match(/ERR-\d+/);
          return m ? m[0] : null;
        }).catch(() => null);
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
      }
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      const ssNoName = `/tmp/kiro-aws-noname-${Date.now()}.png`;
      await page.screenshot({ path: ssNoName, fullPage: true }).catch(() => {});
      console.log(`[${label}]    Field nama TIDAK ditemukan dalam 25s.`);
      console.log(`[${label}]    Screenshot: ${ssNoName}`);
      await dumpNamePageState("noname");
    }

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

    // Submit code ke AWS.
    // AWS Builder ID verify-otp bisa pakai: (a) 1 input utuh, atau (b) 6 box
    // terpisah (1 digit per box). Kita deteksi layout dulu supaya code masuk
    // ke tempat yang benar.
    await focusPage(page);
    await page
      .waitForSelector(
        'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code" i], input[type="text"], input[maxlength]',
        { timeout: 15000 }
      )
      .catch(() => null);

    // Dump struktur input verify-otp untuk diagnosa + screenshot
    const verifyLayout = await page.evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll(
          'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code" i], input[type="text"], input[maxlength]'
        )
      ).filter((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return {
        count: inputs.length,
        maxlengths: inputs.map((i) => i.getAttribute("maxlength")),
        autocompletes: inputs.map((i) => i.getAttribute("autocomplete")),
        names: inputs.map((i) => i.name || ""),
      };
    }).catch(() => ({ count: 0 }));
    const otpSs = `/tmp/kiro-verify-otp-${Date.now()}.png`;
    await page.screenshot({ path: otpSs }).catch(() => {});
    console.log(`[${label}]    verify-otp layout: ${JSON.stringify(verifyLayout)} screenshot: ${otpSs}`);

    const singleInput = await page
      .$('input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="1"], input[name="code" i]')
      .catch(() => null);

    if (verifyLayout.count >= 6 && verifyLayout.maxlengths.some((m) => m === "1")) {
      // Layout 6-box: ketik per-digit ke setiap box (biasanya focus otomatis pindah,
      // tapi kita pakai keyboard.type yang mengikuti focus handler).
      console.log(`[${label}]    Layout 6-box terdeteksi, ketik per-digit`);
      const firstBox = await page
        .$(
          'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"]'
        )
        .catch(() => null);
      if (firstBox) {
        await firstBox.focus();
        await page.keyboard.type(code, { delay: 80 });
      } else {
        await page.keyboard.type(code, { delay: 80 });
      }
    } else if (singleInput) {
      console.log(`[${label}]    Layout single input terdeteksi`);
      await singleInput.focus();
      await singleInput.type(code, { delay: 60 });
    } else {
      // Fallback: input[type=text] pertama yang visible
      const fallback = await page.$('input[type="text"], input[maxlength]').catch(() => null);
      if (!fallback) throw new Error("Field kode verifikasi tidak ditemukan");
      await fallback.focus();
      await fallback.type(code, { delay: 60 });
    }
    await new Promise((r) => setTimeout(r, 900));
    // Submit kode: AWS Builder ID "Continue" kadang tidak respon ke
    // .click() programmatic. Pakai real mouse click pada koordinat button,
    // lalu fallback Enter key kalau halaman belum pindah.
    const beforeSubmitUrl = safeUrl(page);
    const otpClicked = await clickPrimaryButtonMouse(page, ["Verify", "Continue", "Next", "Submit"]);
    if (!otpClicked) {
      submitted = await clickByText(page, ["Verify", "Continue", "Next", "Submit"]);
    }
    await new Promise((r) => setTimeout(r, 1800));
    // Kalau masih di halaman yang sama, coba Enter pada input
    if (safeUrl(page) === beforeSubmitUrl) {
      const inp = await page
        .$('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="text"]')
        .catch(() => null);
      if (inp) {
        await inp.focus();
        await page.keyboard.press("Enter");
      } else {
        await page.keyboard.press("Enter");
      }
    }
    await new Promise((r) => setTimeout(r, 3500));

    // Cek apakah masih di verify-otp (kode salah / tidak masuk). Kalau ya,
    // ambil error message + screenshot untuk diagnosa.
    const postUrl = safeUrl(page);
    if (/verify-otp|enter-otp|verification code/i.test(postUrl)) {
      const postState = await page.evaluate(() => {
        const errs = Array.from(
          document.querySelectorAll('[role="alert"], .alert, .error, .invalid-feedback, [class*="error" i]')
        ).map((e) => (e.innerText || "").trim()).filter(Boolean);
        const inputs = Array.from(document.querySelectorAll("input"))
          .filter((i) => i.getBoundingClientRect().width > 0)
          .map((i) => ({ name: i.name || "", type: i.type, value: (i.value || "").slice(0, 12), autocomplete: i.getAttribute("autocomplete") || "" }));
        return { errors: errs.slice(0, 5), inputs: inputs.slice(0, 10) };
      }).catch(() => ({ errors: [], inputs: [] }));
      const stuckSs = `/tmp/kiro-verify-stuck-${Date.now()}.png`;
      await page.screenshot({ path: stuckSs }).catch(() => {});
      console.log(`[${label}]    ⚠️ Masih di verify-otp setelah submit. state: ${JSON.stringify(postState).slice(0, 400)} screenshot: ${stuckSs}`);
    }

    // Step 5b: Setup password + konfirmasi password (Builder ID registration).
    // Setelah verify-otp berhasil, AWS navigasi ke /signup?registrationCode=...
    // yang meminta password baru. Halaman ini butuh waktu render, jadi kita
    // WAIT sampai field password muncul (bukan cek sekali lalu menyerah).
    console.log(`[${label}] 5b/6 Cek field password AWS Builder ID...`);
    await focusPage(page);
    const pwdPwd = await page
      .waitForSelector('input[type="password"]', { timeout: 25000, visible: true })
      .catch(() => null);
    const passwordFields = await page.evaluate(() => {
      const pwdInputs = Array.from(document.querySelectorAll('input[type="password"]'));
      return pwdInputs.map((inp, idx) => {
        const rect = inp.getBoundingClientRect();
        return {
          idx,
          visible: rect.width > 0 && rect.height > 0,
          name: inp.name || "",
          id: inp.id || "",
          autocomplete: inp.getAttribute("autocomplete") || "",
          placeholder: inp.placeholder || "",
          ariaLabel: inp.getAttribute("aria-label") || "",
        };
      });
    });
    if (pwdPwd && passwordFields.length > 0) {
      const pwd = account.password || `Kiro${Math.random().toString(36).slice(2, 10)}!A1`;
      console.log(`[${label}]    Ditemukan ${passwordFields.length} field password, isi password...`);

      // Isi SEMUA field password visible (password + confirm) pakai element
      // handle langsung. page.focus(selector) sering gagal untuk AWS custom
      // form fields, tapi handle.click() + handle.type() reliable.
      // Loop beberapa kali karena confirm field bisa muncul belakangan.
      for (let attempt = 0; attempt < 3; attempt++) {
        await focusPage(page);
        const handles = await page.$$('input[type="password"]');
        let allFilled = true;
        for (const h of handles) {
          // Cek apakah field ini visible
          const vis = await h.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).catch(() => false);
          if (!vis) continue;
          const curLen = await h.evaluate((el) => (el.value || "").length).catch(() => 0);
          if (curLen > 0) continue; // sudah terisi
          allFilled = false;
          // Select-all + replace supaya bersih, lalu ketik
          await h.click({ clickCount: 3 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 150));
          await h.type(pwd, { delay: 40 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 350));
        }
        if (allFilled) break;
        await new Promise((r) => setTimeout(r, 700));
      }

      // Verifikasi semua field terisi
      const verifyFill = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input[type="password"]')).map((inp) => {
          const r = inp.getBoundingClientRect();
          return { id: inp.id || "", vis: r.width > 0 && r.height > 0, len: (inp.value || "").length };
        });
      }).catch(() => []);
      console.log(`[${label}]    Password fields setelah isi: ${JSON.stringify(verifyFill)}`);

      // Screenshot + dump button state untuk diagnosa
      const pwdSs = `/tmp/kiro-pwd-page-${Date.now()}.png`;
      await page.screenshot({ path: pwdSs }).catch(() => {});
      const btnState = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
        return btns
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .slice(0, 12)
          .map((b) => ({
            text: (b.innerText || b.textContent || b.value || "").trim().slice(0, 30),
            disabled: b.disabled,
            cls: (b.className || "").toString().slice(0, 50),
          }));
      }).catch(() => []);
      console.log(`[${label}]    Buttons: ${JSON.stringify(btnState)} screenshot: ${pwdSs}`);

      await new Promise((r) => setTimeout(r, 600));
      // Submit pakai real mouse click (reliable untuk komponen AWS).
      const pwdClicked = await clickPrimaryButtonMouse(page, [
        "Create account",
        "Create Account",
        "Complete",
        "Complete signup",
        "Sign in",
        "Continue",
        "Next",
        "Submit",
      ]);
      if (pwdClicked) {
        console.log(`[${label}]    Password submit (mouse click): ${pwdClicked}`);
      } else {
        console.log(`[${label}]    Password submit via fallback (button mungkin disabled)`);
        await clickByText(page, ["Create account", "Continue", "Next", "Submit"]);
        await page.keyboard.press("Enter");
      }
      await new Promise((r) => setTimeout(r, 4500));

      // Cek apakah masih di signup (password gagal). Dump error.
      const postPwdUrl = safeUrl(page);
      if (/\/signup|registrationCode/i.test(postPwdUrl)) {
        const pwdErr = await page.evaluate(() => {
          const errs = Array.from(
            document.querySelectorAll('[role="alert"], .alert, .error, .invalid-feedback, [class*="error" i], [data-error]')
          ).map((e) => (e.innerText || "").trim()).filter(Boolean);
          const btns = Array.from(document.querySelectorAll('button')).filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).map((b) => ({ t: (b.innerText || "").trim().slice(0, 20), disabled: b.disabled }));
          return { errors: errs.slice(0, 5), buttons: btns.slice(0, 8) };
        }).catch(() => ({ errors: [], buttons: [] }));
        const stuckSs = `/tmp/kiro-pwd-stuck-${Date.now()}.png`;
        await page.screenshot({ path: stuckSs }).catch(() => {});
        console.log(`[${label}]    ⚠️ Masih di signup setelah password submit. state: ${JSON.stringify(pwdErr).slice(0, 500)} screenshot: ${stuckSs}`);
      } else {
        console.log(`[${label}]    Password setup selesai, navigasi ke: ${postPwdUrl.slice(0, 80)}`);
      }
    } else {
      console.log(`[${label}]    Field password tidak ditemukan dalam 25s (mungkin sudah ada akun / langsung ke consent)`);
    }

    // Tutup tab priyo agar tidak mengganggu loop approval berikutnya
    try { await priyoPage.close(); } catch {}

    // Sisanya: device confirmation + Kiro consent (sama seperti Google flow)
    console.log(`[${label}] 6/6 Menunggu approval device & consent (max 120s)...`);
    const maxWait = 120000;
    const checkInterval = 3000;
    let waited = 0;
    let lastLogUrl = "";

    while (waited < maxWait) {
      await focusPage(page);
      const url = safeUrl(page);
      const body = await page.evaluate(() => document.body.innerText).catch(() => "");

      if (url !== lastLogUrl) {
        console.log(`[${label}]    URL: ${url.slice(0, 100)}`);
        lastLogUrl = url;
      }

      let sel = null;

      if (body.includes("Authorization requested") || body.includes("Confirm this code")) {
        console.log(`[${label}]    Halaman konfirmasi device code terdeteksi`);
        sel = await clickByText(page, ["Confirm and continue"]);
        if (!sel) sel = await clickBySelector(page, 'button[class*="primary" i]');
        if (!sel) sel = await clickPrimaryButton(page);
      } else if (body.includes("Allow kiro-oauth-client") || body.includes("access your data")) {
        console.log(`[${label}]    Halaman consent Kiro terdeteksi`);
        sel = await clickByText(page, ["Allow access", "Allow"]);
        if (!sel) sel = await clickBySelector(page, 'button[class*="allow" i]');
        if (!sel) sel = await clickPrimaryButton(page);
      } else if (
        url.includes("view.awsapps.com") &&
        (body.includes("AWS Customer Agreement") ||
          body.includes("AWS Builder ID") ||
          body.includes("Accept agreement") ||
          body.includes("Accept terms") ||
          body.includes("Accept Terms") ||
          body.includes("confirm agreement") ||
          body.includes("user agreement"))
      ) {
        console.log(`[${label}]    Halaman AWS agreement/TOS terdeteksi`);
        await page.evaluate(() => {
          const containers = Array.from(document.querySelectorAll("div, section, article"));
          const box = containers.find((el) => {
            const style = window.getComputedStyle(el);
            return (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight;
          });
          if (box) box.scrollTop = box.scrollHeight;
          else window.scrollTo(0, document.body.scrollHeight);
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        const checkbox = await page.$(
          'input[type="checkbox"][name*="agree" i], input[type="checkbox"][id*="agree" i], input[type="checkbox"][id*="terms" i], input[type="checkbox"][id*="accept" i]'
        );
        if (checkbox) await checkbox.click().catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        sel = await clickByText(page, [
          "Accept and continue",
          "Agree and continue",
          "I agree",
          "Accept terms",
          "Accept agreement",
          "Accept",
          "Agree",
          "Confirm",
          "Continue",
        ]);
        if (!sel) sel = await clickBySelector(page, 'button[class*="accept" i], button[class*="agree" i], button[class*="primary" i]');
        if (!sel) sel = await clickPrimaryButton(page);
      }

      if (sel) console.log(`[${label}]    Clicked: ${sel}`);

      if (
        body.includes("Request approved") ||
        body.includes("You can close this window") ||
        body.includes("device approved")
      ) {
        console.log(`[${label}] ✅ Device approved!`);
        approved = true;
        break;
      }

      await new Promise((r) => setTimeout(r, checkInterval));
      waited += checkInterval;
    }

    if (!approved) {
      throw new Error("Timeout: Device tidak di-approve dalam 120s");
    }
  } catch (err) {
    console.error(`[${label}] ❌ Gagal: ${err.message}`);
    throw err;
  } finally {
    try {
      const pages = await browser.pages();
      await Promise.all(pages.map((p) => p.close()));
      await browser.close();
      console.log(`[${label}]    Browser ditutup`);
    } catch (e) {
      // ignore
    }
  }

  // Return resolved email (priyo address) agar dipakai untuk rename connection
  return { approved, email: resolvedEmail };
}

async function pollUntilConnected(config, deviceData, email) {
  console.log(`[${email}] Poll 9router untuk menyimpan token...`);
  const extraData = {
    _clientId: deviceData._clientId,
    _clientSecret: deviceData._clientSecret,
    _region: deviceData._region,
    _authMethod: deviceData._authMethod,
    _startUrl: deviceData._startUrl,
  };

  const expiresAt = Date.now() + (deviceData.expires_in || 600) * 1000;
  const intervalMs = (deviceData.interval || 1) * 1000;

  while (Date.now() < expiresAt) {
    try {
      const result = await pollForToken(config, deviceData.device_code, extraData);
      if (result.success) {
        const connectionId = result.connection?.id;
        console.log(`[${email}] ✅ Akun Kiro berhasil terdaftar! ID: ${connectionId}`);
        if (connectionId) {
          try {
            await updateConnectionName(config, connectionId, email);
            console.log(`[${email}]    Nama koneksi diubah menjadi: ${email}`);
          } catch (renameErr) {
            console.warn(`[${email}]    Gagal mengubah nama koneksi: ${renameErr.message}`);
          }
        }
        return result;
      }
      if (result.pending) {
        console.log(`[${email}]    Menunggu approval... (${result.error || "pending"})`);
      } else {
        throw new Error(`Poll failed: ${result.error} - ${result.errorDescription || ""}`);
      }
    } catch (e) {
      console.error(`[${email}]    Poll error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error("Device code expired before approval");
}

// ============================================================
// BATCH
// ============================================================
async function processAccount(config, account) {
  const method = (account.method || "google").toLowerCase();
  const label = account.priyoUsername || account.email || `account-${Date.now()}`;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Proses: ${label} (method=${method})`);
  console.log(`${"=".repeat(60)}`);

  const deviceData = await requestDeviceCode(config);
  console.log(`[${label}] Device code: ${deviceData.user_code}`);

  let resolvedEmail = account.email;
  if (method === "google") {
    if (!account.email || !account.password) {
      throw new Error("Method 'google' butuh field email + password");
    }
    await automateKiroGoogleLogin(config, account.email, account.password, deviceData);
    resolvedEmail = account.email;
  } else if (method === "email" || method === "priyo") {
    const result = await automateKiroEmailLogin(config, deviceData, account);
    resolvedEmail = result.email || account.priyoUsername || account.email || label;
  } else {
    throw new Error(`Method tidak dikenal: ${method} (pakai 'google' atau 'email')`);
  }
  return await pollUntilConnected(config, deviceData, resolvedEmail);
}

async function batchFromFile(config, filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const accounts = JSON.parse(content);

  if (!Array.isArray(accounts) || accounts.length === 0) {
    console.log("File harus berisi array account [{email, password}, ...]");
    return;
  }

  console.log(`\nMemproses ${accounts.length} akun...\n`);
  let success = 0;
  let failed = 0;

  for (let i = 0; i < accounts.length; i++) {
    try {
      await processAccount(config, accounts[i]);
      success++;
    } catch (err) {
      console.error(`Gagal: ${err.message}`);
      failed++;
    }

    if (i < accounts.length - 1) {
      const delay = 3000 + Math.random() * 5000;
      console.log(`\nMenunggu ${Math.round(delay / 1000)} detik sebelum akun berikutnya...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SELESAI: ${success} sukses, ${failed} gagal dari ${accounts.length} akun`);
}

// ============================================================
// REMOTE HELPERS
// ============================================================
function safeParse(s) {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return null;
  }
}

async function listAccountsRemote(config) {
  const data = await apiCall(config, "GET", "/api/providers");
  const arr = Array.isArray(data) ? data : data.connections || data.data || data.items || [];
  return arr.filter((c) => (c.provider || "").toLowerCase() === "kiro");
}

// ============================================================
// INSPECT
// ============================================================
async function inspect(config) {
  console.log(`\n=== AKUN KIRO TERDAFTAR [${config.mode}@${config.host}] ===\n`);
  const accounts = config.mode === "remote" ? await listAccountsRemote(config) : await listAccounts(config);

  if (accounts.length === 0) {
    console.log("Belum ada akun Kiro terdaftar.");
    return;
  }

  console.log(`Total: ${accounts.length} akun\n`);

  accounts.forEach((a, i) => {
    const dp = a.parsedData || safeParse(a.data) || a;
    const status = a.isActive ? "✅" : "❌";
    const email = a.email || a.name || dp.email || "(no email)";
    const created = a.createdAt ? new Date(a.createdAt).toLocaleString("id-ID") : "N/A";
    const lastUsed = dp.lastUsedAt ? new Date(dp.lastUsedAt).toLocaleString("id-ID") : "N/A";
    const authMethod = dp.authMethod || dp._authMethod || "builder-id";
    const region = dp.region || dp._region || "us-east-1";

    console.log(`  ${i + 1}. ${status} ${email}`);
    console.log(`     ID: ${String(a.id).substring(0, 8)}...`);
    console.log(`     Dibuat: ${created}`);
    console.log(`     Terakhir pakai: ${lastUsed}`);
    console.log(`     Auth method: ${authMethod} | Region: ${region}`);
    console.log(`     Status: ${a.isActive ? "Aktif" : "Nonaktif"}`);
    console.log("");
  });
}

// ============================================================
// CLI
// ============================================================
async function deleteAccountCmd(config, id) {
  if (config.mode === "remote") {
    try {
      await apiCall(config, "DELETE", `/api/providers/${encodeURIComponent(id)}`);
      console.log(`✅ Deleted (remote): ${id}`);
    } catch (e) {
      console.log(`❌ Remote delete failed: ${e.message}`);
    }
    return;
  }
  const result = await deleteAccount(config, id);
  console.log(`✅ Deleted: ${result.deleted} account(s)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseCliFlags(argv);
  const command = positional[0];

  if (!command) {
    console.log(`
9router Kiro Bot — Automasi registrasi akun Kiro AI

Usage:
  node bot.js add <email> <password> [flags]      # daftar 1 akun via Google OAuth
  node bot.js add <accounts.json> [flags]         # batch dari file JSON
  node bot.js inspect [flags]                     # lihat akun Kiro terdaftar
  node bot.js delete <id> [flags]                 # hapus akun

Method per akun di batch JSON (field 'method'):
  - "google" (default) — butuh email + password Google
  - "email"            — daftar via AWS email + priyo.email inbox (verifikasi via 6-digit code)
      priyoUsername (optional) — custom username; default: random

Contoh batch-accounts.json:
  [
    { "email": "txn1@fvcksuite.com", "password": "your-google-password", "method": "google" },
    { "method": "email" },
    { "method": "email", "priyoUsername": "mybuildera" }
  ]

Config flags (CLI > env > config.json > default):
  --host / NINEROUTER_HOST          default localhost
  --proto http|https                default http
  --port / NINEROUTER_PORT          default 20128 (https: 443)
  --mode auto|local|remote          default auto
  --password / NINEROUTER_PASSWORD  dashboard password (required in remote)
  --chromium / NINEROUTER_CHROMIUM  default /usr/bin/chromium

Examples:
  # Remote HTTPS VPS:
  node bot.js add txn1@fvcksuite.com 'your-google-password' --host <your-9router-host> --proto https --password '<dashboard-password>'
  # Local:
  node bot.js add txn1@fvcksuite.com 'your-google-password'
  # Batch JSON (campuran Google + email via priyo):
  node bot.js add accounts.json
`);
    return;
  }

  const config = await loadConfig(argv);

  switch (command) {
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
    case "inspect":
    case "list":
    case "list-accounts":
      await inspect(config);
      break;
    case "delete": {
      const id = positional[1];
      if (!id) {
        console.log("Usage: node bot.js delete <id>");
        return;
      }
      await deleteAccountCmd(config, id);
      break;
    }
    default:
      console.log(`Unknown command: ${command}`);
  }
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
