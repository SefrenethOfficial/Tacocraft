// TACOCRAFT LAN server: serves the game page, the PeerJS matchmaking server AND the LAN accounts (TacoMail + leaderboards)
// from this one machine, so friends on the same network can play together without the internet.
// LAN accounts only exist on this server: they're kept in tacocraft-data.json next to this file (passwords are hashed).
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { ExpressPeerServer } = require('peer');

const PORT = +process.env.PORT || 8080;
const ROOT = fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.join(__dirname, '..');   // (the game page: here, or one folder up)
const DATA_FILE = path.join(__dirname, 'tacocraft-data.json');
const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------- the saved data
let db = { users: {}, tokens: {}, messages: [], nextMsg: 1, reports: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
let saveTimer = null;
function save() {                                                        // (written a moment later, so a burst of changes is one write)
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { const tmp = DATA_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DATA_FILE); }, 300);
}
const key = name => String(name || '').trim().toLowerCase();
const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const NAME_OK = /^[A-Za-z0-9_]{3,16}$/;

// ---------------------------------------------------------------- the accounts API (/api/...)
const api = express.Router();
api.use(express.json({ limit: '8kb' }));
const fail = (res, code, msg) => res.status(code).json({ error: msg });
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, ''), k = db.tokens[t];
  if (!k || !db.users[k]) return fail(res, 401, 'Please sign in again.');
  req.user = db.users[k]; next();
}
const session = u => { const t = crypto.randomBytes(24).toString('hex'); db.tokens[t] = key(u.name); save(); return { token: t, username: u.name, user_id: u.id }; };
const tries = {};                                                        // (slows down password guessing: 10 tries a minute per address)
function limited(req) { const k = req.ip, now = Date.now(); tries[k] = (tries[k] || []).filter(t => now - t < 60000); tries[k].push(now); return tries[k].length > 10; }

api.post('/signup', (req, res) => {
  if (limited(req)) return fail(res, 429, 'Too many tries. Wait a minute.');
  const { username, password } = req.body || {};
  if (!NAME_OK.test(username || '')) return fail(res, 400, 'Usernames are 3-16 letters, numbers or _.');
  if (String(password || '').length < 6) return fail(res, 400, 'Passwords need at least 6 characters.');
  if (db.users[key(username)]) return fail(res, 409, 'That username is taken.');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = db.users[key(username)] = { id: crypto.randomUUID(), name: username, salt, hash: hash(password, salt), blocks: [],
    scores: { bosses: 0, kills: 0, coins: 0, playtime: 0 }, created: Date.now() };
  res.json(session(u));
});
api.post('/login', (req, res) => {
  if (limited(req)) return fail(res, 429, 'Too many tries. Wait a minute.');
  const { username, password } = req.body || {}, u = db.users[key(username)];
  if (!u || hash(password, u.salt) !== u.hash) return fail(res, 401, 'Wrong username or password.');
  res.json(session(u));
});
api.post('/logout', auth, (req, res) => { delete db.tokens[(req.headers.authorization || '').replace(/^Bearer /, '')]; save(); res.json({ ok: true }); });

// leaderboards: anyone can look; you can only raise your own scores
const BOARDS = ['bosses', 'kills', 'coins', 'playtime'];
api.get('/scores', (req, res) => {
  const b = BOARDS.includes(req.query.board) ? req.query.board : 'bosses';
  res.json(Object.values(db.users).map(u => ({ username: u.name, user_id: u.id, ...u.scores })).sort((a, z) => z[b] - a[b]).slice(0, 25));
});
api.get('/scores/me', auth, (req, res) => res.json(req.user.scores));
api.post('/scores', auth, (req, res) => {
  const s = req.user.scores, now = Date.now(), b = req.body || {};
  for (const k of ['bosses', 'kills', 'coins']) s[k] = Math.max(s[k], Math.min(1e9, Math.floor(+b[k] || 0)));
  const maxPlay = s.playtime + Math.ceil((now - (req.user.scoredAt || now - 36000e3)) / 1000) + 120;   // (play time can't grow faster than the clock)
  s.playtime = Math.max(s.playtime, Math.min(maxPlay, Math.floor(+b.playtime || 0)));
  req.user.scoredAt = now; save(); res.json(s);
});

// TacoMail
const view = (m, me) => ({ id: m.id, from_id: m.fromId, from_name: m.from, to_name: m.to, body: m.body, read: m.read, created_at: new Date(m.at).toISOString(), mine: m.fromId === me.id });
api.get('/messages', auth, (req, res) => {
  const me = req.user;
  res.json(db.messages.filter(m => m.fromId === me.id || m.toId === me.id).slice(-200).reverse().map(m => view(m, me)));
});
api.post('/messages', auth, (req, res) => {
  const me = req.user, to = db.users[key((req.body || {}).to)], body = String((req.body || {}).body || '').trim();
  if (!body || body.length > 300) return fail(res, 400, 'Messages are 1-300 characters.');
  if (!to) return fail(res, 404, 'There is no player called "' + String((req.body || {}).to).slice(0, 20) + '".');
  if (to.id === me.id) return fail(res, 400, "You can't send a message to yourself.");
  if ((to.blocks || []).includes(me.id)) return fail(res, 403, "That player isn't accepting messages from you.");
  if (db.messages.filter(m => m.fromId === me.id && Date.now() - m.at < 60000).length >= 5) return fail(res, 429, 'Slow down! You can send 5 messages a minute.');
  const m = { id: db.nextMsg++, fromId: me.id, from: me.name, toId: to.id, to: to.name, body, read: false, at: Date.now() };
  db.messages.push(m); if (db.messages.length > 20000) db.messages.splice(0, db.messages.length - 20000);
  save(); res.json(view(m, me));
});
const mineTo = (req, res) => { const m = db.messages.find(x => x.id === +req.params.id && x.toId === req.user.id); if (!m) fail(res, 404, 'Message not found.'); return m; };
api.post('/messages/:id/read', auth, (req, res) => { const m = mineTo(req, res); if (m) { m.read = true; save(); res.json({ ok: true }); } });
api.delete('/messages/:id', auth, (req, res) => { const m = mineTo(req, res); if (m) { db.messages.splice(db.messages.indexOf(m), 1); save(); res.json({ ok: true }); } });
api.post('/messages/:id/block', auth, (req, res) => {
  const m = mineTo(req, res); if (!m) return;
  req.user.blocks = req.user.blocks || []; if (!req.user.blocks.includes(m.fromId)) req.user.blocks.push(m.fromId);
  save(); res.json({ ok: true });
});
api.post('/messages/:id/report', auth, (req, res) => {
  const m = mineTo(req, res); if (!m) return;
  const r = { at: new Date().toISOString(), by: req.user.name, about: m.from, body: m.body, reason: String((req.body || {}).reason || '').slice(0, 200) };
  db.reports.push(r); save();
  console.log('[REPORT] ' + r.by + ' reported ' + r.about + ': "' + r.body + '"' + (r.reason ? ' (' + r.reason + ')' : ''));
  res.json({ ok: true });
});
app.use('/api', api);

// ---------------------------------------------------------------- matchmaking and the game page
app.use('/lan', ExpressPeerServer(server, { allow_discovery: false }));   // matchmaking (the game connects to /lan/)
app.use((req, res, next) => /tacocraft-data|\.json$|\.js$|\.bat$|\.sh$/i.test(req.path) ? res.status(404).end() : next());   // (never hand out the saved accounts or server files)
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.use(express.static(ROOT, { index: 'index.html' }));

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nTACOCRAFT LAN server is running.\n');
  console.log('Everyone on this network opens ONE of these addresses in their browser:');
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log('   http://' + i.address + ':' + PORT);
  console.log('\n(You can use http://localhost:' + PORT + ' on this computer.)');
  console.log('Host: start a world, press Multiplayer > Host, and share the 5-letter code. Friends press Join.');
  console.log('LAN accounts, TacoMail and leaderboards are saved in tacocraft-data.json (reports are printed here).');
  console.log('Keep this window open while playing. Close it to stop.\n');
});
