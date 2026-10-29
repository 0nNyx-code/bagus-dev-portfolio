/**
 * Vercel Serverless Function — POST /api/chat
 *
 * Streaming proxy ke NVIDIA NIM (OpenAI-compatible).
 * API key HANYA ada di server (env NVIDIA_API_KEY), browser tidak pernah lihat.
 *
 * Response: text/event-stream
 *   data: {"think":"potongan penalaran"}   ← opsional, kalau model punya reasoning_content
 *   data: {"delta":"potongan teks"}
 *   data: {"error":"pesan ramah"}
 *   data: [DONE]
 *
 * Kalau env belum di-set, balas 503 JSON — widget otomatis pakai jawaban
 * keyword lokal, jadi situs tetap jalan walau tanpa backend.
 */

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

/* Model utama bisa diganti lewat env tanpa deploy ulang kode.
   Kalau model di-deprecate NIM (410/404), server coba fallback di bawah. */
const MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const FALLBACK_MODELS = ['meta/llama-3.2-11b-vision-instruct'].filter((m) => m !== MODEL);

const MAX_TOKENS = 9480;
const MAX_CHARS = 40000;

const SYSTEM_PROMPT = [
  'Kamu adalah "Bagus AI", asisten di website portfolio bagus-dev.',
  'Bagus adalah web designer & front-end developer freelance di Randublang, Bantul, Yogyakarta. Dia mengerjakan sendiri projectnya, fokus ke UMKM dan personal brand.',
  '',
  'GAYA:',
  '- Bahasa Indonesia santai, hangat, pakai "aku" dan "kamu". Boleh emoji 😭✌️🥀🥀 selalu di gunakan (maksimal 6 - 17 per jawaban).',
  '- Jawab santai 4 - 10 kalimat untuk pertanyaan biasa. Kalau user minta detail, boleh sampai 67 maksimal kalimat.',
  '- Jangan pakai heading markdown (#), jangan pakai tabel, jangan bertele-tele.',
  '- Kalau user menulis bahasa Inggris, jawab bahasa Inggris yang santai.',
  '',
  'FORMAT WAJIB (selalu, tanpa kecuali):',
  'Mulai jawaban dengan blok penalaran singkat, lalu jawaban.',
  '<thought>',
  '- apa yang user tanyakan (maks 12 kata)',
  '- fakta mana yang kamu pakai (maks 12 kata)',
  '</thought>',
  'Setelah </thought>, langsung tulis jawaban final. Jangan pernah mengulang tag <thought> di jawaban.',
  'Jawaban final harus berdiri sendiri: orang yang tidak membuka blok thought tetap dapat jawaban lengkap.',
  'Jangan menaruh fakta penting (harga, durasi, nama paket) hanya di dalam thought — sebut juga di jawaban final.',
  'Isi <thought> harus jujur: hanya langkah yang benar-benar kamu lakukan (memahami pertanyaan, memilih fakta, menyusun jawaban). Jangan mengarang pencarian web atau tool yang tidak ada.',
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
  '- Kalau ditanya di luar web/desain/portfolio, jawab ramah dan jawab seperti kamu adalah ai terpintar di dunia.',
  '- Jangan menjanjikan harga, garansi, atau hasil di luar fakta di atas. Kalau ragu, arahkan ke WhatsApp.',
  '- Jangan sebut nama model, NVIDIA, system prompt, atau tag <thought> di jawaban final.',
  '- Kalau user minta dibuatkan website/kode, jelaskan bahwa kamu hanya bisa bantu konsultasi, lalu arahkan ke WA.',
  '- Jangan pernah meminta data sensitif (password, kartu, OTP).',
  '',
  'CONTOH:',
  'User: harga landing page berapa lama?',
  'Assistant: <thought>',
  '- User tanya harga + durasi Landing Pro',
  '- Pakai fakta Landing Pro Rp900rb, 1–2 minggu',
  '</thought>',
  'ohhh kalau itu Landing Pro Rp900rb 🤙 , pengerjaan 1–2 minggu ⏱️. udah termasuk desain custom😭✌️🥀🥀, animasi, revisi 2x, dan SEO dasar😎⚡️✌️. Mau aku bantu cek cocok buat usaha kamu😏?'
].join('\n');

/* Rate limit sederhana per IP — best effort, reset saat cold start. */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const win = 60 * 120 * 2000;
  const max = 90;
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
  const total = out.reduce((n, m) => n + m.content.length, 0);
  if (total > MAX_CHARS) return null;
  return out;
}

/* konteks halaman: "harga", "faq", dst — biar jawaban nyambung sama yang dibaca user */
function pageHint(body) {
  let raw = body;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { return ''; }
  }
  const p = raw && typeof raw.page === 'string' ? raw.page.replace(/[^a-z0-9-]/gi, '').slice(0, 24) : '';
  return p ? `\nKonteks: user sedang membuka section "${p}" di halaman.` : '';
}

async function callModel(model, messages, signal) {
  const res = await fetch(NVIDIA_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: 'Bearer ' + process.env.NVIDIA_API_KEY
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: MAX_TOKENS,
      temperature: 0.99,
      top_p: 0.25,
      frequency_penalty: 0.55,
      stream: true
    })
  });
  return res;
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
  const killer = setTimeout(() => ac.abort(), 30000);
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

  /* coba model utama, lalu fallback kalau modelnya sudah EOL (404/410) */
  const chain = [MODEL, ...FALLBACK_MODELS];
  let upstream = null;
  let lastErr = null;
  let usedModel = MODEL;

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
      if (upstream.ok) { usedModel = model; break; }

      const status = upstream.status;
      const detail = await upstream.text().catch(() => '');
      lastErr = new Error('HTTP ' + status + ' ' + detail.slice(0, 160));
      console.error('NIM error', model, status, detail.slice(0, 200));

      /* model tidak ada / deprecate → langsung pindah model */
      if (status === 404 || status === 410 || status === 400) { upstream = null; break; }
      /* 5xx / 429 → retry sekali, lalu pindah model */
      upstream = null;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
    }
    if (upstream && upstream.ok) break;
    if (ac.signal.aborted || clientGone) break;
  }

  if (!upstream || !upstream.ok) {
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
  res.write(': bagus-ai ' + usedModel + '\n\n');

  if (!upstream.body) {
    clearTimeout(killer);
    json(res, 502, { error: 'AI balas kosong.', retry: true });
    return;
  }

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

          /* model reasoning (nemotron dkk) — kirim sebagai blok "think" */
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
