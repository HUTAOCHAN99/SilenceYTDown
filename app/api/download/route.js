// app/api/download/route.js
//
// Endpoint yang dipanggil user (lewat web UI atau bot) untuk MEMULAI proses
// download. Handler ini SENGAJA tidak menunggu yt-dlp selesai — dia cuma
// memasukkan job ke Redis Queue (BullMQ) lalu langsung balas jobId ke client.
// Eksekusi yt-dlp yang sesungguhnya terjadi di proses lain (Worker Service),
// lihat worker.js.
//
// Kenapa dipisah begitu? Karena request HTTP di Next.js (dan kebanyakan
// platform hosting) punya batas waktu, sedangkan download+convert video bisa
// makan waktu lama. Dengan pola queue, Web Service tetap responsif walau
// ada banyak user yang minta download bersamaan — mereka semua cuma antre di
// Redis, diproses satu-satu oleh Worker (concurrency: 1) supaya tidak kena
// rate limit (429) dari YouTube.

import { NextResponse } from "next/server";
import { downloadQueue } from "@/lib/queue";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body request tidak valid" }, { status: 400 });
  }

  const { url, type = "video", quality = "mp3-128", formatId = null, title = "" } = body || {};

  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Link tidak boleh kosong" }, { status: 400 });
  }

  try {
    // job.id akan jadi identitas unik yang dipakai lagi nanti untuk
    // mengecek status/progress lewat endpoint terpisah (mis. GET /api/download/[jobId]).
    const job = await downloadQueue.add("download", {
      url,
      type, // "video" | "audio"
      quality, // dipakai kalau type === "audio", lihat AUDIO_QUALITY_PRESETS
      formatId, // opsional, format_id spesifik dari yt-dlp (dipilih manual di web UI)
      title, // opsional, buat penamaan file akhir
    });

    // Jumlah job yang masih menunggu di depan job ini (sekadar info buat UI,
    // tidak 100% presisi kalau ada job baru masuk tepat setelah query ini).
    const queuePosition = await downloadQueue.getWaitingCount();

    return NextResponse.json({
      jobId: job.id,
      status: "queued",
      queuePosition,
    });
  } catch (err) {
    console.error("Gagal menambahkan job ke queue:", err);
    return NextResponse.json(
      { error: "Gagal memproses permintaan, coba lagi sebentar lagi" },
      { status: 500 },
    );
  }
}
