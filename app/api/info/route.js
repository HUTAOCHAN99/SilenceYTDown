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

    // HEAD request langsung ke URL CDN video/audio -> ini angka BYTE ASLI
    // dari Content-Length header, jauh lebih akurat daripada filesize_approx
    // atau estimasi dari bitrate. Kalau HEAD gagal (URL expired/diblokir), fallback ke 0.
    const fetchContentLength = async (url, timeoutMs = 6000) => {
      if (!url) return 0;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, {
          method: "HEAD",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const len = res.headers.get("content-length");
        return len ? parseInt(len, 10) : 0;
      } catch {
        return 0;
      }
    };

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

    // Audio yang akan digabung saat vcodec ada tapi acodec none.
    // Karena output selalu mp4, prioritaskan audio m4a/aac (mp4a) -- itu yang
    // sebenarnya dipakai buat gabung ke mp4, bukan asal ambil audio terbesar
    // (dulu bisa salah pilih track opus/webm yang gak dipakai).
    const audioFormats = (info.formats || []).filter(
      (f) => f.vcodec === "none" && f.acodec !== "none",
    );
    const m4aAudioFormats = audioFormats.filter((f) =>
      (f.acodec || "").startsWith("mp4a"),
    );
    const chosenAudio = (
      m4aAudioFormats.length ? m4aAudioFormats : audioFormats
    ).reduce((best, f) => {
      const abr = f.abr || f.tbr || 0;
      const bestAbr = best ? best.abr || best.tbr || 0 : -1;
      return abr > bestAbr ? f : best;
    }, null);

    // Ukuran audio ASLI dari CDN (HEAD), cuma perlu sekali karena audio ini
    // dipakai bareng buat semua format video-only.
    const bestAudioSize = chosenAudio
      ? chosenAudio.filesize ||
        (await fetchContentLength(chosenAudio.url)) ||
        chosenAudio.filesize_approx ||
        0
      : 0;

    // Nama codec yang ramah dibaca, diambil dari prefix vcodec (mis. "avc1.640028" -> "avc1")
    const CODEC_LABELS = {
      avc1: "H.264",
      avc3: "H.264",
      vp9: "VP9",
      vp09: "VP9",
      av01: "AV1",
      hev1: "HEVC",
      hvc1: "HEVC",
    };
    // Urutan prioritas codec saat resolusi & fps sama (paling kompatibel duluan)
    const CODEC_PRIORITY = { "H.264": 0, VP9: 1, AV1: 2, HEVC: 3 };

    const getCodecLabel = (vcodecRaw) => {
      if (!vcodecRaw || vcodecRaw === "none") return null;
      const key = vcodecRaw.split(".")[0];
      return CODEC_LABELS[key] || key.toUpperCase();
    };

    // Kalau filesize & filesize_approx nggak ada, perkirakan dari bitrate rata-rata (tbr) x durasi
    const estimateFromBitrate = (tbrKbps, durationSec) => {
      if (!tbrKbps || !durationSec) return 0;
      return Math.round(((tbrKbps * 1000) / 8) * durationSec);
    };

    const candidateFormats = (info.formats || []).filter(
      (f) => f.vcodec !== "none" && f.ext === "mp4", // video-only atau gabungan, asal mp4
    );

    const formats = (
      await Promise.all(
        candidateFormats.map(async (f) => {
        // Urutan akurasi: filesize asli (pasti) > HEAD Content-Length (byte
        // asli dari CDN) > filesize_approx > estimasi kasar dari bitrate
        const rawSize =
          f.filesize ||
          (await fetchContentLength(f.url)) ||
          f.filesize_approx ||
          estimateFromBitrate(f.tbr, info.duration) ||
          0;
        // Kalau format ini video-only (tanpa audio), ukuran akhir = video + audio terbaik yang akan digabung
        const isVideoOnly = f.acodec === "none";
        const totalBytes = rawSize
          ? rawSize + (isVideoOnly ? bestAudioSize : 0)
          : 0;

        // Bulatkan fps (yt-dlp kadang kasih desimal spt 29.97/59.94)
        const fps = f.fps ? Math.round(f.fps) : null;
        const baseQuality =
          f.format_note || (f.height ? `${f.height}p` : f.resolution || "unknown");
        // Tambahkan label fps kalau belum otomatis ada di format_note (mis. "1080p" -> "1080p 60fps")
        const quality =
          fps && !baseQuality.toString().includes(String(fps))
            ? `${baseQuality} ${fps}fps`
            : baseQuality;

        return {
          format_id: f.format_id,
          quality,
          codec: getCodecLabel(f.vcodec),
          fps,
          height: f.height || null,
          ext: f.ext,
          filesize: totalBytes || null,
          filesize_label: formatBytes(totalBytes) || "Ukuran tidak diketahui",
        };
        }),
      )
    )
      // buang duplikat yang benar-benar identik: kualitas + fps + codec sama persis
      .filter(
        (f, i, arr) =>
          arr.findIndex(
            (x) => x.quality === f.quality && x.fps === f.fps && x.codec === f.codec,
          ) === i,
      )
      // urutkan: resolusi tertinggi dulu, lalu fps tertinggi, lalu codec paling kompatibel duluan
      .sort((a, b) => {
        if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
        if ((b.fps || 0) !== (a.fps || 0)) return (b.fps || 0) - (a.fps || 0);
        const ap = CODEC_PRIORITY[a.codec] ?? 9;
        const bp = CODEC_PRIORITY[b.codec] ?? 9;
        if (ap !== bp) return ap - bp;
        return (b.filesize || 0) - (a.filesize || 0);
      });

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