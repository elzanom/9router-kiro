# 9router-kiro

Tool CLI (Node.js) untuk **otomatisasi registrasi akun Kiro AI ke 9router** lewat alur AWS SSO OIDC device code. Mendukung dua mode sign-in:

- **Google OAuth** — login pakai akun Google (`email` + `password`).
- **Email via priyo.email** — bikin akun AWS Builder ID baru dengan alamat priyo.email (random atau custom), verifikasi 6-digit code dibaca otomatis dari tab kedua.

> ⚠️ **Etika & ToS:** Tool ini mengotomatiskan login untuk akun yang kamu punya kredensialnya, ke instance 9router milikmu sendiri. Gunakan dengan jeda yang wajar dan hormati Terms of Service pihak terkait.

---

## Daftar Isi

- [Quick Start](#quick-start)
- [Prasyarat](#prasyarat)
- [Setup & Konfigurasi](#setup--konfigurasi)
  - [1. Install](#1-install)
  - [2. Setup Chromium](#2-setup-chromium)
  - [3. File konfigurasi `config.json`](#3-file-konfigurasi-configjson)
  - [4. Mode: local vs remote](#4-mode-local-vs-remote)
  - [5. Verifikasi setup](#5-verifikasi-setup)
- [Cara pakai](#cara-pakai)
- [Batch JSON (mixed google/email)](#batch-json-mixed-googleemail)
- [Semua opsi konfigurasi](#semua-opsi-konfigurasi)
- [Apa yang dilakukan bot](#apa-yang-dilakukan-bot)
- [Troubleshooting](#troubleshooting)
- [Keamanan](#keamanan)

---

## Quick Start

```bash
# 1. Clone & install
git clone git@github.com:elzanom/9router-kiro.git
cd 9router-kiro
npm install

# 2a. Jalankan langsung di mesin yang sama dengan 9router (mode local):
node bot.js add txn1@fvcksuite.com 'your-google-password'

# 2b. Atau dari mesin lain ke 9router remote (mode remote):
node bot.js add txn1@fvcksuite.com 'your-google-password' \
  --host <your-9router-host> --proto https --password '<dashboard-password>'
```

---

## Prasyarat

- **Node.js 18+** (cek: `node --version`).
- **Chromium / Google Chrome / Edge** — Puppeteer membutuhkan executable browser (jalankan `headless: false`).
  - Linux: `sudo apt install chromium` atau `sudo pacman -S chromium`.
  - Path default yang dicari bot: `/usr/bin/chromium`.
- **Mode local:** 9router terpasang di mesin yang sama dengan folder `~/.9router/` (berisi `machine-id`, `auth/cli-secret`, `db/data.sqlite`).
- **Mode remote:** akses HTTPS ke host 9router + dashboard password.

---

## Setup & Konfigurasi

### 1. Install

```bash
git clone git@github.com:elzanom/9router-kiro.git
cd 9router-kiro
npm install
```

Dependency yang dipasang: `puppeteer-core`, `puppeteer-extra` + plugin stealth, `sqlite3`. Bot **tidak** mendownload Chromium sendiri (pakai `puppeteer-core`), jadi browser harus sudah terinstal di sistem.

### 2. Setup Chromium

Bot butuh tahu path executable Chromium. Cek dulu ada di mana:

```bash
# Linux
which chromium || which chromium-browser || which google-chrome
```

Kalau bukan `/usr/bin/chromium`, kasih tahu bot lewat flag `--chromium`, env `NINEROUTER_CHROMIUM`, atau field `chromiumPath` di `config.json`:

```bash
node bot.js add user@example.com 'pass' --chromium /usr/bin/google-chrome
```

### 3. File konfigurasi `config.json`

Buat file `config.json` di root project (sudah ada template `config.example.json`):

```bash
cp config.example.json config.json
```

Contoh isi `config.json` (mode remote HTTPS):

```json
{
  "host": "your-9router-host",
  "proto": "https",
  "port": 443,
  "mode": "remote",
  "password": "dashboard-password-kamu",
  "chromiumPath": "/usr/bin/chromium"
}
```

Contoh untuk mode local:

```json
{
  "host": "localhost",
  "proto": "http",
  "port": 20128,
  "mode": "auto",
  "chromiumPath": "/usr/bin/chromium"
}
```

Pencarian file config (urutan): **cwd/config.json** → **~/.9router-kiro/config.json**. Bisa juga tanpa file sama sekali — semua bisa lewat flag CLI atau env var.

### 4. Mode: local vs remote

| | Local | Remote |
|---|---|---|
| Bot jalan di | mesin yang sama dengan 9router | manapun |
| Auth ke 9router | CLI token otomatis (`~/.9router/machine-id` + `cli-secret`) | dashboard password → session cookie |
| Akses data | SQLite langsung (`~/.9router/db/data.sqlite`) | HTTPS API (`/api/providers`) |
| Butuh `password`? | tidak | **ya** |
| Butuh `proto`? | `http` boleh | **`https`** (wajib kecuali localhost) |

Mode diatur via `--mode auto|local|remote`. Default `auto`:

- **local** kalau file `~/.9router/machine-id` ada **dan** `host` = localhost.
- **remote** untuk selebihnya.

**Setup mode local:**
Pastikan 9router sudah pernah dipakai di mesin itu sehingga `~/.9router/machine-id` terbentuk. Lalu cukup jalankan tanpa password.

**Setup mode remote:**
Cari host 9router kamu (mis. URL tunnel/cloud), pastikan HTTPS aktif, dan siapkan dashboard password. Wajib set `password` + `proto=https` (kecuali host = localhost).

### 5. Verifikasi setup

Tes koneksi tanpa registrasi pakai `inspect`:

```bash
node bot.js inspect
```

Kalau muncul daftar akun Kiro (atau "belum ada akun") berarti konfigurasi benar. Kalau error auth/koneksi, periksa [Semua opsi konfigurasi](#semua-opsi-konfigurasi) di bawah.

---

## Cara pakai

```bash
node bot.js add <email> <password> [flags]      # daftar 1 akun via Google OAuth
node bot.js add <accounts.json> [flags]         # batch dari file JSON (mixed google/email)
node bot.js inspect [flags]                     # lihat semua akun Kiro terdaftar
node bot.js delete <id> [flags]                 # hapus akun berdasarkan ID
```

Contoh:

```bash
# 1 akun Google, mode local:
node bot.js add txn1@fvcksuite.com 'your-google-password'

# 1 akun Google, mode remote:
node bot.js add txn1@fvcksuite.com 'your-google-password' \
  --host your-9router-host --proto https --password '<dashboard-password>'

# Batch banyak akun:
node bot.js add accounts.json

# Lihat hasil:
node bot.js inspect

# Hapus satu akun:
node bot.js delete <id>
```

---

## Batch JSON (mixed google/email)

Buat file `accounts.json` berisi array. Field `method` menentukan mode tiap akun:

```json
[
  { "email": "txn1@fvcksuite.com", "password": "your-google-password", "method": "google" },
  { "email": "txn2@fvcksuite.com", "password": "your-google-password", "method": "google" },
  { "method": "email" },
  { "method": "email", "priyoUsername": "mybuildera" },
  { "method": "email", "name": "John Doe", "password": "CustomKiroPass!1" }
]
```

| Field | Mode | Wajib | Keterangan |
|-------|------|-------|------------|
| `method` | keduanya | — | `"google"` (default) atau `"email"` |
| `email` | google | ya | email akun Google |
| `password` | google | ya | password akun Google |
| `email`/`password` | email | — | override password AWS Builder ID (default: di-generate random kuat) |
| `priyoUsername` | email | — | custom username priyo (`username@priyomail.org`); kosong = random |
| `name` | email | — | nama tampilan AWS Builder ID; kosong = nama realistis random |

> Mode `email`: domain default `priyomail.org` (yang diterima AWS). Username random dibuat 3–15 karakter. Nama default di-generate dari daftar nama realistis (mis. "Sandra Costa").

---

## Semua opsi konfigurasi

Prioritas (yang pertama menang): **flag CLI → env var → `config.json` → default**.

| Field | Flag CLI | Env var | Default | Wajib saat |
|-------|----------|---------|---------|------------|
| `host` | `--host` | `NINEROUTER_HOST` | `localhost` | selalu |
| `proto` | `--proto` | `NINEROUTER_PROTO` | `http` | — (`https` untuk remote) |
| `port` | `--port` | `NINEROUTER_PORT` | `20128` (`443` utk https) | — |
| `mode` | `--mode` | `NINEROUTER_MODE` | `auto` | — |
| `password` | `--password` | `NINEROUTER_PASSWORD` | — | remote |
| `chromiumPath` | `--chromium` | `NINEROUTER_CHROMIUM` | `/usr/bin/chromium` | — |
| `dbPath` | `--db-path` | `NINEROUTER_DB_PATH` | `~/.9router/db/data.sqlite` | (local) |
| `machineIdPath` | `--machine-id-path` | `NINEROUTER_MACHINE_ID_PATH` | `~/.9router/machine-id` | (local) |
| `cliSecretPath` | `--cli-secret-path` | `NINEROUTER_CLI_SECRET_PATH` | `~/.9router/auth/cli-secret` | (local) |

Format flag: `--key value` atau `--key=value`. Contoh lengkap env + flag:

```bash
# Pakai env var:
NINEROUTER_HOST=your-9router-host NINEROUTER_PROTO=https \
NINEROUTER_PASSWORD=<dashboard-password> node bot.js add accounts.json

# Atau pakai flag:
node bot.js add accounts.json --host your-9router-host --proto https --password '<dashboard-password>'
```

---

## Apa yang dilakukan bot

### Mode `google` (default)
1. Meminta *device code* dari 9router (`/api/oauth/kiro/device-code`).
2. Buka Chromium ke halaman verifikasi AWS (`https://view.awsapps.com/start/#/device?user_code=...`).
3. Login otomatis via Google OAuth.
4. Konfirmasi device code + izin aplikasi `kiro-oauth-client`.
5. Poll `/api/oauth/kiro/poll` sampai 9router menyimpan koneksi Kiro.

### Mode `email` (priyo.email)
1. Meminta *device code* dari 9router.
2. Buka 2 tab: AWS verifikasi (tab 1) + priyo.email (tab 2).
3. Tab 1: pilih "Sign in with email" / form email AWS Builder ID.
4. Tab 2: ambil alamat random atau bikin custom username (`priyoUsername`).
5. Submit email ke AWS → AWS kirim kode verifikasi ke priyo.email.
6. Bot fokus tab priyo, **reload** untuk ambil inbox baru, lalu baca inbox & ekstrak 6-digit code dari DOM.
7. Submit code ke AWS, isi password baru, lanjut konfirmasi device + Kiro consent.
8. Poll 9router sampai koneksi tersimpan.

---

## Troubleshooting

- **"Refusing to send the dashboard password in cleartext over HTTP"** — mode remote ke host non-localhost wajib `--proto https`.
- **"Missing required config: Dashboard password"** — mode remote butuh `--password` / `NINEROUTER_PASSWORD` / field `password` di config.json.
- **Chromium tidak ketemu / gagal launch** — set `--chromium <path>` ke executable yang benar (`which chromium`).
- **Mode `auto` terdeteksi `remote` padahal mau local** — pastikan `~/.9router/machine-id` ada dan `--host localhost`.
- **Google CAPTCHA / challenge** — login otomatis beruntun memicu challenge. Bot menycreenshot ke `/tmp` lalu berhenti; kasih jeda lalu ulang.
- **Device code expired** — browser terlalu lama; coba ulang.
- **Consent / tombol AWS tidak ter-klik** — AWS/Kiro sering ganti class tombol. Jalankan dengan `headless: false` (edit `launchStealthBrowser`) dan lanjut manual kalau perlu.
- **Domain priyo ditolak AWS (ERR-837)** — bot otomatis ganti ke email priyo lain; domain `priyomail.org` sudah diverifikasi diterima AWS.

---

## Keamanan

- `.gitignore` mengecualikan: `config.json`, `batch-accounts*.json`, `run-resume.sh`, `*.log`, `*.zip`, `node_modules/`. **Jangan commit file yang berisi password.**
- TLS selalu dipakai untuk remote. Untuk sertifikat self-signed, tambahkan CA ke trust store sistem atau pakai `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` — **jangan** set `NODE_TLS_REJECT_UNAUTHORIZED=0` (membuka celah MITM).
- Mode `remote` + `proto=http` + host non-localhost **langsung ditolak** (tidak mengirim password cleartext).
- Password akun Google tidak di-log; hanya email yang tampil di output.

---

## Test

```bash
npm test          # = node --test
```

---

## Lisensi

Personal project (ISC). Gunakan secara bertanggung jawab dan hanya untuk akun serta instance 9router milikmu sendiri.
