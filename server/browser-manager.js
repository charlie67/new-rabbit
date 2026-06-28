import defaultPuppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { addExtra } from 'puppeteer-extra';
import rebrowserPuppeteer from 'rebrowser-puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..', 'extension');
// Deterministic id derived from the manifest "key". Allowlisting this id lets
// the extension use tabCapture without the activeTab invocation gesture.
const EXTENSION_ID = 'kmifelfcngladpfkjblidkebdcocnnjc';

const VIEWPORT = { width: 1920, height: 1080 };
const FRAME_RATE = 30;
// MediaMTX WebRTC server (same one that serves WHEP). The extension publishes
// here over WHIP, in-container, on loopback.
const WHIP_URL = process.env.WHIP_URL || 'http://127.0.0.1:8889/live/whip';

// Windows virtual key codes for special keys (needed by CDP dispatchKeyEvent)
const KEY_CODES = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Insert: 45,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Meta: 91,
  CapsLock: 20,
  ' ': 32,
};

const puppeteer = addExtra(rebrowserPuppeteer);

export class BrowserManager {
  constructor() {
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.worker = null; // extension service worker (drives tab capture + WHIP)
    this.inputQueue = Promise.resolve();

    // Callbacks set by Room
    this.onUrlChange = null;
  }

  async launch(serverPort = 3000) {
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || defaultPuppeteer.executablePath();
    console.log('Launching Chrome from:', execPath);

    this.browser = await puppeteer.launch({
      executablePath: execPath,
      headless: false,
      ignoreDefaultArgs: ['--enable-automation'], // Removes "controlled by automated software" infobar
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu', // no GPU in container — Chrome encodes H.264 in software (OpenH264)
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=AudioServiceSandbox',
        '--disable-blink-features=AutomationControlled',
        '--auto-accept-this-tab-capture', // suppress the tabCapture permission prompt
        `--allowlisted-extension-id=${EXTENSION_ID}`, // bypass activeTab gesture for tabCapture
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--display=:99',
        '--start-maximized',
        '--kiosk',
      ],
      defaultViewport: null, // Let Chrome use natural kiosk viewport — must match X11/FFmpeg coords
      timeout: 60000,
    });

    // Create our working page
    this.page = await this.browser.newPage();
    await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');

    // Close the default blank page (not the extension page or our page)
    const allPages = await this.browser.pages();
    for (const p of allPages) {
      const url = p.url();
      if (p !== this.page && !url.startsWith('chrome-extension://')) {
        await p.close();
      }
    }

    this.cdp = await this.page.createCDPSession();
    console.log("CDP session created", this.cdp ? "success" : "failed");

    // Track URL changes from in-page navigation
    this.page.on('framenavigated', (frame) => {
      try {
        if (frame === this.page.mainFrame() && this.onUrlChange) {
          this.onUrlChange(frame.url());
        }
      } catch {
        // frame may be detached during navigation — ignore
      }
    });

    // Navigate to a real HTTP page (tabCapture can't capture data: or chrome: URLs)
    await this.page.goto(`https://www.google.com/`, {
      waitUntil: 'domcontentloaded',
    });

    await this.page.bringToFront();

    // tabCapture captures only the tab's web-content area (no browser chrome),
    // so the captured frame == the page viewport == CDP input coords (1:1).
    // Sanity-check that the kiosk viewport matches what clients will see.
    const { innerWidth, innerHeight } = await this.page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }));
    if (innerWidth !== VIEWPORT.width || innerHeight !== VIEWPORT.height) {
      console.warn(`Viewport ${innerWidth}x${innerHeight} != expected ${VIEWPORT.width}x${VIEWPORT.height}`);
    }

    await this.startMediaStream();
    console.log('Browser launched, media stream started');
  }

  // Drive the loaded extension to capture the controlled tab and publish it to
  // MediaMTX over WHIP. Replaces the old FFmpeg/x11grab/RTSP pipeline.
  async startMediaStream() {
    const target = await this.browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 30000 }
    );
    this.worker = await target.worker();

    const result = await this.worker.evaluate(
      (args) => self.startCapture(args),
      { whipUrl: WHIP_URL, width: VIEWPORT.width, height: VIEWPORT.height, frameRate: FRAME_RATE }
    );

    if (!result || !result.ok) {
      throw new Error(`tabCapture/WHIP failed: ${result && result.error ? result.error : 'unknown'}`);
    }
    console.log(`tabCapture publishing to ${WHIP_URL} (${result.codec || 'codec?'})`);
  }

  async navigate(url) {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return { success: true, url: this.page.url() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  getCurrentUrl() {
    return this.page ? this.page.url() : 'about:blank';
  }

  async goBack() {
    try {
      await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {}
  }

  async goForward() {
    try {
      await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {}
  }

  // --- Input injection ---

   _enqueue(fn) {
    this.inputQueue = this.inputQueue.then(fn)
      .then((result) => {
        // Log the successful response from CDP (usually an empty object {} if successful)
        // console.log('CDP Event handled successfully:', result);
      })
      .catch((err) => {
        console.error('Input dispatch error:', err.message);
      });
  }

  dispatchMouse(subType, x, y, options = {}) {
    const cdpType = {
      mousedown: 'mousePressed',
      mouseup: 'mouseReleased',
      mousemove: 'mouseMoved',
    }[subType];
    if (!cdpType) return;

    // tabCapture frames == viewport, so client coords map 1:1 to CDP coords.
    const params = {
      type: cdpType,
      x: Math.round(x),
      y: Math.round(y),
      button: options.button || (cdpType === 'mouseMoved' ? 'none' : 'left'),
      clickCount: options.clickCount || (cdpType === 'mousePressed' || cdpType === 'mouseReleased' ? 1 : 0),
      modifiers: options.modifiers || 0,
    };

    // console.log("Sending mouse event:", params);
    this._enqueue(() => this.cdp.send('Input.dispatchMouseEvent', params));
  }

  dispatchWheel(x, y, deltaX, deltaY, modifiers = 0) {
    const params = {
      type: 'mouseWheel',
      x: Math.round(x),
      y: Math.round(y),
      deltaX: deltaX || 0,
      deltaY: deltaY || 0,
      modifiers,
    };
    this._enqueue(() => this.cdp.send('Input.dispatchMouseEvent', params));
  }

  dispatchKey(subType, key, code, options = {}) {
    const cdpType = {
      keydown: 'keyDown',
      keyup: 'keyUp',
    }[subType];
    if (!cdpType) return;

    const keyCode = KEY_CODES[key] || key.charCodeAt(0) || 0;

    const params = {
      type: cdpType,
      key,
      code,
      modifiers: options.modifiers || 0,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    };

    if (cdpType === 'keyDown' && key.length === 1) {
      params.text = key;
    }

    this._enqueue(() => this.cdp.send('Input.dispatchKeyEvent', params));
  }

  async close() {
    if (this.worker) {
      try {
        await this.worker.evaluate(() => self.stopCapture());
      } catch (err) {
        console.warn('stopCapture failed (non-fatal):', err.message);
      }
      this.worker = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
