#!/bin/bash
set -e

# Start virtual display — Chrome runs non-headless here so it outputs audio
Xvfb :99 -screen 0 1920x1080x24+32 -nolisten tcp &
sleep 1

# Start dbus (PulseAudio may need it)
mkdir -p /run/dbus
dbus-daemon --system --nofork &
sleep 0.5

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

echo "PulseAudio ready — default sink: virtual_speaker"
pactl list sinks short

# Start the Node.js server
exec node server/index.js
