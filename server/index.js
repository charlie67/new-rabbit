import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MEDIAMTX_HOST = process.env.MEDIAMTX_HOST || '127.0.0.1';
const MEDIAMTX_PORT = Number(process.env.MEDIAMTX_PORT || 8889);

const app = express();

// Proxy WHEP signaling (and related WebRTC HTTP routes) to MediaMTX.
// Mounted before express.static so it takes precedence for /live/*.
// In production, Caddy can proxy /live/* directly to MediaMTX and bypass Node.
app.use('/live', (req, res) => {
  const upstream = http.request({
    host: MEDIAMTX_HOST,
    port: MEDIAMTX_PORT,
    method: req.method,
    path: req.originalUrl,
    headers: { ...req.headers, host: `${MEDIAMTX_HOST}:${MEDIAMTX_PORT}` },
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    console.error('WHEP proxy error:', err.message);
    if (!res.headersSent) res.writeHead(502).end('Bad Gateway');
  });
  req.pipe(upstream);
});

app.use(express.static(path.join(__dirname, '..', 'client')));

const server = http.createServer(app);
// Control WebSocket at / — carries JSON messages (mouse, keyboard, navigation, etc.)
const controlWss = new WebSocketServer({ noServer: true });

const room = new Room();

controlWss.on('connection', (ws) => {
  room.addClient(ws);
});

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === '/') {
    controlWss.handleUpgrade(request, socket, head, (ws) => {
      controlWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

async function start() {
  try {
    // Start the HTTP server first so the browser can navigate to a local page
    await new Promise((resolve) => server.listen(PORT, resolve));
    console.log(`Server listening on http://localhost:${PORT}`);

    // Now launch the browser — it needs a real HTTP page for tabCapture
    await room.init(PORT);
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await room.close();
  process.exit(0);
});

start();
