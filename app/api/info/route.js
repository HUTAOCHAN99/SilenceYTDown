import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");

  if (!url) {
    return NextResponse.json(
      { error: "Link tidak boleh kosong" },
      { status: 400 },
    );
  }

  try {
    const { stdout } = await execFileAsync("yt-dlp", [
      "-J", // dump info sebagai JSON
      "--no-playlist",
      url,
    ]);

    const info = JSON.parse(stdout);

    // yt-dlp punya "filesize" (pasti) atau "filesize_approx" (perkiraan)
    const formatBytes = (bytes) => {
      if (!bytes || bytes <= 0) return null;
      const units = ["B", "KB", "MB", "GB"];
      let value = bytes;
      let unitIndex = 0;
      while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
      }
      return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
    };

    // Perkiraan ukuran audio yang akan digabung (format_id + bestaudio) saat vcodec ada tapi acodec none
    const audioFormats = (info.formats || []).filter(
      (f) => f.vcodec === "none" && f.acodec !== "none",
    );
    const bestAudioSize = audioFormats.reduce((max, f) => {
      const size = f.filesize || f.filesize_approx || 0;
      return size > max ? size : max;
    }, 0);

    const formats = (info.formats || [])
      .filter((f) => f.vcodec !== "none" && f.ext === "mp4") // video-only atau gabungan, asal mp4
      .map((f) => {
        const rawSize = f.filesize || f.filesize_approx || 0;
        // Kalau format ini video-only (tanpa audio), ukuran akhir = video + audio terbaik yang akan digabung
        const isVideoOnly = f.acodec === "none";
        const totalBytes = rawSize
          ? rawSize + (isVideoOnly ? bestAudioSize : 0)
          : 0;

        return {
          format_id: f.format_id,
          quality: f.format_note || f.resolution || "unknown",
          ext: f.ext,
          filesize: totalBytes || null,
          filesize_label: formatBytes(totalBytes) || "Ukuran tidak diketahui",
        };
      })
      // buang duplikat kualitas yang sama
      .filter(
        (f, i, arr) => arr.findIndex((x) => x.quality === f.quality) === i,
      )
      // urutkan dari kualitas terbesar ke terkecil berdasarkan ukuran
      .sort((a, b) => (b.filesize || 0) - (a.filesize || 0));

    return NextResponse.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      formats,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Gagal mengambil info video" },
      { status: 500 },
    );
  }
}
