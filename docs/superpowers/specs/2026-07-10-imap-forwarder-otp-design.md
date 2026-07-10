# Forwarder (SimpleLogin + Firefox Relay) + IMAP OTP — Design

**Tanggal:** 2026-07-10
**Status:** Draft — menunggu review user

## Konteks / Masalah

Mode `email` bot saat ini pakai **priyo.email**: bot bikin alamat `*@priyomail.org` di tab kedua, lalu scrape OTP dari DOM inbox priyo. Masalah:

- **`priyomail.org` diblokir AWS (ERR-837).** Run sukses `pm23` (05:41, `ke3bq8dz2@priyomail.org`) → jalan. Run `13:11` (`kejeouflfr@priyomail.org`) → AWS balas `ERR-837`. Pola sama seperti dulu: domain priyo diblokir AWS satu per satu (`priyo.email` → `priyomail.org`).
- **Retry handler rusak** (`bot.js:1388-1402`): deteksi ERR-837 ada, tapi domain di-hardcode (`bot.js:1154`) → retry pakai domain yang sama; cuma 1x; `clickRandomPriyoEmail` + `page.goBack()` gak benar-benar ganti domain → priyo tab nyangkut di `/create-account` → `getPriyoEmail` throw.
- Scraping DOM priyo本身就 rapuh (dua tab, `reload` manual, polling Livewire, text-marker fallback).

## Keputusan

Ganti sumber email pakai **alias forwarder** (SimpleLogin + Firefox Relay) yang forward ke **Gmail**, OTP dibaca via **IMAP**. Fase 1: **list alias diberikan manual** (file/arg) — bot tidak bikin alias via API (YAGNI; bisa fase 2).

Untuk bot, alias itu cuma alamat email biasa → SimpleLogin & Relay didukung sekaligus tanpa code tambahan (cukup campur di list).

## Goals / Non-goals

**Goals**
- Mode `email` reliable lagi (lepas dari blocklist domain priyo).
- Hapus fragilitas scraping DOM priyo.
- OTP via IMAP robust, termasuk email yang masuk **Spam**.

**Non-goals (fase 1)**
- Pembuatan alias via API SimpleLogin/Relay.
- Dukungan provider mailbox selain Gmail (Gmail dipilih eksplisit; struktur config tetap generic biar mudah diperluas).

## Arsitektur

- **1 tab browser** (AWS flow aja). **Tab priyo dihapus total.**
- **Sumber email:** alias dari input (file batch / arg / interactive), bukan digenerate.
- **OTP:** `getOtpViaImap(imapCfg, alias, opts)` — IMAP Gmail, search lintas semua mail via `X-GM-RAW`, hapus setelah baca.
- **Tidak berubah:** device-code flow (`getDeviceCode`), seluruh AWS Builder ID flow (enter email → name → verify-otp → password → consent → device confirm), `runBatch`, `interactiveRun`, `clickPrimaryButtonMouse`, password setup.

## Komponen

### 1. Baru — `getOtpViaImap(imapCfg, alias, opts = {})`

Interface:
```js
// resolve:
{ ok: true, otp: "573868", from: "no-reply@signin.aws", subject: "...", received: "2026-07-10T13:11:..." }
// reject/timeout:
{ ok: false, error: "OTP timeout 120s", debug: { searchedFolders: [...], matchCount: 0 } }
```

Perilaku:
- Connect sekali (`imapflow`), `imap.gmail.com:993`, TLS, App Password.
- Reuse `extractOtpFromRaw` (sekarang di `bot.js:~791`) buat ekstrak 6-digit.
- Poll tiap **5s**, timeout **120s** (sama seperti `getPriyoOtp` lama).
- Catat `submitTime = Date.now()` **tepat setelah klik submit pada step NAME** (submit name inilah yang memicu AWS mengirim code — bukan submit email); dipakai sebagai guard recency (lihat Matching).

**Search (Gmail `X-GM-RAW`, primary):**
- Query: `to:<alias> subject:"Verify your AWS Builder ID email address"`.
- Nyari **lintas semua mail** → otomatis ke-cover Inbox + Spam + All Mail. Menjawarkan "forwarder sering masuk spam".
- Ambil match terbaru (`internalDate` terbesar) yang `internalDate >= submitTime - 60s` (slack forwarding-latency).

**Fallback (kalau server gak iklan `X-GM-EXT-1`):**
- Deteksi folder Spam via special-use flag `\Junk` (`client.list()`), fallback nama `[Gmail]/Spam`.
- Search INBOX dulu (`TO <alias>` + `SUBJECT ...`), lalu folder Spam — di tiap poll.

**`deleteAfterRead` (default true):**
- Hapus email OTP dari folder mana pun dia ketemu (`client.messageDelete` / set flag `\Deleted` + `expunge`).
- Mencegah re-match OTP lama di run berikut + menjaga inbox/spam bersih.

**Auth fail / connect fail:** throw dengan pesan jelas (mis. "IMAP auth gagal — cek App Password / 2FA") → akun gagal, batch lanjut.

### 2. Refactor — `automateKiroEmailLogin(page, ...)`

- `account.email` sekarang = **alias** (wajib untuk method=email). Validasi ada; kalau kosong → throw di awal `processAccount`.
- **Hapus:** `openPriyoTab`, `createCustomPriyoUsername`, `getPriyoEmail`, `clickRandomPriyoEmail`, blok reload priyo, `getPriyoOtp`, blok retry ERR-837 yang rusak.
- Step "3/6 buka priyo" dihilangkan. Langsung dari submit email (alias) → name → `getOtpViaImap(imapCfg, alias)` → verify-otp → password → consent.
- `submitTime` dicatat tepat setelah klik submit pada step NAME (submit name memicu AWS mengirim code).

### 3. Config

Tambah di `config.json` (sudah gitignored):
```json
{
  "imap": {
    "host": "imap.gmail.com",
    "port": 993,
    "user": "<gmail-address>",
    "password": "<gmail-app-password>",
    "tls": true,
    "deleteAfterRead": true
  }
}
```
Flag CLI / env var (prioritas flag > env > config > default, konsisten dengan skema ada):
- `--imap-user` / `NINEROUTER_IMAP_USER`
- `--imap-password` / `NINEROUTER_IMAP_PASSWORD`
- `--imap-host` / `NINEROUTER_IMAP_HOST` (default `imap.gmail.com`)
- `--no-delete-otp` (override `deleteAfterRead=false`)

### 4. CLI / Batch / Interactive

**Batch file** (reuse shape lama):
```json
[
  { "method": "email", "email": "abc@aleeas.com", "name": "Sandra Costa" },
  { "method": "email", "email": "xyz@mozmail.com", "password": "CustomKiro!1" },
  { "method": "google", "email": "txn1@fvcksuite.com", "password": "..." }
]
```
`email` (method=email) = alias. `priyoUsername` deprecated (diabaikan + warning). `name` kosong = `randomRealisticName()`. `password` kosong = random kuat.

**Single:** `node bot.js add <alias> --method email [flags]` (password opsional). `add <email> <password>` tanpa `--method` tetap = google.

**Interactive email-mode:** prompt "prefix username priyo" dihapus. Ganti: minta **file list alias** (one-per-line atau JSON array), pakai N baris/entry pertama sesuai jawaban "Loop berapa kali". Google-mode prompt tidak berubah.

## Data Flow

```
input alias (file/arg/interactive)
  ↓ runBatch loop (delay antar akun)
processAccount(method=email):
  1. getDeviceCode() dari 9router
  2. buka AWS tab, isi email = alias, isi name, **submit name**  →  catat submitTime (name-submit yang memicu code)
  3. getOtpViaImap(imapCfg, alias, {since: submitTime})
       connect Gmail → search X-GM-RAW lintas semua mail → poll 5s/120s
       → dapat OTP → hapus email (deleteAfterRead)
  4. isi OTP ke AWS → password → consent → device confirm
  5. poll 9router simpan token → rename koneksi = alias
```

## Error Handling

- **IMAP connect/auth gagal:** throw jelas; akun gagal; batch lanjut ke alias berikutnya.
- **OTP timeout 120s:** `{ok:false}` → akun gagal; log `debug.searchedFolders` + `matchCount` untuk diagnosis (mis. forwarder tertunda / masuk folder lain).
- **Stale match (OTP lama):** dicegah oleh `deleteAfterRead` + guard `internalDate >= submitTime - 60s`.
- **Alias kosong (method=email tanpa email):** throw di `processAccount` sebelum buka browser.
- **Forwarder rewrite To-header:** (risiko) lihat "Risiko terbuka".

## Kode yang Dihapus

- `PRIYO_HOST` (`bot.js:348`)
- `openPriyoTab` (`:350`)
- `getPriyoEmail` (`:358`)
- `clickRandomPriyoEmail` (`:393`)
- `createCustomPriyoUsername` (`:409`)
- `getPriyoOtp` (`:~561`)
- blok reload priyo (`:~1421`) + retry ERR-837 rusak (`:1388-1402`)
- `extractOtpFromRaw` (`:~791`) **dipertahankan** sebagai helper (dipakai `getOtpViaImap`).

## Dependency

- Tambah **`imapflow`** ke `package.json` (Promise-based, search+fetch+flag, support Gmail `X-GM-EXT`).

## Risiko Terbuka

1. **Forwarder rewrite header To.** SimpleLogin & Relay umumnya preserve alias di To-header → Gmail `to:` search match. Kalau ada provider yang rewrite To ke alamat Gmail, `to:` tidak match alias → fallback: match by `subject` + sender AWS + recency + tracking consumed (kurang presisi untuk batch bersamaan). Fase 1 asumsi To preserved.
2. **`X-GM-EXT-1` tidak tersedia.** Fallback multi-folder (INBOX + `\Junk`) sudah disediakan.
3. **Forwarding latency** (SL/Relay + Gmail) → timeout 120s + slack 60s menutup.
4. **Gmail kategorisasi selain Spam** (Primary/Updates/Promotions) tidak relevan untuk IMAP (kategori = label, bukan folder); X-GM-RAW tetap match.

## Testing

- Unit: `extractOtpFromRaw` pada sample body AWS (sudah ada OTP terverifikasi: `573868`, `344535`, dll).
- Integration (mock IMAP server / akun Gmail test): kirim email OTP ke alias → `getOtpViaImap` berhasil ekstrak + hapus.
- Kasus spam: taruh email OTP di folder Spam → pastikan X-GM-RAW / fallback menemukan.
- E2E: 1 akun email-mode end-to-end lewat alias forwarder → `Akun Kiro berhasil terdaftar`.

## Catatan Operasional (opsional, sisi user)

- Gmail filter `from:(signin.aws) to:(<alias-pattern>) → Never send to Spam` mengurangi latency & ketergantungan search spam.
- App Password butuh 2FA aktif di akun Gmail.
