// A party: one group of players playing one adventure with the AI Game Master.
import crypto from 'node:crypto';
import { runGM, summarize, DICE } from './gm.js';

const COMPACT_AFTER = Number(process.env.COMPACT_AFTER_MESSAGES || 40); // history length that triggers a recap
const KEEP_RECENT = 12;
const MAX_LOG = 600;

export class Party {
  constructor({ io, players, onEmpty }) {
    this.id = crypto.randomUUID().slice(0, 8);
    this.io = io;
    this.room = `party:${this.id}`;
    this.players = players; // array of player objects (shared with server registry)
    this.onEmpty = onEmpty;
    this.phase = 'gm'; // gm | actions | rolls | error | ended
    this.messages = []; // Claude conversation history
    this.log = []; // what players see
    this.pendingActions = new Map(); // playerId -> text
    this.pendingRolls = []; // {id, toolUseId, playerId, playerName, die, reason, difficulty, result}
    this.toolUses = []; // tool_use blocks awaiting tool_result
    this.turn = 0;
    this.createdAt = Date.now();
  }

  // ---------- helpers ----------
  names() { return this.players.map((p) => p.name); }
  connected() { return this.players.filter((p) => p.connected); }
  findByName(name) {
    const n = String(name || '').trim().toLowerCase();
    return this.players.find((p) => p.name.toLowerCase() === n)
      || this.players.find((p) => n && (p.name.toLowerCase().startsWith(n) || n.startsWith(p.name.toLowerCase())));
  }

  addEntry(entry) {
    const e = { id: crypto.randomUUID().slice(0, 8), at: Date.now(), ...entry };
    this.log.push(e);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.io.to(this.room).emit('party:entry', e);
    return e;
  }

  publicState() {
    return {
      id: this.id,
      phase: this.phase,
      turn: this.turn,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, connected: p.connected, acted: this.pendingActions.has(p.id),
      })),
      pendingRolls: this.pendingRolls.map(({ toolUseId, ...r }) => r),
    };
  }
  broadcastState() { this.io.to(this.room).emit('party:state', this.publicState()); }
  sendFull(socket) { socket.emit('party:full', { state: this.publicState(), log: this.log }); }

  // ---------- lifecycle ----------
  start() {
    this.addEntry({ type: 'system', text: `The party assembles: ${this.names().join(', ')}.` });
    this.messages.push({
      role: 'user',
      content: `The adventure begins. The party is: ${this.names().join(', ')}. ` +
        'Briefly introduce each character with a fitting fantasy role inspired by their name, ' +
        'set an intriguing opening scene, and ask the party what they do.',
    });
    this.runGMTurn();
  }

  async runGMTurn() {
    this.phase = 'gm';
    this.broadcastState();
    try {
      await this.maybeCompact();
      const streamId = crypto.randomUUID().slice(0, 8);
      this.io.to(this.room).emit('gm:start', { streamId });
      const { content } = await runGM({
        playerNames: this.names(),
        messages: this.messages,
        onText: (delta) => this.io.to(this.room).emit('gm:delta', { streamId, delta }),
      });
      this.messages.push({ role: 'assistant', content });
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
      if (text) this.addEntry({ type: 'gm', streamId, text });
      this.io.to(this.room).emit('gm:end', { streamId });

      this.toolUses = content.filter((b) => b.type === 'tool_use');
      const end = this.toolUses.find((t) => t.name === 'end_adventure');
      if (end) {
        this.phase = 'ended';
        this.addEntry({ type: 'system', text: `The adventure is over. ${end.input?.outcome || ''}`.trim() });
        return this.broadcastState();
      }
      const rollReq = this.toolUses.find((t) => t.name === 'request_rolls');
      if (rollReq) return this.beginRolls(rollReq);
      this.turn++;
      this.pendingActions.clear();
      this.phase = 'actions';
      this.broadcastState();
    } catch (err) {
      console.error(`[party ${this.id}] GM error:`, err?.message || err);
      this.io.to(this.room).emit('gm:end', {});
      this.phase = 'error';
      this.addEntry({ type: 'system', text: 'The Game Master lost the thread (AI request failed). Anyone can press Retry.' });
      this.broadcastState();
    }
  }

  retry() {
    if (this.phase !== 'error') return;
    // The last message in history is the unanswered user message, so just run again.
    this.runGMTurn();
  }

  // ---------- actions ----------
  submitAction(player, text) {
    if (this.phase !== 'actions') return;
    const clean = String(text || '').trim().slice(0, 600);
    if (!clean) return;
    this.pendingActions.set(player.id, clean);
    this.addEntry({ type: 'action', player: player.name, text: clean });
    this.broadcastState();
    if (this.connected().every((p) => this.pendingActions.has(p.id))) this.resolveActions();
  }

  proceed() {
    if (this.phase === 'actions' && this.pendingActions.size > 0) this.resolveActions();
  }

  resolveActions() {
    const lines = this.players.map((p) => {
      const a = this.pendingActions.get(p.id);
      return a ? `- ${p.name}: ${a}` : `- ${p.name}: (takes no explicit action${p.connected ? '' : ' — player is away'})`;
    });
    this.messages.push({ role: 'user', content: `Player actions this turn:\n${lines.join('\n')}` });
    this.pendingActions.clear();
    this.runGMTurn();
  }

  // ---------- dice ----------
  beginRolls(toolUse) {
    const reqs = Array.isArray(toolUse.input?.rolls) ? toolUse.input.rolls : [];
    this.pendingRolls = reqs.slice(0, 8).map((r) => {
      const p = this.findByName(r.player) || this.connected()[0] || this.players[0];
      return {
        id: crypto.randomUUID().slice(0, 8),
        toolUseId: toolUse.id,
        playerId: p.id,
        playerName: p.name,
        die: DICE[r.die] ? r.die : 'd20',
        reason: String(r.reason || 'Test your luck').slice(0, 120),
        difficulty: Number.isInteger(r.difficulty) ? r.difficulty : null,
        result: null,
      };
    });
    if (!this.pendingRolls.length) return this.finishRolls();
    this.phase = 'rolls';
    this.broadcastState();
    // Players who are away get an automatic roll so the table isn't blocked.
    for (const r of this.pendingRolls) {
      const p = this.players.find((x) => x.id === r.playerId);
      if (!p.connected) this.roll(p, r.id, true);
    }
  }

  roll(player, rollId, auto = false) {
    if (this.phase !== 'rolls') return;
    const r = this.pendingRolls.find((x) => x.id === rollId && x.playerId === player.id && x.result === null);
    if (!r) return;
    r.result = crypto.randomInt(1, DICE[r.die] + 1);
    const verdict = r.difficulty == null ? '' : r.result >= r.difficulty ? 'success' : 'failure';
    this.addEntry({
      type: 'roll', player: r.playerName, die: r.die, result: r.result,
      difficulty: r.difficulty, verdict, reason: r.reason, auto,
    });
    this.broadcastState();
    if (this.pendingRolls.every((x) => x.result !== null)) this.finishRolls();
  }

  finishRolls() {
    const results = this.pendingRolls.map((r) => {
      const dc = r.difficulty == null ? '' : ` vs difficulty ${r.difficulty} → ${r.result >= r.difficulty ? 'SUCCESS' : 'FAILURE'}`;
      return `${r.playerName} rolled ${r.die} for "${r.reason}": ${r.result}${dc}`;
    });
    // Every tool_use in the last assistant message needs a matching tool_result.
    const content = this.toolUses.map((t) => ({
      type: 'tool_result',
      tool_use_id: t.id,
      content: t.name === 'request_rolls' ? (results.join('\n') || 'No rolls were made.') : 'Acknowledged.',
    }));
    this.messages.push({ role: 'user', content });
    this.pendingRolls = [];
    this.toolUses = [];
    this.runGMTurn();
  }

  // ---------- presence ----------
  setConnected(player, connected) {
    player.connected = connected;
    this.addEntry({ type: 'system', text: `${player.name} ${connected ? 'rejoined' : 'stepped away'}.` });
    if (!connected) {
      if (this.phase === 'rolls') {
        for (const r of this.pendingRolls) if (r.playerId === player.id && r.result === null) this.roll(player, r.id, true);
      } else if (this.phase === 'actions' && this.pendingActions.size > 0
        && this.connected().every((p) => this.pendingActions.has(p.id))) {
        this.resolveActions();
      }
    }
    this.broadcastState();
    if (!this.connected().length) this.onEmpty?.(this);
  }

  removePlayer(player) {
    this.players = this.players.filter((p) => p.id !== player.id);
    this.pendingActions.delete(player.id);
    this.addEntry({ type: 'system', text: `${player.name} has left the party.` });
    if (!this.players.length) return this.onEmpty?.(this, true);
    if (this.phase === 'rolls') {
      // Reassign their outstanding rolls as automatic rolls.
      for (const r of this.pendingRolls) if (r.playerId === player.id && r.result === null) {
        r.result = crypto.randomInt(1, DICE[r.die] + 1);
        this.addEntry({ type: 'roll', player: r.playerName, die: r.die, result: r.result, difficulty: r.difficulty,
          verdict: r.difficulty == null ? '' : r.result >= r.difficulty ? 'success' : 'failure', reason: r.reason, auto: true });
      }
      if (this.pendingRolls.every((x) => x.result !== null)) return this.finishRolls();
    }
    if (this.phase === 'actions' && this.pendingActions.size > 0
      && this.connected().every((p) => this.pendingActions.has(p.id))) return this.resolveActions();
    this.broadcastState();
  }

  // ---------- context management ----------
  async maybeCompact() {
    if (this.messages.length <= COMPACT_AFTER) return;
    // Cut at a plain-text user message so tool_use/tool_result pairs are never split.
    let k = -1;
    for (let i = this.messages.length - KEEP_RECENT; i > 0; i--) {
      const m = this.messages[i];
      if (m.role === 'user' && typeof m.content === 'string') { k = i; break; }
    }
    if (k <= 0) return;
    const transcript = this.messages.slice(0, k).map((m) => {
      if (typeof m.content === 'string') return `${m.role === 'user' ? 'PLAYERS' : 'GM'}: ${m.content}`;
      return m.content.map((b) => {
        if (b.type === 'text') return `GM: ${b.text}`;
        if (b.type === 'tool_use') return `GM requested: ${JSON.stringify(b.input)}`;
        if (b.type === 'tool_result') return `RESULTS: ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}`;
        return '';
      }).join('\n');
    }).join('\n\n');
    const recap = await summarize(transcript);
    const rest = this.messages.slice(k);
    rest[0] = { role: 'user', content: `[Recap of the story so far]\n${recap}\n\n${rest[0].content}` };
    this.messages = rest;
  }
}
