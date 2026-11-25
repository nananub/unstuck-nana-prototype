// UnStuck backend
// - Serves the website.
// - Forwards AI requests to Google Gemini (the API key stays on the server).
// - Records anonymous usage stats and shows them on a password-protected /admin page.
// No npm packages needed: run with `npm start` (Node 18+).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---- Load .env (simple KEY=value lines) when running locally. Render sets env vars itself. ----
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file: fine on Render */ }

// Trim spaces, line breaks and quotes that often sneak in when a value is pasted.
const env = name => String(process.env[name] || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const isPlaceholder = value => !value || /paste|your-key|your-password|change-me/i.test(value);

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = isPlaceholder(env('GEMINI_API_KEY')) ? '' : env('GEMINI_API_KEY');
const MODEL = env('GEMINI_MODEL') || 'gemini-3.8-flash';
const GEMINI_BASE = (env('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const ALLOWED_ORIGINS = env('ALLOWED_ORIGINS').split(',').map(origin => origin.trim()).filter(Boolean);
const RATE_LIMIT = Number(env('RATE_LIMIT_PER_MINUTE')) || 20;
const ADMIN_PASSWORD = isPlaceholder(env('ADMIN_PASSWORD')) ? '' : env('ADMIN_PASSWORD');
const SUPABASE_URL = env('SUPABASE_URL').replace(/\/$/, '');
const SUPABASE_KEY = isPlaceholder(env('SUPABASE_SECRET_KEY')) ? '' : env('SUPABASE_SECRET_KEY');
const SUPABASE_TABLE = env('SUPABASE_TABLE') || 'unstuck_events';
const useDatabase = Boolean(SUPABASE_URL && SUPABASE_KEY);
const MAX_BODY = 1_500_000;

// Only these files are public. Everything else (server.js, .env, admin.html…) is never served directly.
const PUBLIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/writer-desktop.html': 'writer-desktop.html',
  '/writer-phone.html': 'writer-phone.html'
};

// ---------- helpers ----------
function makeLimiter(perMinute) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [ip, times] of hits) if (times.every(time => now - time > 60_000)) hits.delete(ip); }, 60_000).unref();
  return ip => {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(time => now - time < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > perMinute;
  };
}
const aiLimited = makeLimiter(RATE_LIMIT);
const trackLimited = makeLimiter(120);
const loginLimited = makeLimiter(10);
const clientIp = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function send(res, status, body, headers = {}) {
  const isJson = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !(ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Request is too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const clip = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;
const fraction = value => Number.isFinite(value) ? Math.min(1, Math.max(0, Math.round(value * 10000) / 10000)) : null;
const whole = value => Number.isFinite(value) ? Math.max(0, Math.min(100000, Math.round(value))) : null;

// ---------- event storage: Supabase (persistent) or memory (resets on restart) ----------
const memoryEvents = [];
function supabaseHeaders(extra = {}) {
  // New Supabase secret keys (sb_secret_…) go on the apikey header only; old JWT keys also need Authorization.
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', ...extra };
  if (!SUPABASE_KEY.startsWith('sb_')) headers.Authorization = 'Bearer ' + SUPABASE_KEY;
  return headers;
}
async function storeEvents(rows) {
  if (!rows.length) return;
  if (!useDatabase) {
    memoryEvents.push(...rows);
    if (memoryEvents.length > 50_000) memoryEvents.splice(0, memoryEvents.length - 50_000);
    return;
  }
  try {
    const response = await fetch(SUPABASE_URL + '/rest/v1/' + SUPABASE_TABLE, {
      method: 'POST', headers: supabaseHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(rows), signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) console.error('Supabase insert failed', response.status, (await response.text()).slice(0, 300));
  } catch (error) { console.error('Supabase insert failed:', error.message); }
}
async function loadEvents(sinceIso) {
  if (!useDatabase) return memoryEvents.filter(event => !sinceIso || event.ts >= sinceIso);
  const rows = [];
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const query = 'select=ts,visitor,session,type,page,action,label,x,y,vw,vh,edition,meta&order=ts.asc&limit=1000&offset=' + offset +
      (sinceIso ? '&ts=gte.' + encodeURIComponent(sinceIso) : '');
    const response = await fetch(SUPABASE_URL + '/rest/v1/' + SUPABASE_TABLE + '?' + query, { headers: supabaseHeaders(), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Supabase read failed (' + response.status + '): ' + (await response.text()).slice(0, 200));
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

// ---------- POST /api/track: anonymous usage events from the app ----------
const EVENT_TYPES = new Set(['view', 'click']);
async function handleTrack(req, res, cors) {
  if (trackLimited(clientIp(req))) return send(res, 429, { error: 'Slow down.' }, cors);
  let input;
  try { input = JSON.parse(await readBody(req, 64_000)); } catch { return send(res, 400, { error: 'Bad request.' }, cors); }
  const visitor = clip(input?.visitor, 40), session = clip(input?.session, 40), edition = input?.edition === 'phone' ? 'phone' : 'desktop';
  const now = Date.now();
  const rows = (Array.isArray(input?.events) ? input.events : []).slice(0, 50)
    .filter(event => EVENT_TYPES.has(event?.type))
    .map(event => ({
      ts: new Date(Number.isFinite(event.t) && Math.abs(now - event.t) < 600_000 ? event.t : now).toISOString(),
      visitor, session, edition, type: event.type,
      page: clip(event.page, 30), action: clip(event.action, 40), label: clip(event.label, 60),
      x: fraction(event.x), y: fraction(event.y), vw: whole(event.vw), vh: whole(event.vh),
      meta: event.docMode ? { doc: true } : null
    }));
  await storeEvents(rows);
  send(res, 204, '', cors);
}

// ---------- POST /api/ai  { system, prompt, kind?, visitor?, session? }  ->  { text } ----------
const AI_KINDS = new Set(['scan', 'suggest', 'characters', 'test']);
async function handleAI(req, res, cors) {
  if (!API_KEY) return send(res, 503, { error: 'The server has no GEMINI_API_KEY set.' }, cors);
  if (aiLimited(clientIp(req))) return send(res, 429, { error: 'Too many AI requests. Wait a minute and try again.' }, cors);

  let input;
  try { input = JSON.parse(await readBody(req)); }
  catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'Request must be JSON.' }, cors); }
  const { system, prompt } = input || {};
  if (typeof system !== 'string' || typeof prompt !== 'string' || !prompt.trim() || system.length > 20_000 || prompt.length > 1_200_000) {
    return send(res, 400, { error: 'Request needs a "system" and a "prompt" string.' }, cors);
  }
  const started = Date.now();
  const logAI = (ok, status) => storeEvents([{
    ts: new Date().toISOString(), visitor: clip(input.visitor, 40), session: clip(input.session, 40), edition: null,
    type: 'ai', page: null, action: AI_KINDS.has(input.kind) ? input.kind : 'other', label: ok ? 'ok' : 'error',
    x: null, y: null, vw: null, vh: null, meta: { ms: Date.now() - started, status, chars: prompt.length }
  }]);

  let upstream;
  try {
    upstream = await fetch(GEMINI_BASE + '/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      }),
      signal: AbortSignal.timeout(120_000)
    });
  } catch (error) {
    console.error('Gemini request failed:', error.message);
    logAI(false, 0);
    return send(res, 502, { error: 'The server could not reach the AI service.' }, cors);
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    console.error('Gemini error', upstream.status, data.error?.message);
    logAI(false, upstream.status);
    const reason = data.error?.details?.find(detail => detail.reason)?.reason || data.error?.status || '';
    const keyProblem = /api[ _-]?key/i.test((data.error?.message || '') + ' ' + reason);
    const message = upstream.status === 429 ? 'The free AI quota is used up for now. Try again in a minute, or tomorrow.'
      : keyProblem ? 'Google rejected the server’s API key (' + (reason || upstream.status) + '): ' + (data.error?.message || '') +
        ' Make a new key in Google AI Studio and update GEMINI_API_KEY, then restart or redeploy the server.'
      : data.error?.message || 'The AI service returned an error.';
    return send(res, upstream.status === 429 ? 429 : 502, { error: message }, cors);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).filter(part => !part.thought && part.text).map(part => part.text).join('');
  if (!text) {
    logAI(false, 200);
    return send(res, 502, { error: data.promptFeedback?.blockReason ? 'The AI declined this request.' : 'The AI returned an empty answer. Try again.' }, cors);
  }
  logAI(true, 200);
  send(res, 200, { text, model: MODEL }, cors);
}

// ---------- admin: password check (browser login box) ----------
function adminAllowed(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
function requireAdmin(req, res) {
  if (!ADMIN_PASSWORD) {
    send(res, 503, 'The admin page is off. Set ADMIN_PASSWORD in .env (locally) or in Render’s environment variables, then restart.');
    return false;
  }
  if (adminAllowed(req)) return true;
  if (req.headers.authorization && loginLimited(clientIp(req))) { send(res, 429, 'Too many attempts. Wait a minute.'); return false; }
  send(res, 401, 'Admin password required.', { 'WWW-Authenticate': 'Basic realm="UnStuck admin", charset="UTF-8"', 'Cache-Control': 'no-store' });
  return false;
}

// ---------- GET /api/admin/stats?days=1|7|30|0 ----------
function summarise(events, days) {
  const visitors = new Set(), sessions = new Set();
  const byDay = new Map(), pages = new Map(), clicks = new Map(), ai = new Map(), editions = { desktop: new Set(), phone: new Set() };
  const points = {};
  let pageViews = 0, clickCount = 0, aiRequests = 0, aiErrors = 0;
  const dayOf = ts => ts.slice(0, 10);
  const day = ts => {
    const key = dayOf(ts);
    if (!byDay.has(key)) byDay.set(key, { date: key, visitors: new Set(), pageViews: 0, clicks: 0, ai: 0 });
    return byDay.get(key);
  };
  for (const event of events) {
    if (event.visitor) visitors.add(event.visitor);
    if (event.session) sessions.add(event.session);
    if (event.visitor && editions[event.edition]) editions[event.edition].add(event.visitor);
    const bucket = day(event.ts);
    if (event.visitor) bucket.visitors.add(event.visitor);
    if (event.type === 'view') {
      pageViews++; bucket.pageViews++;
      const entry = pages.get(event.page) || { page: event.page || 'unknown', views: 0, visitors: new Set() };
      entry.views++; if (event.visitor) entry.visitors.add(event.visitor);
      pages.set(event.page, entry);
    } else if (event.type === 'click') {
      clickCount++; bucket.clicks++;
      const key = (event.page || '') + '|' + (event.action || '') + '|' + (event.label || '');
      const entry = clicks.get(key) || { page: event.page, action: event.action, label: event.label, count: 0 };
      entry.count++;
      clicks.set(key, entry);
      if (event.x !== null && event.y !== null && event.page) {
        const group = (points[(event.edition || 'desktop') + ':' + event.page] ??= []);
        if (group.length < 3000) group.push([event.x, event.y, event.meta?.doc ? 1 : 0]);
      }
    } else if (event.type === 'ai') {
      aiRequests++; bucket.ai++;
      const entry = ai.get(event.action) || { kind: event.action, count: 0, failures: 0, totalMs: 0 };
      entry.count++; entry.totalMs += event.meta?.ms || 0;
      if (event.label !== 'ok') { entry.failures++; aiErrors++; }
      ai.set(event.action, entry);
    }
  }
  // Fill empty days so the chart has no gaps.
  const daily = [];
  const span = days || Math.max(1, Math.min(90, Math.ceil((Date.now() - Date.parse(events[0]?.ts || new Date().toISOString())) / 86_400_000) + 1));
  for (let i = span - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const bucket = byDay.get(key);
    daily.push({ date: key, visitors: bucket ? bucket.visitors.size : 0, pageViews: bucket?.pageViews || 0, clicks: bucket?.clicks || 0, ai: bucket?.ai || 0 });
  }
  return {
    storage: useDatabase ? 'supabase' : 'memory',
    generatedAt: new Date().toISOString(),
    totals: { visitors: visitors.size, sessions: sessions.size, pageViews, clicks: clickCount, aiRequests, aiErrors },
    editions: { desktop: editions.desktop.size, phone: editions.phone.size },
    daily,
    pages: [...pages.values()].map(entry => ({ page: entry.page, views: entry.views, visitors: entry.visitors.size })).sort((a, b) => b.views - a.views),
    topClicks: [...clicks.values()].sort((a, b) => b.count - a.count).slice(0, 25),
    ai: [...ai.values()].map(entry => ({ kind: entry.kind, count: entry.count, failures: entry.failures, avgSeconds: Math.round(entry.totalMs / entry.count / 100) / 10 })).sort((a, b) => b.count - a.count),
    clickPoints: points,
    recent: events.slice(-40).reverse().map(({ ts, type, page, action, label, edition }) => ({ ts, type, page, action, label, edition }))
  };
}
function sinceFor(days) { return days ? new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z' : ''; }

async function handleAdmin(req, res, pathname, searchParams) {
  if (!requireAdmin(req, res)) return;
  if (pathname === '/admin' || pathname === '/admin/') {
    const body = await fs.promises.readFile(path.join(ROOT, 'admin.html'));
    return send(res, 200, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  const days = [0, 1, 7, 30, 90].includes(Number(searchParams.get('days'))) ? Number(searchParams.get('days')) : 7;
  let events;
  try { events = await loadEvents(sinceFor(days)); }
  catch (error) { console.error(error.message); return send(res, 502, { error: 'Could not read stats from Supabase. Check SUPABASE_URL, SUPABASE_SECRET_KEY and that the table exists.' }); }
  if (pathname === '/api/admin/stats') return send(res, 200, summarise(events, days), { 'Cache-Control': 'no-store' });
  if (pathname === '/api/admin/export.csv') {
    const columns = ['ts', 'type', 'page', 'action', 'label', 'edition', 'x', 'y', 'vw', 'vh', 'visitor', 'session'];
    const cell = value => { const text = value === null || value === undefined ? '' : String(value); return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text; };
    const csv = [columns.join(','), ...events.map(event => columns.map(column => cell(event[column])).join(','))].join('\n');
    return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="unstuck-events.csv"', 'Cache-Control': 'no-store' });
  }
  send(res, 404, { error: 'Not found.' });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  const cors = corsHeaders(req);
  try {
    if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) return send(res, 204, '', cors);
    if (pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, ai: Boolean(API_KEY), model: MODEL, tracking: true }, cors);
    if (pathname === '/api/ai') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' }, cors);
      return await handleAI(req, res, cors);
    }
    if (pathname === '/api/track') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' }, cors);
      return await handleTrack(req, res, cors);
    }
    if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/api/admin/')) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
      return await handleAdmin(req, res, pathname, searchParams);
    }
    const file = PUBLIC_FILES[pathname];
    if (file && (req.method === 'GET' || req.method === 'HEAD')) {
      const body = await fs.promises.readFile(path.join(ROOT, file));
      return send(res, 200, req.method === 'HEAD' ? '' : body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    send(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: 'Server error.' });
  }
});

server.listen(PORT, () => {
  console.log('UnStuck is running at http://localhost:' + PORT);
  console.log(API_KEY ? 'AI is on (model ' + MODEL + '). Key loaded: ' + API_KEY.slice(0, 4) + '…' + API_KEY.slice(-4) + ' (' + API_KEY.length + ' characters).'
    : 'AI is off: add GEMINI_API_KEY to .env (locally) or to Render’s environment variables.');
  console.log(ADMIN_PASSWORD ? 'Admin page: /admin' : 'Admin page is off: set ADMIN_PASSWORD.');
  console.log(useDatabase ? 'Stats are saved to Supabase (table ' + SUPABASE_TABLE + ').' : 'Stats are kept in memory only and reset when the server restarts. Set SUPABASE_URL and SUPABASE_SECRET_KEY to keep them.');
});
