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
    for (const t of targets) {
      const btn = all.find((b) => {
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

async function typeWithDelay(page, selector, text, delay = 50) {
  const field = await page.$(selector);
  if (!field) return false;
  await field.focus();
  await new Promise((r) => setTimeout(r, 300));
  await field.type(text, { delay });
  return true;
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
  const { email, password } = account;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Proses: ${email}`);
  console.log(`${"=".repeat(60)}`);

  const deviceData = await requestDeviceCode(config);
  console.log(`[${email}] Device code: ${deviceData.user_code}`);

  await automateKiroGoogleLogin(config, email, password, deviceData);
  return await pollUntilConnected(config, deviceData, email);
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

Config flags (CLI > env > config.json > default):
  --host / NINEROUTER_HOST          default localhost
  --proto http|https                default http
  --port / NINEROUTER_PORT          default 20128 (https: 443)
  --mode auto|local|remote          default auto
  --password / NINEROUTER_PASSWORD  dashboard password (required in remote)
  --chromium / NINEROUTER_CHROMIUM  default /usr/bin/chromium

Examples:
  # Remote HTTPS VPS:
  node bot.js add txn1@fvcksuite.com 'Lucky123!' --host <your-9router-host> --proto https --password '<dashboard-password>'
  # Local:
  node bot.js add txn1@fvcksuite.com 'Lucky123!'
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
