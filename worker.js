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
import fs from "fs/promises";
import os from "os";
import path from "path";
import { connection, DOWNLOAD_QUEUE_NAME } from "./lib/queue.js";

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

async function processAudioJob(job, tmpDir) {
  const { url, quality } = job.data;
  const preset = AUDIO_QUALITY_PRESETS[quality] || AUDIO_QUALITY_PRESETS["mp3-128"];
  const sourceTemplate = path.join(tmpDir, "source.%(ext)s");
  const finalPath = path.join(tmpDir, `audio.${preset.ext}`);

  const ytdlpArgs = ["-f", "bestaudio/best", "-o", sourceTemplate, "--no-playlist", "--newline", url];

  const ytdlpResult = await runProcess("yt-dlp", ytdlpArgs, (line) => {
    const percent = parseProgressPercent(line);
    if (percent !== null) job.updateProgress({ status: "downloading", percent });
  });

  if (ytdlpResult.code !== 0) {
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
  const { url, formatId } = job.data;
  const mergedPath = path.join(tmpDir, "merged.mp4");
  const finalPath = path.join(tmpDir, "final.mp4");

  const ytdlpArgs = ["-o", mergedPath, "--no-playlist", "--merge-output-format", "mp4", "--newline"];
  ytdlpArgs.push("-f", formatId ? `${formatId}+bestaudio/best` : "bv*[ext=mp4]+ba[ext=m4a]/best[ext=mp4]/best");
  ytdlpArgs.push(url);

  const ytdlpResult = await runProcess("yt-dlp", ytdlpArgs, (line) => {
    const percent = parseProgressPercent(line);
    if (percent !== null) job.updateProgress({ status: "downloading", percent });
  });

  if (ytdlpResult.code !== 0) {
    throw new Error(`yt-dlp gagal (video): ${ytdlpResult.stderr.slice(-1500)}`);
  }

  await job.updateProgress({ status: "converting", percent: 99 });

  const ffmpegArgs = ["-y", "-i", mergedPath, "-c", "copy", "-movflags", "+faststart", finalPath];
  const ffmpegResult = await runProcess("ffmpeg", ffmpegArgs);

  if (ffmpegResult.code !== 0) {
    throw new Error(`ffmpeg gagal (faststart): ${ffmpegResult.stderr.slice(-1500)}`);
  }

  const filename = `${sanitizeTitle(job.data.title) || "video"}.mp4`;
  return { finalPath, contentType: "video/mp4", filename };
}

// --- Fungsi utama yang dipanggil BullMQ untuk setiap job ---
async function handleJob(job) {
  const tmpDir = path.join(os.tmpdir(), `silenceytdl-${job.id}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    await job.updateProgress({ status: "downloading", percent: 0 });

    const result =
      job.data.type === "audio" ? await processAudioJob(job, tmpDir) : await processVideoJob(job, tmpDir);

    await job.updateProgress({ status: "done", percent: 100 });

    // CATATAN: file hasil download saat ini ada di `result.finalPath`, di
    // dalam CONTAINER WORKER — bukan container Web Service. Karena keduanya
    // adalah service terpisah di Railway, mereka TIDAK berbagi filesystem.
    // Sesuaikan bagian ini dengan strategi penyimpanan project-mu, misalnya:
    //   1. Upload finalPath ke object storage (S3/R2/Cloudinary) lalu simpan
    //      URL-nya sebagai returnvalue job, ATAU
    //   2. Serve file langsung dari Worker Service lewat HTTP server kecil
    //      yang berjalan di worker.js (butuh expose port worker di Railway).
    // Return value job disimpan BullMQ dan bisa dibaca dari sisi Web Service
    // lewat `job.returnvalue` setelah job selesai.
    return {
      contentType: result.contentType,
      filename: result.filename,
      // path ini HANYA valid di dalam container worker, jangan dikirim ke user secara mentah
      tmpDir,
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

// Railway mengirim SIGTERM saat mau redeploy/restart service. Tutup worker
// dengan rapi supaya job yang sedang berjalan tidak korup di tengah jalan
// (BullMQ akan menandainya "stalled" lalu bisa diambil ulang kalau memungkinkan).
process.on("SIGTERM", async () => {
  console.log("[worker] menerima SIGTERM, menutup worker...");
  await worker.close();
  process.exit(0);
});

console.log(`[worker] siap. Mendengarkan antrean "${DOWNLOAD_QUEUE_NAME}" dengan concurrency 1...`);
