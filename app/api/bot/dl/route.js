import { NextResponse } from "next/server";
import crypto from "crypto";
import { createJob, updateJob } from "../../download/_store";
import { enqueueTask } from "../../download/_queue";
import { processVideoJob, fetchVideoTitle } from "../../download/_pipeline";

// Endpoint ini didesain buat dipanggil dari bot (mis. bot WhatsApp) waktu
// user ketik "!dl <link>". Bedanya dengan /api/download/start:
// - Nggak perlu panggil /api/info dulu buat milih format_id secara manual.
// - Kualitas otomatis di-cap ke MAX_HEIGHT_DEFAULT (1080p), tapi tetap
//   fallback otomatis ke kualitas tertinggi yang tersedia kalau videonya
//   memang cuma ada di resolusi yang lebih rendah.
// - Job selalu lewat antrian single-worker yang sama dengan web UI, jadi
//   nggak akan ada 2 proses yt-dlp/ffmpeg jalan bersamaan biarpun banyak
//   user WA nge-spam "!dl" bersamaan.

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

  const jobId = crypto.randomUUID();
  createJob(jobId);

  const queuePosition = enqueueTask(
    async () => {
      try {
        // Judul diambil di sini (bukan sebelum enqueue) supaya request awal
        // tetap cepat dibalas -- pengambilan judul ini kepakai kuota antrian,
        // bukan nambah beban di luar antrian.
        const title = await fetchVideoTitle(url);
        await processVideoJob(jobId, url, { maxHeight: MAX_HEIGHT_DEFAULT, title });
      } catch (err) {
        console.error(err);
        updateJob(jobId, {
          status: "error",
          error: "Terjadi kesalahan saat memproses unduhan",
        });
      }
    },
    {
      label: `bot:${jobId}`,
      onQueued: (position) => updateJob(jobId, { status: "queued", percent: 0, queuePosition: position }),
    },
  );

  return NextResponse.json({
    jobId,
    status: "queued",
    queuePosition,
    pendingAhead: Math.max(0, queuePosition - 1),
    maxHeight: MAX_HEIGHT_DEFAULT,
    // Endpoint yang perlu di-poll bot buat cek progress, lalu ambil filenya.
    statusUrl: `/api/bot/status/${jobId}`,
    fileUrl: `/api/download/file/${jobId}`,
  });
}
