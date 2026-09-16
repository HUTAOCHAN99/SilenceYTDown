// scripts/clear-queue.js
//
// Script buat bersihin antrian BullMQ "yt-downloads" di Redis (dipakai oleh
// SilenceYTDown). Taruh file ini di folder `scripts/` project kamu.
//
// CARA PAKAI:
//
//   1) Jalankan lokal, ambil REDIS_URL dari Railway (tab Variables di service
//      Redis kamu), lalu:
//
//        REDIS_URL="redis://..." node scripts/clear-queue.js
//
//      Ini cuma menghapus job yang masih NUNGGU/ANTRE (waiting + delayed).
//      Job yang lagi diproses saat ini dibiarkan selesai duluan.
//
//   2) Atau kalau mau nuklir total (hapus job aktif, waiting, completed,
//      failed, delayed -- reset queue dari nol):
//
//        REDIS_URL="redis://..." node scripts/clear-queue.js --all
//
//   3) Kalau punya Railway CLI, kamu bisa langsung run ini di environment
//      Railway (nggak perlu copy REDIS_URL manual):
//
//        railway run node scripts/clear-queue.js
//        railway run node scripts/clear-queue.js --all

import { Queue } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error(
    "REDIS_URL belum di-set. Ambil dari Railway -> service Redis kamu -> tab Variables.",
  );
  process.exit(1);
}

const mode = process.argv[2]; // "--all" atau kosong

async function main() {
  const connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const queue = new Queue("yt-downloads", { connection });

  if (mode === "--all") {
    // Hapus TOTAL semua data queue ini di Redis (semua status job + metadata).
    await queue.obliterate({ force: true });
    console.log("✅ Queue 'yt-downloads' sudah dihapus total (obliterate).");
  } else {
    // Default & lebih aman: cuma hapus job yang masih antre, job yang lagi
    // jalan (active) tetap dibiarkan selesai supaya nggak korup file setengah
    // download.
    const waitingJobs = await queue.getJobs(["waiting", "delayed"]);
    for (const job of waitingJobs) {
      await job.remove();
    }
    console.log(`✅ Menghapus ${waitingJobs.length} job yang masih antre (waiting/delayed).`);
    console.log("   (Job yang sedang diproses sekarang dibiarkan jalan sampai selesai.)");
    console.log("   Jalankan dengan flag --all kalau mau bersihin semuanya termasuk job aktif/histori.");
  }

  await queue.close();
  await connection.quit();
}

main().catch((err) => {
  console.error("Gagal membersihkan queue:", err);
  process.exit(1);
});
