import { NextResponse } from "next/server";
import { getDownloadQueue } from "@/lib/queue";

// Endpoint ini didesain buat dipanggil dari bot (mis. bot WhatsApp) waktu
// user ketik "!dl <link>". Bedanya dengan /api/download:
// - Nggak perlu panggil /api/info dulu buat milih format_id secara manual.
// - Kualitas otomatis di-cap ke MAX_HEIGHT_DEFAULT (1080p), tapi tetap
//   fallback otomatis ke kualitas tertinggi yang tersedia kalau videonya
//   memang cuma ada di resolusi yang lebih rendah.
// - Job masuk ke QUEUE REDIS/BULLMQ YANG SAMA dengan web UI (lihat lib/queue.js),
//   jadi nggak akan ada 2 proses yt-dlp/ffmpeg jalan bersamaan biarpun web
//   dan bot dipakai bersamaan (Worker Service tetap concurrency: 1).

const MAX_HEIGHT_DEFAULT = 1080;

// Batas aman buat maxHeight yang dikirim bot -- nolak nilai ngawur
// (negatif, 99999, atau string) tanpa bikin worker bingung.
const ALLOWED_HEIGHTS = [360, 480, 720, 1080, 1440, 2160];

// Harus sama persis dengan AUDIO_QUALITY_PRESETS di worker.js -- kalau
// nilainya nggak dikenal, worker jatuh ke "mp3-128" (lihat processAudioJob).
const ALLOWED_AUDIO_QUALITY = ["m4a-48", "m4a-128", "mp3-128"];

// Pola link YouTube yang umum: youtube.com/watch, youtu.be/, shorts, embed, dll.
const YOUTUBE_URL_RE =
  /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+/i;

function isAuthorized(request) {
  const expected = process.env.BOT_API_KEY;
  // Kalau BOT_API_KEY nggak di-set sama sekali, endpoint ini dianggap publik
  // (cocok buat testing lokal). Set env var ini di production supaya
  // endpoint nggak bisa dipakai orang lain selain bot kamu.
  if (!expected) return true;
  const provided =
    request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return provided === expected;
}

export async function POST(request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body request tidak valid" }, { status: 400 });
  }

  const url = (body?.url || "").trim();

  if (!url) {
    return NextResponse.json({ error: "Link tidak boleh kosong" }, { status: 400 });
  }
  if (!YOUTUBE_URL_RE.test(url)) {
    return NextResponse.json({ error: "Link bukan URL YouTube yang valid" }, { status: 400 });
  }

  // --- Opsi tambahan dari bot (semuanya OPSIONAL & backward-compatible:
  // body lama yang cuma isi { url } tetap jalan persis seperti dulu) ---
  //
  // type=audio ditambahkan buat command "!dl <link> mp3" di bot WhatsApp.
  // Worker sudah lama dukung ini lewat processAudioJob(), cuma endpoint bot
  // ini yang dulunya hardcode "video" sehingga jalur audio nggak kepakai.
  const type = body?.type === "audio" ? "audio" : "video";

  const requestedHeight = Number(body?.maxHeight);
  const maxHeight = ALLOWED_HEIGHTS.includes(requestedHeight)
    ? requestedHeight
    : MAX_HEIGHT_DEFAULT;

  const quality = ALLOWED_AUDIO_QUALITY.includes(body?.quality)
    ? body.quality
    : "mp3-128";

  try {
    const downloadQueue = getDownloadQueue();

    // Sengaja TIDAK fetch title di sini -- biar request bot ini tetap cepat
    // dibalas. Judul diambil oleh worker DI DALAM kuota antrean (lihat
    // fetchVideoTitle() di worker.js), sama seperti perilaku versi lama.
    const job = await downloadQueue.add(
      "download",
      type === "audio"
        ? { url, type: "audio", quality }
        : { url, type: "video", maxHeight },
    );

    const queuePosition = await downloadQueue.getWaitingCount();

    return NextResponse.json({
      jobId: job.id,
      status: "queued",
      queuePosition,
      pendingAhead: Math.max(0, queuePosition - 1),
      type,
      // Dibalikin apa adanya biar bot bisa lihat nilai mana yang BENERAN
      // dipakai -- kalau dia kirim maxHeight ngawur, di sini kelihatan
      // bahwa yang dipakai default, bukan yang dia minta.
      ...(type === "audio" ? { quality } : { maxHeight }),
      // Endpoint yang perlu di-poll bot buat cek progress. `fileUrl` BELUM
      // ada di sini (job baru masuk antrean) -- baru muncul di response
      // /api/bot/status/{jobId} setelah status jadi "done", dan mengarah
      // langsung ke Worker Service (bukan ke Web Service ini), karena
      // file-nya memang ada di container worker.
      statusUrl: `/api/bot/status/${job.id}`,
    });
  } catch (err) {
    console.error("Gagal menambahkan job bot ke queue:", err);
    return NextResponse.json(
      { error: "Gagal memproses permintaan, coba lagi sebentar lagi" },
      { status: 500 },
    );
  }
}