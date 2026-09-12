import { NextResponse } from "next/server";
import crypto from "crypto";
import { createJob, updateJob } from "../_store";
import { enqueueTask } from "../_queue";
import { processAudioJob, processVideoJob } from "../_pipeline";

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

  // Job masuk antrian single-worker: kalau lagi ada proses download lain
  // yang jalan (dari web UI ataupun bot), job ini nunggu sampai gilirannya,
  // bukan langsung jalan paralel.
  const queuePosition = enqueueTask(
    async () => {
      try {
        if (type === "audio") {
          await processAudioJob(jobId, url, quality, title);
        } else {
          await processVideoJob(jobId, url, { formatId, title });
        }
      } catch (err) {
        console.error(err);
        updateJob(jobId, {
          status: "error",
          error: "Terjadi kesalahan saat memproses unduhan",
        });
      }
    },
    {
      label: `web:${jobId}`,
      onQueued: (position) => updateJob(jobId, { status: "queued", percent: 0, queuePosition: position }),
    },
  );

  return NextResponse.json({ jobId, queuePosition });
}
