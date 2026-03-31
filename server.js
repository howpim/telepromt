const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// HTTP server — serve static files
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// WebSocket server
const wss = new WebSocketServer({ server });

// State
let state = {
  text: '',
  playing: false,
  speed: 50,       // px/sec
  position: 0,     // scroll position in px
  fontSize: 52,
  lastUpdate: Date.now()
};

let controller = null;
const displays = new Set();

function broadcast(msg, exclude = null) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  });
}

wss.on('connection', (ws) => {
  // Send current state to new connection
  ws.send(JSON.stringify({ type: 'state', ...state }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join':
        if (msg.role === 'controller') {
          controller = ws;
        } else {
          displays.add(ws);
        }
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
        state.position = msg.position ?? state.position;
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
        if (state.playing) {
          state.position = msg.position ?? state.position;
        }
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

server.listen(PORT, () => {
  console.log(`Teleprompter running on port ${PORT}`);
});
