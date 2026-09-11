import { getJob } from "../../_store";

export async function GET(request, { params }) {
  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job) {
    return new Response("Job tidak ditemukan", { status: 404 });
  }

  const encoder = new TextEncoder();
  let currentSend;

  const stream = new ReadableStream({
    start(controller) {
      currentSend = (j) => {
        const payload = {
          status: j.status,
          percent: j.percent,
          error: j.error,
        };
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // controller sudah ditutup, abaikan
        }
        if (j.status === "done" || j.status === "error") {
          job.listeners.delete(currentSend);
          try {
            controller.close();
          } catch {}
        }
      };

      job.listeners.add(currentSend);
      // Langsung kirim state job saat ini begitu client konek,
      // biar kalau job sudah selesai duluan sebelum EventSource dibuka,
      // client tetap dapat statusnya.
      currentSend(job);
    },
    cancel() {
      job.listeners.delete(currentSend);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
