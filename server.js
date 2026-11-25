// UnStuck backend: serves the website and forwards AI requests to Google Gemini.
// The Gemini API key lives only here (in .env locally, or in Render's environment settings),
// so it never reaches the browser. No npm packages needed: run with `npm start` (Node 18+).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---- Load .env (simple KEY=value lines) when running locally. Render sets env vars itself. ----
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file: fine on Render */ }

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY && !/paste|your-key/i.test(process.env.GEMINI_API_KEY) ? process.env.GEMINI_API_KEY : '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean);
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE) || 20;
const MAX_BODY = 1_500_000;

// Only these files are public. Everything else (server.js, .env, package.json…) is never served.
const PUBLIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/writer-desktop.html': 'writer-desktop.html',
  '/writer-phone.html': 'writer-phone.html'
};

// ---- Small in-memory rate limit per visitor, to protect the free Gemini quota ----
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(time => now - time < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}
setInterval(() => { const now = Date.now(); for (const [ip, times] of hits) if (times.every(time => now - time > 60_000)) hits.delete(ip); }, 60_000).unref();

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Story is too large to send.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- POST /api/ai  { system, prompt }  ->  { text } ----
async function handleAI(req, res, cors) {
  if (!API_KEY) return send(res, 503, { error: 'The server has no GEMINI_API_KEY set.' }, cors);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (rateLimited(ip)) return send(res, 429, { error: 'Too many AI requests. Wait a minute and try again.' }, cors);

  let input;
  try { input = JSON.parse(await readBody(req)); }
  catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'Request must be JSON.' }, cors); }
  const { system, prompt } = input || {};
  if (typeof system !== 'string' || typeof prompt !== 'string' || !prompt.trim() || system.length > 20_000 || prompt.length > 1_200_000) {
    return send(res, 400, { error: 'Request needs a "system" and a "prompt" string.' }, cors);
  }

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
    return send(res, 502, { error: 'The server could not reach the AI service.' }, cors);
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    console.error('Gemini error', upstream.status, data.error?.message);
    const message = upstream.status === 429 ? 'The free AI quota is used up for now. Try again in a minute, or tomorrow.'
      : upstream.status === 400 && /api key/i.test(data.error?.message || '') ? 'The server’s API key was not accepted.'
      : data.error?.message || 'The AI service returned an error.';
    return send(res, upstream.status === 429 ? 429 : 502, { error: message }, cors);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).filter(part => !part.thought && part.text).map(part => part.text).join('');
  if (!text) return send(res, 502, { error: data.promptFeedback?.blockReason ? 'The AI declined this request.' : 'The AI returned an empty answer. Try again.' }, cors);
  send(res, 200, { text, model: MODEL }, cors);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const cors = corsHeaders(req);
  try {
    if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) return send(res, 204, '', cors);
    if (pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, ai: Boolean(API_KEY), model: MODEL }, cors);
    if (pathname === '/api/ai') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' }, cors);
      return await handleAI(req, res, cors);
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
  console.log(API_KEY ? 'AI is on (model ' + MODEL + ').' : 'AI is off: add GEMINI_API_KEY to .env (locally) or to Render’s environment variables.');
});
