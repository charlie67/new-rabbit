// Offscreen document — holds the captured MediaStream and the publishing
// RTCPeerConnection. Receives start/stop from the background service worker.

let pc = null;
let stream = null;
let whipUrl = null;
let resourceUrl = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'start') {
    start(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }
  if (msg.type === 'stop') {
    stop().then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function start({ streamId, whipUrl: url, width, height, frameRate }) {
  // Tear down any previous session first.
  await stop();
  whipUrl = url;

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: width,
        maxHeight: height,
        maxFrameRate: frameRate,
      },
    },
  });

  // No STUN: publisher and MediaMTX are both on container loopback, so host
  // candidates are enough → trivial ICE, lowest latency.
  pc = new RTCPeerConnection();
  for (const track of stream.getTracks()) pc.addTrack(track, stream);

  // Force H.264 end-to-end so a future GPU encoder is a flag flip, not a
  // renegotiation. The WHEP clients accept whatever MediaMTX forwards.
  const videoTransceiver = pc
    .getTransceivers()
    .find((t) => t.sender && t.sender.track && t.sender.track.kind === 'video');
  if (videoTransceiver && videoTransceiver.setCodecPreferences) {
    const caps = RTCRtpSender.getCapabilities('video');
    const h264 = (caps?.codecs || []).filter(
      (c) => c.mimeType.toLowerCase() === 'video/h264'
    );
    if (h264.length) {
      try {
        videoTransceiver.setCodecPreferences(h264);
      } catch (e) {
        console.warn('setCodecPreferences(H264) failed:', e.message);
      }
    }
  }

  pc.addEventListener('connectionstatechange', () => {
    console.log('WHIP pc state:', pc.connectionState);
  });

  await pc.setLocalDescription(await pc.createOffer());
  await waitForIceGathering(pc, 1000);

  const resp = await fetch(whipUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription.sdp,
  });
  if (!resp.ok) throw new Error(`WHIP POST failed: ${resp.status} ${resp.statusText}`);

  const location = resp.headers.get('Location');
  if (location) resourceUrl = new URL(location, whipUrl).href;

  const answerSdp = await resp.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  return { ok: true, resource: resourceUrl, codec: 'H264' };
}

async function stop() {
  if (resourceUrl) {
    try {
      await fetch(resourceUrl, { method: 'DELETE' });
    } catch {
      // resource may already be gone — ignore
    }
  }
  if (pc) {
    try { pc.close(); } catch {}
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
  pc = null;
  stream = null;
  resourceUrl = null;
}

function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}
