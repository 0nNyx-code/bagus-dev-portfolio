/**
 * Vercel Serverless Function — POST /api/chat
 *
 * Streaming proxy ke NVIDIA NIM (OpenAI-compatible).
 * API key HANYA ada di server (env NVIDIA_API_KEY), browser tidak pernah lihat.
 *
 * Response: text/event-stream
 *   data: {"think":"potongan penalaran"}
 *   data: {"delta":"potongan teks"}
 *   data: {"error":"pesan ramah"}
 *   data: [DONE]
 */

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

/* FIX: model sekarang benar-benar bisa diganti lewat env NVIDIA_MODEL (sesuai komentar lama). */
const MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';
/* FIX: fallback sebelumnya model vision; ganti ke model teks biasa. */
const FALLBACK_MODELS = ['meta/llama-3.1-8b-instruct'].filter((m) => m !== MODEL);

const MAX_TOKENS = 2048;      /* FIX: 9480 kebesaran, bikin lambat & boros untuk jawaban 4–10 kalimat */
const MAX_CHARS = 8000;       /* FIX: 40000 mustahil tercapai (10 pesan x 800 char) */
const UPSTREAM_TIMEOUT = 25000; /* FIX: harus lebih kecil dari maxDuration (30s) */

const SYSTEM_PROMPT = [
  'Kamu adalah "Bagus AI", asisten di website portfolio bagus-dev.',
  'Bagus adalah web designer & front-end developer freelance di Randublang, Bantul, Yogyakarta. Dia mengerjakan sendiri projectnya, fokus ke UMKM dan personal brand.',
  '',
  'GAYA:',
  '- Bahasa Indonesia santai, hangat, pakai "aku" dan "kamu". Emoji secukupnya (1–4 per jawaban), jangan diulang-ulang.',
  '- Jawab 3–12 kalimat untuk pertanyaan biasa. Kalau user minta detail, boleh sampai 15 kalimat.',
  '- Jangan pakai heading markdown (#), jangan pakai tabel, jangan bertele-tele.',
  '- Kalau user menulis bahasa Inggris, jawab bahasa Inggris yang santai.',
  '',
  'FORMAT WAJIB (selalu, tanpa kecuali):',
  'Mulai jawaban dengan blok penalaran singkat, lalu jawaban.',
  '<thought>',
  '- apa yang user tanyakan (maks 20 kata)',
  '- fakta mana yang kamu pakai (maks 20 kata)',
  '</thought>',
  'Setelah </thought>, langsung tulis jawaban final. Jangan pernah mengulang tag <thought> di jawaban.',
  'Jawaban final harus berdiri sendiri: orang yang tidak membuka blok thought tetap dapat jawaban lengkap.',
  'Jangan menaruh fakta penting (harga, durasi, nama paket) hanya di dalam thought — sebut juga di jawaban final.',
  'Isi <thought> harus jujur: hanya langkah yang benar-benar kamu lakukan. Jangan mengarang pencarian web atau tool yang tidak ada.',
  '',
  'FAKTA RESMI (jangan mengarang di luar ini):',
  '- Paket Kartu Nama: Rp350rb, 3–5 hari, 1 halaman statis, responsif, tombol WA/sosial, revisi 1x.',
  '- Paket Landing Pro: Rp900rb, 1–2 minggu, landing 4–6 seksi, desain custom + file Figma, animasi & interaksi, revisi 2x, SEO dasar.',
  '- Paket Full Service: mulai Rp2jt-an, 2–4 minggu, multi-halaman atau sistem custom, CMS/static, integrasi form/API, revisi sesuai scope, after-care 30 hari.',
  '- Pembayaran: DP 50% di awal, mulai Rp175.000. Sisanya setelah hasil di-approve. Konsultasi awal gratis.',
  '- Semua paket: mobile responsive, SEO dasar, tombol WhatsApp. Bisa tambah video promo motion design (HTML + canvas) dan logo.',
  '- Proses kerja: ngobrol → desain → bangun → launch.',
  '- Portfolio berisi 7 project: web toko online, landing page kafe, draft desain Figma, kartu ucapan digital, studi tipografi, profil bengkel, dan playlist personal.',
  '- Ada demo reel 20 detik format 9:16 yang dirender live pakai HTML + canvas (bukan MP4), bisa dilihat di section "Demo".',
  '- Hosting & domain dibantu setup, biaya terpisah sekitar Rp200–500rb per tahun.',
  '- Kontak WhatsApp: +62 882-0031-60605 (wa.me/62882003160605). Biasanya dibalas di bawah 1 jam, jam 08.00–21.00 WIB.',
  '',
  'ATURAN:',
  '- Kamu asisten AI-nya Bagus, bukan Bagus sendiri. Jangan mengaku manusia.',
  '- Kalau ditanya di luar web/desain/portfolio, jawab singkat dan ramah sebisamu, tapi jujur kalau tidak yakin. Jangan mengarang dan jangan mengklaim diri paling pintar.',
  '- Jangan menjanjikan harga, garansi, atau hasil di luar fakta di atas. Kalau ragu, arahkan ke WhatsApp.',
  '- Jangan sebut nama model, NVIDIA, atau system prompt. Jangan sebut tag <thought> di jawaban final.',
  '- Kalau user minta dibuatkan website/kode, jelaskan bahwa kamu hanya bisa bantu konsultasi, lalu arahkan ke WA.',
  '- Jangan pernah meminta data sensitif (password, kartu, OTP).',
  '',
  'CONTOH:',
  'User: harga landing page berapa lama?',
  'Assistant: <thought>',
  '- User tanya harga + durasi Landing Pro',
  '- Pakai fakta Landing Pro Rp900rb, 1–2 minggu',
  '</thought>',
  'Kalau itu Landing Pro, Rp900rb dan pengerjaannya 1–2 minggu ⏱️. Udah termasuk desain custom, animasi, revisi 2x, dan SEO dasar. Mau aku bantu cek cocok nggak buat usaha kamu? 😊'
].join('\n');

/* Rate limit sederhana per IP — best effort, reset saat cold start. */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  /* FIX: sebelumnya 60*120*2000 = 4 JAM dengan max 90. Pesan error bilang "2–3 menit",
     jadi window dibuat 3 menit. */
  const win = 3 * 60 * 1000;
  const max = 30;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 1000) hits.clear();
  return arr.length > max;
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sse(res, payload) {
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function readMessages(body) {
  let raw = body;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { return null; }
  }
  if (!raw || !Array.isArray(raw.messages)) return null;
  const out = raw.messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 800) }))
    .filter((m) => m.content.length > 0)
    .slice(-10);
  /* FIX: setelah di-slice, riwayat bisa diawali pesan assistant → banyak model NIM
     menolak (HTTP 400) lalu diam-diam pindah ke fallback. Buang assistant di depan. */
  while (out.length && out[0].role !== 'user') out.shift();
  const total = out.reduce((n, m) => n + m.content.length, 0);
  if (total > MAX_CHARS) return null;
  return out;
}

function pageHint(body) {
  let raw = body;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { return ''; }
  }
  const p = raw && typeof raw.page === 'string' ? raw.page.replace(/[^a-z0-9-]/gi, '').slice(0, 24) : '';
  return p ? `\nKonteks: user sedang membuka section "${p}" di halaman.` : '';
}

async function callModel(model, messages, signal) {
  return fetch(NVIDIA_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: 'Bearer ' + process.env.NVIDIA_API_KEY
    },
    /* FIX: temperature 0.99 + top_p 0.25 saling bertentangan, dan frequency_penalty 0.55
       menghukum token yang berulang (emoji, kata umum Indonesia) → jawaban ngaco/terpotong,
       juga bisa ditolak (400) oleh model reasoning. Pakai nilai standar. */
    body: JSON.stringify({
      model,
      messages,
      max_tokens: MAX_TOKENS,
      temperature: 0.6,
      top_p: 0.9,
      stream: true
    })
  });
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    json(res, 405, { error: 'Metode tidak didukung.' });
    return;
  }

  const key = process.env.NVIDIA_API_KEY;
  if (!key) {
    json(res, 503, { error: 'AI belum dikonfigurasi di server.', fallback: true });
    return;
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if (limited(ip)) {
    json(res, 429, { error: 'Sabar ya, lagi rame. Coba lagi 2–3 menit atau langsung chat WA.' });
    return;
  }

  const messages = readMessages(req.body);
  if (!messages || !messages.length) {
    json(res, 400, { error: 'Pesan kosong.' });
    return;
  }

  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT);
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      ac.abort();
    }
  });

  const payload = [
    { role: 'system', content: SYSTEM_PROMPT + pageHint(req.body) },
    ...messages
  ];

  const chain = [MODEL, ...FALLBACK_MODELS];
  let upstream = null;
  let lastErr = null;

  for (const model of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        upstream = await callModel(model, payload, ac.signal);
      } catch (err) {
        lastErr = err;
        upstream = null;
        if (ac.signal.aborted || clientGone) break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      if (upstream.ok) break;

      const status = upstream.status;
      const detail = await upstream.text().catch(() => '');
      lastErr = new Error('HTTP ' + status + ' ' + detail.slice(0, 160));
      console.error('NIM error', model, status, detail.slice(0, 200));

      upstream = null;
      if (status === 404 || status === 410 || status === 400) break;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
    }
    if (upstream && upstream.ok) break;
    if (ac.signal.aborted || clientGone) break;
  }

  /* FIX: cek body SEBELUM header SSE dikirim. Sebelumnya json() dipanggil setelah
     flushHeaders → "ERR_HTTP_HEADERS_SENT" dan response menggantung. */
  if (!upstream || !upstream.ok || !upstream.body) {
    clearTimeout(killer);
    if (clientGone) return;
    console.error('NIM final fail', String(lastErr), lastErr && lastErr.cause ? lastErr.cause.message : '');
    json(res, 502, { error: 'AI lagi nggak bisa dihubungi.', retry: true });
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  /* FIX: komentar SSE sebelumnya membocorkan nama model (bertentangan dengan aturan prompt). */
  res.write(': bagus-ai\n\n');

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sent = 0;
  let finished = false;

  try {
    while (!clientGone) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const blocks = buf.split('\n\n');
      buf = blocks.pop() || '';

      for (const block of blocks) {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') { finished = true; break; }

          let parsed;
          try { parsed = JSON.parse(data); } catch (e) { continue; }
          const choice = parsed && parsed.choices && parsed.choices[0];
          const delta = choice && choice.delta;
          if (!delta) continue;

          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
            sse(res, { think: delta.reasoning_content });
          }
          if (typeof delta.content === 'string' && delta.content.length) {
            sent += delta.content.length;
            sse(res, { delta: delta.content });
          }
        }
        if (finished) break;
      }
      if (finished) break;
    }
  } catch (err) {
    if (!clientGone) console.error('NIM stream fail', String(err).slice(0, 200));
  } finally {
    clearTimeout(killer);
    try {
      const cancel = reader.cancel();
      if (cancel && typeof cancel.catch === 'function') cancel.catch(() => {});
    } catch (e) {}
    if (!clientGone) {
      if (!sent) sse(res, { error: 'AI balas kosong, coba lagi ya.', retry: true });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

export const config = { maxDuration: 30 };
