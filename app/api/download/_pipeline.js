import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { updateJob } from "./_store";
import { getCookieArgs } from "./_cookies";
import { looksLikeBotCheck, notifyCookiesExpired } from "./_notify";

// Bersihkan judul video jadi nama file yang aman di semua OS
export function sanitizeTitle(rawTitle) {
  if (!rawTitle) return "";
  return rawTitle
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

export function buildFilename(rawTitle, fallbackBaseName, ext) {
  const clean = sanitizeTitle(rawTitle);
  const base = clean || fallbackBaseName;
  return `${base}.${ext}`;
}

export const AUDIO_QUALITY_PRESETS = {
  "m4a-48": { ext: "m4a", codec: "aac", bitrate: "48k", contentType: "audio/mp4" },
  "m4a-128": { ext: "m4a", codec: "aac", bitrate: "128k", contentType: "audio/mp4" },
  "mp3-128": { ext: "mp3", codec: "libmp3lame", bitrate: "128k", contentType: "audio/mpeg" },
};

// Selector format yt-dlp yang dibatasi tinggi maksimum (mis. 1080p), tapi
// tetap otomatis fallback ke kualitas di bawahnya kalau video itu memang
// nggak punya format setinggi itu ("max 1080, atau yang tersedia").
//
// Urutan percobaan:
// 1) video mp4 <= maxHeight + audio m4a terbaik (hasil gabung paling kompatibel)
// 2) video apapun <= maxHeight + audio terbaik apapun
// 3) stream gabungan (progressive) mp4 <= maxHeight
// 4) stream gabungan apapun <= maxHeight
// 5) "best" tanpa filter -- hanya kepakai kalau video itu sama sekali nggak
//    punya metadata height (kasus sangat jarang), supaya user tetap dapat
//    filenya alih-alih error.
export function buildHeightCappedFormatSelector(maxHeight) {
  return [
    `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]`,
    `bv*[height<=${maxHeight}]+ba`,
    `b[height<=${maxHeight}][ext=mp4]`,
    `b[height<=${maxHeight}]`,
    "best",
  ].join("/");
}

// Jalankan proses eksternal, sambil membaca stdout baris per baris
// (dipakai buat "menangkap" baris progress yt-dlp saat masih berjalan,
// bukan cuma pas proses sudah selesai).
function runProcess(cmd, args, onStdoutLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";
    let buf = "";

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      // yt-dlp biasanya update progress pakai \r (overwrite baris yang sama).
      // Flag --newline yang kita pasang di args bikin dia selalu \n,
      // tapi kita split dua-duanya biar aman.
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (line) onStdoutLine?.(line);
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => resolve({ code, stderr }));
  });
}

// Contoh baris yt-dlp: "[download]  42.5% of ~10.00MiB at 1.20MiB/s ETA 00:08"
function parseYtDlpProgressLine(line, jobId) {
  const match = line.match(/\[download\]\s+(\d{1,3}(?:\.\d+)?)%/);
  if (match) {
    const percent = Math.min(99, parseFloat(match[1]));
    updateJob(jobId, { status: "downloading", percent });
  }
}

// Ambil judul video secara cepat (tanpa download) -- dipakai kalau caller
// (mis. endpoint bot) belum tahu judulnya sebelum mulai proses.
// runProcess di atas tidak mengembalikan stdout gabungan (cuma per-baris lewat
// callback), jadi bikin varian kecil khusus yang butuh output utuh.
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

export async function fetchVideoTitle(url) {
  try {
    const result = await runProcessCollectStdout("yt-dlp", [
      "--no-playlist",
      "--skip-download",
      "--print",
      "%(title)s",
      ...getCookieArgs(),
      url,
    ]);
    if (result.code !== 0) return "";
    return result.stdout?.trim?.() || "";
  } catch {
    return "";
  }
}

export async function processAudioJob(jobId, url, qualityParam, title) {
  const preset = AUDIO_QUALITY_PRESETS[qualityParam] || AUDIO_QUALITY_PRESETS["mp3-128"];
  const tmpDir = path.join(os.tmpdir(), `silenceytdl-audio-${jobId}`);
  const sourceTemplate = path.join(tmpDir, "source.%(ext)s");
  const finalPath = path.join(tmpDir, `audio.${preset.ext}`);

  await fs.mkdir(tmpDir, { recursive: true });
  updateJob(jobId, { tmpDir, status: "downloading", percent: 0 });

  const ytdlpArgs = [
    "-f", "bestaudio/best",
    "-o", sourceTemplate,
    "--no-playlist",
    "--newline", // paksa progress ditulis per baris baru, bukan \r overwrite
    ...getCookieArgs(),
    url,
  ];

  const ytdlpResult = await runProcess("yt-dlp", ytdlpArgs, (line) =>
    parseYtDlpProgressLine(line, jobId),
  );

  if (ytdlpResult.code !== 0) {
    console.error(`yt-dlp gagal (audio): ${ytdlpResult.stderr}`);
    if (looksLikeBotCheck(ytdlpResult.stderr)) {
      notifyCookiesExpired("(saat proses download audio)");
    }
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    updateJob(jobId, { status: "error", error: "Gagal mengunduh audio dari sumbernya" });
    return;
  }

  const filesInTmp = await fs.readdir(tmpDir);
  const sourceFile = filesInTmp.find((f) => f.startsWith("source."));

  if (!sourceFile) {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    updateJob(jobId, { status: "error", error: "File audio hasil unduhan tidak ditemukan" });
    return;
  }

  // Fase konversi (ffmpeg) biasanya cepat untuk audio, jadi cukup ditandai
  // "converting" tanpa persentase granular (UI bisa tampilkan sebagai indeterminate).
  updateJob(jobId, { status: "converting", percent: 99 });

  const sourcePath = path.join(tmpDir, sourceFile);
  const ffmpegArgs = [
    "-y", "-i", sourcePath, "-vn",
    "-c:a", preset.codec, "-b:a", preset.bitrate, "-ar", "44100",
    finalPath,
  ];

  const ffmpegResult = await runProcess("ffmpeg", ffmpegArgs);

  if (ffmpegResult.code !== 0) {
    console.error(`ffmpeg konversi audio gagal: ${ffmpegResult.stderr}`);
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    updateJob(jobId, { status: "error", error: "Gagal memproses hasil unduhan audio" });
    return;
  }

  updateJob(jobId, {
    status: "done",
    percent: 100,
    finalPath,
    contentType: preset.contentType,
    filename: buildFilename(title, "audio", preset.ext),
  });
}

// options:
// - formatId: format_id mentah dari /api/info (dipakai web UI, user milih sendiri)
// - maxHeight: cap tinggi otomatis dgn fallback (dipakai bot, mis. 1080)
// - title: judul video buat nama file akhir
export async function processVideoJob(jobId, url, options = {}) {
  const { formatId, maxHeight, title } = options;
  const tmpDir = path.join(os.tmpdir(), `silenceytdl-${jobId}`);
  const mergedPath = path.join(tmpDir, "merged.mp4");
  const finalPath = path.join(tmpDir, "final.mp4");

  await fs.mkdir(tmpDir, { recursive: true });
  updateJob(jobId, { tmpDir, status: "downloading", percent: 0 });

  const ytdlpArgs = [
    "-o", mergedPath,
    "--no-playlist",
    "--merge-output-format", "mp4",
    "--newline",
    ...getCookieArgs(),
  ];

  if (formatId) {
    ytdlpArgs.push("-f", `${formatId}+bestaudio[ext=m4a]/${formatId}+bestaudio/best`);
  } else if (maxHeight) {
    ytdlpArgs.push("-f", buildHeightCappedFormatSelector(maxHeight));
  } else {
    ytdlpArgs.push("-f", "bv*[ext=mp4]+ba[ext=m4a]/best[ext=mp4]/best");
  }
  ytdlpArgs.push(url);

  // Catatan: yt-dlp mengunduh video lalu audio sebagai dua stream terpisah,
  // jadi persentase ini bisa "reset" turun sekali di tengah jalan (mulai
  // stream audio setelah video selesai). Itu normal, bukan bug.
  const ytdlpResult = await runProcess("yt-dlp", ytdlpArgs, (line) =>
    parseYtDlpProgressLine(line, jobId),
  );

  if (ytdlpResult.code !== 0) {
    console.error(`yt-dlp gagal: ${ytdlpResult.stderr}`);
    if (looksLikeBotCheck(ytdlpResult.stderr)) {
      notifyCookiesExpired("(saat proses download video)");
    }
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    updateJob(jobId, { status: "error", error: "Gagal mengunduh video dari sumbernya" });
    return;
  }

  updateJob(jobId, { status: "converting", percent: 99 });

  const ffmpegArgs = ["-y", "-i", mergedPath, "-c", "copy", "-movflags", "+faststart", finalPath];
  const ffmpegResult = await runProcess("ffmpeg", ffmpegArgs);

  if (ffmpegResult.code !== 0) {
    console.error(`ffmpeg faststart gagal: ${ffmpegResult.stderr}`);
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    updateJob(jobId, { status: "error", error: "Gagal memproses hasil unduhan" });
    return;
  }

  updateJob(jobId, {
    status: "done",
    percent: 100,
    finalPath,
    contentType: "video/mp4",
    filename: buildFilename(title, "video", "mp4"),
  });
}
