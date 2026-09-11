"use client";

import { useState } from "react";

interface FormatOption {
  format_id: string;
  quality: string;
  codec: string | null;
  ext: string;
  filesize: number | null;
  filesize_label: string;
}

interface VideoInfo {
  title: string;
  thumbnail: string;
  duration: number;
  formats: FormatOption[];
}

const AUDIO_QUALITIES = [
  { value: "m4a-48", label: "M4A - (48K)" },
  { value: "m4a-128", label: "M4A - (128K)" },
  { value: "mp3-128", label: "MP3 - (128K)" },
];

function AudioQualityDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected =
    AUDIO_QUALITIES.find((q) => q.value === value) ?? AUDIO_QUALITIES[0];

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px",
          backgroundColor: "#ffffff",
          color: "#171717",
          border: "2px solid #171717",
          borderRadius: open ? "10px 10px 0 0" : 10,
          fontSize: 15,
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        <span>{selected.label}</span>
        <span
          style={{
            fontSize: 11,
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s ease",
          }}
        >
          ▼
        </span>
      </button>

      {open && (
        <>
          {/* Klik di luar untuk menutup dropdown */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 9 }}
          />
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              border: "2px solid #171717",
              borderTop: "1px solid #e5e7eb",
              borderRadius: "0 0 10px 10px",
              overflow: "hidden",
              zIndex: 10,
              backgroundColor: "#ffffff",
              boxShadow: "0 8px 16px rgba(0,0,0,0.15)",
            }}
          >
            {AUDIO_QUALITIES.map((q) => {
              const isSelected = q.value === value;
              return (
                <div
                  key={q.value}
                  onClick={() => {
                    onChange(q.value);
                    setOpen(false);
                  }}
                  style={{
                    padding: "12px 16px",
                    cursor: "pointer",
                    backgroundColor: isSelected ? "#2563eb" : "#ffffff",
                    color: isSelected ? "#ffffff" : "#171717",
                    fontWeight: isSelected ? 600 : 400,
                    fontSize: 15,
                  }}
                >
                  {q.label}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"video" | "audio">("video");
  const [audioQuality, setAudioQuality] = useState("m4a-48");
  const [videoFormatId, setVideoFormatId] = useState("");

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
        setVideoFormatId(data.formats?.[0]?.format_id ?? "");
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

  const handleDownloadAudio = () => {
    // eslint-disable-next-line react-hooks/immutability
    window.location.href = `/api/download?url=${encodeURIComponent(url)}&type=audio&quality=${audioQuality}`;
  };

  const tabButtonStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "10px 16px",
    backgroundColor: active ? "#2563eb" : "#f3f4f6",
    color: active ? "#ffffff" : "#171717",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  });

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
      <button
        onClick={handleCheck}
        disabled={loading}
        style={{
          marginTop: 10,
          padding: "10px 20px",
          backgroundColor: loading ? "#93c5fd" : "#2563eb",
          color: "#ffffff",
          border: "none",
          borderRadius: 6,
          fontSize: 16,
          cursor: loading ? "not-allowed" : "pointer",
        }}
      >
        {loading ? "Memeriksa..." : "Cek Video"}
      </button>

      {error && <p style={{ color: "red" }}>{error}</p>}

      {info && (
        <div style={{ marginTop: 20 }}>
          <img src={info.thumbnail} alt="" style={{ width: "100%", borderRadius: 8 }} />
          <h3>{info.title}</h3>
          <p>Durasi: {Math.floor(info.duration / 60)} menit {info.duration % 60} detik</p>

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              type="button"
              onClick={() => setMode("video")}
              style={tabButtonStyle(mode === "video")}
            >
              Video
            </button>
            <button
              type="button"
              onClick={() => setMode("audio")}
              style={tabButtonStyle(mode === "audio")}
            >
              Audio (MP3)
            </button>
          </div>

          {mode === "video" && (
            <div style={{ marginTop: 16 }}>
              <h4>Pilih Kualitas:</h4>
              <select
                value={videoFormatId}
                onChange={(e) => setVideoFormatId(e.target.value)}
                disabled={info.formats.length === 0}
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  backgroundColor: "#ffffff",
                  color: "#171717",
                  border: "2px solid #171717",
                  borderRadius: 8,
                  fontSize: 15,
                  cursor: info.formats.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                {info.formats.map((f) => (
                  <option
                    key={f.format_id}
                    value={f.format_id}
                  >
                    {f.quality} ({f.ext}
                    {f.codec ? `, ${f.codec}` : ""}) - {f.filesize_label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => handleDownload(videoFormatId)}
                disabled={!videoFormatId}
                style={{
                  marginTop: 12,
                  width: "100%",
                  padding: "12px 16px",
                  backgroundColor: videoFormatId ? "#2563eb" : "#93c5fd",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 16,
                  fontWeight: 600,
                  cursor: videoFormatId ? "pointer" : "not-allowed",
                }}
              >
                Download Video
              </button>
            </div>
          )}

          {mode === "audio" && (
            <div style={{ marginTop: 16 }}>
              <h4>Pilih Kualitas Audio:</h4>
              <AudioQualityDropdown value={audioQuality} onChange={setAudioQuality} />
              <button
                onClick={handleDownloadAudio}
                style={{
                  marginTop: 12,
                  width: "100%",
                  padding: "12px 16px",
                  backgroundColor: "#2563eb",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 16,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Download Audio
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
