import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { COOKIES_PATH } from "../../download/_cookies";

// Taruh file ini di app/api/admin/cookies/route.js
//
// Cara pakai:
//   curl -X POST https://domain-kamu.up.railway.app/api/admin/cookies \
//     -H "x-admin-token: ISI_ADMIN_TOKEN_KAMU" \
//     --data-binary @cookies.txt
//
// Endpoint ini nulis langsung ke volume /data, jadi efeknya instan
// tanpa perlu redeploy container.

export async function POST(request) {
  const token = request.headers.get("x-admin-token");

  if (!process.env.ADMIN_TOKEN) {
    return NextResponse.json(
      { error: "ADMIN_TOKEN belum di-set di server, endpoint ini dinonaktifkan" },
      { status: 503 },
    );
  }

  if (!token || token !== process.env.ADMIN_TOKEN) {
    return NextResponse.json({ error: "Token tidak valid" }, { status: 401 });
  }

  const body = await request.text();

  if (!body || !body.includes("youtube.com")) {
    return NextResponse.json(
      { error: "Isi body kosong atau bukan cookies.txt yang valid" },
      { status: 400 },
    );
  }

  await fs.mkdir(path.dirname(COOKIES_PATH), { recursive: true });
  await fs.writeFile(COOKIES_PATH, body, "utf8");

  return NextResponse.json({ ok: true, path: COOKIES_PATH, updatedAt: new Date().toISOString() });
}

// GET buat ngecek status tanpa expose isi cookies-nya
export async function GET(request) {
  const token = request.headers.get("x-admin-token");
  if (!process.env.ADMIN_TOKEN || !token || token !== process.env.ADMIN_TOKEN) {
    return NextResponse.json({ error: "Token tidak valid" }, { status: 401 });
  }

  try {
    const stat = await fs.stat(COOKIES_PATH);
    return NextResponse.json({ exists: true, lastModified: stat.mtime });
  } catch {
    return NextResponse.json({ exists: false });
  }
}
