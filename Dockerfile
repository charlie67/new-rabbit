FROM node:20-slim

# Install Chromium, Xvfb (virtual display), PulseAudio, and dbus
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

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY server/ server/
COPY client/ client/
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
