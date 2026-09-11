"use client";

import { useState } from "react";

interface FormatOption {
  format_id: string;
  quality: string;
  ext: string;
}

interface VideoInfo {
  title: string;
  thumbnail: string;
  duration: number;
  formats: FormatOption[];
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCheck = async () => {
    setError("");
    setInfo(null);
    if (!url) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setInfo(data);
      }
    } catch {
      setError("Terjadi kesalahan, coba lagi.");
    }
    setLoading(false);
  };

  const handleDownload = (formatId: string) => {
    // eslint-disable-next-line react-hooks/immutability
    window.location.href = `/api/download?url=${encodeURIComponent(url)}&format_id=${formatId}`;
  };

  return (
    <div style={{ maxWidth: 600, margin: "60px auto", fontFamily: "sans-serif" }}>
      <h1>YouTube Video Downloader</h1>

      <input
        type="text"
        placeholder="Tempel link YouTube di sini..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        style={{ width: "100%", padding: 10, fontSize: 16 }}
      />
      <button onClick={handleCheck} disabled={loading} style={{ marginTop: 10, padding: "10px 20px" }}>
        {loading ? "Memeriksa..." : "Cek Video"}
      </button>

      {error && <p style={{ color: "red" }}>{error}</p>}

      {info && (
        <div style={{ marginTop: 20 }}>
          <img src={info.thumbnail} alt="" style={{ width: "100%", borderRadius: 8 }} />
          <h3>{info.title}</h3>
          <p>Durasi: {Math.floor(info.duration / 60)} menit {info.duration % 60} detik</p>

          <h4>Pilih Kualitas:</h4>
          {info.formats.map((f) => (
            <button
              key={f.format_id}
              onClick={() => handleDownload(f.format_id)}
              style={{ margin: 5, padding: "8px 16px" }}
            >
              {f.quality} ({f.ext})
            </button>
          ))}
        </div>
      )}
    </div>
  );
}