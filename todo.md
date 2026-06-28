2. Use something instead of puppeeter
    * undetected-chromedriver
        * promosing but last updated 9 months ago
    * playwright
        * might have issues - similar to puppeeter
4. Skip FFmpeg entirely. Load a Chrome extension in the Puppeteer browser that calls chrome.tabCapture.capture() → the extension opens an RTCPeerConnection directly to MediaMTX via WHIP. Chrome's compositor hands you a MediaStream with
  hardware-accelerated H.264 already, no x11grab, no libx264. This is how commercial remote-browser products (browserless, hyperbeam) get sub-100ms.
