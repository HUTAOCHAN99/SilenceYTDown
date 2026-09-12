import fs from "fs";

// Simpan di /data (Railway Volume) supaya nggak hilang tiap redeploy.
// Bisa dioverride lewat env var COOKIES_PATH kalau perlu.
export const COOKIES_PATH = process.env.COOKIES_PATH || "/data/cookies.txt";

// Taruh file ini di app/api/download/_cookies.js
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
