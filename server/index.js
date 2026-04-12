import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));

const server = http.createServer(app);
 // Control WebSocket at / — carries JSON messages (mouse, keyboard, navigation, etc.)
const controlWss = new WebSocketServer({ noServer: true });

// Media WebSocket at /media — carries MPEG-TS binary stream
const mediaWss = new WebSocketServer({ noServer: true });

const room = new Room();

controlWss.on('connection', (ws) => {
  room.addClient(ws);
});

mediaWss.on('connection', (ws) => {
  room.addMediaClient(ws);
});

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === '/') {
    controlWss.handleUpgrade(request, socket, head, (ws) => {
      controlWss.emit('connection', ws, request);
    });
  } else if (pathname === '/media') {
    mediaWss.handleUpgrade(request, socket, head, (ws) => {
      mediaWss.emit('connection', ws, request);
    });
  } else {
    // Destroy connections to unknown paths
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
