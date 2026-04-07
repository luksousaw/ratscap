// ═══════════════════════════════════════════════
//  TINY ESCAPE — Servidor Multiplayer
//  Requer: Node.js + ws  →  npm install ws
//  Rodar:  node server.js
//  Acessar: http://localhost:3000
// ═══════════════════════════════════════════════
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// rooms: roomCode → Map< id, { ws, name, x, z, yaw, dead, host } >
const rooms = new Map();
let nextId = 1;

// ── HTTP: serve game.html ───────────────────────
const httpServer = http.createServer((req, res) => {
  try {
    const file = fs.readFileSync(path.join(__dirname, 'game.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(file);
  } catch (e) {
    res.writeHead(404); res.end('game.html not found');
  }
});

// ── WebSocket ───────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

function send(ws, obj) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch(e){}
}

function broadcastRoom(code, obj, exceptId = null) {
  const room = rooms.get(code);
  if (!room) return;
  const data = JSON.stringify(obj);
  room.forEach(({ ws }, id) => {
    if (id !== exceptId && ws.readyState === 1) ws.send(data);
  });
}

function playerList(room) {
  return [...room.entries()].map(([id, p]) => ({
    id, name: p.name, x: p.x, z: p.z, yaw: p.yaw, dead: p.dead, host: p.host
  }));
}

wss.on('connection', ws => {
  const id = String(nextId++);
  let myRoom = null;

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      // ── JOIN ──────────────────────────────────
      if (msg.type === 'join') {
        myRoom = (msg.room || 'GERAL').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0, 6) || 'GERAL';
        if (!rooms.has(myRoom)) rooms.set(myRoom, new Map());
        const room = rooms.get(myRoom);
        const isHost = room.size === 0;
        room.set(id, {
          ws, name: (msg.name || 'Rato').slice(0, 12),
          x: 1, z: 1, yaw: 0, dead: false, host: isHost
        });
        // Welcome: send ID + all current players
        send(ws, { type: 'welcome', id, isHost, players: playerList(room) });
        // Tell others someone joined
        broadcastRoom(myRoom, { type: 'joined', id, name: room.get(id).name, x:1, z:1, yaw:0 }, id);
        console.log(`[${myRoom}] +${room.get(id).name} (${id}) | ${room.size} jogadores`);
      }

      // ── MOVE ──────────────────────────────────
      else if (msg.type === 'move' && myRoom) {
        const p = rooms.get(myRoom)?.get(id);
        if (p) { p.x = msg.x; p.z = msg.z; p.yaw = msg.yaw; }
        broadcastRoom(myRoom, { type: 'move', id, x: msg.x, z: msg.z, yaw: msg.yaw }, id);
      }

      // ── CAT SYNC (host only) ──────────────────
      else if (msg.type === 'cat' && myRoom) {
        if (rooms.get(myRoom)?.get(id)?.host) {
          broadcastRoom(myRoom, { type: 'cat', x: msg.x, z: msg.z }, id);
        }
      }

      // ── HIT (player attacks player) ───────────
      else if (msg.type === 'hit' && myRoom) {
        const attacker = rooms.get(myRoom)?.get(id);
        const target   = rooms.get(myRoom)?.get(msg.targetId);
        if (attacker && target && !target.dead) {
          const dmg = Math.min(50, Math.max(1, msg.dmg || 34));
          // Track HP server-side
          target.hp = (target.hp ?? 100) - dmg;
          // Send hit only to target
          send(target.ws, { type: 'hit', dmg, fromName: attacker.name });
          // Broadcast HP update to everyone in room (so they see the bar)
          broadcastRoom(myRoom, {
            type: 'hpupdate', id: msg.targetId, hp: Math.max(0, target.hp)
          });
          console.log(`[${myRoom}] ⚔ ${attacker.name} → ${target.name} (-${dmg}) HP:${target.hp}`);
        }
      }

      // ── DEAD ──────────────────────────────────
      else if (msg.type === 'dead' && myRoom) {
        const p = rooms.get(myRoom)?.get(id);
        if (p) p.dead = true;
        broadcastRoom(myRoom, { type: 'dead', id }, id);
        console.log(`[${myRoom}] 🐱 ${p?.name} morreu`);
      }

      // ── WIN ───────────────────────────────────
      else if (msg.type === 'win' && myRoom) {
        const name = rooms.get(myRoom)?.get(id)?.name || 'Rato';
        broadcastRoom(myRoom, { type: 'win', id, name }, id);
        console.log(`[${myRoom}] 🏆 ${name} chegou na saída!`);
      }

      // ── LEVEL CHANGE (host only) ──────────────
      else if (msg.type === 'level' && myRoom) {
        if (rooms.get(myRoom)?.get(id)?.host) {
          // Reset dead + HP status for all players in room
          rooms.get(myRoom).forEach(p => { p.dead = false; p.hp = 100; });
          broadcastRoom(myRoom, { type: 'level', lvl: msg.lvl }, id);
          console.log(`[${myRoom}] Fase ${msg.lvl + 1}`);
        }
      }

    } catch(e) { console.error('Parse error:', e.message); }
  });

  ws.on('close', () => {
    if (!myRoom || !rooms.has(myRoom)) return;
    const room = rooms.get(myRoom);
    const p = room.get(id);
    const wasHost = p?.host;
    room.delete(id);
    console.log(`[${myRoom}] -${p?.name || id} | ${room.size} jogadores`);
    if (room.size === 0) { rooms.delete(myRoom); return; }
    broadcastRoom(myRoom, { type: 'left', id });
    // Pass host to next player
    if (wasHost) {
      const newHostId = room.keys().next().value;
      room.get(newHostId).host = true;
      broadcastRoom(myRoom, { type: 'newhost', id: newHostId });
      console.log(`[${myRoom}] Novo host: ${room.get(newHostId).name}`);
    }
  });
});

// ── Start ───────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   🐭  TINY ESCAPE MULTIPLAYER         ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Local:  http://localhost:${PORT}        ║`);
  console.log(`║  Rede:   http://${localIP}:${PORT}`.padEnd(41) + '║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Compartilhe o IP da Rede com amigos  ║');
  console.log('║  Use o mesmo código de sala para jogar║');
  console.log('╚══════════════════════════════════════╝\n');
});
