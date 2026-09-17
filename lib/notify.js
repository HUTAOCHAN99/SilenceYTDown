// Taruh file ini di app/api/download/_notify.js
//
// Deteksi pola error yang biasanya muncul kalau YouTube minta verifikasi
// "bukan bot", lalu kirim notifikasi ke webhook (Discord/Slack/Telegram)
// supaya kamu tahu harus refresh cookies.

const BOT_CHECK_PATTERNS = [
  /sign in to confirm/i,
  /not a bot/i,
  /429/,
  /too many requests/i,
];

export function looksLikeBotCheck(stderr = "") {
  return BOT_CHECK_PATTERNS.some((re) => re.test(stderr));
}

let lastNotifyAt = 0;
const NOTIFY_COOLDOWN_MS = 15 * 60 * 1000; // biar nggak spam kalau error beruntun

export async function notifyCookiesExpired(context = "") {
  const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
  if (!webhookUrl) return;

  const now = Date.now();
  if (now - lastNotifyAt < NOTIFY_COOLDOWN_MS) return;
  lastNotifyAt = now;

  // Format ini kompatibel dengan Discord & Slack incoming webhook (field "content"/"text").
  const message = {
    content: `⚠️ yt-dlp kena bot-check YouTube, kemungkinan cookies expired. ${context}`,
    text: `⚠️ yt-dlp kena bot-check YouTube, kemungkinan cookies expired. ${context}`,
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (err) {
    console.error("Gagal kirim notifikasi webhook:", err);
  }
}
