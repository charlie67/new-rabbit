import { getStream, wss } from 'puppeteer-stream';
import defaultPuppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { addExtra } from 'puppeteer-extra';
import rebrowserPuppeteer from 'rebrowser-puppeteer-core';

const VIEWPORT = { width: 1920, height: 1080 };

// Opening page must be a real HTTP URL — data: and chrome: URLs can't be captured by tabCapture
const OPENING_PAGE_PATH = '/blank.html';

// Resolve the puppeteer-stream extension path
const require = createRequire(import.meta.url);
const pStreamDir = path.dirname(require.resolve('puppeteer-stream'));
const extensionPath = path.join(pStreamDir, '..', 'extension');
const extensionId = 'jjndjgheafjngoipoacpjgeicjeomjli';

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
    this.stream = null;
    this.inputQueue = Promise.resolve();

    // Callbacks set by Room
    this.onMedia = null;
    this.onUrlChange = null;

    // WebM init segment — cached for late-joining clients
    this.initSegment = null;
  }

  async launch(serverPort = 3000) {
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || defaultPuppeteer.executablePath();
    console.log('Launching Chrome from:', execPath);
    console.log('Extension path:', extensionPath);

    // Launch browser ourselves (not via puppeteer-stream's launch) to avoid
    // pipe:true which breaks in Docker. We load the extension manually.
    this.browser = await puppeteer.launch({
      executablePath: execPath,
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=AudioServiceSandbox',
        '--disable-blink-features=AutomationControlled',
        '--auto-accept-this-tab-capture',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
      defaultViewport: VIEWPORT,
      timeout: 60000,
    });

    console.log('Chrome launched, setting up extension...');

    // Open the extension options page — it connects to puppeteer-stream's internal WS
    const wsPort = (await wss).address().port;
    const extPage = await this.browser.newPage();
    await extPage.goto(`chrome-extension://${extensionId}/options.html#${wsPort}`, {
      waitUntil: 'domcontentloaded',
    });
    console.log(`Extension options page connected on port ${wsPort}`);

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

    // Invoke the extension for the current tab via real X11 keyboard shortcut.
    // CDP keyboard events don't trigger Chrome extension commands, so we use xdotool.
    await this.page.bringToFront();
    try {
      execSync('xdotool key ctrl+shift+y', { timeout: 5000 });
      console.log('Extension invoked via xdotool');
    } catch (err) {
      console.warn('xdotool failed (non-fatal):', err.message);
    }
    await new Promise((r) => setTimeout(r, 500));

    await this.startMediaStream();
    console.log('Browser launched, media stream started');
  }

  async startMediaStream() {
    this.stream = await getStream(this.page, {
      audio: true,
      video: true,
      mimeType: 'video/webm;codecs=vp8,opus',
      frameSize: 10,
      videoBitsPerSecond: 3000000,
      audioBitsPerSecond: 128000,
    });

    // Accumulate initial chunks until we have the full WebM init segment
    // (EBML header + Segment + Info + Tracks, everything before the first Cluster).
    // The Cluster element ID is 0x1F43B675.
    let initParts = [];
    let initDone = false;
    let chunkCount = 0;

    let accumulationBuffer = Buffer.alloc(0);
    const clusterPattern = Buffer.from([0x1F, 0x43, 0xB6, 0x75]);

    this.stream.on('data', (chunk) => {
      console.log(`Received chunk from p-stream: ${chunk.length} bytes at ${Date.now()}`);

      // 1. Add new data to our running buffer
      accumulationBuffer = Buffer.concat([accumulationBuffer, chunk]);
      console.log(`Received chunk from p-stream: ${chunk.length} bytes at ${Date.now()}`);

      // 2. If we haven't found the Init Segment yet, look for the first Cluster
      if (!initDone) {
        const clusterIdx = accumulationBuffer.indexOf(clusterPattern);
        if (clusterIdx > 0) {
          this.initSegment = accumulationBuffer.subarray(0, clusterIdx);
          initDone = true;
          console.log(`Media stream: init segment cached (${this.initSegment.length} bytes)`);
          
          // Remove the init segment from the buffer so only Clusters remain
          accumulationBuffer = accumulationBuffer.subarray(clusterIdx);
        } else if (accumulationBuffer.length > 65536) {
          // Fallback
          this.initSegment = accumulationBuffer;
          initDone = true;
          accumulationBuffer = Buffer.alloc(0); 
        }
        return; // Don't broadcast media until init segment is found
      }

      // 3. For live data, find the Next cluster boundary
      // We start searching at index 1 so we don't just match the cluster we are currently parsing
      let nextClusterIdx = accumulationBuffer.indexOf(clusterPattern, 1);
      
      // Keep pulling out clusters as long as we have complete ones in the buffer
      while (nextClusterIdx !== -1) {
        const completeCluster = accumulationBuffer.subarray(0, nextClusterIdx);
        
        if (this.onMedia) {
          console.log(`Media stream: sending cluster chunk (${completeCluster.length} bytes)`);
          this.onMedia(completeCluster); // Send a guaranteed whole cluster
        }
        
        accumulationBuffer = accumulationBuffer.subarray(nextClusterIdx);
        nextClusterIdx = accumulationBuffer.indexOf(clusterPattern, 1);
      }
    });

    this.stream.on('error', (err) => {
      console.error('Media stream error:', err.message);
    });

    this.stream.on('end', () => {
      console.log('Media stream ended');
    });
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

  // --- Input injection ---

  _enqueue(fn) {
    this.inputQueue = this.inputQueue.then(fn).catch((err) => {
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

    const params = {
      type: cdpType,
      x: Math.round(x),
      y: Math.round(y),
      button: options.button || 'left',
      clickCount: options.clickCount || (cdpType === 'mousePressed' || cdpType === 'mouseReleased' ? 1 : 0),
      modifiers: options.modifiers || 0,
    };

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
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
