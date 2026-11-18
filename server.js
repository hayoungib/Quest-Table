import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { Party } from './src/party.js';
import { MOCK, MODEL } from './src/gm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MAX_PARTY = 8;
const MAX_PARTIES = Number(process.env.MAX_PARTIES || 20);
const ABANDON_MS = Number(process.env.ABANDON_MINUTES || 15) * 60_000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, parties: parties.size, lobby: lobby.members.length, mock: MOCK }));

const server = http.createServer(app);
const io = new Server(server);

/** playerId -> { id, name, socketId, connected, partyId } */
const players = new Map();
/** partyId -> Party */
const parties = new Map();
/** The single shared waiting room. */
const lobby = { members: [], targetSize: 4 };

const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _'\-.]/gu, '').trim().slice(0, 24);
const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

function lobbyState() {
  return {
    targetSize: lobby.targetSize,
    max: MAX_PARTY,
    members: lobby.members.map((id) => ({ id, name: players.get(id)?.name })),
  };
}
const broadcastLobby = () => io.to('lobby').emit('lobby:state', lobbyState());

function uniqueName(name, takenNames) {
  const taken = new Set(takenNames.map((n) => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

function leaveLobby(player) {
  const before = lobby.members.length;
  lobby.members = lobby.members.filter((id) => id !== player.id);
  const s = io.sockets.sockets.get(player.socketId);
  s?.leave('lobby');
  if (before !== lobby.members.length) broadcastLobby();
}

function startParty() {
  if (!lobby.members.length) return;
  if (parties.size >= MAX_PARTIES) {
    io.to('lobby').emit('notice', 'All adventure tables are busy right now. Please try again shortly.');
    return;
  }
  const members = lobby.members.map((id) => players.get(id)).filter(Boolean);
  lobby.members = [];
  const party = new Party({ io, players: members, onEmpty: scheduleCleanup });
  parties.set(party.id, party);
  for (const p of members) {
    p.partyId = party.id;
    const s = io.sockets.sockets.get(p.socketId);
    if (s) { s.leave('lobby'); s.join(party.room); }
  }
  for (const p of members) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) party.sendFull(s);
  }
  broadcastLobby();
  console.log(`[party ${party.id}] started with ${members.length} player(s)`);
  party.start();
}

function scheduleCleanup(party, immediate = false) {
  const remove = () => {
    if (!parties.has(party.id)) return;
    if (!immediate && party.connected().length) return; // someone came back
    for (const p of party.players) if (p.partyId === party.id) p.partyId = null;
    parties.delete(party.id);
    console.log(`[party ${party.id}] closed`);
  };
  if (immediate) remove(); else setTimeout(remove, ABANDON_MS);
}

function maybeAutoStart() {
  if (lobby.members.length >= Math.min(lobby.targetSize, MAX_PARTY)) startParty();
}

io.on('connection', (socket) => {
  let player = null;
  const party = () => (player?.partyId ? parties.get(player.partyId) : null);

  // Client identifies itself with a persistent id from localStorage (enables reconnect after refresh).
  socket.on('hello', ({ playerId } = {}) => {
    if (!validId(playerId)) return socket.emit('fatal', 'Invalid session id.');
    player = players.get(playerId);
    if (player) {
      // Same browser opened twice: the newer tab takes over.
      if (player.connected && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.disconnect(true);
      player.socketId = socket.id;
      const pt = party();
      if (pt) {
        socket.join(pt.room);
        pt.setConnected(player, true);
        pt.sendFull(socket);
        return;
      }
      player.connected = true;
    }
    socket.emit('welcome', { name: player?.name || '', mock: MOCK, model: MODEL });
  });

  socket.on('lobby:join', ({ playerId, name } = {}) => {
    if (!validId(playerId)) return;
    const n = cleanName(name);
    if (!n) return socket.emit('notice', 'Please enter a name.');
    if (!player) {
      player = { id: playerId, name: n, socketId: socket.id, connected: true, partyId: null };
      players.set(playerId, player);
    }
    if (party()) return party().sendFull(socket);
    if (lobby.members.includes(player.id)) return;
    player.name = uniqueName(n, lobby.members.map((id) => players.get(id).name));
    player.socketId = socket.id;
    player.connected = true;
    lobby.members.push(player.id);
    socket.join('lobby');
    socket.emit('lobby:joined', { name: player.name });
    broadcastLobby();
    maybeAutoStart();
  });

  socket.on('lobby:setTarget', ({ size } = {}) => {
    if (!player || !lobby.members.includes(player.id)) return;
    const n = Number(size);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARTY) return;
    lobby.targetSize = n;
    broadcastLobby();
    maybeAutoStart();
  });

  socket.on('lobby:start', () => {
    if (player && lobby.members.includes(player.id)) startParty();
  });

  socket.on('lobby:leave', () => { if (player) leaveLobby(player); });

  socket.on('game:action', ({ text } = {}) => party()?.submitAction(player, text));
  socket.on('game:proceed', () => party()?.proceed());
  socket.on('game:roll', ({ rollId } = {}) => party()?.roll(player, rollId));
  socket.on('game:retry', () => party()?.retry());
  socket.on('game:chat', ({ text } = {}) => {
    const pt = party();
    const t = String(text || '').trim().slice(0, 300);
    if (pt && t) pt.addEntry({ type: 'chat', player: player.name, text: t });
  });
  socket.on('game:leave', () => {
    const pt = party();
    if (!pt) return;
    socket.leave(pt.room);
    player.partyId = null;
    pt.removePlayer(player);
    socket.emit('welcome', { name: player.name, mock: MOCK, model: MODEL });
  });

  socket.on('disconnect', () => {
    if (!player || player.socketId !== socket.id) return;
    player.connected = false;
    leaveLobby(player);
    party()?.setConnected(player, false);
  });
});

server.listen(PORT, () => {
  console.log(`Quest Table listening on :${PORT} (${MOCK ? 'MOCK GM — set ANTHROPIC_API_KEY for Claude' : `model ${MODEL}`})`);
});
