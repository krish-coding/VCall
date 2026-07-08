// Minimal signaling server for WebRTC.
// It does ONE job: relay messages between two clients in the same "room".
// It never touches audio/video — that goes peer-to-peer (or via TURN) once
// the connection is set up. This means the server stays tiny and cheap,
// which matters because it needs to run reliably even if your VPS is modest.

import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 8080;

// rooms: Map<roomId, Set<ws>>
const rooms = new Map();

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Signaling server is running.\n');
});

const wss = new WebSocketServer({ server });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

wss.on('connection', (ws) => {
  let currentRoom = null;

  // Simple heartbeat so we can detect dead connections on flaky networks
  // instead of waiting for a TCP timeout that could take minutes.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // ignore malformed messages
    }

    if (msg.type === 'join') {
      const roomId = msg.room;
      if (!roomId) return;

      currentRoom = roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const peers = rooms.get(roomId);

      if (peers.size >= 2) {
        ws.send(JSON.stringify({ type: 'room-full' }));
        return;
      }

      peers.add(ws);
      log(`peer joined room ${roomId}, size=${peers.size}`);

      // Tell this peer whether they're first (offerer) or second (answerer)
      ws.send(JSON.stringify({
        type: 'joined',
        room: roomId,
        role: peers.size === 1 ? 'offerer' : 'answerer',
      }));

      // If two peers are now present, let both know it's time to start
      if (peers.size === 2) {
        for (const peer of peers) {
          peer.send(JSON.stringify({ type: 'ready' }));
        }
      }
      return;
    }

    // Relay everything else (offer/answer/ice-candidate/bye) to the other
    // peer in the same room.
    if (currentRoom && rooms.has(currentRoom)) {
      for (const peer of rooms.get(currentRoom)) {
        if (peer !== ws && peer.readyState === peer.OPEN) {
          peer.send(JSON.stringify(msg));
        }
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const peers = rooms.get(currentRoom);
      peers.delete(ws);
      // Let the remaining peer know so they can show "reconnecting" instead
      // of silently hanging.
      for (const peer of peers) {
        peer.send(JSON.stringify({ type: 'peer-left' }));
      }
      if (peers.size === 0) rooms.delete(currentRoom);
      log(`peer left room ${currentRoom}`);
    }
  });
});

// Kill dead sockets every 30s (helps a lot on wifi that silently drops
// connections without sending a proper close frame)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  log(`Signaling server listening on port ${PORT}`);
});
