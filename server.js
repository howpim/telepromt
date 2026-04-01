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
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

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

// WebSocket server
const wss = new WebSocketServer({ server });

let state = {
  text: '',
  playing: false,
  speed: 50,
  position: 0,
  fontSize: 52,
  lastUpdate: Date.now()
};

let controller = null;
const displays = new Set();

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', ...state }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join':
        if (msg.role === 'controller') { controller = ws; }
        else { displays.add(ws); }
        ws.send(JSON.stringify({ type: 'state', ...state }));
        break;
      case 'setText':
        state.text = msg.text;
        state.position = 0;
        state.playing = false;
        broadcast({ type: 'state', ...state });
        break;
      case 'play':
        state.playing = true;
        state.lastUpdate = Date.now();
        broadcast({ type: 'play', position: state.position, speed: state.speed, lastUpdate: state.lastUpdate });
        break;
      case 'pause':
        state.playing = false;
        state.position = msg.position != null ? msg.position : state.position;
        broadcast({ type: 'pause', position: state.position });
        break;
      case 'seek':
        state.position = msg.position;
        state.lastUpdate = Date.now();
        broadcast({ type: 'seek', position: state.position, playing: state.playing, lastUpdate: state.lastUpdate });
        break;
      case 'speed':
        state.speed = msg.speed;
        state.lastUpdate = Date.now();
        if (state.playing) state.position = msg.position != null ? msg.position : state.position;
        broadcast({ type: 'speed', speed: state.speed, position: state.position, playing: state.playing, lastUpdate: state.lastUpdate });
        break;
      case 'fontSize':
        state.fontSize = msg.fontSize;
        broadcast({ type: 'fontSize', fontSize: state.fontSize });
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  ws.on('close', () => {
    if (ws === controller) controller = null;
    displays.delete(ws);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Teleprompter running on port ${PORT}`);
});
