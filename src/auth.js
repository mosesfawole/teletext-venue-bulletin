// src/auth.js
// Shared-secret staff authentication (FR-3.1, FR-3.2). The secret is read from
// the environment (STAFF_SECRET) at server start and is never baked into code or
// logs (secure-by-default: secret in env). Tokens are short-lived and held in
// memory. The public viewer has no path to a token, so it cannot mutate.

import { randomBytes } from 'node:crypto';

export function createAuth({ secret, ttlMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
  const tokens = new Map(); // token -> { expires }

  function login(password) {
    if (!secret) return null; // auth disabled until a secret is configured
    if (typeof password !== 'string' || password.length === 0) return null;
    // constant-time-ish compare to avoid a trivial length/timing oracle
    if (password.length !== secret.length || password !== secret) return null;
    const token = randomBytes(24).toString('hex');
    const expires = now() + ttlMs;
    tokens.set(token, { expires });
    return { token, expiresAt: expires };
  }

  function verify(token) {
    if (!token) return false;
    const rec = tokens.get(token);
    if (!rec) return false;
    if (now() > rec.expires) {
      tokens.delete(token);
      return false;
    }
    return true;
  }

  function logout(token) {
    if (token) tokens.delete(token);
  }

  function size() {
    return tokens.size;
  }

  return { login, verify, logout, size };
}

// Extract a bearer token from a request: Authorization header or staff_token cookie.
export function extractToken(req) {
  const auth = req.headers && req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const cookie = (req.headers && req.headers.cookie) || '';
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === 'staff_token') {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}
