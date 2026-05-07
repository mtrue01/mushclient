'use strict';

const TERM_THEME = {
  background:      '#0d1117',
  foreground:      '#c9d1d9',
  cursor:          '#58a6ff',
  cursorAccent:    '#0d1117',
  selectionBackground: '#264f7860',
  black:           '#484f58',
  red:             '#ff7b72',
  green:           '#3fb950',
  yellow:          '#d29922',
  blue:            '#58a6ff',
  magenta:         '#bc8cff',
  cyan:            '#39c5cf',
  white:           '#b1bac4',
  brightBlack:     '#6e7681',
  brightRed:       '#ffa198',
  brightGreen:     '#56d364',
  brightYellow:    '#e3b341',
  brightBlue:      '#79c0ff',
  brightMagenta:   '#d2a8ff',
  brightCyan:      '#56d4dd',
  brightWhite:     '#f0f6fc',
};

// ── Session persistence ────────────────────────────────

const SESSIONS_KEY = 'mc_sessions';
const TERM_BUF_LIMIT = 75000; // chars of base64 ≈ ~56KB of terminal data

function genSessionId() {
  return crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
}

function saveSession(conn) {
  const all = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}');
  all[conn.sessionId] = {
    worldName: conn.world.name,
    worldHost: conn.world.host,
    worldPort: conn.world.port,
    charName: conn.character ? conn.character.name : null,
    tabLabel: conn.tabEl.querySelector('.tab-name').textContent,
    termBuffer: conn.termBuffer || [],
  };
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(all));
}

function clearSession(sessionId) {
  if (!sessionId) return;
  const all = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}');
  delete all[sessionId];
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(all));
}

function restoreSessions() {
  const all = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}');
  for (const [sessionId, info] of Object.entries(all)) {
    const world = { id: null, name: info.worldName, host: info.worldHost, port: info.worldPort, characters: [] };
    let char = null;
    if (info.charName) {
      const saved = worlds.find(w => w.host.toLowerCase() === info.worldHost.toLowerCase() && w.port === info.worldPort);
      char = (saved?.characters || []).find(c => c.name === info.charName) || null;
    }
    createTab(world, char, sessionId, info.tabLabel, info.termBuffer || []);
  }
}

window.addEventListener('beforeunload', () => {
  tabs.forEach(conn => {
    if (conn.connected && conn.sessionId) {
      saveSession(conn); // flush latest buffer to localStorage
      navigator.sendBeacon('/api/park', new Blob(
        [JSON.stringify({ sessionId: conn.sessionId })],
        { type: 'application/json' }
      ));
    }
  });
});

// ── State ─────────────────────────────────────────────

let worlds = [];
let tabs = new Map();   // tabId -> conn object
let activeTabId = null;
let tabSeq = 0;

// World modal state
let editingWorldId = null;

// Character modal state
let charModalWorldId = null;
let editingCharId = null;

// ── DOM refs ──────────────────────────────────────────

const worldList       = document.getElementById('world-list');
const tabsEl          = document.getElementById('tabs');
const termArea        = document.getElementById('terminal-area');
const welcome         = document.getElementById('welcome');
const cmdInput        = document.getElementById('cmd-input');
const btnSend         = document.getElementById('btn-send');
const footerStatus    = document.getElementById('footer-status');

const modalOverlay    = document.getElementById('modal-overlay');
const worldForm       = document.getElementById('world-form');
const modalTitle      = document.getElementById('modal-title');

const charModalOverlay = document.getElementById('char-modal-overlay');
const charForm         = document.getElementById('char-form');
const charModalTitle   = document.getElementById('char-modal-title');

// ── Utils ─────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Worlds API ────────────────────────────────────────

async function loadWorlds() {
  const r = await fetch('/api/worlds');
  worlds = await r.json();
  renderWorldList();
}

async function apiSaveWorld(data, id) {
  const r = await fetch(id ? `/api/worlds/${id}` : '/api/worlds', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json();
}

async function apiDeleteWorld(id) {
  await fetch(`/api/worlds/${id}`, { method: 'DELETE' });
}

async function apiAddCharacter(worldId, data) {
  const r = await fetch(`/api/worlds/${worldId}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json();
}

async function apiUpdateCharacter(worldId, charId, data) {
  const r = await fetch(`/api/worlds/${worldId}/characters/${charId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json();
}

async function apiDeleteCharacter(worldId, charId) {
  await fetch(`/api/worlds/${worldId}/characters/${charId}`, { method: 'DELETE' });
}

// ── Sidebar ───────────────────────────────────────────

function renderWorldList() {
  worldList.innerHTML = '';
  worlds.forEach(w => renderWorldItem(w));
}

function renderWorldItem(w) {
  const chars = w.characters || [];
  const div = document.createElement('div');
  div.className = 'world-item';
  div.dataset.worldId = w.id;

  div.innerHTML = `
    <div class="world-header">
      <span class="world-name" title="Double-click to rename">${esc(w.name)}</span>
      <div class="world-header-actions">
        <button class="btn-icon btn-edit" title="Edit world">✎</button>
        <button class="btn-icon btn-delete" title="Delete world">✕</button>
      </div>
    </div>
    ${w.description ? `<span class="world-desc">${esc(w.description)}</span>` : ''}
    <span class="world-addr">${esc(w.host)}:${w.port}</span>
    <div class="world-actions">
      <button class="btn-connect">Connect</button>
      <button class="btn-chars-toggle ${chars.length ? '' : 'dim'}">${chars.length ? `▾ ${chars.length} character${chars.length !== 1 ? 's' : ''}` : '▾ Characters'}</button>
    </div>
    <div class="chars-section hidden">
      <div class="chars-list">
        ${chars.map(c => renderCharHTML(w.id, c)).join('')}
      </div>
      <button class="btn-add-char">+ Add Character</button>
    </div>`;

  // Inline rename on double-click
  div.querySelector('.world-name').addEventListener('dblclick', () => startInlineRename(div, w));

  div.querySelector('.btn-connect').addEventListener('click', () => openConnection(w.id, null));
  div.querySelector('.btn-edit').addEventListener('click', () => openWorldModal(w.id));
  div.querySelector('.btn-delete').addEventListener('click', async () => {
    if (confirm(`Delete "${w.name}"?`)) {
      await apiDeleteWorld(w.id);
      worlds = worlds.filter(x => x.id !== w.id);
      renderWorldList();
    }
  });

  div.querySelector('.btn-chars-toggle').addEventListener('click', () => {
    div.querySelector('.chars-section').classList.toggle('hidden');
  });

  div.querySelector('.btn-add-char').addEventListener('click', () => openCharModal(w.id, null));

  bindCharButtons(div, w);

  worldList.appendChild(div);
}

function renderCharHTML(worldId, c) {
  return `
    <div class="char-item" data-char-id="${c.id}">
      <span class="char-name">${esc(c.name)}</span>
      <div class="char-actions">
        <button class="btn-play" data-world="${worldId}" data-char="${c.id}" title="Connect as ${esc(c.name)}">▶ Play</button>
        <button class="btn-icon btn-char-edit" data-world="${worldId}" data-char="${c.id}" title="Edit">✎</button>
        <button class="btn-icon btn-char-delete" data-world="${worldId}" data-char="${c.id}" title="Delete">✕</button>
      </div>
    </div>`;
}

function bindCharButtons(container, w) {
  container.querySelectorAll('.btn-play').forEach(b => {
    b.addEventListener('click', () => {
      const char = (w.characters || []).find(c => c.id === b.dataset.char);
      if (char) openConnection(w.id, char);
    });
  });
  container.querySelectorAll('.btn-char-edit').forEach(b => {
    b.addEventListener('click', () => openCharModal(b.dataset.world, b.dataset.char));
  });
  container.querySelectorAll('.btn-char-delete').forEach(b => {
    b.addEventListener('click', async () => {
      const char = (w.characters || []).find(c => c.id === b.dataset.char);
      if (!char || !confirm(`Delete character "${char.name}"?`)) return;
      await apiDeleteCharacter(w.id, b.dataset.char);
      w.characters = (w.characters || []).filter(c => c.id !== b.dataset.char);
      refreshWorldItem(w);
    });
  });
}

function refreshWorldItem(w) {
  const existing = worldList.querySelector(`[data-world-id="${w.id}"]`);
  const open = existing && !existing.querySelector('.chars-section').classList.contains('hidden');
  if (existing) existing.remove();
  renderWorldItem(w);
  if (open) {
    worldList.querySelector(`[data-world-id="${w.id}"] .chars-section`).classList.remove('hidden');
  }
}

// ── Inline rename ─────────────────────────────────────

function startInlineRename(container, w) {
  const nameEl = container.querySelector('.world-name');
  const original = w.name;

  const input = document.createElement('input');
  input.className = 'inline-rename';
  input.value = original;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let saved = false;

  async function commit() {
    if (saved) return;
    saved = true;
    const newName = input.value.trim();
    if (newName && newName !== original) {
      w.name = newName;
      await apiSaveWorld(w, w.id);
      tabs.forEach(conn => {
        if (conn.world.id === w.id) {
          conn.world.name = newName;
          conn.tabEl.querySelector('.tab-name').textContent = newName;
        }
      });
    } else {
      w.name = original;
    }
    refreshWorldItem(w);
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      saved = true;
      refreshWorldItem(w);
    }
  });
}

// ── Terminal tabs ─────────────────────────────────────

function openConnection(worldId, character) {
  const world = worlds.find(w => w.id === worldId);
  if (!world) return;
  createTab(world, character);
}

function createTab(world, character, resumeSessionId = null, tabLabel = null, savedBuffer = null) {
  const id = ++tabSeq;
  const label = tabLabel || (character ? `${world.name} (${character.name})` : world.name);

  // Tab element
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = id;
  tabEl.innerHTML = `<span class="tab-dot"></span><span class="tab-name">${esc(label)}</span><span class="tab-act" title="New activity">⬤</span><button class="tab-close" title="Close">×</button>`;
  tabsEl.appendChild(tabEl);
  tabEl.querySelector('.tab-name').addEventListener('click', () => activateTab(id));
  tabEl.querySelector('.tab-dot').addEventListener('click', () => activateTab(id));
  tabEl.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });

  // Pane
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.dataset.tabId = id;
  termArea.appendChild(pane);

  // xterm
  const isMobile = window.innerWidth <= 768;
  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
    fontSize: isMobile ? 11 : 14,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  // Show pane briefly so xterm measures real dimensions, not zero (display:none)
  pane.style.display = 'block';
  term.open(pane);
  fitAddon.fit();
  pane.style.display = '';

  if (isMobile) {
    let touchStartY = 0;
    const lineHeight = term.options.fontSize * term.options.lineHeight;
    pane.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
    pane.addEventListener('touchmove', (e) => {
      const dy = touchStartY - e.touches[0].clientY;
      touchStartY = e.touches[0].clientY;
      term.scrollLines(Math.round(dy / lineHeight));
    }, { passive: true });
  }

  const initBuf = savedBuffer || [];
  const conn = {
    id, ws: null, term, fitAddon, pane, tabEl, world,
    connected: false,
    sessionId: genSessionId(),
    resumeSessionId,
    character: character || null,
    pendingCharacter: resumeSessionId ? null : (character || null), // don't auto-login on resume
    history: [], histIdx: -1, pendingInput: '',
    logging: false, logFilename: null,
    termBuffer: [...initBuf],
    termBufSize: initBuf.reduce((s, c) => s + c.length, 0),
  };
  tabs.set(id, conn);

  activateTab(id);
  connectWS(conn);
  closeSidebar();

  // xterm measures cell dimensions on its first render (async RAF).
  // Double RAF guarantees we fire *after* that render, so fit() uses correct cell metrics.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    conn.fitAddon.fit();
    if (savedBuffer && savedBuffer.length > 0) {
      for (const chunk of savedBuffer) conn.term.write(b64ToBytes(chunk));
      conn.term.scrollToBottom();
    }
  }));

  return conn;
}

function activateTab(id) {
  activeTabId = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', +t.dataset.tabId === id));
  tabs.get(id)?.tabEl.classList.remove('has-activity');
  document.querySelectorAll('.terminal-pane').forEach(p => p.classList.toggle('active', +p.dataset.tabId === id));
  welcome.classList.add('hidden');

  const conn = tabs.get(id);
  if (conn) {
    conn.fitAddon.fit();
    setInputEnabled(conn.connected);
    updateLogBtn(conn);
    footerStatus.textContent = conn.connected
      ? `Connected to ${conn.world.host}:${conn.world.port}`
      : `Disconnected — ${conn.world.name}`;
  }
}

function closeTab(id) {
  const conn = tabs.get(id);
  if (!conn) return;
  clearSession(conn.sessionId);
  if (conn.ws) {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify({ type: 'disconnect' }));
    conn.ws.close();
    conn.ws = null;
  }
  conn.pane.remove();
  conn.tabEl.remove();
  tabs.delete(id);

  if (activeTabId === id) {
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      activateTab(remaining[remaining.length - 1]);
    } else {
      activeTabId = null;
      welcome.classList.remove('hidden');
      setInputEnabled(false);
      footerStatus.textContent = 'Ready';
    }
  }
}

// ── WebSocket proxy ───────────────────────────────────

function connectWS(conn) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  conn.ws = ws;

  if (conn.resumeSessionId) {
    conn.term.write(`\x1b[2mResuming session…\x1b[0m\r\n`);
  } else {
    conn.term.write(`\x1b[2mConnecting to ${conn.world.host}:${conn.world.port}…\x1b[0m\r\n`);
  }

  ws.onopen = () => {
    if (conn.resumeSessionId) {
      ws.send(JSON.stringify({ type: 'resume', sessionId: conn.resumeSessionId }));
      conn._resumeTimeout = setTimeout(() => {
        if (conn.resumeSessionId) {
          clearSession(conn.resumeSessionId);
          conn.resumeSessionId = null;
          conn.pendingCharacter = conn.character; // restore auto-login for fresh connect
          conn.term.write(`\x1b[33mSession expired, reconnecting…\x1b[0m\r\n`);
          if (conn.ws) { conn.ws.close(); conn.ws = null; }
          setTimeout(() => connectWS(conn), 500);
        }
      }, 5000);
    } else {
      ws.send(JSON.stringify({ type: 'connect', host: conn.world.host, port: conn.world.port, sessionId: conn.sessionId }));
    }
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'session_expired') {
      clearSession(conn.resumeSessionId);
      conn.resumeSessionId = null;
      conn.pendingCharacter = conn.character; // restore auto-login for fresh connect
      conn.term.write(`\x1b[33mSession expired, reconnecting…\x1b[0m\r\n`);
      if (conn.ws) { conn.ws.close(); conn.ws = null; }
      setTimeout(() => connectWS(conn), 1000);
      return;
    }

    if (msg.type === 'status') {
      conn.connected = msg.connected;
      conn.tabEl.querySelector('.tab-dot').classList.toggle('connected', msg.connected);
      if (msg.connected) {
        clearTimeout(conn._resumeTimeout);
        if (conn.resumeSessionId) conn.sessionId = conn.resumeSessionId; // keep in sync with server
        conn.resumeSessionId = null;
        saveSession(conn);
      } else { clearSession(conn.sessionId); }

      if (activeTabId === conn.id) {
        setInputEnabled(msg.connected);
        footerStatus.textContent = msg.connected
          ? `Connected to ${conn.world.host}:${conn.world.port}`
          : `Disconnected — ${conn.world.name}`;
      }

      if (msg.connected && conn.pendingCharacter) {
        const { name, password } = conn.pendingCharacter;
        conn.pendingCharacter = null;
        const cmd = password ? `connect ${name} ${password}` : `connect ${name}`;
        setTimeout(() => {
          if (conn.ws && conn.connected) {
            conn.ws.send(JSON.stringify({ type: 'input', data: cmd }));
          }
        }, 400);
      }

      if (!msg.connected) {
        conn.term.write('\r\n\x1b[31m--- Disconnected ---\x1b[0m\r\n');
      }
    }

    if (msg.type === 'data') {
      conn.term.write(b64ToBytes(msg.data));
      conn.termBuffer.push(msg.data);
      conn.termBufSize += msg.data.length;
      while (conn.termBufSize > TERM_BUF_LIMIT && conn.termBuffer.length > 1) {
        conn.termBufSize -= conn.termBuffer[0].length;
        conn.termBuffer.shift();
      }
      if (conn.id !== activeTabId) conn.tabEl.classList.add('has-activity');
      if (document.hidden) startFaviconFlash();
    }

    if (msg.type === 'error') {
      conn.term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
    }

    if (msg.type === 'logStarted' || msg.type === 'logStopped') {
      handleLogMessage(conn, msg);
    }
  };

  ws.onclose = () => {
    conn.connected = false;
    conn.tabEl.querySelector('.tab-dot').classList.remove('connected');
    if (activeTabId === conn.id) {
      setInputEnabled(false);
      footerStatus.textContent = `Disconnected — ${conn.world.name}`;
    }
  };

  ws.onerror = () => {
    conn.term.write('\r\n\x1b[31mWebSocket error\x1b[0m\r\n');
  };
}

// ── Input ─────────────────────────────────────────────

function setInputEnabled(on) {
  cmdInput.disabled = !on;
  btnSend.disabled = !on;
  if (on) cmdInput.focus();
}

function sendCommand(text) {
  const conn = tabs.get(activeTabId);
  if (!conn || !conn.connected || !conn.ws) return;
  conn.ws.send(JSON.stringify({ type: 'input', data: text }));
  if (text && (conn.history.length === 0 || conn.history[conn.history.length - 1] !== text)) {
    conn.history.push(text);
  }
  conn.histIdx = -1;
  conn.pendingInput = '';
}

cmdInput.addEventListener('keydown', (e) => {
  const conn = tabs.get(activeTabId);
  if (!conn) return;
  if (e.key === 'Enter') { sendCommand(cmdInput.value); cmdInput.value = ''; return; }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (conn.histIdx === -1) conn.pendingInput = cmdInput.value;
    if (conn.histIdx < conn.history.length - 1) {
      conn.histIdx++;
      cmdInput.value = conn.history[conn.history.length - 1 - conn.histIdx];
    }
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (conn.histIdx > 0) { conn.histIdx--; cmdInput.value = conn.history[conn.history.length - 1 - conn.histIdx]; }
    else if (conn.histIdx === 0) { conn.histIdx = -1; cmdInput.value = conn.pendingInput; }
  }
});

btnSend.addEventListener('click', () => {
  sendCommand(cmdInput.value);
  cmdInput.value = '';
  cmdInput.focus();
});

// ── World modal ───────────────────────────────────────

function openWorldModal(id) {
  editingWorldId = id || null;
  modalTitle.textContent = id ? 'Edit World' : 'Add World';
  worldForm.reset();
  if (id) {
    const w = worlds.find(x => x.id === id);
    if (w) {
      worldForm.name.value        = w.name;
      worldForm.host.value        = w.host;
      worldForm.port.value        = w.port;
      worldForm.description.value = w.description || '';
    }
  }
  modalOverlay.classList.remove('hidden');
  worldForm.querySelector('input').focus();
}

function closeWorldModal() {
  modalOverlay.classList.add('hidden');
  editingWorldId = null;
}

document.getElementById('btn-add-world').addEventListener('click', () => openWorldModal(null));
document.getElementById('btn-modal-cancel').addEventListener('click', closeWorldModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeWorldModal(); });

worldForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    name:        worldForm.name.value.trim(),
    host:        worldForm.host.value.trim(),
    port:        parseInt(worldForm.port.value),
    description: worldForm.description.value.trim(),
  };
  if (editingWorldId) {
    const w = worlds.find(x => x.id === editingWorldId);
    Object.assign(w, data);
    await apiSaveWorld(w, editingWorldId);
    refreshWorldItem(w);
    tabs.forEach(conn => {
      if (conn.world.id === editingWorldId) {
        Object.assign(conn.world, data);
        if (!conn.tabEl.querySelector('.tab-name').textContent.includes('(')) {
          conn.tabEl.querySelector('.tab-name').textContent = data.name;
        }
      }
    });
  } else {
    const result = await apiSaveWorld(data, null);
    result.characters = [];
    worlds.push(result);
    renderWorldList();
  }
  closeWorldModal();
});

// ── Character modal ───────────────────────────────────

function openCharModal(worldId, charId) {
  charModalWorldId = worldId;
  editingCharId = charId || null;
  charModalTitle.textContent = charId ? 'Edit Character' : 'Add Character';
  charForm.reset();
  if (charId) {
    const w = worlds.find(x => x.id === worldId);
    const c = (w?.characters || []).find(x => x.id === charId);
    if (c) charForm.charName.value = c.name;
    // Don't pre-fill password — blank means "keep existing"
  }
  charModalOverlay.classList.remove('hidden');
  charForm.querySelector('input').focus();
}

function closeCharModal() {
  charModalOverlay.classList.add('hidden');
  charModalWorldId = null;
  editingCharId = null;
}

document.getElementById('btn-char-cancel').addEventListener('click', closeCharModal);
charModalOverlay.addEventListener('click', (e) => { if (e.target === charModalOverlay) closeCharModal(); });

charForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name     = charForm.charName.value.trim();
  const password = charForm.password.value;
  const w = worlds.find(x => x.id === charModalWorldId);
  if (!w) return;

  if (editingCharId) {
    const data = { name };
    if (password !== '') data.password = password;
    const updated = await apiUpdateCharacter(charModalWorldId, editingCharId, data);
    const idx = (w.characters || []).findIndex(c => c.id === editingCharId);
    if (idx !== -1) w.characters[idx] = updated;
  } else {
    const char = await apiAddCharacter(charModalWorldId, { name, password });
    if (!w.characters) w.characters = [];
    w.characters.push(char);
  }

  refreshWorldItem(w);
  // Re-open the chars section so the user sees the result
  const section = worldList.querySelector(`[data-world-id="${w.id}"] .chars-section`);
  if (section) section.classList.remove('hidden');

  closeCharModal();
});

// ── Logging ───────────────────────────────────────────

const btnLog = document.getElementById('btn-log');

btnLog.addEventListener('click', () => {
  const conn = tabs.get(activeTabId);
  if (!conn || !conn.connected) return;
  if (conn.logging) {
    conn.ws.send(JSON.stringify({ type: 'stopLog' }));
  } else {
    const label = conn.world.name + (conn.pendingCharacter ? `-${conn.pendingCharacter.name}` : '');
    conn.ws.send(JSON.stringify({ type: 'startLog', label }));
  }
});

function handleLogMessage(conn, msg) {
  if (msg.type === 'logStarted') {
    conn.logging = true;
    conn.logFilename = msg.filename;
    btnLog.classList.add('logging');
    btnLog.title = `Logging to ${msg.filename} — click to stop`;
    conn.term.write(`\r\n\x1b[33m⏺ Logging to logs/${msg.filename}\x1b[0m\r\n`);
    if (activeTabId === conn.id) updateLogBtn(conn);
  }
  if (msg.type === 'logStopped') {
    conn.logging = false;
    conn.logFilename = null;
    conn.term.write(`\r\n\x1b[33m⏹ Logging stopped\x1b[0m\r\n`);
    if (activeTabId === conn.id) updateLogBtn(conn);
  }
}

function updateLogBtn(conn) {
  btnLog.disabled = !conn.connected;
  if (conn.logging) {
    btnLog.classList.add('logging');
    btnLog.title = `Logging to ${conn.logFilename} — click to stop`;
  } else {
    btnLog.classList.remove('logging');
    btnLog.title = 'Toggle session logging';
  }
}

// ── Export / Import ───────────────────────────────────

document.getElementById('btn-export').addEventListener('click', () => {
  const json = JSON.stringify(worlds, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mushclient-worlds-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    footerStatus.textContent = 'Import failed: invalid JSON';
    return;
  }
  if (!Array.isArray(data)) {
    footerStatus.textContent = 'Import failed: file must contain an array of worlds';
    return;
  }
  try {
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    await loadWorlds();
    const skippedNote = result.skipped ? `, ${result.skipped} skipped (already exists)` : '';
    footerStatus.textContent = `Imported ${result.added} world${result.added !== 1 ? 's' : ''}${skippedNote}`;
  } catch (err) {
    footerStatus.textContent = `Import failed: ${err.message}`;
  }
});

// ── MUSH list browser ─────────────────────────────────

const browseOverlay  = document.getElementById('browse-overlay');
const browseSearch   = document.getElementById('browse-search');
const browseStatus   = document.getElementById('browse-status-filter');
const browseServer   = document.getElementById('browse-server-filter');
const browseTbody    = document.getElementById('browse-tbody');
const browseCount    = document.getElementById('browse-count');
const browsePageInfo = document.getElementById('browse-page-info');
const browseEmpty    = document.getElementById('browse-empty');
const btnPrevPage    = document.getElementById('btn-prev-page');
const btnNextPage    = document.getElementById('btn-next-page');

const PAGE_SIZE = 25;
let mlAll = [];
let mlFiltered = [];
let mlPage = 0;
let mlLoaded = false;

document.getElementById('btn-browse').addEventListener('click', openBrowse);
document.getElementById('btn-browse-close').addEventListener('click', () => browseOverlay.classList.add('hidden'));
browseOverlay.addEventListener('click', (e) => { if (e.target === browseOverlay) browseOverlay.classList.add('hidden'); });

browseSearch.addEventListener('input', () => { mlPage = 0; applyFilters(); });
browseStatus.addEventListener('change', () => { mlPage = 0; applyFilters(); });
browseServer.addEventListener('change', () => { mlPage = 0; applyFilters(); });
btnPrevPage.addEventListener('click', () => { if (mlPage > 0) { mlPage--; renderBrowsePage(); } });
btnNextPage.addEventListener('click', () => { const pages = Math.ceil(mlFiltered.length / PAGE_SIZE); if (mlPage < pages - 1) { mlPage++; renderBrowsePage(); } });

async function openBrowse() {
  browseOverlay.classList.remove('hidden');
  if (mlLoaded) return;
  browseTbody.innerHTML = '<tr><td colspan="7" style="padding:30px;text-align:center;color:var(--text2)">Loading…</td></tr>';
  try {
    const res = await fetch('/api/mushlist');
    mlAll = await res.json();
    mlLoaded = true;
    // Populate server filter
    const servers = [...new Set(mlAll.map(e => e.server.replace(/[\s\d.pP]+$/, '').trim()).filter(Boolean))].sort();
    browseServer.innerHTML = '<option value="">All servers</option>' +
      servers.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    mlPage = 0;
    applyFilters();
  } catch (err) {
    browseTbody.innerHTML = `<tr><td colspan="7" style="padding:30px;text-align:center;color:var(--danger)">Failed to load: ${esc(err.message)}</td></tr>`;
  }
}

function applyFilters() {
  const q      = browseSearch.value.trim().toLowerCase();
  const status = browseStatus.value;
  const svrQ   = browseServer.value.replace(/[\s\d.pP]+$/, '').trim().toLowerCase();

  mlFiltered = mlAll.filter(e => {
    if (q && !e.name.toLowerCase().includes(q) && !e.host.toLowerCase().includes(q) && !e.type.toLowerCase().includes(q)) return false;
    if (status && e.status !== status) return false;
    if (svrQ && !e.server.toLowerCase().includes(svrQ)) return false;
    return true;
  });
  renderBrowsePage();
}

function isAlreadyAdded(entry) {
  return worlds.some(w => w.host.toLowerCase() === entry.host && w.port === entry.port);
}

function renderBrowsePage() {
  const total = mlFiltered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  mlPage = Math.min(mlPage, pages - 1);
  const slice = mlFiltered.slice(mlPage * PAGE_SIZE, (mlPage + 1) * PAGE_SIZE);

  const upCount = mlAll.filter(e => e.status === 'UP').length;
  browseCount.textContent = `${total} result${total !== 1 ? 's' : ''} · ${upCount} UP total`;
  browsePageInfo.textContent = `Page ${mlPage + 1} of ${pages}`;
  btnPrevPage.disabled = mlPage === 0;
  btnNextPage.disabled = mlPage >= pages - 1;
  browseEmpty.classList.toggle('hidden', slice.length > 0);

  browseTbody.innerHTML = slice.map(e => {
    const added = isAlreadyAdded(e);
    const dotCls = e.status === 'UP' ? 'up' : e.status === 'DOWN' ? 'down' : '';
    return `<tr>
      <td><span class="browse-dot ${dotCls}" title="${esc(e.status)}"></span></td>
      <td class="browse-name" title="${esc(e.name)}">${esc(e.name)}</td>
      <td class="browse-type" title="${esc(e.type)}">${esc(e.type)}</td>
      <td>${e.players}</td>
      <td>${esc(e.server)}</td>
      <td class="browse-host">${esc(e.host)}:${e.port}</td>
      <td><button class="btn-browse-add ${added ? 'added' : ''}" data-host="${esc(e.host)}" data-port="${e.port}" data-name="${esc(e.name)}" data-type="${esc(e.type)}" ${added ? 'disabled' : ''}>${added ? '✓ Added' : 'Add'}</button></td>
    </tr>`;
  }).join('');

  browseTbody.querySelectorAll('.btn-browse-add:not(.added)').forEach(btn => {
    btn.addEventListener('click', async () => {
      const data = {
        name:        btn.dataset.name,
        host:        btn.dataset.host,
        port:        parseInt(btn.dataset.port),
        description: btn.dataset.type || '',
      };
      const result = await apiSaveWorld(data, null);
      result.characters = [];
      worlds.push(result);
      renderWorldList();
      btn.textContent = '✓ Added';
      btn.classList.add('added');
      btn.disabled = true;
    });
  });
}

// ── Favicon flash ─────────────────────────────────────

const faviconEl = document.getElementById('favicon');

function makeFaviconURI(alert) {
  const color = alert ? '#ff7b72' : '#3fb950';
  const dot = alert ? '<circle cx="26" cy="6" r="6" fill="#ff7b72"/>' : '';
  return 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#0d1117"/><text x="3" y="25" font-family="monospace" font-size="22" font-weight="bold" fill="${color}">&gt;_</text>${dot}</svg>`
  );
}

const FAVICON_NORMAL = makeFaviconURI(false);
const FAVICON_ALERT  = makeFaviconURI(true);
let faviconTimer = null;

function startFaviconFlash() {
  if (faviconTimer) return;
  let on = true;
  faviconEl.href = FAVICON_ALERT;
  faviconTimer = setInterval(() => {
    faviconEl.href = (on = !on) ? FAVICON_ALERT : FAVICON_NORMAL;
  }, 600);
}

function stopFaviconFlash() {
  clearInterval(faviconTimer);
  faviconTimer = null;
  faviconEl.href = FAVICON_NORMAL;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) stopFaviconFlash();
});

// ── Resize ────────────────────────────────────────────

new ResizeObserver(() => {
  tabs.forEach(conn => {
    if (conn.id === activeTabId) {
      conn.fitAddon.fit();
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ type: 'resize', cols: conn.term.cols, rows: conn.term.rows }));
      }
    }
  });
}).observe(termArea);

// ── Mobile sidebar ────────────────────────────────────

const sidebarEl = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

function toggleSidebar() {
  sidebarEl.classList.toggle('mobile-open');
  sidebarOverlay.classList.toggle('mobile-open');
}

function closeSidebar() {
  sidebarEl.classList.remove('mobile-open');
  sidebarOverlay.classList.remove('mobile-open');
}

document.getElementById('btn-sidebar-toggle').addEventListener('click', toggleSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

// ── Boot ──────────────────────────────────────────────

loadWorlds().then(restoreSessions);
