#!/bin/bash
set -e

# Start virtual display — Chrome runs non-headless here so it outputs audio
Xvfb :99 -screen 0 1920x1080x24+32 -nolisten tcp &
sleep 1

# Start dbus (PulseAudio may need it)
mkdir -p /run/dbus
dbus-daemon --system --nofork &
sleep 0.5

# Configure PulseAudio for low latency
mkdir -p /etc/pulse
cat > /etc/pulse/daemon.conf <<PULSEEOF
default-fragment-size-msec = 10
default-fragments = 2
PULSEEOF

# Start PulseAudio with TCP socket (avoids Unix socket path issues as root)
pulseaudio \
  --exit-idle-time=-1 \
  --load="module-native-protocol-tcp auth-anonymous=1 port=4713" \
  --disallow-exit \
  --daemonize

sleep 0.5

# Create the virtual audio sink
pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description=Virtual_Speaker
pactl set-default-sink virtual_speaker

# Feed continuous silence so FFmpeg's audio input never blocks
pacat --playback -d virtual_speaker --format=s16le --rate=44100 --channels=2 < /dev/zero &

echo "PulseAudio ready — default sink: virtual_speaker"
pactl list sinks short

# Start MediaMTX (RTSP ingest on 127.0.0.1:8554, WHEP on :8889, WebRTC UDP on :8189)
mediamtx /etc/mediamtx.yml &
sleep 0.5
echo "MediaMTX started"

# Start the Node.js server
exec node server/index.js
