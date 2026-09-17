import fs from "fs";
import path from "path";

// Simpan di /data (Railway Volume) supaya nggak hilang tiap redeploy.
// Bisa dioverride lewat env var COOKIES_PATH kalau perlu.
export const COOKIES_PATH = process.env.COOKIES_PATH || "/data/cookies.txt";

// Dipindah ke lib/ (dari app/api/download/_cookies.js) supaya bisa
// di-import oleh worker.js juga -- Dockerfile.worker cuma COPY lib dan
// worker.js, jadi apa pun yang tadinya di app/ tidak pernah masuk ke
// image worker sama sekali.

// Dipanggil SEKALI di awal worker.js (sebelum queue mulai memproses job).
// Worker Service punya volume /data SENDIRI, terpisah dari Web Service --
// jadi cookies yang diupload lewat /api/admin/cookies (yang nulis ke
// /data milik Web Service) TIDAK otomatis kelihatan di sini. Fungsi ini
// mengisi COOKIES_PATH dari env var YT_COOKIES_B64 (isi cookies.txt yang
// di-base64-kan) supaya worker punya salinannya sendiri saat boot.
let _ensured = false;
export function ensureCookiesFromEnv() {
  if (_ensured) return;
  _ensured = true;

  const b64 = process.env.YT_COOKIES_B64;
  if (!b64) return;

  try {
    fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });
    fs.writeFileSync(COOKIES_PATH, Buffer.from(b64, "base64").toString("utf8"), "utf8");
    console.log(`[cookies] Ditulis dari YT_COOKIES_B64 ke ${COOKIES_PATH}`);
  } catch (err) {
    console.error("[cookies] Gagal menulis cookies dari YT_COOKIES_B64:", err);
  }
}

export function getCookieArgs() {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      return ["--cookies", COOKIES_PATH];
    }
  } catch {
    // abaikan, jalan tanpa cookies
  }
  return [];
}
