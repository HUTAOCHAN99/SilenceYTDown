import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { Readable } from "stream";
import fs from "fs/promises";
import { createReadStream } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

// Jalankan proses eksternal dan tunggu sampai selesai.
// Resolve dengan { code, stderr }. Tidak reject di exit code != 0
// supaya pemanggil bisa decide sendiri cara handle errornya.
function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      // Misal binary-nya nggak ketemu di PATH
      reject(err);
    });

    proc.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

// Pilihan kualitas audio yang didukung, sesuai dropdown di UI
const AUDIO_QUALITY_PRESETS = {
  "m4a-48": { ext: "m4a", codec: "aac", bitrate: "48k", contentType: "audio/mp4" },
  "m4a-128": { ext: "m4a", codec: "aac", bitrate: "128k", contentType: "audio/mp4" },
  "mp3-128": { ext: "mp3", codec: "libmp3lame", bitrate: "128k", contentType: "audio/mpeg" },
};

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const formatId = searchParams.get("format_id");
  const type = searchParams.get("type") || "video";
  const audioQualityParam = searchParams.get("quality") || "mp3-128";

  if (!url) {
    return NextResponse.json(
      { error: "Link tidak boleh kosong" },
      { status: 400 },
    );
  }

  if (type === "audio") {
    return handleAudioDownload(url, audioQualityParam);
  }

  return handleVideoDownload(url, formatId);
}

async function handleAudioDownload(url, audioQualityParam) {
  const preset = AUDIO_QUALITY_PRESETS[audioQualityParam] || AUDIO_QUALITY_PRESETS["mp3-128"];

  const jobId = crypto.randomUUID();
  const tmpDir = path.join(os.tmpdir(), `silenceytdl-audio-${jobId}`);
  const sourceTemplate = path.join(tmpDir, "source.%(ext)s");
  const finalPath = path.join(tmpDir, `audio.${preset.ext}`);

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    // 1. Unduh stream audio terbaik yang tersedia (ekstensi ditentukan yt-dlp sendiri)
    const ytdlpArgs = [
      "-f", "bestaudio/best",
      "-o", sourceTemplate,
      "--no-playlist",
      url,
    ];

    const ytdlpResult = await runProcess("yt-dlp", ytdlpArgs);

    if (ytdlpResult.code !== 0) {
      console.error(`yt-dlp gagal (audio): ${ytdlpResult.stderr}`);
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return NextResponse.json(
        { error: "Gagal mengunduh audio dari sumbernya" },
        { status: 502 },
      );
    }

    // Cari file hasil download (ekstensi bervariasi: webm, m4a, opus, dll)
    const filesInTmp = await fs.readdir(tmpDir);
    const sourceFile = filesInTmp.find((f) => f.startsWith("source."));

    if (!sourceFile) {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return NextResponse.json(
        { error: "File audio hasil unduhan tidak ditemukan" },
        { status: 500 },
      );
    }

    const sourcePath = path.join(tmpDir, sourceFile);

    // 2. Konversi ke format & bitrate target dengan ffmpeg
    const ffmpegArgs = [
      "-y",
      "-i", sourcePath,
      "-vn",
      "-c:a", preset.codec,
      "-b:a", preset.bitrate,
      "-ar", "44100",
      finalPath,
    ];

    const ffmpegResult = await runProcess("ffmpeg", ffmpegArgs);

    if (ffmpegResult.code !== 0) {
      console.error(`ffmpeg konversi audio gagal: ${ffmpegResult.stderr}`);
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return NextResponse.json(
        { error: "Gagal memproses hasil unduhan audio" },
        { status: 502 },
      );
    }

    // 3. Kirim file audio yang sudah dikonversi
    const stat = await fs.stat(finalPath);
    const nodeStream = createReadStream(finalPath);
    const webStream = Readable.toWeb(nodeStream);

    const cleanup = () => {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    };
    nodeStream.on("close", cleanup);
    nodeStream.on("error", cleanup);

    return new NextResponse(webStream, {
      headers: {
        "Content-Disposition": `attachment; filename="audio.${preset.ext}"`,
        "Content-Type": preset.contentType,
        "Content-Length": String(stat.size),
      },
    });
  } catch (err) {
    console.error(err);
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return NextResponse.json(
      { error: "Terjadi kesalahan saat memproses unduhan audio" },
      { status: 500 },
    );
  }
}

async function handleVideoDownload(url, formatId) {
  // Folder sementara unik per request, biar request paralel nggak tabrakan
  const jobId = crypto.randomUUID();
  const tmpDir = path.join(os.tmpdir(), `silenceytdl-${jobId}`);
  const mergedPath = path.join(tmpDir, "merged.mp4");
  const finalPath = path.join(tmpDir, "final.mp4");

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    // 1. Download + merge video & audio ke file lokal (bukan stdout)
    const ytdlpArgs = [
      "-o", mergedPath,
      "--no-playlist",
      "--merge-output-format", "mp4",
    ];

    if (formatId) {
      ytdlpArgs.push(
        "-f",
        `${formatId}+bestaudio[ext=m4a]/${formatId}+bestaudio/best`,
      );
    } else {
      ytdlpArgs.push("-f", "bv*[ext=mp4]+ba[ext=m4a]/best[ext=mp4]/best");
    }

    ytdlpArgs.push(url);

    const ytdlpResult = await runProcess("yt-dlp", ytdlpArgs);

    if (ytdlpResult.code !== 0) {
      console.error(`yt-dlp gagal: ${ytdlpResult.stderr}`);
      return NextResponse.json(
        { error: "Gagal mengunduh video dari sumbernya" },
        { status: 502 },
      );
    }

    // 2. Rapikan MP4: pindahkan moov atom ke depan file (faststart)
    // -c copy = cuma remux, tanpa re-encode, jadi cepat & kualitas tetap
    const ffmpegArgs = [
      "-y",
      "-i", mergedPath,
      "-c", "copy",
      "-movflags", "+faststart",
      finalPath,
    ];

    const ffmpegResult = await runProcess("ffmpeg", ffmpegArgs);

    if (ffmpegResult.code !== 0) {
      console.error(`ffmpeg faststart gagal: ${ffmpegResult.stderr}`);
      return NextResponse.json(
        { error: "Gagal memproses hasil unduhan" },
        { status: 502 },
      );
    }

    // 3. Kirim file yang sudah utuh & valid, lengkap dengan Content-Length
    const stat = await fs.stat(finalPath);
    const nodeStream = createReadStream(finalPath);
    const webStream = Readable.toWeb(nodeStream);

    // Bersihkan folder sementara setelah stream selesai dikirim (atau gagal di tengah jalan)
    const cleanup = () => {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    };
    nodeStream.on("close", cleanup);
    nodeStream.on("error", cleanup);

    return new NextResponse(webStream, {
      headers: {
        "Content-Disposition": `attachment; filename="video.mp4"`,
        "Content-Type": "video/mp4",
        "Content-Length": String(stat.size),
      },
    });
  } catch (err) {
    console.error(err);
    // Kalau gagal sebelum sempat stream ke user, langsung bersihkan
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return NextResponse.json(
      { error: "Terjadi kesalahan saat memproses unduhan" },
      { status: 500 },
    );
  }
}
