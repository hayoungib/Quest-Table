// End-to-end test: spins up the server in mock mode and drives several simulated players.
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import assert from 'node:assert/strict';

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const env = { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: '' };
const srv = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => srv.stdout.on('data', (d) => d.toString().includes('listening') && res()));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function until(fn, label, ms = 4000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return res(v);
      if (Date.now() - t0 > ms) return rej(new Error(`timeout: ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function makePlayer(name) {
  const id = `test-${name}-${Math.random().toString(36).slice(2, 10)}`;
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const p = { id, name, s, lobby: null, state: null, log: [], full: false };
  s.on('lobby:state', (ls) => (p.lobby = ls));
  s.on('party:full', ({ state, log }) => { p.state = state; p.log = [...log]; p.full = true; });
  s.on('party:state', (st) => (p.state = st));
  s.on('party:entry', (e) => p.log.push(e));
  s.on('connect', () => s.emit('hello', { playerId: id }));
  p.join = () => s.emit('lobby:join', { playerId: id, name });
  return p;
}

let ok = 0;
const pass = (m) => { ok++; console.log('  ✓', m); };

try {
  // 1. Waiting room + manual start
  const a = makePlayer('Aria'), b = makePlayer('Bram'), c = makePlayer('Cael');
  await wait(200);
  a.join(); b.join(); c.join();
  await until(() => a.lobby?.members.length === 3, 'three in lobby');
  pass('three players in waiting room (default target 4, no auto-start)');

  b.s.emit('lobby:start');
  await until(() => a.full && b.full && c.full, 'all moved to party');
  assert.equal(a.state.id, c.state.id);
  pass('any player can start; whole waiting room joins the same party');

  await until(() => a.state.phase === 'actions', 'first GM turn');
  assert.ok(a.log.some((e) => e.type === 'gm'));
  pass('GM opened the scene, phase=actions');

  // 2. Actions: all submit -> auto resolve -> mock requests rolls on turn 2
  a.s.emit('game:action', { text: 'I test the bridge with my staff' });
  b.s.emit('game:action', { text: 'I ready my bow' });
  await wait(100);
  assert.equal(a.state.phase, 'actions');
  c.s.emit('game:action', { text: 'I look for another way across' });
  await until(() => a.state.phase === 'rolls', 'roll phase');
  assert.equal(a.state.pendingRolls.length, 3);
  pass('turn resolves when all connected players act; GM requested rolls');

  // 3. Player tries to roll someone else's die -> ignored
  const bRoll = a.state.pendingRolls.find((r) => r.playerName === 'Bram');
  a.s.emit('game:roll', { rollId: bRoll.id });
  await wait(100);
  assert.equal(a.state.pendingRolls.find((r) => r.id === bRoll.id).result, null);
  pass("can't roll another player's die");

  // 4. Disconnect during rolls -> auto roll for absent player
  for (const p of [a, b]) p.s.emit('game:roll', { rollId: p.state.pendingRolls.find((r) => r.playerName === p.name).id });
  await wait(100);
  c.s.disconnect();
  await until(() => a.log.some((e) => e.type === 'roll' && e.player === 'Cael' && e.auto), 'auto roll for Cael');
  const rolls = a.log.filter((e) => e.type === 'roll');
  assert.ok(rolls.every((r) => r.result >= 1 && r.result <= 20));
  pass('away player auto-rolled; results in range 1-20');
  await until(() => a.state.phase === 'actions', 'GM narrated roll outcome');
  pass('GM received tool_result and continued');

  // 5. Reconnect with same id restores the party
  const c2 = io(URL, { transports: ['websocket'], forceNew: true });
  let c2full = null;
  c2.on('party:full', (d) => (c2full = d));
  c2.emit('hello', { playerId: c.id });
  await until(() => c2full, 'reconnect');
  assert.equal(c2full.state.id, a.state.id);
  assert.ok(c2full.log.length > 3);
  pass('reconnecting player rejoins the same party with full history');

  // 6. Proceed without waiting
  a.s.emit('game:action', { text: 'I charge ahead' });
  await wait(50);
  a.s.emit('game:proceed');
  await until(() => a.state.phase !== 'actions' || a.state.turn > 2, 'proceed');
  pass('"proceed without waiting" resolves the turn early');
  await until(() => ['actions', 'rolls'].includes(a.state.phase), 'settle');
  if (a.state.phase === 'rolls') {
    for (const [p, sock] of [[a, a.s], [b, b.s]]) {
      const r = a.state.pendingRolls.find((x) => x.playerName === p.name && x.result === null);
      if (r) sock.emit('game:roll', { rollId: r.id });
    }
    const r = a.state.pendingRolls.find((x) => x.playerName === 'Cael' && x.result === null);
    if (r) c2.emit('game:roll', { rollId: r.id });
    await until(() => a.state.phase === 'actions', 'back to actions');
  }

  // 7. Auto-start when the lobby reaches the target size
  const d = makePlayer('Dara'), e = makePlayer('Eryn');
  await wait(200);
  d.join();
  await until(() => d.lobby?.members.length === 1, 'dara in lobby');
  d.s.emit('lobby:setTarget', { size: 2 });
  e.join();
  await until(() => d.full && e.full, 'auto-start at target');
  assert.notEqual(d.state.id, a.state.id);
  pass('lobby auto-starts a new, separate party at the target size');

  // 8. Max 8 and min 1
  d.s.emit('lobby:setTarget', { size: 9 });
  const solo = makePlayer('Solo');
  await wait(200);
  solo.join();
  await until(() => solo.lobby?.members.length === 1, 'solo lobby');
  assert.ok(solo.lobby.targetSize <= 8);
  solo.s.emit('lobby:start');
  await until(() => solo.full, 'solo start');
  pass('single player can start alone; target size capped at 8');

  // 9. Ending
  await until(() => a.state.phase === 'actions', 'actions before end');
  for (const p of [a, b]) p.s.emit('game:action', { text: 'We end this' });
  c2.emit('game:action', { text: 'end' });
  await until(() => a.state.phase === 'ended', 'ended');
  pass('end_adventure tool ends the game');

  for (const p of [a, b, d, e, solo]) p.s.disconnect();
  c2.disconnect();
  console.log(`\nAll ${ok} checks passed.`);
} catch (err) {
  console.error('\nFAILED:', err.message);
  process.exitCode = 1;
} finally {
  srv.kill();
}
