// lib/queue.js
//
// Modul bersama (dipakai oleh Web Service DAN Worker Service) untuk:
// 1. Membuka koneksi ke Redis milik Railway.
// 2. Mendefinisikan Queue BullMQ tempat job download disimpan/diantre.
//
// PENTING: file ini di-import oleh dua proses yang berbeda:
//   - app/api/download/route.js (proses Next.js / Web Service) -> cuma nge-`add()` job.
//   - worker.js (proses Node.js terpisah / Worker Service)      -> yang benar-benar
//     mengonsumsi job lewat `Worker`.
// Karena keduanya connect ke Redis yang sama, job yang di-push dari Web Service
// akan otomatis "terlihat" dan diproses oleh Worker Service, meskipun mereka
// jalan di container/replica yang berbeda.

import { Queue } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  throw new Error(
    "REDIS_URL belum diset. Tambahkan Redis service di Railway lalu set env var REDIS_URL di kedua service (Web & Worker).",
  );
}

// BullMQ mewajibkan opsi ini di level koneksi ioredis:
// - maxRetriesPerRequest: null  -> supaya command BullMQ (yang pakai blocking
//   command seperti BRPOPLPUSH) tidak langsung dianggap gagal saat Redis
//   sedang reconnect; biarkan BullMQ sendiri yang mengatur retry.
// - enableReadyCheck: false     -> menghindari race condition saat startup
//   koneksi di beberapa provider Redis terkelola (termasuk Railway).
export const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

connection.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});

// Nama queue dipisah jadi konstanta biar Web Service & Worker Service selalu
// merujuk ke queue yang SAMA persis (typo nama queue = job tidak pernah diambil).
export const DOWNLOAD_QUEUE_NAME = "yt-downloads";

export const downloadQueue = new Queue(DOWNLOAD_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    // Video privat / dihapus / kena bot-check tidak akan membaik walau
    // diulang otomatis -> biarkan gagal sekali lalu laporkan ke user.
    attempts: 1,
    // Beres-beres otomatis biar memori Redis nggak numpuk oleh histori job.
    removeOnComplete: { age: 60 * 60, count: 1000 }, // simpan 1 jam / max 1000 job selesai
    removeOnFail: { age: 24 * 60 * 60 }, // simpan histori gagal 24 jam buat debugging
  },
});
