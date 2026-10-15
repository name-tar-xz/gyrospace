'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const peers = new Set();
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_LENGTH = 6;
const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

function makeRoomCode() {
  let code;
  do {
    const bytes = crypto.randomBytes(ROOM_LENGTH);
    code = Array.from(bytes, (value) => ROOM_CHARS[value % ROOM_CHARS.length]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_LENGTH);
}

function sendJSON(peer, payload) {
  if (peer && !peer.closed) peer.send(JSON.stringify(payload));
}

function closeRoomLater(room) {
  if (room.expiry) clearTimeout(room.expiry);
  room.expiry = setTimeout(() => {
    if (!room.game && !room.controller && rooms.get(room.code) === room) {
      rooms.delete(room.code);
    }
  }, ROOM_TTL_MS);
  room.expiry.unref?.();
}

function roomFor(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { code, game: null, controller: null, expiry: null };
    rooms.set(code, room);
  }
  if (room.expiry) {
    clearTimeout(room.expiry);
    room.expiry = null;
  }
  return room;
}

function notifyLink(room) {
  sendJSON(room.game, { type: 'controller', connected: Boolean(room.controller) });
  sendJSON(room.controller, { type: 'game', connected: Boolean(room.game) });
}

function removePeer(peer) {
  peers.delete(peer);
  const { room, role } = peer;
  if (!room) return;

  if (role === 'game' && room.game === peer) {
    room.game = null;
    notifyLink(room);
  } else if (role === 'controller' && room.controller === peer) {
    room.controller = null;
    notifyLink(room);
  }

  if (!room.game && !room.controller) closeRoomLater(room);
}

function attachGame(peer, requestedCode) {
  let code = requestedCode;
  let room;

  if (code) {
    room = roomFor(code);
  } else {
    code = makeRoomCode();
    room = roomFor(code);
  }

  // A refresh/reconnect takes over the room's game socket while preserving the code.
  if (room.game && room.game !== peer) room.game.close(1000, 'Game page reconnected');
  peer.role = 'game';
  peer.room = room;
  room.game = peer;

  sendJSON(peer, { type: 'room', code: room.code });
  sendJSON(peer, { type: 'controller', connected: Boolean(room.controller) });
  if (room.controller) {
    sendJSON(room.controller, { type: 'game', connected: true });
  }
}

function attachController(peer, requestedCode) {
  const code = cleanCode(requestedCode);
  const room = rooms.get(code);
  if (!code || code.length !== ROOM_LENGTH || !room) {
    sendJSON(peer, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'That flight code was not found. Check the code and try again.' });
    setTimeout(() => peer.close(1008, 'Room not found'), 250).unref?.();
    return;
  }

  if (room.controller && room.controller !== peer) room.controller.close(1000, 'Controller reconnected');
  peer.role = 'controller';
  peer.room = room;
  room.controller = peer;

  sendJSON(peer, { type: 'joined', room: room.code, gameOnline: Boolean(room.game) });
  notifyLink(room);
}

function handleMessage(peer, text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') return;

  if (message.type === 'latency' && peer.role === 'controller') {
    sendJSON(peer, { type: 'latency', t: message.t });
    return;
  }

  if (message.type === 'hit' && ['asteroid', 'player'].includes(message.target) && peer.role === 'game' && peer.room) {
    sendJSON(peer.room.controller, { type: 'hit', target: message.target });
    return;
  }

  if (message.type !== 'input' || peer.role !== 'controller' || !peer.room) return;
  const now = Date.now();
  if (now - peer.lastInputAt < 10) return;
  peer.lastInputAt = now;

  const x = Number(message.x);
  const throttle = Number(message.throttle);
  const safeX = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
  const safeThrottle = Number.isFinite(throttle) ? Math.max(-1, Math.min(1, throttle)) : 0;
  sendJSON(peer.room.game, {
    type: 'input',
    x: safeX,
    throttle: safeThrottle
  });
}

class WebSocketPeer {
  constructor(socket, head, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.fragmentBytes = 0;
    this.closed = false;
    this.alive = true;
    this.role = null;
    this.room = null;
    this.lastInputAt = 0;

    socket.on('data', (chunk) => this.read(chunk));
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());
    if (head && head.length) this.read(head);
  }

  read(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_MESSAGE_BYTES)) return this.close(1009, 'Message too large');
        payloadLength = Number(longLength);
        offset = 10;
      }

      let mask;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + payloadLength) return;

      let payload = this.buffer.subarray(offset, offset + payloadLength);
      this.buffer = this.buffer.subarray(offset + payloadLength);
      if (masked) {
        const decoded = Buffer.allocUnsafe(payloadLength);
        for (let i = 0; i < payloadLength; i++) decoded[i] = payload[i] ^ mask[i % 4];
        payload = decoded;
      }

      if (opcode === 0x8) {
        if (!this.closed) this.sendFrame(payload, 0x8);
        this.finish();
        this.socket.end();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(payload, 0xA);
        continue;
      }
      if (opcode === 0xA) {
        this.alive = true;
        continue;
      }

      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) return this.close(1002, 'Unexpected continuation frame');
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) return this.close(1009, 'Message too large');
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentOpcode = null;
          this.fragmentBytes = 0;
          this.onMessage(full.toString('utf8'));
        }
        continue;
      }
      if (opcode === 0x2) return this.close(1003, 'Text messages only');
      if (opcode === 0x1) {
        if (this.fragmentOpcode !== null) return this.close(1002, 'Unexpected data frame');
        if (fin) {
          this.onMessage(payload.toString('utf8'));
        } else {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
          this.fragmentBytes = payload.length;
        }
        continue;
      }
      return this.close(1002, 'Unsupported frame opcode');
    }
  }

  send(text) {
    this.sendFrame(Buffer.from(String(text)), 0x1);
  }

  ping() {
    this.sendFrame(Buffer.alloc(0), 0x9);
  }

  sendFrame(payload, opcode) {
    if (this.closed || this.socket.destroyed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(payload.length ? Buffer.concat([header, payload]) : header);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(String(reason)).subarray(0, 120);
    const body = Buffer.allocUnsafe(2 + reasonBuffer.length);
    body.writeUInt16BE(code, 0);
    reasonBuffer.copy(body, 2);
    this.sendFrame(body, 0x8);
    this.finish();
    this.socket.end();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function getLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : (entry.family === 4 ? 'IPv4' : 'IPv6');
      if (family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      addresses.push(entry.address);
    }
  }
  addresses.sort((a, b) => {
    const rank = (value) => value.startsWith('192.168.') ? 0 : value.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(value) ? 2 : 3;
    return rank(a) - rank(b);
  });
  return addresses;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, port: PORT, lanAddresses: getLanAddresses() }));
    return;
  }

  let requested = decodeURIComponent(url.pathname);
  if (requested === '/') requested = '/index.html';
  const normalized = path.normalize(requested).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n'));

  const peer = new WebSocketPeer(socket, head, (text) => handleMessage(peer, text), removePeer);
  peers.add(peer);
  const role = url.searchParams.get('role');
  if (role === 'game') attachGame(peer, cleanCode(url.searchParams.get('room')));
  else if (role === 'controller') attachController(peer, url.searchParams.get('room'));
  else {
    sendJSON(peer, { type: 'error', code: 'BAD_ROLE', message: 'Choose a game or controller connection.' });
    setTimeout(() => peer.close(1008, 'Bad role'), 100).unref?.();
  }
});

const heartbeat = setInterval(() => {
  for (const peer of peers) {
    if (peer.closed) continue;
    if (!peer.alive) {
      peer.close(1001, 'Heartbeat timeout');
    } else {
      peer.alive = false;
      peer.ping();
    }
  }
}, 25000);
heartbeat.unref?.();

server.listen(PORT, HOST, () => {
  console.log(`STARLANE Motion Arcade listening at http://${HOST}:${PORT}`);
});

process.on('SIGTERM', () => {
  clearInterval(heartbeat);
  for (const peer of peers) peer.close(1001, 'Server stopping');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  clearInterval(heartbeat);
  for (const peer of peers) peer.close(1001, 'Server stopping');
  server.close(() => process.exit(0));
});
