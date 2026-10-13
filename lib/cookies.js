import fs from "fs";
import os from "os";
import path from "path";
import { notifyCookiesExpired, notifyMessage, looksLikeBotCheck, looksLikeCookieProblem } from "./notify.js";

// Simpan di /data (Railway Volume) supaya nggak hilang tiap redeploy.
// Bisa dioverride lewat env var COOKIES_PATH kalau perlu.
// File ini juga dipakai endpoint /api/admin/cookies (upload manual) -- dianggap
// sebagai slot cadangan TERAKHIR di pool.
export const COOKIES_PATH = process.env.COOKIES_PATH || "/data/cookies.txt";

// ---------------------------------------------------------------------------
// COOKIE POOL + ROTASI OTOMATIS
//
// Isi pool diambil dari env var (urutan prioritas):
//   YT_COOKIES_B64, YT_COOKIES_B64_1, YT_COOKIES_B64_2, ... (berapa pun, 1..N)
// Lalu file upload manual di COOKIES_PATH (kalau ada) sebagai cadangan terakhir.
//
// Cara kerja:
//  - Selalu pakai cookie yang terakhir berhasil (sticky), bukan acak, supaya
//    cookie cadangan tetap "segar" sampai benar-benar dibutuhkan.
//  - Kalau yt-dlp kena bot-check / cookies invalid -> slot itu ditandai
//    "habis" (cooldown, default 6 jam), langsung coba slot berikutnya di
//    request yang SAMA (user tidak merasakan error).
//  - Kalau semua slot habis -> kirim notifikasi webhook sekali: saatnya ganti.
//
// Cooldown bisa diatur lewat env COOKIE_COOLDOWN_MINUTES (default 360).
// ---------------------------------------------------------------------------

const COOLDOWN_MS = Math.max(1, Number(process.env.COOKIE_COOLDOWN_MINUTES) || 360) * 60 * 1000;

// State disimpan di globalThis karena Next.js bisa membundel modul ini
// terpisah untuk tiap route -- tanpa ini, tiap route punya "ingatan" sendiri.
function getState() {
  if (!globalThis.__ytCookiePool) {
    globalThis.__ytCookiePool = { initialized: false, slots: [], cursor: 0 };
  }
  return globalThis.__ytCookiePool;
}

function resolvePoolDir() {
  const candidates = [
    process.env.COOKIES_POOL_DIR,
    path.join(path.dirname(COOKIES_PATH), "cookie-pool"),
    path.join(os.tmpdir(), "silenceytdl-cookie-pool"),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // coba kandidat berikutnya
    }
  }
  return null;
}

function listEnvCookieKeys() {
  const found = [];
  for (const [key, value] of Object.entries(process.env)) {
    const m = key.match(/^YT_COOKIES_B64(?:_(\d+))?$/);
    if (!m || !value || !value.trim()) continue;
    found.push({ key, order: m[1] === undefined ? -1 : Number(m[1]) });
  }
  return found.sort((a, b) => a.order - b.order).map((x) => x.key);
}

// Dipanggil otomatis oleh fungsi lain; aman dipanggil berkali-kali.
// worker.js tetap memanggilnya di awal supaya log boot jelas.
export function ensureCookiesFromEnv() {
  const state = getState();
  if (state.initialized) return state.slots.length;
  state.initialized = true;

  const keys = listEnvCookieKeys();
  const dir = keys.length ? resolvePoolDir() : null;

  for (const key of keys) {
    if (!dir) {
      console.error("[cookies] Tidak ada folder yang bisa ditulis untuk pool cookies");
      break;
    }
    try {
      const text = Buffer.from(process.env[key].trim(), "base64").toString("utf8");
      if (!text.includes("youtube.com") && !text.includes("Netscape")) {
        console.error(`[cookies] ${key} diabaikan: hasil decode bukan cookies.txt yang valid`);
        continue;
      }
      const file = path.join(dir, `${key.toLowerCase()}.txt`);
      fs.writeFileSync(file, text, "utf8");
      state.slots.push({ id: key, path: file, deadUntil: 0, lastError: null });
    } catch (err) {
      console.error(`[cookies] Gagal menulis ${key}:`, err);
    }
  }

  // Upload manual lewat /api/admin/cookies = slot cadangan terakhir.
  state.slots.push({ id: "upload", path: COOKIES_PATH, deadUntil: 0, lastError: null, optional: true });

  const real = state.slots.filter((s) => !s.optional).length;
  console.log(`[cookies] Pool siap: ${real} cookies dari env (${keys.join(", ") || "-"}) + slot upload manual`);
  return state.slots.length;
}

function slotUsable(slot) {
  if (slot.optional) {
    try {
      return fs.existsSync(slot.path);
    } catch {
      return false;
    }
  }
  return true;
}

function isAlive(slot, now = Date.now()) {
  return slotUsable(slot) && slot.deadUntil <= now;
}

// Pilih slot: mulai dari cursor (cookie terakhir yang berhasil), cari yang
// masih hidup dan belum dicoba pada request ini.
function pickAliveSlot(excludeIds) {
  const { slots, cursor } = getState();
  const now = Date.now();
  for (let i = 0; i < slots.length; i++) {
    const idx = (cursor + i) % slots.length;
    const slot = slots[idx];
    if (!excludeIds.has(slot.id) && isAlive(slot, now)) return { slot, idx };
  }
  return null;
}

// Semua slot sedang cooldown -> coba slot yang cooldown-nya paling cepat
// selesai (siapa tahu penyebabnya sebenarnya IP/sementara, bukan cookies-nya).
function pickLeastDeadSlot() {
  const { slots } = getState();
  const usable = slots.filter(slotUsable).sort((a, b) => a.deadUntil - b.deadUntil);
  if (!usable.length) return null;
  return { slot: usable[0], idx: slots.indexOf(usable[0]) };
}

function markDead(slot, stderr, context) {
  slot.deadUntil = Date.now() + COOLDOWN_MS;
  slot.lastError = (stderr || "").slice(-300);
  const state = getState();
  const left = state.slots.filter((s) => isAlive(s)).length;
  console.warn(`[cookies] ${slot.id} kena bot-check, di-skip ${Math.round(COOLDOWN_MS / 60000)} menit. Sisa cookies hidup: ${left}`);
  notifyMessage(
    `dead:${slot.id}`,
    `🍪 Cookies ${slot.id} habis/ditolak YouTube. Sisa yang masih hidup: ${left}. ${context}`.trim(),
  );
}

// Bungkus satu eksekusi yt-dlp dengan rotasi cookies.
//
// run(cookieArgs) harus mengembalikan { code, stderr, ... } (jangan throw
// untuk exit code non-zero). Hasil terakhir dikembalikan apa adanya, jadi
// caller tinggal cek result.code seperti biasa.
export async function runWithCookieRotation(run, context = "") {
  ensureCookiesFromEnv();
  const state = getState();

  // Tidak ada cookies sama sekali -> jalan polos, perilaku sama seperti dulu.
  if (!state.slots.some(slotUsable)) {
    const result = await run([]);
    if (result.code !== 0 && looksLikeBotCheck(result.stderr)) notifyCookiesExpired(context);
    return result;
  }

  const tried = new Set();
  let last = null;

  for (;;) {
    let pick = pickAliveSlot(tried);
    if (!pick && tried.size === 0) pick = pickLeastDeadSlot(); // semua cooldown
    if (!pick) break;

    const { slot, idx } = pick;
    tried.add(slot.id);

    const result = await run(["--cookies", slot.path]);
    last = result;

    if (result.code === 0) {
      slot.deadUntil = 0;
      slot.lastError = null;
      state.cursor = idx; // sticky: lanjut pakai yang berhasil ini
      return result;
    }

    if (!looksLikeCookieProblem(result.stderr)) {
      // Gagal karena hal lain (video private, format hilang, jaringan, dll):
      // ganti cookies nggak akan menolong, jadi jangan bakar slot.
      if (looksLikeBotCheck(result.stderr)) notifyCookiesExpired(context); // mis. 429
      return result;
    }

    markDead(slot, result.stderr, context);
    state.cursor = (idx + 1) % state.slots.length;
  }

  notifyMessage(
    "all-dead",
    `🚨 SEMUA cookies YouTube habis (${state.slots.filter(slotUsable).length} slot). Download akan gagal sampai kamu ganti YT_COOKIES_B64*. ${context}`.trim(),
  );
  return last;
}

// Status pool TANPA membocorkan isi cookies -- dipakai GET /api/admin/cookies.
export function getCookiePoolStatus() {
  ensureCookiesFromEnv();
  const now = Date.now();
  return getState()
    .slots.filter(slotUsable)
    .map((s) => ({
      slot: s.id,
      alive: isAlive(s, now),
      retryAt: s.deadUntil > now ? new Date(s.deadUntil).toISOString() : null,
    }));
}

// Kompatibilitas: kembalikan args untuk slot yang sedang aktif (tanpa rotasi).
// Untuk pemakaian baru, gunakan runWithCookieRotation().
export function getCookieArgs() {
  ensureCookiesFromEnv();
  const pick = pickAliveSlot(new Set()) || pickLeastDeadSlot();
  return pick ? ["--cookies", pick.slot.path] : [];
}
