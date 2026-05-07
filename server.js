const express = require('express');
const { WebSocketServer } = require('ws');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const WORLDS_FILE = path.join(DATA_DIR, 'worlds.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

fs.mkdirSync(LOGS_DIR, { recursive: true });

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const sessions = new Set();

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(rest.join('=').trim());
  }
  return out;
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const token = parseCookies(req.headers.cookie).session;
  return !!(token && sessions.has(token));
}

// ── Password encryption at rest ───────────────────────

function loadSecretKey() {
  if (fs.existsSync(SECRET_FILE)) {
    return Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, key.toString('hex'), { mode: 0o600 });
  return key;
}

const SECRET_KEY = loadSecretKey();

function encryptPassword(plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${data.toString('hex')}`;
}

function decryptPassword(stored) {
  if (!stored || !stored.startsWith('enc:')) return stored; // plaintext passthrough for migration
  try {
    const [, ivHex, tagHex, dataHex] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(dataHex, 'hex')).toString('utf8') + decipher.final('utf8');
  } catch {
    return '';
  }
}

const DEFAULT_WORLDS = [
  {
    id: 'shangrila',
    name: 'Shangrila MUX',
    host: 'shangrilamux.com',
    port: 9999,
    description: 'Adult roleplay MUX — est. 2001'
  }
];

function loadWorlds() {
  try {
    if (fs.existsSync(WORLDS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(WORLDS_FILE, 'utf8'));
      return raw.map(w => ({
        ...w,
        characters: (w.characters || []).map(c => ({ ...c, password: decryptPassword(c.password) })),
      }));
    }
  } catch {}
  return [...DEFAULT_WORLDS];
}

function saveWorlds(worlds) {
  const toSave = worlds.map(w => ({
    ...w,
    characters: (w.characters || []).map(c => ({ ...c, password: encryptPassword(c.password) })),
  }));
  fs.writeFileSync(WORLDS_FILE, JSON.stringify(toSave, null, 2));
}

let worlds = loadWorlds();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

app.get('/login', (req, res) => {
  if (!APP_PASSWORD || isAuthed(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/auth/login', (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.add(token);
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}; Path=/`);
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Max-Age=0; Path=/');
  res.redirect('/login');
});

app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

// Serve logs directory listing
app.get('/api/logs', (req, res) => {
  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.endsWith('.log'))
    .map(f => {
      const stat = fs.statSync(path.join(LOGS_DIR, f));
      return { name: f, size: stat.size, modified: stat.mtime };
    })
    .sort((a, b) => b.modified - a.modified);
  res.json(files);
});

app.get('/api/worlds', (req, res) => res.json(worlds));

app.post('/api/worlds', (req, res) => {
  const { name, host, port, description } = req.body;
  if (!name || !host || !port) return res.status(400).json({ error: 'name, host, and port are required' });
  const world = { id: Date.now().toString(), name, host, port: parseInt(port), description: description || '' };
  worlds.push(world);
  saveWorlds(worlds);
  res.json(world);
});

app.put('/api/worlds/:id', (req, res) => {
  const idx = worlds.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  worlds[idx] = { ...worlds[idx], ...req.body, id: req.params.id, port: parseInt(req.body.port || worlds[idx].port) };
  saveWorlds(worlds);
  res.json(worlds[idx]);
});

app.delete('/api/worlds/:id', (req, res) => {
  worlds = worlds.filter(w => w.id !== req.params.id);
  saveWorlds(worlds);
  res.json({ ok: true });
});

// Characters
app.post('/api/worlds/:id/characters', (req, res) => {
  const world = worlds.find(w => w.id === req.params.id);
  if (!world) return res.status(404).json({ error: 'not found' });
  const { name, password } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!world.characters) world.characters = [];
  const char = { id: Date.now().toString(), name, password: password || '' };
  world.characters.push(char);
  saveWorlds(worlds);
  res.json(char);
});

app.put('/api/worlds/:id/characters/:cid', (req, res) => {
  const world = worlds.find(w => w.id === req.params.id);
  if (!world) return res.status(404).json({ error: 'not found' });
  const idx = (world.characters || []).findIndex(c => c.id === req.params.cid);
  if (idx === -1) return res.status(404).json({ error: 'character not found' });
  const existing = world.characters[idx];
  world.characters[idx] = {
    id: existing.id,
    name: req.body.name || existing.name,
    password: req.body.password !== '' ? req.body.password : existing.password,
  };
  saveWorlds(worlds);
  res.json(world.characters[idx]);
});

app.post('/api/import', (req, res) => {
  const incoming = req.body;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'expected an array' });
  let added = 0, skipped = 0;
  for (const w of incoming) {
    if (!w.name || !w.host || !w.port) { skipped++; continue; }
    const host = String(w.host).toLowerCase().trim();
    const port = parseInt(w.port);
    if (!port) { skipped++; continue; }
    if (worlds.some(x => x.host.toLowerCase() === host && x.port === port)) { skipped++; continue; }
    const mkId = () => Date.now().toString() + Math.random().toString(36).slice(2, 6);
    const chars = Array.isArray(w.characters)
      ? w.characters.map(c => ({ id: mkId(), name: String(c.name || '').trim(), password: String(c.password || '') })).filter(c => c.name)
      : [];
    worlds.push({ id: mkId(), name: String(w.name).trim(), host, port, description: String(w.description || '').trim(), characters: chars });
    added++;
  }
  if (added > 0) saveWorlds(worlds);
  res.json({ added, skipped });
});

app.delete('/api/worlds/:id/characters/:cid', (req, res) => {
  const world = worlds.find(w => w.id === req.params.id);
  if (!world) return res.status(404).json({ error: 'not found' });
  world.characters = (world.characters || []).filter(c => c.id !== req.params.cid);
  saveWorlds(worlds);
  res.json({ ok: true });
});

// ── MUSH list browser ─────────────────────────────────

let mlCache = null;
let mlCacheAt = 0;
const ML_TTL = 5 * 60 * 1000;

function fetchUrl(url, hops = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'MUSHClient/1.0' } }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && hops > 0) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
        return fetchUrl(next, hops - 1).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseMushlist(html) {
  const out = [];
  const seen = new Set();
  const trRx = /<tr[\s>]([\s\S]*?)<\/tr>/gi;
  let trM;
  while ((trM = trRx.exec(html))) {
    const row = trM[1];
    const tlM = row.match(/href=["']telnet:\/\/([^:'"]+):(\d+)["']/i);
    if (!tlM) continue;
    const host = tlM[1].trim().toLowerCase();
    const port = parseInt(tlM[2]);
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Extract TD text contents in order
    const tds = [];
    const tdRx = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdM;
    while ((tdM = tdRx.exec(row))) {
      tds.push(tdM[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim());
    }
    if (tds.length < 1) continue;

    // Name is the first non-empty TD; strip host:port if it leaked in
    let name = tds[0] || '';
    if (!name) {
      const nlM = row.match(/<a[^>]+>([\s\S]*?)<\/a>/i);
      if (nlM) name = nlM[1].replace(/<[^>]+>/g,'').trim();
    }
    // Remove "host port" suffix that sometimes appears in the same cell
    name = name.replace(new RegExp(`\\s*${host.replace(/\./g,'\\.')}\\s*${port}\\s*`, 'i'), '').trim();
    if (!name || name.toLowerCase() === key) continue;

    const status = /\bUP\b/.test(row) ? 'UP' : /\bDOWN\b/.test(row) ? 'DOWN' : 'UNKNOWN';

    // Player count: first numeric-only TD that isn't the port
    const players = tds
      .filter(t => /^\d+$/.test(t) && parseInt(t) !== port)
      .map(Number)[0] ?? 0;

    // Server software
    const svrM = row.match(/\b(PennMUSH[\s\d.pP]*|TinyMUX[\s\d.]*|TinyMUSH[\s\d.]*|RhostMUSH[\s\d.]*|NetMUSH[\s\d.]*|Firan[\s\d.]*)/i);
    const server = svrM ? svrM[0].trim() : '';

    // Type: first TD that's not name, not digits, not status word, not server name
    let type = '';
    for (let i = 1; i < tds.length; i++) {
      const t = tds[i];
      if (t && !/^(UP|DOWN|UNKNOWN)$/i.test(t) && !/^\d+$/.test(t) && !/Penn|MUX|Tiny|Rhost|Firan/i.test(t) && !t.includes(host)) {
        type = t; break;
      }
    }

    out.push({ name, host, port, status, players, server, type });
  }
  return out;
}

app.get('/api/mushlist', async (req, res) => {
  try {
    const now = Date.now();
    if (!mlCache || now - mlCacheAt > ML_TTL) {
      const html = await fetchUrl('http://mushcode.com/mushlist');
      mlCache = parseMushlist(html);
      mlCacheAt = now;
    }
    res.json(mlCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Telnet IAC ────────────────────────────────────────

const IAC = 255, WILL = 251, WONT = 252, DO = 253, DONT = 254;
const SB = 250, SE = 240, GA = 249, EOR = 239;
const NAWS = 31;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function makeTelnetProcessor(sendToMux) {
  let state = 'data';
  let sbBuf = [];
  return function process(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      switch (state) {
        case 'data':
          if (b === IAC) state = 'iac'; else out.push(b); break;
        case 'iac':
          if (b === WILL) state = 'will';
          else if (b === WONT) state = 'wont';
          else if (b === DO) state = 'do';
          else if (b === DONT) state = 'dont';
          else if (b === SB) { state = 'sb'; sbBuf = []; }
          else if (b === GA || b === EOR) state = 'data';
          else if (b === IAC) { out.push(255); state = 'data'; }
          else state = 'data';
          break;
        case 'will': sendToMux(Buffer.from([IAC, DONT, b])); state = 'data'; break;
        case 'wont': state = 'data'; break;
        case 'do':
          if (b === NAWS) {
            sendToMux(Buffer.from([IAC, WILL, NAWS]));
            sendToMux(Buffer.from([IAC, SB, NAWS, 0, 220, 0, 50, IAC, SE]));
          } else {
            sendToMux(Buffer.from([IAC, WONT, b]));
          }
          state = 'data'; break;
        case 'dont': sendToMux(Buffer.from([IAC, WONT, b])); state = 'data'; break;
        case 'sb': if (b === IAC) state = 'sb_iac'; else sbBuf.push(b); break;
        case 'sb_iac': if (b === SE) state = 'data'; else { sbBuf.push(b); state = 'sb'; } break;
      }
    }
    return out.length > 0 ? Buffer.from(out) : null;
  };
}

// ── WebSocket proxy ───────────────────────────────────

wss.on('connection', (ws, req) => {
  if (!isAuthed(req)) { ws.close(1008, 'Unauthorized'); return; }
  let tcp = null;
  let logStream = null;

  const telnet = makeTelnetProcessor((data) => {
    if (tcp && !tcp.destroyed) tcp.write(data);
  });

  function send(obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'connect') {
      if (tcp) tcp.destroy();
      tcp = net.createConnection(msg.port, msg.host);
      tcp.on('connect', () => send({ type: 'status', connected: true }));
      tcp.on('data', (data) => {
        const clean = telnet(data);
        if (clean) {
          send({ type: 'data', data: clean.toString('base64') });
          if (logStream) {
            const text = clean.toString('utf8').replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            logStream.write(text);
          }
        }
      });
      tcp.on('error', (err) => send({ type: 'error', message: err.message }));
      tcp.on('close', () => {
        send({ type: 'status', connected: false });
        if (logStream) { logStream.write('\n--- Session ended ---\n'); logStream.end(); logStream = null; }
      });
    }

    if (msg.type === 'input' && tcp && !tcp.destroyed) {
      tcp.write(msg.data + '\r\n');
      if (logStream) logStream.write(`> ${msg.data}\n`);
    }

    if (msg.type === 'resize' && tcp && !tcp.destroyed) {
      const c = msg.cols, r = msg.rows;
      tcp.write(Buffer.from([IAC, SB, NAWS, (c >> 8) & 0xFF, c & 0xFF, (r >> 8) & 0xFF, r & 0xFF, IAC, SE]));
    }

    if (msg.type === 'startLog') {
      if (logStream) { logStream.end(); logStream = null; }
      const safe = (msg.label || 'session').replace(/[^a-z0-9_-]/gi, '_');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${safe}-${ts}.log`;
      const fullPath = path.join(LOGS_DIR, filename);
      logStream = fs.createWriteStream(fullPath, { flags: 'a' });
      logStream.write(`--- Session started ${new Date().toISOString()} ---\n`);
      send({ type: 'logStarted', filename });
    }

    if (msg.type === 'stopLog' && logStream) {
      logStream.write(`--- Session ended ${new Date().toISOString()} ---\n`);
      logStream.end(); logStream = null;
      send({ type: 'logStopped' });
    }

    if (msg.type === 'disconnect') {
      if (tcp) { tcp.destroy(); tcp = null; }
    }
  });

  ws.on('close', () => {
    if (tcp) tcp.destroy();
    if (logStream) { logStream.end(); logStream = null; }
  });
});

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`MUSH client → http://localhost:${PORT}`);
});
