// خادم لعبة المافيا — بدون أي مكتبات خارجية (Node.js فقط): HTTP + Server-Sent Events
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const T = { reveal: 120, night: 60, day: 180, vote: 60, result: 9 }; // مدد المراحل بالثواني
const rooms = new Map();
const rnd = n => Math.floor(Math.random() * n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const uid = () => crypto.randomBytes(8).toString('hex');
const clamp = (v, a, b) => Math.max(a, Math.min(b, parseInt(v) || a));
const newCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s; do { s = Array.from({ length: 5 }, () => c[rnd(c.length)]).join(''); } while (rooms.has(s)); return s; };
const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16);

const alive = r => r.players.filter(p => p.alive);
const sys = (r, text) => r.chat.push({ sys: 1, text, t: Date.now() });
function setPhase(r, phase, secs, fn) {
  clearTimeout(r.timer); r.phase = phase;
  r.deadline = secs ? Date.now() + secs * 1000 : null;
  r.timer = secs ? setTimeout(() => { fn(); push(r); }, secs * 1000) : null;
}
function startNight(r) {
  r.round++; r.acts = {}; r.lastResult = null;
  setPhase(r, 'night', T.night, () => resolveNight(r));
}
function checkWin(r) {
  const m = alive(r).filter(p => p.role === 'mafia').length, o = alive(r).length - m;
  const w = m === 0 ? 'citizens' : m >= o ? 'mafia' : null;
  if (w) { r.winner = w; setPhase(r, 'over', 0); sys(r, w === 'citizens' ? 'انتهت اللعبة: فاز المواطنون!' : 'انتهت اللعبة: فازت المافيا!'); }
  return !!w;
}
function resolveNight(r) {
  const picks = {}; let saved = null;
  for (const p of alive(r)) {
    const a = r.acts[p.id]; if (!a) continue;
    if (p.role === 'mafia') picks[a.target] = (picks[a.target] || 0) + 1;
    if (p.role === 'doctor') saved = a.target;
  }
  const max = Math.max(0, ...Object.values(picks));
  const top = Object.keys(picks).filter(k => picks[k] === max);
  const tid = top.length ? top[rnd(top.length)] : null, t = r.players.find(p => p.id === tid);
  if (t && t.id !== saved) {
    t.alive = false; r.announce = { kind: 'kill', name: t.name, role: t.role };
    sys(r, `قُتل ${t.name} في الليل — كان ${ROLE_AR[t.role]}.`);
  } else {
    r.announce = { kind: 'none', saved: !!t };
    sys(r, t ? 'حاولت المافيا القتل، لكن الدكتور أنقذ الضحية!' : 'مرّت الليلة بسلام، لم يُقتل أحد.');
  }
  if (checkWin(r)) return;
  r.ready = new Set(); sys(r, `— النهار ${r.round}: ابدأوا النقاش —`);
  setPhase(r, 'day', T.day, () => startVote(r));
}
function startVote(r) { r.votes = {}; setPhase(r, 'vote', T.vote, () => resolveVote(r)); }
const ROLE_AR = { mafia: 'من المافيا', detective: 'المحقق', doctor: 'الدكتور', citizen: 'مواطناً' };
function resolveVote(r) {
  const c = {};
  for (const v of Object.values(r.votes)) c[v] = (c[v] || 0) + 1;
  const tally = Object.entries(c).map(([id, n]) => ({ name: id === 'skip' ? 'امتناع' : r.players.find(p => p.id === id).name, n })).sort((a, b) => b.n - a.n);
  const max = Math.max(0, ...Object.values(c)), top = Object.keys(c).filter(k => c[k] === max);
  if (top.length !== 1 || top[0] === 'skip') {
    r.lastResult = { none: true, tally }; sys(r, 'تعادلت الأصوات أو تم الامتناع، لم يُقصَ أحد.');
  } else {
    const p = r.players.find(x => x.id === top[0]); p.alive = false;
    const innocent = p.role !== 'mafia';
    r.lastResult = { name: p.name, role: p.role, innocent, tally };
    sys(r, innocent ? `أُقصي ${p.name} — كان بريئاً (${ROLE_AR[p.role].replace('من ', '')})!` : `أُقصي ${p.name} — كان من المافيا!`);
  }
  if (checkWin(r)) return;
  setPhase(r, 'result', T.result, () => startNight(r));
}
function view(r, pid) {
  const me = r.players.find(p => p.id === pid), over = r.phase === 'over', mafMe = me.role === 'mafia';
  return {
    code: r.code, phase: r.phase, round: r.round, max: r.max, mafia: r.mafia, deadline: r.deadline, winner: r.winner,
    isHost: r.host === pid, announce: r.announce, result: ['result', 'over'].includes(r.phase) ? r.lastResult : null,
    players: r.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive, host: p.id === r.host, seen: p.seen,
      role: (!p.alive || over || p.id === pid || (mafMe && p.role === 'mafia')) ? p.role : null
    })),
    me: { id: pid, role: me.role, alive: me.alive, checks: me.checks, act: (r.acts[pid] || {}).target || null, vote: r.votes[pid] || null, ready: r.ready.has(pid), seen: me.seen },
    chat: r.chat.slice(-100)
  };
}
function push(r) {
  for (const [pid, set] of r.clients) for (const res of set) res.write(`data: ${JSON.stringify(view(r, pid))}\n\n`);
}
function api(b) {
  const t = b.type;
  if (t === 'create') {
    const name = clean(b.name); if (!name) return { error: 'اكتب اسمك أولاً' };
    const max = clamp(b.max, 4, 12), mafia = clamp(b.mafia, 1, Math.floor((max - 1) / 2));
    const r = { code: newCode(), host: null, max, mafia, phase: 'lobby', round: 0, players: [], chat: [], clients: new Map(), acts: {}, votes: {}, ready: new Set(), timer: null, deadline: null, winner: null, announce: null, lastResult: null, last: Date.now() };
    const p = { id: uid(), name, alive: true, role: null, seen: false, checks: [] };
    r.host = p.id; r.players.push(p); rooms.set(r.code, r);
    return { ok: 1, code: r.code, pid: p.id };
  }
  const r = rooms.get(String(b.code || '').toUpperCase());
  if (t === 'join') {
    const name = clean(b.name); if (!name) return { error: 'اكتب اسمك أولاً' };
    if (!r) return { error: 'كود الغرفة غير صحيح' };
    if (r.phase !== 'lobby') return { error: 'اللعبة بدأت بالفعل' };
    if (r.players.length >= r.max) return { error: 'الغرفة ممتلئة' };
    if (r.players.some(p => p.name === name)) return { error: 'الاسم مستخدم، اختر اسماً آخر' };
    const p = { id: uid(), name, alive: true, role: null, seen: false, checks: [] };
    r.players.push(p); sys(r, `${name} انضم إلى الغرفة`); push(r);
    return { ok: 1, code: r.code, pid: p.id };
  }
  const me = r && r.players.find(p => p.id === b.pid);
  if (!me) return { error: 'الغرفة أو اللاعب غير موجود' };
  r.last = Date.now();
  const target = () => r.players.find(p => p.id === b.target && p.alive);
  switch (t) {
    case 'start': {
      if (r.host !== me.id || r.phase !== 'lobby') return { error: 'غير مسموح' };
      const n = r.players.length; if (n < 4) return { error: 'تحتاج 4 لاعبين على الأقل' };
      r.mafia = Math.min(r.mafia, Math.floor((n - 1) / 2));
      const roles = shuffle([...Array(r.mafia).fill('mafia'), 'detective', 'doctor', ...Array(n - r.mafia - 2).fill('citizen')]);
      r.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.seen = false; p.checks = []; });
      r.round = 0; r.winner = null; r.announce = null; r.chat = [];
      sys(r, 'بدأت اللعبة! كل لاعب يكشف دوره سرّاً.');
      setPhase(r, 'reveal', T.reveal, () => startNight(r)); break;
    }
    case 'seen':
      if (r.phase !== 'reveal') break; me.seen = true;
      if (r.players.every(p => p.seen)) startNight(r); break;
    case 'night': {
      const tg = target();
      if (r.phase !== 'night' || !me.alive || r.acts[me.id] || !tg) return { error: 'إجراء غير صالح' };
      if (me.role === 'mafia' && tg.role === 'mafia') return { error: 'لا يمكنك استهداف زميلك' };
      if (me.role === 'detective' && tg.id === me.id) return { error: 'لا يمكنك التحقق من نفسك' };
      if (!['mafia', 'detective', 'doctor'].includes(me.role)) return { error: 'ليس لديك قدرة' };
      r.acts[me.id] = { target: tg.id };
      if (me.role === 'detective') me.checks.push({ name: tg.name, mafia: tg.role === 'mafia', round: r.round });
      const actors = alive(r).filter(p => ['mafia', 'detective', 'doctor'].includes(p.role));
      if (actors.every(p => r.acts[p.id])) resolveNight(r); break;
    }
    case 'ready':
      if (r.phase !== 'day' || !me.alive) break;
      r.ready.has(me.id) ? r.ready.delete(me.id) : r.ready.add(me.id);
      if (alive(r).every(p => r.ready.has(p.id))) startVote(r); break;
    case 'vote': {
      if (r.phase !== 'vote' || !me.alive || r.votes[me.id]) return { error: 'لا يمكنك التصويت' };
      if (b.target !== 'skip' && !target()) return { error: 'اختيار غير صالح' };
      r.votes[me.id] = b.target;
      if (alive(r).every(p => r.votes[p.id])) resolveVote(r); break;
    }
    case 'chat': {
      const text = String(b.text || '').trim().slice(0, 300);
      if (!text || !(me.alive || ['lobby', 'over'].includes(r.phase)) || ['reveal', 'night'].includes(r.phase)) return { error: 'لا يمكنك الكتابة الآن' };
      r.chat.push({ from: me.id, name: me.name, text, t: Date.now() }); break;
    }
    case 'again':
      if (r.host !== me.id || r.phase !== 'over') return { error: 'غير مسموح' };
      r.players.forEach(p => { p.role = null; p.alive = true; p.checks = []; p.seen = false; });
      r.winner = null; r.announce = null; r.lastResult = null; r.chat = []; setPhase(r, 'lobby', 0); break;
    case 'leave':
      if (r.phase !== 'lobby') break;
      r.players = r.players.filter(p => p.id !== me.id);
      if (!r.players.length) { rooms.delete(r.code); return { ok: 1 }; }
      if (r.host === me.id) r.host = r.players[0].id;
      sys(r, `${me.name} غادر الغرفة`); break;
    default: return { error: 'طلب غير معروف' };
  }
  push(r); return { ok: 1 };
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/events') {
    const r = rooms.get((u.searchParams.get('code') || '').toUpperCase()), pid = u.searchParams.get('pid');
    if (!r || !r.players.some(p => p.id === pid)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (!r.clients.has(pid)) r.clients.set(pid, new Set()); r.clients.get(pid).add(res);
    res.write(`data: ${JSON.stringify(view(r, pid))}\n\n`);
    const hb = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(hb); r.clients.get(pid) && r.clients.get(pid).delete(res); });
    return;
  }
  if (u.pathname === '/api' && req.method === 'POST') {
    let body = ''; req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      let out; try { out = api(JSON.parse(body)); } catch (e) { out = { error: 'طلب غير صالح' }; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(out));
    }); return;
  }
  const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d);
  });
}).listen(PORT, () => console.log(`Mafia game running on http://localhost:${PORT}`));
setInterval(() => { for (const [c, r] of rooms) if (Date.now() - r.last > 6 * 3600e3) { clearTimeout(r.timer); rooms.delete(c); } }, 600e3);
