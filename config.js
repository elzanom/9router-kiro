const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const DEFAULTS = {
  host: "localhost",
  proto: "http",
  port: 20128,
  mode: "auto",
  chromiumPath: "/usr/bin/chromium",
};

function parseCliFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function readConfigFile() {
  const CONFIG_FILE_CANDIDATES = [
    path.join(process.cwd(), "config.json"),
    path.join(os.homedir(), ".9router-kiro", "config.json"),
  ];
  for (const p of CONFIG_FILE_CANDIDATES) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (e) {
        throw new Error(`Config file ${p} is invalid JSON: ${e.message}`);
      }
    }
  }
  return {};
}

function isLocalHost(host) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(host).toLowerCase());
}

function resolveMode(mode, cfg) {
  if (mode === "local" || mode === "remote") return mode;
  return fs.existsSync(cfg.machineIdPath) && isLocalHost(cfg.host) ? "local" : "remote";
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function loadConfig(argv = process.argv.slice(2), { interactive = process.stdout.isTTY } = {}) {
  const { flags } = parseCliFlags(argv);
  const file = readConfigFile();

  const pick = (flagKey, envKey) => {
    if (flags[flagKey] !== undefined && flags[flagKey] !== true) return String(flags[flagKey]);
    if (process.env[envKey] !== undefined) return process.env[envKey];
    if (file[flagKey] !== undefined) return String(file[flagKey]);
    return undefined;
  };

  const home = os.homedir();
  const proto = pick("proto", "NINEROUTER_PROTO") || DEFAULTS.proto;
  const userPort = pick("port", "NINEROUTER_PORT");
  const port = userPort ? Number(userPort) : proto === "https" ? 443 : DEFAULTS.port;

  const cfg = {
    host: pick("host", "NINEROUTER_HOST") || DEFAULTS.host,
    proto,
    port,
    mode: pick("mode", "NINEROUTER_MODE") || DEFAULTS.mode,
    chromiumPath: pick("chromium", "NINEROUTER_CHROMIUM") || DEFAULTS.chromiumPath,
    dbPath: pick("db-path", "NINEROUTER_DB_PATH") || path.join(home, ".9router", "db", "data.sqlite"),
    machineIdPath: pick("machine-id-path", "NINEROUTER_MACHINE_ID_PATH") || path.join(home, ".9router", "machine-id"),
    cliSecretPath: pick("cli-secret-path", "NINEROUTER_CLI_SECRET_PATH") || path.join(home, ".9router", "auth", "cli-secret"),
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

  // Quota tracker — per-UTC-day per-domain counter. Skip akun kalau domain
  // sudah cap (default 10/hari). Persisted di .batch-stats.json.
  const quotaFile = file.quota || {};
  cfg.quota = {
    perDomainPerDay: Number(quotaFile.perDomainPerDay) || 10,
  };
  cfg.statsFile = pick("stats-file", "NINEROUTER_STATS_FILE") || ".batch-stats.json";
  cfg.proxyFile = pick("proxy-file", "NINEROUTER_PROXY_FILE") || "proxies.txt";

  cfg.mode = resolveMode(cfg.mode, cfg);

  if (cfg.mode === "remote" && cfg.proto === "http" && !isLocalHost(cfg.host)) {
    throw new Error(
      `Refusing to send the dashboard password in cleartext over HTTP to non-localhost host "${cfg.host}". ` +
        `Use --proto https for remote connections.`
    );
  }

  const missing = [];
  if (cfg.mode === "remote" && !cfg.password) {
    missing.push({ key: "password", msg: "Dashboard password (required in remote mode)" });
  }
  if (missing.length) {
    if (interactive) {
      for (const m of missing) cfg[m.key] = await prompt(`${m.msg}: `);
    } else {
      throw new Error(
        `Missing required config: ${missing.map((m) => m.msg).join("; ")}. Provide via flag (e.g. --${missing[0].key}) or env var.`
      );
    }
  }
  return cfg;
}

module.exports = { loadConfig, parseCliFlags, resolveMode, isLocalHost, DEFAULTS, readConfigFile };
