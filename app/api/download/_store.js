import fs from "fs/promises";

// Penyimpanan job di memori (in-memory), dipakai bareng oleh start/progress/file route.
//
// PENTING: ini cuma jalan benar kalau app-nya jalan sebagai SATU proses Node.js
// (mis. `next start` di satu instance/container). Kalau nanti di-deploy ke
// serverless atau multi-instance (misalnya Vercel functions, beberapa replica di
// belakang load balancer), setiap instance punya memori sendiri-sendiri sehingga
// job yang dibuat di satu instance nggak akan kelihatan di instance lain.
// Untuk kasus itu, ganti Map ini dengan penyimpanan bersama seperti Redis.
const jobs = new Map();

export function createJob(jobId) {
  const job = {
    id: jobId,
    status: "queued", // "queued" | "downloading" | "converting" | "done" | "error"
    percent: 0,
    error: null,
    finalPath: null,
    contentType: null,
    filename: null,
    tmpDir: null,
    queuePosition: null, // posisi di antrian single-worker saat status masih "queued"
    createdAt: Date.now(),
    listeners: new Set(), // kumpulan fungsi callback buat push update SSE
  };
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId);
}

export function deleteJob(jobId) {
  jobs.delete(jobId);
}

// Update state job lalu langsung push ke semua listener SSE yang lagi dengar job ini.
export function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
  for (const send of job.listeners) {
    send(job);
  }
}

// Bersihkan job-job basi (misalnya client putus koneksi sebelum sempat
// download filenya) supaya tmp folder & memori nggak numpuk terus.
const JOB_TTL_MS = 30 * 60 * 1000; // 30 menit
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      if (job.tmpDir) {
        fs.rm(job.tmpDir, { recursive: true, force: true }).catch(() => {});
      }
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref?.();
