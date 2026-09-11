import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { createJob, updateJob } from "../_store";

// Bersihkan judul video jadi nama file yang aman di semua OS
function sanitizeTitle(rawTitle) {
  if (!rawTitle) return "";
  return rawTitle
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

function buildFilename(rawTitle, fallbackBaseName, ext) {
  const clean = sanitizeTitle(rawTitle);
  const base = clean || fallbackBaseName;
  return `${base}.${ext}`;
}

const AUDIO_QUALITY_PRESETS = {
  "m4a-48": { ext: "m4a", codec: "aac", bitrate: "48k", contentType: "audio/mp4" },
  "m4a-128": { ext: "m4a", codec: "aac", bitrate: "128k", contentType: "audio/mp4" },
  "mp3-128": { ext: "mp3", codec: "libmp3lame", bitrate: "128k", contentType: "audio/mpeg" },
};

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

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body request tidak valid" }, { status: 400 });
  }

  const { url, formatId, type = "video", quality = "mp3-128", title = "" } = body || {};

  if (!url) {
    return NextResponse.json({ error: "Link tidak boleh kosong" }, { status: 400 });
  }

  const jobId = crypto.randomUUID();
  createJob(jobId);

  // Sengaja tidak di-await: biar endpoint ini langsung balas jobId ke client,
  // sementara proses download+convert yang berat jalan di background.
  // Client lalu memantau progressnya lewat /api/download/progress/[jobId].
  processJob(jobId, { url, formatId, type, quality, title }).catch((err) => {
    console.error(err);
    updateJob(jobId, {
      status: "error",
      error: "Terjadi kesalahan saat memproses unduhan",
    });
  });

  return NextResponse.json({ jobId });
}

async function processJob(jobId, { url, formatId, type, quality, title }) {
  if (type === "audio") {
    await processAudioJob(jobId, url, quality, title);
  } else {
    await processVideoJob(jobId, url, formatId, title);
  }
}

async function processAudioJob(jobId, url, qualityParam, title) {
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
    url,
  ];

  const ytdlpResult = await runProcess("yt-dlp", ytdlpArgs, (line) =>
    parseYtDlpProgressLine(line, jobId),
  );

  if (ytdlpResult.code !== 0) {
    console.error(`yt-dlp gagal (audio): ${ytdlpResult.stderr}`);
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

async function processVideoJob(jobId, url, formatId, title) {
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
  ];

  if (formatId) {
    ytdlpArgs.push("-f", `${formatId}+bestaudio[ext=m4a]/${formatId}+bestaudio/best`);
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
