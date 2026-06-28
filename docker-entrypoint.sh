#!/bin/bash
set -e

# Start virtual display — extensions require headed Chrome, so we run it on Xvfb.
Xvfb :99 -screen 0 1920x1080x24+32 -nolisten tcp &
sleep 1

# Audio rides through chrome.tabCapture now, so no PulseAudio/dbus is needed.

# Start MediaMTX (WHIP ingest + WHEP egress on :8889, WebRTC media on :8189)
mediamtx /etc/mediamtx.yml &
sleep 0.5
echo "MediaMTX started"

# Start the Node.js server
exec node server/index.js
