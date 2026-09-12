import { NextResponse } from "next/server";
import { getJob } from "../../../download/_store";

// Polling biasa (bukan SSE) khusus buat konsumen non-browser kayak bot WA,
// yang biasanya lebih gampang nembak GET tiap beberapa detik daripada
// pasang EventSource. Job & tmp file TIDAK dihapus di sini -- baru dihapus
// saat file-nya benar-benar diambil lewat /api/download/file/[jobId], atau
// kena TTL basi di _store.js.
export async function GET(request, { params }) {
  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Job tidak ditemukan" }, { status: 404 });
  }

  const payload = {
    jobId,
    status: job.status, // "queued" | "downloading" | "converting" | "done" | "error"
    percent: job.percent,
    queuePosition: job.status === "queued" ? job.queuePosition : null,
    error: job.error,
    done: job.status === "done",
  };

  if (job.status === "done") {
    payload.filename = job.filename;
    payload.contentType = job.contentType;
    payload.fileUrl = `/api/download/file/${jobId}`;
  }

  return NextResponse.json(payload);
}
