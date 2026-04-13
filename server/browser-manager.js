import defaultPuppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { addExtra } from 'puppeteer-extra';
import rebrowserPuppeteer from 'rebrowser-puppeteer-core';
import { spawn } from 'child_process';

const VIEWPORT = { width: 1920, height: 1080 };

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

    // Offset between X11 screen coords (FFmpeg) and page viewport coords (CDP)
    // Chrome UI (tab bar, etc.) pushes the viewport down from the top of the screen
    this.viewportOffsetX = 0;
    this.viewportOffsetY = 0;
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
        '--disable-gpu',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=AudioServiceSandbox',
        '--disable-blink-features=AutomationControlled',
        '--auto-accept-this-tab-capture',
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

    try {
      // Force X11 to maximize and focus the Chrome window
      execSync(`
        export DISPLAY=:99
        WID=$(xdotool search --onlyvisible --class "google-chrome" | head -1)
        if [ ! -z "$WID" ]; then
          xdotool windowactivate --sync "$WID"
          xdotool windowfocus "$WID"
          echo "Chrome window focused via xdotool"
        fi
      `, { shell: '/bin/bash', timeout: 5000 });
    } catch (err) {
      console.warn('xdotool focus failed (non-fatal):', err.message);
    }

    await new Promise((r) => setTimeout(r, 500));

    // Measure the offset between the X11 screen and the page viewport.
    // FFmpeg captures the full screen, but CDP coordinates are relative to
    // the page viewport (which starts below any Chrome UI like the tab bar).
    const { innerWidth, innerHeight } = await this.page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }));
    this.viewportOffsetY = VIEWPORT.height - innerHeight;
    this.viewportOffsetX = Math.round((VIEWPORT.width - innerWidth) / 2);
    console.log(`Viewport: ${innerWidth}x${innerHeight}, offset: (${this.viewportOffsetX}, ${this.viewportOffsetY})`);

    await this.startMediaStream();
    console.log('Browser launched, media stream started');
  }

  async startMediaStream() {
    const ffmpegArgs = [
      // Low-latency global flags
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-analyzeduration', '0',

      // Video input — x11grab (wallclock timestamps prevent muxer stalls)
      '-use_wallclock_as_timestamps', '1',
      '-thread_queue_size', '512',
      '-f', 'x11grab',
      '-draw_mouse', '0',
      '-probesize', '32',
      '-video_size', '1920x1080',
      '-framerate', '30',
      '-i', ':99.0',

      // Audio input — PulseAudio (wallclock timestamps to stay in sync with video)
      '-use_wallclock_as_timestamps', '1',
      '-thread_queue_size', '512',
      '-f', 'pulse',
      '-probesize', '32',
      '-i', 'default',

      '-vf', 'scale=1280:720',
      '-af', 'aresample=async=1:first_pts=0',  // don't let audio block video

      // Video encoding — H.264 with zero-latency tuning
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '23',
      '-g', '30',
      '-threads', '2',
      '-pix_fmt', 'yuv420p',

      // Audio encoding
      '-c:a', 'aac',
      '-b:a', '128k',

      // MPEG-TS output
      '-f', 'mpegts',
      '-mpegts_flags', '+initial_discontinuity',
      '-muxdelay', '0',
      '-muxpreload', '0',
      '-flush_packets', '1',
      'pipe:1',
    ];

    this.stream = spawn('ffmpeg', ffmpegArgs);

    this.stream.stdout.on('data', (chunk) => {
      if (this.onMedia) this.onMedia(chunk);
    });

    this.stream.stderr.on('data', (data) => {
      // FFmpeg stats go to stderr — uncomment to debug
      console.log(`FFmpeg: ${data}`);
    });

    this.stream.on('close', (code) => {
      console.log(`FFmpeg exited with code ${code}`);
    });
    this.stream.on('error', (err) => {
      console.error("FFmpeg failed to start:", err.message);
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

    // Convert screen coords (from FFmpeg capture) to page viewport coords (for CDP)
    const params = {
      type: cdpType,
      x: Math.round(x) - this.viewportOffsetX,
      y: Math.round(y) - this.viewportOffsetY,
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
      x: Math.round(x) - this.viewportOffsetX,
      y: Math.round(y) - this.viewportOffsetY,
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
