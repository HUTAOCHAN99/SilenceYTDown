// lib/queue.js
//
// Modul bersama (dipakai oleh Web Service DAN Worker Service) untuk:
// 1. Membuka koneksi ke Redis milik Railway.
// 2. Mendefinisikan Queue BullMQ tempat job download disimpan/diantre.
//
// PENTING soal timing: file ini di-import oleh route Next.js, dan Next.js
// meng-import (mentrace) semua route API saat `next build` -- BUKAN cuma
// saat runtime. Pada saat build, env var seperti REDIS_URL BELUM ter-inject
// (Railway baru inject env var saat container benar-benar dijalankan, bukan
// saat image di-build). Karena itu koneksi Redis & instance Queue TIDAK BOLEH
// dibuat di level atas module (top-level) -- kalau begitu, `next build` akan
// gagal duluan sebelum sempat deploy.
//
// Solusinya: lazy-init. `connection` dan `downloadQueue` baru benar-benar
// dibuat saat pertama kali dipakai (saat ada request masuk ke /api/download),
// bukan saat file ini di-import.

import { Queue } from "bullmq";
import IORedis from "ioredis";

export const DOWNLOAD_QUEUE_NAME = "yt-downloads";

let _connection = null;
let _downloadQueue = null;

function createConnection() {
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
  const connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  connection.on("error", (err) => {
    console.error("[redis] connection error:", err.message);
  });

  return connection;
}

// Dipanggil oleh worker.js (butuh objek `connection` mentah untuk dipakai di `Worker`).
export function getConnection() {
  if (!_connection) {
    _connection = createConnection();
  }
  return _connection;
}

// Dipanggil oleh app/api/download/route.js.
export function getDownloadQueue() {
  if (!_downloadQueue) {
    _downloadQueue = new Queue(DOWNLOAD_QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        // Video privat / dihapus / kena bot-check tidak akan membaik walau
        // diulang otomatis -> biarkan gagal sekali lalu laporkan ke user.
        attempts: 1,
        // Beres-beres otomatis biar memori Redis nggak numpuk oleh histori job.
        removeOnComplete: { age: 60 * 60, count: 1000 }, // simpan 1 jam / max 1000 job selesai
        removeOnFail: { age: 24 * 60 * 60 }, // simpan histori gagal 24 jam buat debugging
      },
    });
  }
  return _downloadQueue;
}
