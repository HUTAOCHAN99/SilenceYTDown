import { NextResponse } from "next/server";
import { Readable } from "stream";
import { createReadStream } from "fs";
import fs from "fs/promises";
import { getJob, deleteJob } from "../../_store";

// Bangun header Content-Disposition dengan:
// - filename: fallback ASCII-only (buat browser/klien lama)
// - filename*: UTF-8 sesuai RFC 5987 (buat judul dgn emoji/non-latin)
function buildContentDisposition(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  const encodedUtf8 = encodeURIComponent(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`;
}

export async function GET(request, { params }) {
  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job || job.status !== "done" || !job.finalPath) {
    return NextResponse.json(
      { error: "File belum siap atau job tidak ditemukan" },
      { status: 404 },
    );
  }

  const stat = await fs.stat(job.finalPath);
  const nodeStream = createReadStream(job.finalPath);
  const webStream = Readable.toWeb(nodeStream);

  const cleanup = () => {
    if (job.tmpDir) {
      fs.rm(job.tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    deleteJob(jobId);
  };
  nodeStream.on("close", cleanup);
  nodeStream.on("error", cleanup);

  return new NextResponse(webStream, {
    headers: {
      "Content-Disposition": buildContentDisposition(job.filename),
      "Content-Type": job.contentType,
      "Content-Length": String(stat.size),
    },
  });
}
