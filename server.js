const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, 'public', urlPath);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// WebSocket server — signaling + fallback relay
const wss = new WebSocketServer({ server });

let clientId = 0;
let controller = null;
const displays = new Map(); // id -> ws

// Shared state for initial sync
let state = {
  text: '',
  playing: false,
  speed: 50,
  position: 0,
  fontSize: 52,
  textPadding: 10,
  lineHeight: 1.35,
  lastUpdate: Date.now(),
  displayW: 0,
  displayH: 0
};

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastAll(msg, excludeWs) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === 1) client.send(data);
  });
}

wss.on('connection', (ws) => {
  const id = ++clientId;
  ws._id = id;
  ws._role = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // ── Role registration ──
      case 'join':
        ws._role = msg.role;
        if (msg.role === 'controller') {
          controller = ws;
          // Tell controller about existing displays so it can create peer connections
          displays.forEach((dws, did) => {
            sendTo(ws, { type: 'display-joined', displayId: did });
            if (dws._displayW) {
              sendTo(ws, { type: 'displayDimensions', displayW: dws._displayW, displayH: dws._displayH });
            }
          });
        } else {
          displays.set(id, ws);
          if (msg.displayW && msg.displayH) {
            ws._displayW = msg.displayW;
            ws._displayH = msg.displayH;
            state.displayW = msg.displayW;
            state.displayH = msg.displayH;
          }
          // Tell controller a new display joined
          sendTo(controller, { type: 'display-joined', displayId: id });
          if (msg.displayW) {
            sendTo(controller, { type: 'displayDimensions', displayW: msg.displayW, displayH: msg.displayH });
          }
        }
        // Send current state for initial sync
        sendTo(ws, { type: 'state', ...state });
        break;

      // ── WebRTC signaling ──
      case 'rtc-offer': {
        const target = displays.get(msg.targetId);
        sendTo(target, { type: 'rtc-offer', offer: msg.offer, fromId: id });
        break;
      }
      case 'rtc-answer': {
        sendTo(controller, { type: 'rtc-answer', answer: msg.answer, fromId: id });
        break;
      }
      case 'rtc-ice': {
        if (ws._role === 'controller') {
          const target = displays.get(msg.targetId);
          sendTo(target, { type: 'rtc-ice', candidate: msg.candidate, fromId: id });
        } else {
          sendTo(controller, { type: 'rtc-ice', candidate: msg.candidate, fromId: id });
        }
        break;
      }

      // ── Fallback relay (used when WebRTC not yet established or fails) ──
      case 'relay':
        // Controller sends relay messages that go to all displays via WS
        broadcastAll(msg.payload ? { ...msg.payload } : msg, ws);
        break;

      case 'setText':
        state.text = msg.text;
        state.position = 0;
        state.playing = false;
        broadcastAll({ type: 'state', ...state }, ws);
        break;
      case 'play':
        state.playing = true;
        state.lastUpdate = Date.now();
        state.position = msg.position != null ? msg.position : state.position;
        broadcastAll({ type: 'play', position: state.position, speed: state.speed, lastUpdate: state.lastUpdate }, ws);
        break;
      case 'pause':
        state.playing = false;
        state.position = msg.position != null ? msg.position : state.position;
        broadcastAll({ type: 'pause', position: state.position }, ws);
        break;
      case 'seek':
        state.position = msg.position;
        state.lastUpdate = Date.now();
        broadcastAll({ type: 'seek', position: state.position, playing: state.playing, lastUpdate: state.lastUpdate }, ws);
        break;
      case 'speed':
        state.speed = msg.speed;
        state.lastUpdate = Date.now();
        if (state.playing) state.position = msg.position != null ? msg.position : state.position;
        broadcastAll({ type: 'speed', speed: state.speed, position: state.position, playing: state.playing, lastUpdate: state.lastUpdate }, ws);
        break;
      case 'fontSize':
        state.fontSize = msg.fontSize;
        broadcastAll({ type: 'fontSize', fontSize: state.fontSize }, ws);
        break;
      case 'textPadding':
        state.textPadding = msg.textPadding;
        broadcastAll({ type: 'textPadding', textPadding: state.textPadding }, ws);
        break;
      case 'lineHeight':
        state.lineHeight = msg.lineHeight;
        broadcastAll({ type: 'lineHeight', lineHeight: state.lineHeight }, ws);
        break;
      case 'ping':
        sendTo(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (ws === controller) {
      controller = null;
    }
    displays.delete(id);
    if (ws._role === 'display' && controller) {
      sendTo(controller, { type: 'display-left', displayId: id });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Teleprompter signaling server on port ${PORT}`);
});
