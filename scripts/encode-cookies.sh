#!/bin/sh
# Ubah beberapa file cookies.txt jadi baris env var siap tempel ke Railway.
#
# Cara pakai:
#   ./scripts/encode-cookies.sh akun1.txt akun2.txt akun3.txt akun4.txt akun5.txt
#
# Output:
#   YT_COOKIES_B64=...      (file pertama)
#   YT_COOKIES_B64_1=...    (file kedua)
#   YT_COOKIES_B64_2=...    (file ketiga) dst.
#
# Tempel ke Variables di Worker Service (dan Web Service kalau /api/info
# juga mau pakai cookies). Setelah menyimpan variable, Railway redeploy
# otomatis.

set -e

if [ $# -eq 0 ]; then
  echo "Pakai: $0 cookies1.txt [cookies2.txt ...]"
  exit 1
fi

i=0
for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "File $f tidak ditemukan." >&2
    exit 1
  fi
  if [ $i -eq 0 ]; then name="YT_COOKIES_B64"; else name="YT_COOKIES_B64_$i"; fi
  printf '%s=%s\n' "$name" "$(base64 < "$f" | tr -d '\n')"
  i=$((i + 1))
done
