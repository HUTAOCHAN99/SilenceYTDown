#!/bin/sh
# Jalankan ini di komputer kamu sendiri setelah export cookies.txt terbaru
# dari extension "Get cookies.txt LOCALLY" (login dulu ke youtube.com).
#
# Cara pakai:
#   ADMIN_TOKEN=xxxx RAILWAY_URL=https://domain-kamu.up.railway.app ./refresh-cookies.sh cookies.txt

set -e

COOKIES_FILE="${1:-cookies.txt}"

if [ -z "$ADMIN_TOKEN" ]; then
  echo "Set env var ADMIN_TOKEN dulu (sama dengan yang di-set di Railway)."
  exit 1
fi

if [ -z "$RAILWAY_URL" ]; then
  echo "Set env var RAILWAY_URL dulu, contoh: https://xxx.up.railway.app"
  exit 1
fi

if [ ! -f "$COOKIES_FILE" ]; then
  echo "File $COOKIES_FILE tidak ditemukan."
  exit 1
fi

echo "Mengirim $COOKIES_FILE ke $RAILWAY_URL/api/admin/cookies ..."

curl -sf -X POST "$RAILWAY_URL/api/admin/cookies" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  --data-binary "@$COOKIES_FILE"

echo ""
echo "Selesai. Cookies langsung aktif, tanpa perlu redeploy."
