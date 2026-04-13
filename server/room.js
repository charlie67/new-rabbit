import crypto from 'crypto';
import { MSG } from './protocol.js';
import { BrowserManager } from './browser-manager.js';

export class Room {
  constructor() {
    this.clients = new Map(); // id -> { id, ws, nickname, isController }
    this.mediaClients = new Set(); // WebSocket connections on /media path
    this.controllerId = null;
    this.browser = new BrowserManager();

    // Buffer MPEG-TS data from last keyframe so new clients can sync immediately
    this.keyframeBuffer = [];
    this.tsBuf = Buffer.alloc(0);

    this.browser.onMedia = (chunk) => this.broadcastMedia(chunk);
    this.browser.onUrlChange = (url) => this.broadcast({
      type: MSG.URL_CHANGED,
      url,
    });
  }

  async init(serverPort) {
    await this.browser.launch(serverPort);
  }

  addClient(ws) {
    const id = crypto.randomUUID();
    const client = { id, ws, nickname: `User-${id.slice(0, 4)}`, isController: false };
    this.clients.set(id, client);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // clients don't send binary
      try {
        const msg = JSON.parse(raw);
        this.handleMessage(id, msg);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => this.removeClient(id));
    ws.on('error', () => this.removeClient(id));

    // Send welcome
    this.send(ws, {
      type: MSG.WELCOME,
      clientId: id,
      users: this.getUserList(),
      controllerId: this.controllerId,
      currentUrl: this.browser.getCurrentUrl(),
    });

    // Notify others
    this.broadcastUserList();
    console.log(`Client ${client.nickname} (${id}) joined. Total: ${this.clients.size}`);
  }

  removeClient(id) {
    const client = this.clients.get(id);
    if (!client) return;

    this.clients.delete(id);

    if (this.controllerId === id) {
      this.controllerId = null;
      this.broadcast({ type: MSG.CONTROL_RELEASED, clientId: id });
    }

    this.broadcastUserList();
    console.log(`Client ${client.nickname} (${id}) left. Total: ${this.clients.size}`);
  }

  handleMessage(clientId, msg) {
    switch (msg.type) {
      case MSG.SET_NICKNAME: {
        const client = this.clients.get(clientId);
        if (client && msg.nickname) {
          client.nickname = String(msg.nickname).slice(0, 20);
          this.broadcastUserList();
        }
        break;
      }

      case MSG.REQUEST_CONTROL: {
        if (this.controllerId && this.controllerId !== clientId) {
          this.send(this.clients.get(clientId)?.ws, {
            type: MSG.ERROR,
            message: 'Someone else has control. Wait for them to release it.',
          });
          return;
        }
        this.controllerId = clientId;
        const client = this.clients.get(clientId);
        if (client) client.isController = true;
        this.broadcast({ type: MSG.CONTROL_GRANTED, clientId });
        this.broadcastUserList();
        break;
      }

      case MSG.RELEASE_CONTROL: {
        if (this.controllerId === clientId) {
          const client = this.clients.get(clientId);
          if (client) client.isController = false;
          this.controllerId = null;
          this.broadcast({ type: MSG.CONTROL_RELEASED, clientId });
          this.broadcastUserList();
        }
        break;
      }

      case MSG.NAVIGATE: {
        if (this.controllerId !== clientId) return;
        this.browser.navigate(msg.url).then((result) => {
          this.broadcast({ type: MSG.NAV_RESULT, ...result });
          if (result.success) {
            this.broadcast({ type: MSG.URL_CHANGED, url: result.url });
          }
        });
        break;
      }

      case MSG.NAV_BACK: {
        if (this.controllerId !== clientId) return;
        this.browser.goBack();
        break;
      }

      case MSG.NAV_FORWARD: {
        if (this.controllerId !== clientId) return;
        this.browser.goForward();
        break;
      }

      case MSG.MOUSE_EVENT: {
        if (this.controllerId !== clientId) return;
        this.browser.dispatchMouse(msg.subType, msg.x, msg.y, {
          button: msg.button,
          clickCount: msg.clickCount,
          modifiers: msg.modifiers,
        });
        break;
      }

      case MSG.WHEEL_EVENT: {
        if (this.controllerId !== clientId) return;
        this.browser.dispatchWheel(msg.x, msg.y, msg.deltaX, msg.deltaY, msg.modifiers);
        break;
      }

      case MSG.KEY_EVENT: {
        if (this.controllerId !== clientId) return;
        this.browser.dispatchKey(msg.subType, msg.key, msg.code, {
          modifiers: msg.modifiers,
        });
        break;
      }
    }
  }

  // --- Broadcasting ---
  broadcast(obj) {
    const message = JSON.stringify(obj);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === 1) {
        client.ws.send(message);
      }
    }
  }

  send(ws, obj) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    }
  }

  getUserList() {
    return [...this.clients.values()].map((c) => ({
      id: c.id,
      nickname: c.nickname,
      isController: c.id === this.controllerId,
    }));
  }

  broadcastUserList() {
    this.broadcast({ type: MSG.USER_LIST, users: this.getUserList() });
  }

  // --- Media WS ---
  addMediaClient(ws) {
    // Send buffered data from last keyframe so client can decode immediately
    for (const buf of this.keyframeBuffer) {
      ws.send(buf);
    }
    this.mediaClients.add(ws);
    console.log(`Media client connected. Total media clients: ${this.mediaClients.size}`);

    ws.on('close', () => {
      this.mediaClients.delete(ws);
      console.log(`Media client disconnected. Total media clients: ${this.mediaClients.size}`);
    });

    ws.on('error', () => {
      this.mediaClients.delete(ws);
    });
  }

  broadcastMedia(chunk) {
    // Parse TS packets to detect keyframes (random_access_indicator)
    this.tsBuf = Buffer.concat([this.tsBuf, chunk]);
    while (this.tsBuf.length >= 188) {
      const sync = this.tsBuf.indexOf(0x47);
      if (sync === -1) { this.tsBuf = Buffer.alloc(0); break; }
      if (sync > 0) this.tsBuf = this.tsBuf.subarray(sync);
      if (this.tsBuf.length < 188) break;

      const hasAdaptation = (this.tsBuf[3] & 0x20) !== 0;
      if (hasAdaptation && this.tsBuf[4] > 0 && (this.tsBuf[5] & 0x40) !== 0) {
        // Random access point — new keyframe, reset buffer
        this.keyframeBuffer = [];
      }
      this.tsBuf = this.tsBuf.subarray(188);
    }

    this.keyframeBuffer.push(chunk);
    // Cap buffer at ~2 seconds of data to prevent memory growth
    while (this.keyframeBuffer.length > 200) this.keyframeBuffer.shift();

    for (const ws of this.mediaClients) {
      if (ws.readyState === 1 && ws.bufferedAmount < 128 * 1024) {
        ws.send(chunk);
      }
    }
  }

  async close() {
    await this.browser.close();
  }
}
