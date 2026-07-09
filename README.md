# 9router-kiro

Tool CLI (Node.js) untuk **otomatisasi registrasi akun Kiro AI ke 9router** lewat alur AWS SSO OIDC device code + Google OAuth.

> ⚠️ **Etika & ToS:** Tool ini mengotomatiskan login untuk akun yang kamu punya kredensialnya, ke 9router milikmu sendiri. Gunakan dengan jeda yang wajar dan hormati Terms of Service pihak terkait.

---

## Apa yang dilakukan

Untuk satu akun Google (email + password), bot akan:

1. Meminta *device code* dari 9router (`/api/oauth/kiro/device-code`).
2. Membuka Chromium ke halaman verifikasi AWS (`https://view.awsapps.com/start/#/device?user_code=...`).
3. Login otomatis via Google OAuth.
4. Konfirmasi device code dan memberi izin aplikasi `kiro-oauth-client`.
5. Poll `/api/oauth/kiro/poll` sampai 9router menyimpan koneksi Kiro.

Tersedia juga operasi baca/hapus (`inspect`, `delete`).

---

## Command

```bash
node bot.js add <email> <password> [flags]      # daftarkan 1 akun
node bot.js add <accounts.json> [flags]         # batch dari file JSON
node bot.js inspect [flags]                     # lihat akun Kiro terdaftar
node bot.js delete <id> [flags]                 # hapus akun
```

`accounts.json` berformat array:

```json
[
  { "email": "user1@example.com", "password": "theirpassword" },
  { "email": "user2@example.com", "password": "theirpassword" }
]
```

---

## Mode: local vs remote

| | Local | Remote |
|---|---|---|
| Bot jalan di | mesin yang sama dengan 9router | manapun |
| Auth ke 9router | CLI token (`~/.9router/machine-id` + `cli-secret`) | dashboard password → session cookie |
| Akses data | SQLite langsung (`~/.9router/db/data.sqlite`) | HTTPS API (`/api/providers`) |
| `add` | ✅ | ✅ |
| `inspect` / `delete` | ✅ | ✅ |

Mode diatur via `--mode auto|local|remote`. Default `auto`: **local** kalau `~/.9router/machine-id` ada **dan** host = localhost; selain itu **remote**.

---

## Prasyarat

- **Node.js 18+**.
- **Chromium/Chrome/Edge** (Puppeteer, `headless: false`).
- **Mode local:** 9router terpasang di mesin yang sama (`~/.9router/`).
- **Mode remote:** akses ke host 9router (HTTPS) + dashboard password.

---

## Install

```bash
git clone git@github.com:elzanom/9router-kiro.git
cd 9router-kiro
npm install
```

---

## Config

Prioritas: **flag CLI → env var → `config.json` → default**.

| Field | Flag | Env | Default | Wajib |
|-------|------|-----|---------|-------|
| `host` | `--host` | `NINEROUTER_HOST` | `localhost` | ya |
| `proto` | `--proto` | `NINEROUTER_PROTO` | `http` | — |
| `port` | `--port` | `NINEROUTER_PORT` | `20128` (`443` untuk https) | — |
| `mode` | `--mode` | `NINEROUTER_MODE` | `auto` | — |
| `password` | `--password` | `NINEROUTER_PASSWORD` | — | remote |
| `chromiumPath` | `--chromium` | `NINEROUTER_CHROMIUM` | `/usr/bin/chromium` | — |

File `config.json` dicari di cwd dulu, lalu `~/.9router-kiro/config.json`.

---

## Contoh pakai

```bash
# Local (default):
node bot.js add txn1@fvcksuite.com 'Lucky123!'
node bot.js inspect

# Remote via HTTPS:
node bot.js add txn1@fvcksuite.com 'Lucky123!' \
  --host <your-9router-host> \
  --proto https \
  --password '<dashboard-password>'

# Batch:
node bot.js add accounts.json

# Hapus akun:
node bot.js delete <id>
```

---

## Keamanan

- `config.json`, `batch-accounts.json`, `*.zip`, `node_modules/` di-gitignore.
- TLS selalu aktif. Untuk sertifikat self-signed, gunakan `NODE_EXTRA_CA_CERTS`.
- Mode `remote` + `proto=http` + host non-localhost akan ditolak.
- Password akun Google tidak di-log; hanya email yang tampil.

---

## Test

```bash
npm test
# atau: node --test
```

---

## Troubleshooting

- **Google CAPTCHA / challenge** — login otomatis beruntun memicu challenge. Bot menycreenshot ke `/tmp` lalu berhenti.
- **Device code expired** — browser terlalu lama; coba ulang.
- **Consent page tidak ter-klik** — AWS/Kiro sering mengubah class tombol; coba jalankan dengan `headless: false` dan lanjutkan manual.

---

## Lisensi

Personal project. Gunakan secara bertanggung jawab.
