// worker.js
//
// Ini adalah PROSES TERPISAH dari Next.js — dijalankan sebagai Worker Service
// sendiri di Railway (Dockerfile berbeda, lihat Dockerfile.worker), bukan
// bagian dari `next start`. Tugasnya cuma satu: mendengarkan antrean Redis
// terus-menerus, ambil job SATU PER SATU (concurrency: 1), lalu jalankan
// yt-dlp + ffmpeg lewat child_process.
//
// Jalankan lokal dengan: node worker.js
// (pastikan REDIS_URL, yt-dlp, dan ffmpeg sudah tersedia di environment lokal)

import { Worker } from "bullmq";
import { spawn } from "child_process";
import { createReadStream } from "fs";
import fs from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { getConnection, DOWNLOAD_QUEUE_NAME } from "./lib/queue.js";
import { getCookieArgs, ensureCookiesFromEnv } from "./lib/cookies.js";
import { looksLikeBotCheck, notifyCookiesExpired } from "./lib/notify.js";

// Materialisasi cookies dari YT_COOKIES_B64 (kalau di-set) sebelum job
// pertama diproses -- lihat komentar di lib/cookies.js soal kenapa ini
// perlu dan tidak bisa cuma mengandalkan /api/admin/cookies.
ensureCookiesFromEnv();

// worker.js adalah proses long-running yang start SETELAH Railway inject env
// var, jadi aman untuk langsung resolve koneksi di sini (beda kondisi dengan
// lib/queue.js yang di-import saat next build).
const connection = getConnection();

const AUDIO_QUALITY_PRESETS = {
  "m4a-48": { ext: "m4a", codec: "aac", bitrate: "48k" },
  "m4a-128": { ext: "m4a", codec: "aac", bitrate: "128k" },
  "mp3-128": { ext: "mp3", codec: "libmp3lame", bitrate: "128k" },
};

function sanitizeTitle(rawTitle) {
  if (!rawTitle) return "";
  return rawTitle
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

// Jalankan proses eksternal (yt-dlp / ffmpeg) sambil membaca stdout baris per
// baris — dipakai untuk menangkap progress "[download] 42.5% ..." secara real-time.
function runProcess(cmd, args, onStdoutLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";
    let buf = "";

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (line) onStdoutLine?.(line);
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // "error" berarti proses gagal DI-SPAWN sama sekali (mis. binary tidak
    // ditemukan) — beda dengan exit code non-zero yang ditangani di "close".
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => resolve({ code, stderr }));
  });
}

function parseProgressPercent(line) {
  const match = line.match(/\[download\]\s+(\d{1,3}(?:\.\d+)?)%/);
  return match ? Math.min(99, parseFloat(match[1])) : null;
}

// Format selector dengan cap tinggi maksimum + fallback otomatis kalau video
// nggak punya format setinggi itu. Dipakai jalur bot (maxHeight), beda dengan
// jalur web UI yang biasanya sudah kasih formatId spesifik hasil pilihan user.
function buildHeightCappedFormatSelector(maxHeight) {
  return [
    `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]`,
    `bv*[height<=${maxHeight}]+ba`,
    `b[height<=${maxHeight}][ext=mp4]`,
    `b[height<=${maxHeight}]`,
    "best",
  ].join("/");
}

// Varian runProcess yang mengembalikan stdout utuh (bukan per-baris lewat
// callback) — dipakai untuk ambil judul video secara cepat tanpa download.
function runProcessCollectStdout(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fetchVideoTitle(url) {
  try {
    const result = await runProcessCollectStdout("yt-dlp", [
      "--no-playlist",
      "--skip-download",
      "--print", "%(title)s",
      ...getCookieArgs(),
      url,
    ]);
    if (result.code !== 0) return "";
    return result.stdout?.trim?.() || "";
  } catch {
    return "";
  }
}

async function processAudioJob(job, tmpDir) {
  const { url, quality } = job.data;
  const preset = AUDIO_QUALITY_PRESETS[quality] || AUDIO_QUALITY_PRESETS["mp3-128"];
  const sourceTemplate = path.join(tmpDir, "source.%(ext)s");
  const finalPath = path.join(tmpDir, `audio.${preset.ext}`);

  const ytdlpArgs = [
    "-f", "bestaudio/best",
    "-o", sourceTemplate,
    "--no-playlist",
    "--newline",
    ...getCookieArgs(),
    url,
  ];

  const ytdlpResult = await runProcess("yt-dlp", ytdlpArgs, (line) => {
    const percent = parseProgressPercent(line);
    if (percent !== null) job.updateProgress({ status: "downloading", percent });
  });

  if (ytdlpResult.code !== 0) {
    if (looksLikeBotCheck(ytdlpResult.stderr)) {
      notifyCookiesExpired("(worker, saat proses download audio)");
    }
    throw new Error(`yt-dlp gagal (audio): ${ytdlpResult.stderr.slice(-1500)}`);
  }

  const filesInTmp = await fs.readdir(tmpDir);
  const sourceFile = filesInTmp.find((f) => f.startsWith("source."));
  if (!sourceFile) {
    throw new Error("File audio hasil unduhan tidak ditemukan");
  }

  await job.updateProgress({ status: "converting", percent: 99 });

  const ffmpegArgs = [
    "-y", "-i", path.join(tmpDir, sourceFile), "-vn",
    "-c:a", preset.codec, "-b:a", preset.bitrate, "-ar", "44100",
    finalPath,
  ];
  const ffmpegResult = await runProcess("ffmpeg", ffmpegArgs);

  if (ffmpegResult.code !== 0) {
    throw new Error(`ffmpeg gagal mengonversi audio: ${ffmpegResult.stderr.slice(-1500)}`);
  }

  const filename = `${sanitizeTitle(job.data.title) || "audio"}.${preset.ext}`;
  return { finalPath, contentType: "audio/mpeg", filename };
}

async function processVideoJob(job, tmpDir) {
  const { url, formatId, maxHeight } = job.data;
  let { title } = job.data;
  const mergedPath = path.join(tmpDir, "merged.mp4");
  const finalPath = path.join(tmpDir, "final.mp4");

  // Jalur bot tidak kirim title dari muka (biar request awal cepat dibalas).
  // Judul diambil di sini -- di dalam kuota antrean -- bukan di luar antrean.
  if (!title) {
    title = await fetchVideoTitle(url);
  }

  const ytdlpArgs = ["-o", mergedPath, "--no-playlist", "--merge-output-format", "mp4", "--newline"];
  if (formatId) {
    ytdlpArgs.push("-f", `${formatId}+bestaudio/best`);
  } else if (maxHeight) {
    ytdlpArgs.push("-f", buildHeightCappedFormatSelector(maxHeight));
  } else {
    ytdlpArgs.push("-f", "bv*[ext=mp4]+ba[ext=m4a]/best[ext=mp4]/best");
  }
  ytdlpArgs.push(...getCookieArgs());
  ytdlpArgs.push(url);

  const ytdlpResult = await runProcess("yt-dlp", ytdlpArgs, (line) => {
    const percent = parseProgressPercent(line);
    if (percent !== null) job.updateProgress({ status: "downloading", percent });
  });

  if (ytdlpResult.code !== 0) {
    if (looksLikeBotCheck(ytdlpResult.stderr)) {
      notifyCookiesExpired("(worker, saat proses download video)");
    }
    throw new Error(`yt-dlp gagal (video): ${ytdlpResult.stderr.slice(-1500)}`);
  }

  await job.updateProgress({ status: "converting", percent: 99 });

  const ffmpegArgs = ["-y", "-i", mergedPath, "-c", "copy", "-movflags", "+faststart", finalPath];
  const ffmpegResult = await runProcess("ffmpeg", ffmpegArgs);

  if (ffmpegResult.code !== 0) {
    throw new Error(`ffmpeg gagal (faststart): ${ffmpegResult.stderr.slice(-1500)}`);
  }

  const filename = `${sanitizeTitle(title) || "video"}.mp4`;
  return { finalPath, contentType: "video/mp4", filename };
}

// --- Penyimpanan file hasil download, di memori worker ini saja ---
//
// Web Service dan Worker Service adalah container terpisah di Railway (tidak
// share filesystem), jadi kita TIDAK bisa balikin file lewat Web Service.
// Solusinya: worker ini sendiri yang serve file-nya lewat HTTP server kecil
// di bawah (lihat fileServer), dan Web Service cukup kasih tahu bot alamat
// worker (`WORKER_PUBLIC_URL`) buat ambil file itu langsung dari sini.
//
// `finalPath` SENGAJA tidak dikembalikan lewat return value job (yang akan
// tersimpan di Redis & bisa dibaca dari Web Service) -- itu path lokal di
// container worker dan tidak berguna/aman untuk dikirim ke luar. Cukup
// disimpan di Map lokal ini, dan Web Service cuma tahu ada `fileUrl`.
const completedFiles = new Map(); // jobId -> { finalPath, filename, contentType, tmpDir, createdAt }
const FILE_TTL_MS = 30 * 60 * 1000; // file yang tidak diambil bot dalam 30 menit akan dibuang

function cleanupCompletedFile(jobId) {
  const entry = completedFiles.get(jobId);
  if (!entry) return;
  completedFiles.delete(jobId);
  fs.rm(entry.tmpDir, { recursive: true, force: true }).catch(() => {});
}

setInterval(() => {
  const now = Date.now();
  for (const [jobId, entry] of completedFiles) {
    if (now - entry.createdAt > FILE_TTL_MS) {
      console.log(`[worker] file job ${jobId} kedaluwarsa (tidak diambil), dibuang`);
      cleanupCompletedFile(jobId);
    }
  }
}, 5 * 60 * 1000).unref?.();

// --- Fungsi utama yang dipanggil BullMQ untuk setiap job ---
async function handleJob(job) {
  const tmpDir = path.join(os.tmpdir(), `silenceytdl-${job.id}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    await job.updateProgress({ status: "downloading", percent: 0 });

    const result =
      job.data.type === "audio" ? await processAudioJob(job, tmpDir) : await processVideoJob(job, tmpDir);

    await job.updateProgress({ status: "done", percent: 100 });

    // Daftarkan file ke fileServer lokal (lihat definisi di atas) supaya
    // bisa langsung diambil bot lewat GET {WORKER_PUBLIC_URL}/files/{job.id}.
    completedFiles.set(job.id, {
      finalPath: result.finalPath,
      filename: result.filename,
      contentType: result.contentType,
      tmpDir,
      createdAt: Date.now(),
    });

    // Return value ini disimpan BullMQ (Redis) dan dibaca Web Service lewat
    // `job.returnvalue` -- sengaja tidak menyertakan path lokal di sini.
    return {
      contentType: result.contentType,
      filename: result.filename,
    };
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    // Melempar error di sini membuat BullMQ menandai job sebagai "failed"
    // dan event "failed" di bawah akan menangkapnya untuk logging.
    throw err;
  }
}

const worker = new Worker(DOWNLOAD_QUEUE_NAME, handleJob, {
  connection,
  // WAJIB 1: satu job diproses sampai selesai sebelum job berikutnya mulai.
  // Ini yang memastikan pola "1 Queue -> 1 Worker -> 1 Download" dan mencegah
  // beberapa proses yt-dlp menghantam YouTube bersamaan (rate limit / 429).
  concurrency: 1,
});

worker.on("active", (job) => {
  console.log(`[worker] mulai memproses job ${job.id} (${job.data.type}) -> ${job.data.url}`);
});

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} selesai`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id} gagal:`, err?.message || err);
});

worker.on("error", (err) => {
  // Error di level koneksi Redis/worker itu sendiri (bukan error per-job).
  console.error("[worker] error koneksi:", err.message || err);
});

// --- HTTP server kecil khusus buat serve file hasil download ---
//
// Ini SATU-SATUNYA cara bot bisa ambil file-nya, karena file cuma ada di
// container worker ini. Railway inject PORT secara dinamis kalau service ini
// diberi domain publik (aktifkan "Generate Domain" di Settings > Networking
// pada Worker Service), lalu isi env WORKER_PUBLIC_URL di WEB SERVICE dengan
// domain tsb, mis. https://xxxx.up.railway.app (tanpa trailing slash).
//
// Opsional tapi disarankan: set BOT_API_KEY (sama dengan yang dipakai di
// /api/bot/dl) supaya orang lain yang kebetulan tahu/tebak jobId tidak bisa
// ikut mengunduh filenya.
function buildContentDisposition(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  const encodedUtf8 = encodeURIComponent(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`;
}

function isFileRequestAuthorized(req) {
  const expected = process.env.BOT_API_KEY;
  if (!expected) return true; // sama seperti /api/bot/dl: publik kalau tidak diset
  const url = new URL(req.url, "http://localhost");
  const provided =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key");
  return provided === expected;
}

const fileServer = http.createServer(async (req, res) => {
  const match = req.url.match(/^\/files\/([^/?]+)/);

  if (req.method !== "GET" || !match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (!isFileRequestAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const jobId = decodeURIComponent(match[1]);
  const entry = completedFiles.get(jobId);

  if (!entry) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "File tidak ditemukan, sudah diambil, atau sudah kedaluwarsa" }));
    return;
  }

  try {
    const stat = await fs.stat(entry.finalPath);
    res.writeHead(200, {
      "Content-Type": entry.contentType,
      "Content-Length": stat.size,
      "Content-Disposition": buildContentDisposition(entry.filename),
    });
    const stream = createReadStream(entry.finalPath);
    stream.pipe(res);
    stream.on("close", () => cleanupCompletedFile(jobId));
    stream.on("error", (err) => {
      console.error(`[worker] error streaming file job ${jobId}:`, err.message);
      cleanupCompletedFile(jobId);
    });
  } catch (err) {
    console.error(`[worker] gagal baca file job ${jobId}:`, err.message);
    cleanupCompletedFile(jobId);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Gagal membaca file" }));
  }
});

const PORT = process.env.PORT || 8080;
fileServer.listen(PORT, () => {
  console.log(`[worker] file server siap di port ${PORT} (GET /files/:jobId)`);
});

// Railway mengirim SIGTERM saat mau redeploy/restart service. Tutup worker
// dengan rapi supaya job yang sedang berjalan tidak korup di tengah jalan
// (BullMQ akan menandainya "stalled" lalu bisa diambil ulang kalau memungkinkan).
process.on("SIGTERM", async () => {
  console.log("[worker] menerima SIGTERM, menutup worker...");
  await worker.close();
  fileServer.close();
  process.exit(0);
});

console.log(`[worker] siap. Mendengarkan antrean "${DOWNLOAD_QUEUE_NAME}" dengan concurrency 1...`);
