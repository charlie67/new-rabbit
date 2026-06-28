FROM bluenviron/mediamtx:1 AS mediamtx

FROM node:20-slim

# MediaMTX binary (config comes from our mediamtx.yml, copied below)
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx

# Install Chromium, Xvfb (virtual display), PulseAudio, dbus, ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    xdotool \
    pulseaudio \
    pulseaudio-utils \
    dbus \
    fonts-liberation \
    fonts-noto-color-emoji \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Xvfb display
ENV DISPLAY=:99

# Clear any default PulseAudio config — entrypoint handles setup
RUN mkdir -p /root/.config/pulse && echo "" > /root/.config/pulse/default.pa

ENV PULSE_SERVER=tcp:127.0.0.1:4713

# App setup
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY server/ server/
COPY client/ client/
COPY mediamtx.yml /etc/mediamtx.yml
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

# 3000: Node (HTTP + control WebSocket + WHEP proxy)
# 8889/tcp: MediaMTX WHEP HTTP (for Caddy reverse-proxy target if bypassing Node)
# 8189/udp + 8189/tcp: MediaMTX WebRTC media — MUST be exposed directly (not via
# Caddy). TCP is the fallback transport where UDP can't traverse (e.g. WSL2 NAT).
EXPOSE 3000 8889 8189/udp 8189/tcp

ENTRYPOINT ["./docker-entrypoint.sh"]
