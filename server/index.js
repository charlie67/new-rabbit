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
const wss = new WebSocketServer({ server });

const room = new Room();

wss.on('connection', (ws) => {
  room.addClient(ws);
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
