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

    const formats = (info.formats || [])
      .filter((f) => f.vcodec !== "none" && f.ext === "mp4") // video-only atau gabungan, asal mp4
      .map((f) => ({
        format_id: f.format_id,
        quality: f.format_note || f.resolution || "unknown",
        ext: f.ext,
      }))
      // buang duplikat kualitas yang sama
      .filter(
        (f, i, arr) => arr.findIndex((x) => x.quality === f.quality) === i,
      );

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
