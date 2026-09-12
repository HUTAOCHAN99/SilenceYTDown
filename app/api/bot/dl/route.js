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

  try {
    const downloadQueue = getDownloadQueue();

    // Sengaja TIDAK fetch title di sini -- biar request bot ini tetap cepat
    // dibalas. Judul diambil oleh worker DI DALAM kuota antrean (lihat
    // fetchVideoTitle() di worker.js), sama seperti perilaku versi lama.
    const job = await downloadQueue.add("download", {
      url,
      type: "video",
      maxHeight: MAX_HEIGHT_DEFAULT,
    });

    const queuePosition = await downloadQueue.getWaitingCount();

    return NextResponse.json({
      jobId: job.id,
      status: "queued",
      queuePosition,
      pendingAhead: Math.max(0, queuePosition - 1),
      maxHeight: MAX_HEIGHT_DEFAULT,
      // Endpoint yang perlu di-poll bot buat cek progress, lalu ambil filenya.
      statusUrl: `/api/bot/status/${job.id}`,
      fileUrl: `/api/download/file/${job.id}`,
    });
  } catch (err) {
    console.error("Gagal menambahkan job bot ke queue:", err);
    return NextResponse.json(
      { error: "Gagal memproses permintaan, coba lagi sebentar lagi" },
      { status: 500 },
    );
  }
}
