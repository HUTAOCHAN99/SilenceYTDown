import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { Readable } from "stream";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const formatId = searchParams.get("format_id");

  if (!url) {
    return NextResponse.json({ error: "Link tidak boleh kosong" }, { status: 400 });
  }

  const args = [
    "-o", "-", // output ke stdout
    "--no-playlist",
  ];

  if (formatId) {
  args.push("-f", `${formatId}+bestaudio/best`);
} else {
  args.push("-f", "best");
}

  args.push(url);

  const ytdlp = spawn("yt-dlp", args);

  // Tangani error proses tanpa crash server
  ytdlp.stderr.on("data", (data) => {
    console.error(`yt-dlp stderr: ${data}`);
  });

  const webStream = Readable.toWeb(ytdlp.stdout);

  return new NextResponse(webStream, {
    headers: {
      "Content-Disposition": `attachment; filename="video.mp4"`,
      "Content-Type": "video/mp4",
    },
  });
}