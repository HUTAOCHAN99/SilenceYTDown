// Antrian FIFO single-worker.
//
// yt-dlp + ffmpeg cukup berat buat CPU/bandwidth kalau container-nya kecil
// (mis. 1 vCPU di Railway). Kalau ada beberapa request nyaris bersamaan --
// entah dari web UI, entah dari bot WA yang nembak /api/bot/dl -- kita nggak
// mau semuanya jalan paralel dan rebutan resource / kena rate-limit YouTube
// bareng-bareng.
//
// Modul ini memastikan HANYA ADA 1 job yang benar-benar diproses (isProcessing)
// dalam satu waktu. Job lain otomatis nunggu di array `queue` sampai job yang
// sedang berjalan selesai (baik sukses maupun gagal), baru worker ambil job
// berikutnya secara berurutan.
//
// PENTING: sama seperti _store.js, ini cuma valid untuk deployment SATU proses
// Node.js. Kalau nanti di-scale ke multi-instance, ganti dengan antrian
// eksternal (mis. BullMQ + Redis) supaya "single worker"-nya tetap global.

const queue = [];
let isProcessing = false;
let currentTaskLabel = null;

// Berapa banyak job yang masih menunggu (tidak termasuk yang sedang diproses).
export function getPendingCount() {
  return queue.length;
}

// Posisi job berikutnya kalau di-enqueue sekarang (1 = langsung diproses,
// 2 = nunggu 1 job di depannya, dst). Berguna buat dikasih tahu ke client
// biar dia tahu kira-kira harus nunggu berapa antrian.
export function getNextQueuePosition() {
  return queue.length + (isProcessing ? 1 : 0) + 1;
}

export function getCurrentTaskLabel() {
  return currentTaskLabel;
}

// task harus berupa async function tanpa argumen (bungkus sendiri argumennya
// pakai closure). onQueued dipanggil sinkron sesaat setelah task masuk
// antrian, berisi posisi antrian saat itu -- berguna buat langsung update
// status job jadi "queued" dengan posisi yang akurat.
export function enqueueTask(task, { label, onQueued } = {}) {
  const position = getNextQueuePosition();
  queue.push({ task, label: label || null });
  onQueued?.(position);
  processNext();
  return position;
}

async function processNext() {
  if (isProcessing) return;
  const next = queue.shift();
  if (!next) return;

  isProcessing = true;
  currentTaskLabel = next.label;
  try {
    await next.task();
  } catch (err) {
    // Task seharusnya menangani error-nya sendiri (update job jadi status
    // "error"), tapi kalau ada yang lolos, jangan sampai bikin worker mati.
    console.error("Task antrian gagal tanpa ditangkap:", err);
  } finally {
    isProcessing = false;
    currentTaskLabel = null;
    // Lanjut ke job berikutnya di antrian, kalau ada.
    processNext();
  }
}
