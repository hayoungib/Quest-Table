/* Quest Table client */
(() => {
  const $ = (id) => document.getElementById(id);
  const store = window.sessionStorage; // per-tab identity: lets you test several players in one browser
  let playerId = store.getItem('qt:id');
  if (!playerId) {
    playerId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9-]/g, '');
    store.setItem('qt:id', playerId);
  }
  let myName = store.getItem('qt:name') || '';
  let state = null;
  const streams = new Map(); // streamId -> element

  const socket = io();

  // ---------- screens ----------
  function show(screen) {
    for (const s of ['join', 'lobby', 'game']) $(`screen-${s}`).hidden = s !== screen;
  }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 4000);
  }

  // ---------- rendering ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const paras = (s) => s.split(/\n{2,}/).map((p) => `<p>${md(p).replace(/\n/g, '<br>')}</p>`).join('');

  function nearBottom() { const l = $('log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 120; }
  function scroll(force) { const l = $('log'); if (force || nearBottom()) l.scrollTop = l.scrollHeight; }

  function renderEntry(e) {
    const div = document.createElement('div');
    div.className = `entry ${e.type}`;
    if (e.type === 'gm') div.innerHTML = paras(e.text);
    else if (e.type === 'action') div.innerHTML = `<b>${esc(e.player)}:</b> ${esc(e.text)}`;
    else if (e.type === 'chat') div.innerHTML = `<b>${esc(e.player)}</b> <span>(table talk)</span>: ${esc(e.text)}`;
    else if (e.type === 'roll') {
      const v = e.verdict ? ` <span class="${e.verdict}">${e.verdict.toUpperCase()}</span>` : '';
      const dc = e.difficulty != null ? ` vs ${e.difficulty}` : '';
      div.innerHTML = `🎲 ${esc(e.player)} rolls ${esc(e.die)} — ${esc(e.reason)}: <span class="num">${e.result}</span>${dc}${v}${e.auto ? ' <span class="muted">(auto)</span>' : ''}`;
      const wrap = document.createElement('div'); wrap.className = 'entry'; wrap.appendChild(div); return wrap;
    } else div.textContent = e.text;
    return div;
  }

  function addEntry(e) {
    const stick = nearBottom();
    if (e.type === 'gm' && e.streamId && streams.has(e.streamId)) {
      const el = streams.get(e.streamId);
      el.classList.remove('streaming'); el.innerHTML = paras(e.text);
      streams.delete(e.streamId);
    } else {
      $('log').appendChild(renderEntry(e));
    }
    scroll(stick);
  }

  function renderParty() {
    if (!state) return;
    const stick = nearBottom();
    renderPartyInner();
    requestAnimationFrame(() => scroll(stick)); // the input panel may change height
  }
  function renderPartyInner() {
    const list = $('party-list');
    list.innerHTML = '';
    for (const p of state.players) {
      const li = document.createElement('li');
      if (p.id === playerId) li.classList.add('me');
      if (!p.connected) li.classList.add('away');
      let tag = '';
      if (!p.connected) tag = '<span class="tag">away</span>';
      else if (state.phase === 'actions') tag = p.acted ? '<span class="tag ok">ready</span>' : '<span class="tag">deciding…</span>';
      else if (state.phase === 'rolls') {
        const owes = state.pendingRolls.some((r) => r.playerId === p.id && r.result === null);
        tag = owes ? '<span class="tag">must roll</span>' : '';
      }
      li.innerHTML = `<span>${esc(p.name)}</span>${tag}`;
      list.appendChild(li);
    }
    $('turn').textContent = state.turn ? `Turn ${state.turn}` : '';

    const me = state.players.find((p) => p.id === playerId);
    const phase = state.phase;
    $('action-form').hidden = phase !== 'actions';
    $('rolls').hidden = phase !== 'rolls';
    $('retry').hidden = phase !== 'error';
    $('ended').hidden = phase !== 'ended';

    const status = $('status');
    if (phase === 'gm') status.textContent = 'The Game Master is weaving the tale…';
    else if (phase === 'actions') {
      const waiting = state.players.filter((p) => p.connected && !p.acted).map((p) => p.name);
      const acted = me?.acted;
      status.textContent = acted
        ? `Action declared. Waiting for: ${waiting.join(', ') || 'no one'}.`
        : 'Your move. Declare what your character does.';
      $('action').disabled = !!acted;
      $('action-form').querySelector('button[type=submit]').disabled = !!acted;
      $('btn-proceed').disabled = !state.players.some((p) => p.acted);
    } else if (phase === 'rolls') {
      const mine = state.pendingRolls.filter((r) => r.playerId === playerId && r.result === null);
      status.textContent = mine.length ? 'Fate demands a roll!' : 'Waiting for the other dice to fall…';
      const box = $('rolls');
      box.innerHTML = '';
      for (const r of state.pendingRolls) {
        const row = document.createElement('div');
        row.className = 'rollreq';
        const dc = r.difficulty != null ? ` (need ${r.difficulty}+)` : '';
        const label = `<span><b>${esc(r.playerName)}</b> — ${esc(r.reason)} <span class="die">${esc(r.die)}</span>${dc}</span>`;
        if (r.result !== null) row.innerHTML = `${label}<span class="die">${r.result}</span>`;
        else if (r.playerId === playerId) {
          row.innerHTML = label;
          const b = document.createElement('button');
          b.textContent = `Roll ${r.die}`;
          b.onclick = () => { b.disabled = true; socket.emit('game:roll', { rollId: r.id }); };
          row.appendChild(b);
        } else row.innerHTML = `${label}<span class="muted">waiting</span>`;
        box.appendChild(row);
      }
    } else if (phase === 'error') status.textContent = 'Something went wrong reaching the Game Master.';
    else if (phase === 'ended') status.textContent = 'The tale is told.';
  }

  function renderLobby(ls) {
    const sel = $('target');
    if (!sel.options.length) for (let i = 1; i <= ls.max; i++) sel.add(new Option(`${i} player${i > 1 ? 's' : ''}`, i));
    sel.value = ls.targetSize;
    $('lobby-count').textContent = `${ls.members.length} of ${ls.targetSize} adventurers waiting`;
    const list = $('lobby-list');
    list.innerHTML = '';
    for (const m of ls.members) {
      const li = document.createElement('li');
      if (m.id === playerId) li.classList.add('me');
      li.innerHTML = `<span>${esc(m.name)}</span>${m.id === playerId ? '<span class="tag">you</span>' : ''}`;
      list.appendChild(li);
    }
  }

  // ---------- socket events ----------
  socket.on('connect', () => socket.emit('hello', { playerId }));
  socket.on('welcome', ({ name, mock, model }) => {
    $('mode').textContent = mock ? 'Demo mode (mock Game Master)' : `Game Master: ${model}`;
    myName = name || myName;
    $('name').value = myName;
    state = null;
    if (store.getItem('qt:lobby') === '1' && myName) socket.emit('lobby:join', { playerId, name: myName });
    else show('join');
  });
  socket.on('lobby:joined', ({ name }) => {
    myName = name; store.setItem('qt:name', name); store.setItem('qt:lobby', '1');
    show('lobby');
  });
  socket.on('lobby:state', renderLobby);
  socket.on('party:full', ({ state: s, log }) => {
    store.removeItem('qt:lobby');
    state = s;
    streams.clear();
    $('log').innerHTML = '';
    for (const e of log) addEntry(e);
    show('game');
    renderParty();
    scroll(true);
  });
  socket.on('party:state', (s) => { state = s; renderParty(); });
  socket.on('party:entry', addEntry);
  socket.on('gm:start', ({ streamId }) => {
    const el = document.createElement('div');
    el.className = 'entry gm streaming';
    el.dataset.raw = '';
    $('log').appendChild(el);
    streams.set(streamId, el);
    scroll(true);
  });
  socket.on('gm:delta', ({ streamId, delta }) => {
    const el = streams.get(streamId);
    if (!el) return;
    const stick = nearBottom();
    el.dataset.raw += delta;
    el.innerHTML = paras(el.dataset.raw);
    scroll(stick);
  });
  socket.on('gm:end', ({ streamId } = {}) => {
    // If the GM produced no text (e.g. a bare dice request), drop the empty placeholder.
    for (const [id, el] of streams) if (!streamId || id === streamId) {
      if (!el.dataset.raw) { el.remove(); streams.delete(id); }
    }
  });
  socket.on('notice', toast);
  socket.on('fatal', toast);
  socket.on('disconnect', () => toast('Connection lost — reconnecting…'));

  // ---------- UI events ----------
  $('join-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = $('name').value.trim();
    if (name) socket.emit('lobby:join', { playerId, name });
  });
  $('target').addEventListener('change', (ev) => socket.emit('lobby:setTarget', { size: Number(ev.target.value) }));
  $('btn-start').addEventListener('click', () => socket.emit('lobby:start'));
  $('btn-leave-lobby').addEventListener('click', () => {
    socket.emit('lobby:leave'); store.removeItem('qt:lobby'); show('join');
  });
  $('action-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('action').value.trim();
    if (!text) return;
    socket.emit('game:action', { text });
    $('action').value = '';
  });
  $('action').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('action-form').requestSubmit(); }
  });
  $('btn-proceed').addEventListener('click', () => socket.emit('game:proceed'));
  $('btn-retry').addEventListener('click', () => socket.emit('game:retry'));
  $('chat-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('chat').value.trim();
    if (text) socket.emit('game:chat', { text });
    $('chat').value = '';
  });
  const leave = () => { if (confirmLeave()) socket.emit('game:leave'); };
  const confirmLeave = () => state?.phase === 'ended' || window.confirm('Leave this adventure? You cannot rejoin this party.');
  $('btn-leave-game').addEventListener('click', leave);
  $('btn-new').addEventListener('click', () => socket.emit('game:leave'));
})();
