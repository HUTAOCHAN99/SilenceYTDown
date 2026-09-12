import { NextResponse } from "next/server";
import { getDownloadQueue } from "@/lib/queue";

// Polling biasa (bukan SSE) khusus buat konsumen non-browser kayak bot WA,
// yang biasanya lebih gampang nembak GET tiap beberapa detik daripada
// pasang EventSource.
//
// PENTING: job dari /api/bot/dl disimpan di Redis lewat BullMQ (bukan di
// _store.js in-memory yang dipakai jalur web UI lama) -- jadi endpoint ini
// HARUS baca dari queue yang sama, kalau tidak jobId dari bot tidak akan
// pernah ketemu.
function mapState(state, progress) {
  if (state === "completed") return "done";
  if (state === "failed") return "error";
  if (state === "active") return progress?.status || "downloading";
  // "waiting", "delayed", "paused", "unknown" -> dianggap masih antre
  return "queued";
}

export async function GET(request, { params }) {
  const { jobId } = await params;
  const downloadQueue = getDownloadQueue();
  const job = await downloadQueue.getJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Job tidak ditemukan" }, { status: 404 });
  }

  const state = await job.getState();
  const progress = job.progress && typeof job.progress === "object" ? job.progress : {};

  const payload = {
    jobId,
    status: mapState(state, progress),
    percent: progress.percent ?? (state === "completed" ? 100 : 0),
    queuePosition: null,
    error: state === "failed" ? job.failedReason || "Gagal memproses unduhan" : null,
    done: state === "completed",
  };

  if (state === "waiting" || state === "delayed") {
    // BullMQ tidak punya API langsung "posisi job ke berapa", jadi dihitung
    // manual dari daftar job yang masih menunggu.
    const waitingJobs = await downloadQueue.getJobs(["waiting", "delayed"]);
    const idx = waitingJobs.findIndex((j) => j.id === job.id);
    payload.queuePosition = idx >= 0 ? idx + 1 : null;
  }

  if (state === "completed") {
    const result = job.returnvalue || {};
    payload.filename = result.filename;
    payload.contentType = result.contentType;

    // File hasil download ada di container WORKER, bukan Web Service --
    // jadi bot harus ambil langsung dari sana, bukan dari domain Web Service.
    const workerPublicUrl = process.env.WORKER_PUBLIC_URL;
    if (workerPublicUrl) {
      payload.fileUrl = `${workerPublicUrl.replace(/\/+$/, "")}/files/${jobId}`;
    } else {
      payload.fileUrl = null;
      payload.error =
        "WORKER_PUBLIC_URL belum diset di Web Service, jadi file tidak bisa diarahkan ke Worker Service";
    }
  }

  return NextResponse.json(payload);
}
