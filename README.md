# bagus-dev — portfolio + Bagus AI

Website portfolio satu halaman untuk **Bagus**, web designer & front-end developer di Randublang, Bantul, Jogja. Gaya neo-brutalist, motion-heavy, dengan asisten AI dan demo reel 9:16 yang dirender live.

## Isi folder

```
index.html          # halaman utama (single-file: CSS + JS inline)
demo.html           # promo reel 20 detik, HTML + canvas
api/chat.js         # serverless proxy ke NVIDIA NIM (streaming SSE)
assets/             # gambar project, maskot, lockup, favicon, journal
.env.local          # API key (JANGAN di-commit)
.env.example        # contoh format env
```

## Jalanin lokal

**Tanpa backend** (paling cepat, AI pakai jawaban keyword lokal):

```bash
python3 -m http.server 8080
# buka http://localhost:8080
```

**Dengan AI beneran** (butuh Node 18+ dan Vercel CLI):

```bash
npx vercel dev
# buka URL yang muncul (biasanya http://localhost:3000)
```

`vercel dev` membaca `.env.local` otomatis. Kalau `NVIDIA_API_KEY` kosong, endpoint balas 503 dan widget otomatis fallback ke jawaban lokal — situs tetap aman.

## Deploy

1. Import folder ini (atau repo-nya) ke Vercel.
2. Tambahkan Environment Variable:
   - `NVIDIA_API_KEY` = key dari [build.nvidia.com](https://build.nvidia.com)
3. Deploy. Tidak ada build step — Vercel menyajikan `index.html` + `demo.html` statis, dan `api/chat.js` jadi function.

> API key **tidak pernah** masuk ke HTML. Browser hanya memanggil `/api/chat`, lalu server yang meneruskan ke NVIDIA.

## Bagian yang sering diedit

| Mau ubah | Lokasi |
| --- | --- |
| Harga & paket | `index.html` cari `id="harga"`; `demo.html` cari `PACKS` |
| Fakta untuk AI | `api/chat.js` → `SYSTEM_PROMPT` |
| Jawaban fallback | `index.html` cari `var replies = {` |
| Model AI | `api/chat.js` → `MODEL` |
| Nomor WA | cari `62882003160605` |
| Demo reel | `demo.html`; embed di `index.html` pakai `demo.html?stage=1` |

Kalau mengubah harga, samakan di **tiga tempat**: section Harga, `SYSTEM_PROMPT`, dan `PACKS` di `demo.html`.

## Catatan teknis

- Chat memakai SSE (`text/event-stream`) supaya teks muncul bertahap, bukan nunggu penuh.
- Rate limit: 20 pesan / 3 menit per IP (best effort, in-memory).
- Model: `meta/llama-3.2-11b-vision-instruct` — cepat dan cukup buat FAQ.
- `demo.html?stage=1` menyembunyikan kontrol dan autoplay-loop, dipakai di iframe section Demo.
- Semua animasi baru dimatikan otomatis saat `prefers-reduced-motion: reduce`.
