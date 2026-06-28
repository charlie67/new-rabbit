// Service worker — orchestrates tab capture + WHIP publishing.
//
// Driven by the Node server via Puppeteer's `worker.evaluate(...)`, which calls
// the globals exposed below. MV3 service workers can't hold a MediaStream or an
// RTCPeerConnection, so the actual capture + WebRTC lives in an offscreen
// document (offscreen.html / offscreen.js); this worker just mints the stream id
// and relays start/stop messages to it.

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture the controlled tab and publish it over WebRTC (WHIP).',
  });
}

async function resolveTargetTabId() {
  // Single kiosk window with one real page — the active tab is the controlled
  // page. (id is available without the "tabs" permission; url/title are not.)
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) tabs = await chrome.tabs.query({ active: true });
  if (!tabs.length) tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => t.id != null);
  if (!tab) throw new Error('no capturable tab found');
  return tab.id;
}

// Begin capturing the controlled tab and publish it to MediaMTX at `whipUrl`.
// Returns { ok, resource } from the offscreen document, or throws.
self.startCapture = async ({ whipUrl, width, height, frameRate }) => {
  const targetTabId = await resolveTargetTabId();
  // getMediaStreamId can be called from the service worker without a user
  // gesture as long as targetTabId is specified. The consumer-side
  // getUserMedia prompt is auto-accepted via --auto-accept-this-tab-capture.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
  await ensureOffscreen();
  return await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    whipUrl,
    width,
    height,
    frameRate,
  });
};

self.stopCapture = async () => {
  if (!(await chrome.offscreen.hasDocument())) return { ok: true };
  return await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
};
