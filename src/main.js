// src/main.js
// HTTP entry point for the Kiroween venue bulletin. Wires the shared-secret
// auth (src/auth.js), the in-memory page store (src/store.js), and the live
// carousel (src/carousel.js) over Node built-ins only (design §3, §6, §7).
//
// Security posture (secure-by-default):
//   * Binds to 127.0.0.1 (loopback) unless an explicit LAN bind is requested.
//   * The staff secret comes from STAFF_SECRET (env) or --secret, never code.
//   * The public viewer has no path to a token, so it cannot mutate state; with
//     no secret configured, login fails for everyone and the service is safely
//     read-only even on a LAN bind.
//   * Staff tokens travel in an HttpOnly, SameSite=Lax cookie (or Bearer header).
//
// Routing:
//   Public (viewer): GET /api/health | /api/pages | /api/page/:num | /api/stream (SSE)
//   Staff (token):   POST /api/staff/login | /logout | /edit | /schedule
//                    GET  /api/staff/status
//   Static:          GET/HEAD / (and /staff/...) served from public/
//
// Late join (design §6): on SSE connect we push an immediate `snapshot` event
// carrying the current on-air page, the full page list, and carousel status, so
// a viewer that connects mid-cycle is never blank. The carousel's 1 Hz slot
// events follow as the heartbeat.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

import { createAuth, extractToken } from './auth.js';
import { createStore, makeTimestamp } from './store.js';
import { createCarousel } from './carousel.js';
import { liveSchedule, SCHEDULE_NAMES } from './schedules.js';

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_OFFSET_MIN = 60;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_PUBLIC_DIR = join(resolve(__dirname, '..'), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function mimeFor(p) {
  return MIME[extname(p).toLowerCase()] || 'application/octet-stream';
}

// Map a typed store error to an HTTP status (see store.applyEdit).
function mapEditError(code) {
  switch (code) {
    case 'UNKNOWN_PAGE':
    case 'UNKNOWN_WORKSHOP':
      return 404;
    case 'NOT_EDITABLE':
      return 409;
    case 'BAD_ROOM':
    default:
      return 400;
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Read and JSON-parse a request body, capped to protect the server. Throws a
// { code: 'BAD_JSON' } error the caller can map to 400.
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  }).then((buf) => {
    if (buf.length === 0) return {};
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      const e = new Error('Invalid JSON body');
      e.code = 'BAD_JSON';
      throw e;
    }
  });
}

function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--lan') out.host = '0.0.0.0';
    else if (a === '--host') out.host = next();
    else if (a.startsWith('--host=')) out.host = a.slice(7);
    else if (a === '--port') out.port = Number(next());
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--schedule') out.schedule = next();
    else if (a.startsWith('--schedule=')) out.schedule = a.slice(11);
    else if (a === '--secret') out.secret = next();
    else if (a.startsWith('--secret=')) out.secret = a.slice(9);
    else if (a === '--slot-ms') out.slotMs = Number(next());
    else if (a.startsWith('--slot-ms=')) out.slotMs = Number(a.slice(10));
    else if (a === '--offset') out.venueOffsetMinutes = Number(next());
    else if (a.startsWith('--offset=')) out.venueOffsetMinutes = Number(a.slice(9));
  }
  return out;
}

function lanAddresses() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (!i.internal && i.family === 'IPv4') out.push(i.address);
    }
  }
  return out;
}

// --- request handlers --------------------------------------------------------

function requireAuth(ctx, req, res) {
  const token = extractToken(req);
  if (ctx.auth.verify(token)) return true;
  json(res, 401, { error: 'Unauthorized' });
  return false;
}

function handleHealth(ctx, res) {
  const st = ctx.carousel.status();
  return json(res, 200, {
    ok: true,
    schedule: st.schedule,
    slot: st.slot,
    pages: ctx.store.listPages().length,
    time: makeTimestamp(new Date(), ctx.venueOffsetMinutes),
  });
}

function handlePages(ctx, res) {
  return json(res, 200, ctx.store.listPages());
}

function handlePage(ctx, res, num) {
  const page = ctx.store.getPage(num);
  if (!page) return json(res, 404, { error: 'Page not found', page: num });
  return json(res, 200, page);
}

function handleStream(ctx, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Late-join snapshot: reconstruct the on-air page without advancing the
  // carousel pointer. After each emit the pointer points at the NEXT page, so
  // the last-emitted (currently on-air) page is one behind; before the first
  // emit (slot 0) it is the page at the current pointer.
  const st = ctx.carousel.status();
  const seq = liveSchedule(st.schedule);
  const n = seq.length || 1;
  const onAirIdx = st.slot === 0 ? st.pointer : (st.pointer - 1 + n) % n;
  const onAirNum = seq[onAirIdx];
  const snapshot = {
    onAir: ctx.store.getPage(onAirNum),
    pages: ctx.store.listPages(),
    carousel: st,
    serverTime: makeTimestamp(new Date(), ctx.venueOffsetMinutes),
  };
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  const unsub = ctx.carousel.subscribe(res);
  req.on('close', () => unsub());
}

async function handleLogin(ctx, req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  const password = typeof body.password === 'string' ? body.password : '';
  const r = ctx.auth.login(password);
  if (!r) return json(res, 401, { error: 'Invalid credentials' });
  const ttlSec = Math.round((ctx.ttlMs || DEFAULT_TTL_MS) / 1000);
  res.setHeader(
    'Set-Cookie',
    serializeCookie('staff_token', r.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: ttlSec,
    }),
  );
  return json(res, 200, { token: r.token, expiresAt: r.expiresAt });
}

function handleLogout(ctx, req, res) {
  const token = extractToken(req);
  ctx.auth.logout(token);
  res.setHeader(
    'Set-Cookie',
    serializeCookie('staff_token', '', {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 0,
    }),
  );
  return json(res, 200, { ok: true });
}

async function handleEdit(ctx, req, res) {
  if (!requireAuth(ctx, req, res)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  // Expects { page, workshop, room }; the store enforces that only page 201 is
  // editable via this endpoint (FR-3.2 anchor action) and bumps that page's
  // revision + timestamp only (FR-1.3).
  try {
    const result = ctx.store.applyEdit(body);
    return json(res, 200, result);
  } catch (e) {
    return json(res, mapEditError(e.code), { error: e.message, code: e.code || 'EDIT_FAILED' });
  }
}

async function handleSchedule(ctx, req, res) {
  if (!requireAuth(ctx, req, res)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  const name = typeof body.schedule === 'string' ? body.schedule : '';
  if (!SCHEDULE_NAMES.includes(name)) {
    return json(res, 400, { error: 'Unknown schedule', valid: SCHEDULE_NAMES });
  }
  ctx.carousel.setSchedule(name);
  return json(res, 200, ctx.carousel.status());
}

function handleStaffStatus(ctx, req, res) {
  if (!requireAuth(ctx, req, res)) return;
  return json(res, 200, {
    carousel: ctx.carousel.status(),
    auth: { tokens: ctx.auth.size(), enabled: Boolean(ctx.secret) },
    store: { pages: ctx.store.listPages() },
  });
}

// --- static assets -----------------------------------------------------------

function sendNotFound(res, method) {
  const body = '404 Not Found\n';
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

function placeholder(ctx, res, method) {
  const st = ctx.carousel.status();
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Teletext Kiroween</title>
</head>
<body style="font-family:monospace;background:#000;color:#0f0;padding:2rem;line-height:1.5">
<h1>Teletext Kiroween &mdash; service online</h1>
<p>Viewer assets are not installed yet. Drop <code>public/index.html</code> to go live.</p>
<ul>
<li>Live stream: <a href="/api/stream" style="color:#0f0">/api/stream</a></li>
<li>Pages: <a href="/api/pages" style="color:#0f0">/api/pages</a></li>
<li>Health: <a href="/api/health" style="color:#0f0">/api/health</a></li>
</ul>
<p>Schedule: ${st.schedule} &middot; slot ${st.slot} &middot; pages ${st.pages}</p>
</body>
</html>`;
  const buf = Buffer.from(body);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
  });
  if (method === 'HEAD') res.end();
  else res.end(buf);
}

async function serveStatic(ctx, req, res, pathname, method) {
  const root = resolve(ctx.publicDir);
  let rel = pathname;
  if (rel === '/') rel = '/index.html';
  else if (rel.endsWith('/')) rel += 'index.html';

  // Map the URL path into the public dir and refuse anything that escapes it.
  // (new URL() already collapses ".." segments, so this is belt-and-suspenders.)
  const filePath = resolve(root, '.' + rel);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return sendNotFound(res, method);
  }

  let body;
  let type = mimeFor(filePath);
  try {
    body = await readFile(filePath);
  } catch (e) {
    if (e.code === 'EISDIR') {
      try {
        const idx = join(filePath, 'index.html');
        body = await readFile(idx);
        type = mimeFor(idx);
      } catch {
        if (pathname === '/' || pathname === '/index.html') return placeholder(ctx, res, method);
        return sendNotFound(res, method);
      }
    } else if (e.code === 'ENOENT') {
      if (pathname === '/' || pathname === '/index.html') return placeholder(ctx, res, method);
      return sendNotFound(res, method);
    } else {
      throw e;
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

// --- app factory --------------------------------------------------------------

export function createApp(options = {}) {
  const secret = options.secret ?? '';
  const venueOffsetMinutes = options.venueOffsetMinutes ?? DEFAULT_OFFSET_MIN;
  const scheduleName = options.schedule ?? 'priority';
  const slotMs = options.slotMs ?? 1000;
  const autoStart = options.autoStart ?? true;
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  const auth = createAuth({ secret, ttlMs, now: options.now });
  const store = createStore({ clock: options.clock, venueOffsetMinutes });
  const carousel = createCarousel({ store, schedule: scheduleName, autoStart, slotMs });

  const ctx = { auth, store, carousel, publicDir, venueOffsetMinutes, secret, ttlMs };

  function onRequest(req, res) {
    const method = req.method;
    const { pathname } = new URL(req.url, 'http://localhost');

    (async () => {
      try {
        if (method === 'GET' && pathname === '/api/health') return handleHealth(ctx, res);
        if (method === 'GET' && pathname === '/api/pages') return handlePages(ctx, res);
        if (method === 'GET' && pathname.startsWith('/api/page/')) {
          const raw = pathname.slice('/api/page/'.length).replace(/\/$/, '');
          const num = Number(raw);
          if (raw === '' || !Number.isFinite(num)) return json(res, 400, { error: 'Invalid page number' });
          return handlePage(ctx, res, num);
        }
        if (method === 'GET' && pathname === '/api/stream') return handleStream(ctx, req, res);

        if (method === 'POST' && pathname === '/api/staff/login') return handleLogin(ctx, req, res);
        if (method === 'POST' && pathname === '/api/staff/logout') return handleLogout(ctx, req, res);
        if (method === 'POST' && pathname === '/api/staff/edit') return handleEdit(ctx, req, res);
        if (method === 'POST' && pathname === '/api/staff/schedule') return handleSchedule(ctx, req, res);
        if (method === 'GET' && pathname === '/api/staff/status') return handleStaffStatus(ctx, req, res);

        if ((method === 'GET' || method === 'HEAD') && !pathname.startsWith('/api/')) {
          return serveStatic(ctx, req, res, pathname, method);
        }
        return json(res, 404, { error: 'Not found', path: pathname });
      } catch (e) {
        if (!res.headersSent) {
          json(res, 500, { error: e && e.message ? e.message : 'Internal error' });
        } else {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
      }
    })();
  }

  const server = createServer(onRequest);

  function start(host = DEFAULT_HOST, port = DEFAULT_PORT) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve({ host, port });
      });
    });
  }

  function stop() {
    carousel.stop();
    // End live SSE responses so server.close() can resolve promptly.
    for (const res of carousel.subscribers) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return { server, auth, store, carousel, publicDir, start, stop };
}

// --- direct execution --------------------------------------------------------

function logStartup({ host, port, secret, schedule, slotMs, venueOffsetMinutes, publicDir }) {
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  console.log('Teletext Kiroween — venue bulletin service');
  console.log(`  Bind: ${host}:${port} (${loopback ? 'loopback' : 'LAN'})`);
  if (!loopback) {
    const addrs = host === '0.0.0.0' ? lanAddresses() : [host];
    for (const a of addrs) console.log(`    http://${a}:${port}/`);
    console.log('  WARNING: bound to a non-loopback address — reachable from the LAN.');
  }
  console.log(`  Staff editing: ${secret ? 'enabled (secret set)' : 'DISABLED — set STAFF_SECRET to enable'}`);
  if (!secret && !loopback) {
    console.log('  Note: with no secret, editing stays disabled and the viewer is read-only.');
  }
  console.log(`  Schedule: ${schedule} · slot ${slotMs}ms · venue offset +${venueOffsetMinutes}min`);
  console.log(`  Viewer assets: ${publicDir} (placeholder shown until index.html exists)`);
  console.log('  Endpoints:');
  console.log('    GET  /api/stream (SSE) · /api/pages · /api/page/:num · /api/health');
  console.log('    POST /api/staff/login · /logout · /edit · /schedule');
  console.log('    GET  /api/staff/status');
}

async function run() {
  const cli = parseArgs(process.argv.slice(2));
  const host = cli.host || process.env.HOST || DEFAULT_HOST;
  const port = cli.port || Number(process.env.PORT) || DEFAULT_PORT;
  const secret = cli.secret != null ? cli.secret : process.env.STAFF_SECRET || '';
  const schedule = cli.schedule || process.env.SCHEDULE || 'priority';
  const slotMs = cli.slotMs || Number(process.env.SLOT_MS) || 1000;
  const venueOffsetMinutes = cli.venueOffsetMinutes || Number(process.env.VENUE_OFFSET_MINUTES) || DEFAULT_OFFSET_MIN;

  let effectiveSchedule = schedule;
  if (!SCHEDULE_NAMES.includes(effectiveSchedule)) {
    console.error(
      `Unknown schedule "${schedule}"; falling back to "priority". Valid: ${SCHEDULE_NAMES.join(', ')}`,
    );
    effectiveSchedule = 'priority';
  }

  const app = createApp({ secret, schedule: effectiveSchedule, slotMs, venueOffsetMinutes });

  app.server.on('error', (err) => {
    console.error(`Failed to listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
  });

  app.server.listen(port, host, () => {
    logStartup({ host, port, secret, schedule: effectiveSchedule, slotMs, venueOffsetMinutes, publicDir: app.publicDir });
  });

  const shutdown = (sig) => {
    console.log(`\n${sig} received, shutting down…`);
    app.stop().then(() => process.exit(0), () => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  run();
}

export { parseArgs, serializeCookie, mimeFor, mapEditError };
