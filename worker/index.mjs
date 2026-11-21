import { readUpload, verifyImage } from './image.mjs';

const DEFAULT_CLOSE = '2026-12-02T00:00:00+10:00';
const SESSION_MS = 7 * 86_400_000;
const AUTH_WINDOW_MS = 900_000;
const AUTH_THRESHOLD = 20;
const CHUNK_SIZE = 1_000_000;
const encoder = new TextEncoder();
const identifier = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const random = length => hex(crypto.getRandomValues(new Uint8Array(length)));
const error = (message, status) => Response.json({ error: message }, { status });

async function passwordHash(password, salt, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(`${secret}\0${password}`), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100_000
  }, key, 256);
  return hex(hash);
}

function sameHash(a, b) {
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function session(request, db, now) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '')?.[1];
  if (!token) return null;
  const key = await digest(token);
  const account = await db.prepare(`
    SELECT a.username, a.display_name AS displayName
    FROM sessions s JOIN accounts a ON a.username = s.username
    WHERE s.token_digest = ? AND s.expires_at > ?
  `).bind(key, now).first();
  return account ? { account, key } : null;
}

async function authIsLimited(request, env, now) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const key = await digest(`${env.AUTH_SECRET}\0${ip}`);
  const window = Math.floor(now / AUTH_WINDOW_MS);
  const result = await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_attempts WHERE window < ?').bind(window - 1),
    env.DB.prepare(`
      INSERT INTO auth_attempts (address_digest, window, attempts) VALUES (?, ?, 1)
      ON CONFLICT(address_digest, window) DO UPDATE SET attempts = attempts + 1
      RETURNING attempts
    `).bind(key, window)
  ]);
  return result[1].results[0].attempts > AUTH_THRESHOLD;
}

async function authenticate(request, env, now, register) {
  if (await authIsLimited(request, env, now)) return error('Too many tries. Please try again in a few minutes.', 429);
  const data = await readJSON(request);
  const username = typeof data?.username === 'string' ? data.username.trim().toLowerCase() : '';
  const password = data?.password;
  const displayName = typeof data?.displayName === 'string' ? data.displayName.trim() : '';
  if (!/^[a-z0-9._-]{3,32}$/.test(username) || typeof password !== 'string' || password.length < 3 || password.length > 128
    || (register && (!displayName || displayName.length > 48))) return error('Check your username, display name and password.', 400);

  const db = env.DB;
  const token = random(32);
  const createSession = db.prepare('INSERT INTO sessions (token_digest, username, expires_at) VALUES (?, ?, ?)')
    .bind(await digest(token), username, now + SESSION_MS);
  const cleanSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now);
  if (register) {
    const salt = random(16);
    const hash = await passwordHash(password, salt, env.AUTH_SECRET);
    try {
      await db.batch([
        db.prepare('INSERT INTO accounts (username, display_name, salt, password_hash) VALUES (?, ?, ?, ?)')
          .bind(username, displayName, salt, hash),
        cleanSessions,
        createSession
      ]);
    } catch (failure) {
      if (await db.prepare('SELECT 1 FROM accounts WHERE username = ?').bind(username).first()) {
        return error('That username is taken.', 409);
      }
      throw failure;
    }
    return Response.json({ token, account: { username, displayName } }, { status: 201 });
  }
  const account = await db.prepare('SELECT display_name AS displayName, salt, password_hash FROM accounts WHERE username = ?')
    .bind(username).first();
  const hash = await passwordHash(password, account?.salt || '0123456789abcdef0123456789abcdef', env.AUTH_SECRET);
  if (!sameHash(hash, account?.password_hash || '0'.repeat(64)) || !account) return error('Username or password is incorrect.', 401);
  await db.batch([cleanSessions, createSession]);
  return Response.json({ token, account: { username, displayName: account.displayName } });
}

async function readJSON(request) {
  if (!request.body || !request.headers.get('Content-Type')?.startsWith('application/json')) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) {
      await reader.cancel();
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(body + decoder.decode());
  } catch {
    return null;
  }
}

async function listEntries(db, username, closesAt, now) {
  const entries = await db.prepare(`
    SELECT e.id, e.title, e.description, e.created_at AS createdAt, a.display_name AS displayName,
      COUNT(CASE WHEN v.criterion = 'wow' THEN 1 END) AS wow,
      COUNT(CASE WHEN v.criterion = 'theme' THEN 1 END) AS theme,
      COUNT(v.criterion) AS score,
      MAX(CASE WHEN v.username = ?1 AND v.criterion = 'wow' THEN 1 ELSE 0 END) AS myWow,
      MAX(CASE WHEN v.username = ?1 AND v.criterion = 'theme' THEN 1 ELSE 0 END) AS myTheme
    FROM entries e JOIN accounts a ON a.username = e.username
    LEFT JOIN votes v ON v.entry_id = e.id
    GROUP BY e.id
    ORDER BY score DESC, e.created_at ASC, e.id ASC
  `).bind(username ?? null).all();
  return Response.json({ entries: entries.results, closesAt, closed: now >= closesAt });
}

async function addEntry(request, db, username, closesAt) {
  const form = await readUpload(request);
  const title = form?.get('title') ?? '';
  const description = form?.get('description') ?? '';
  const image = await verifyImage(form?.get('image'));
  if (!image) return error('Choose a still JPG, PNG or WebP of 3 MB or less.', 400);
  if (typeof title !== 'string' || title.trim().length > 80 || typeof description !== 'string' || description.trim().length > 500) {
    return error('Use up to 80 characters for the title and 500 for the description.', 400);
  }
  const now = Date.now();
  if (now >= closesAt) return error('Entries are closed.', 409);
  const id = crypto.randomUUID();
  const statements = [
    db.prepare('INSERT INTO entries (id, username, title, description, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, username, title.trim(), description.trim(), image.type, now)
  ];
  for (let offset = 0; offset < image.bytes.byteLength; offset += CHUNK_SIZE) {
    statements.push(db.prepare('INSERT INTO image_parts (entry_id, part, bytes) VALUES (?, ?, ?)')
      .bind(id, offset / CHUNK_SIZE, image.bytes.slice(offset, offset + CHUNK_SIZE)));
  }
  await db.batch(statements);
  return Response.json({ id }, { status: 201 });
}

async function readImage(db, id) {
  const result = await db.prepare(`
    SELECT e.content_type, p.bytes FROM entries e JOIN image_parts p ON p.entry_id = e.id
    WHERE e.id = ? ORDER BY p.part
  `).bind(id).all();
  if (!result.results.length) return error('Image not found.', 404);
  const parts = result.results.map(row => new Uint8Array(row.bytes));
  return new Response(new Blob(parts), {
    headers: { 'Content-Type': result.results[0].content_type, 'Cache-Control': 'public, max-age=300' }
  });
}

async function writeVote(request, db, username, id, criterion, closesAt) {
  const data = await readJSON(request);
  if (typeof data?.active !== 'boolean') return error('Invalid vote.', 400);
  if (Date.now() >= closesAt) return error('Voting is closed.', 409);
  const statements = [db.prepare('SELECT 1 FROM entries WHERE id = ?').bind(id)];
  if (data.active) {
    statements.push(db.prepare(`
      INSERT INTO votes (entry_id, username, criterion)
      SELECT id, ?2, ?3 FROM entries WHERE id = ?1
      ON CONFLICT(entry_id, username, criterion) DO NOTHING
    `).bind(id, username, criterion));
  } else {
    statements.push(db.prepare('DELETE FROM votes WHERE entry_id = ? AND username = ? AND criterion = ?')
      .bind(id, username, criterion));
  }
  const result = await db.batch(statements);
  if (!result[0].results.length) return error('Design not found.', 404);
  return Response.json({ active: data.active });
}

async function route(request, env) {
  const pathname = new URL(request.url).pathname;
  const method = request.method;
  const db = env.DB;
  const now = Date.now();
  const closesAt = Date.parse(env.CLOSES_AT || DEFAULT_CLOSE);
  if (!db || !env.AUTH_SECRET || !Number.isFinite(closesAt)) return error('Competition setup is incomplete.', 503);

  if (pathname === '/api/login' && method === 'POST') return authenticate(request, env, now, false);
  if (pathname === '/api/register' && method === 'POST') {
    return now >= closesAt ? error('Registrations are closed.', 409) : authenticate(request, env, now, true);
  }
  const image = new RegExp(`^/api/images/(${identifier})$`).exec(pathname);
  if (image && method === 'GET') return readImage(db, image[1]);

  const current = await session(request, db, now);
  if (pathname === '/api/entries' && method === 'GET') {
    if (!current && request.headers.has('Authorization')) return error('Please log in again.', 401);
    return listEntries(db, current?.account.username, closesAt, now);
  }
  const vote = new RegExp(`^/api/entries/(${identifier})/votes/(wow|theme)$`).exec(pathname);
  const protectedRoute = (pathname === '/api/entries' && method === 'POST')
    || (pathname === '/api/session' && method === 'GET') || (pathname === '/api/logout' && method === 'POST')
    || (vote && method === 'PUT');
  if (!protectedRoute) return error('Page not found.', 404);
  if (!current) return error('Please log in to continue.', 401);
  if (pathname === '/api/session') return Response.json({ account: current.account });
  if (pathname === '/api/logout') {
    await db.prepare('DELETE FROM sessions WHERE token_digest = ?').bind(current.key).run();
    return Response.json({ ok: true });
  }
  if (now >= closesAt) return error('The competition is closed.', 409);
  if (vote) return writeVote(request, db, current.account.username, vote[1], vote[2], closesAt);
  return addEntry(request, db, current.account.username, closesAt);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    let response;
    if (origin && origin !== env.SITE_ORIGIN) {
      response = error('Origin not allowed.', 403);
    } else {
      try {
        response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await route(request, env);
      } catch {
        response = error('The competition is temporarily unavailable. Please try again.', 500);
      }
    }
    const headers = new Headers(response.headers);
    headers.set('Vary', 'Origin');
    headers.set('X-Content-Type-Options', 'nosniff');
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
    if (origin && origin === env.SITE_ORIGIN) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      headers.set('Access-Control-Max-Age', '600');
    }
    return new Response(response.body, { status: response.status, headers });
  }
};
