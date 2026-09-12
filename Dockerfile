FROM node:20-slim

# yt-dlp butuh python3, dan proses konversi butuh ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp sebagai binary standalone (lebih gampang di-maintain daripada lewat pip)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Railway inject env PORT secara dinamis, jadi start harus ikut itu
CMD sh -c "npx next start -p ${PORT:-3000}"
