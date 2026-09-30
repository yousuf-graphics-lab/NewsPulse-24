'use strict';

/**
 * Test harness.
 *
 * This file must be required BEFORE anything from `src/`, because `src/config.js`
 * reads `process.env` at require time and freezes the result. Every test file
 * therefore starts with `const H = require('./helpers');`.
 *
 * Each `node --test` worker process gets its own throwaway data directory, so
 * test files can run in parallel without sharing a database.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `np24-test-${process.pid}-`));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.DB_FILE = path.join(TMP, 'data', 'test.db');
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.BCRYPT_ROUNDS = '4'; // keep the suite fast; production uses 12
process.env.SESSION_SECRET = 'test-only-session-secret-0123456789abcdef';
process.env.CSRF_SECRET = 'test-only-csrf-secret-0123456789abcdef';
process.env.IP_HASH_PEPPER = 'test-only-ip-pepper';
process.env.AI_PROVIDER = 'none'; // exercise the built-in local engine
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'TestAdmin#1234';
process.env.REQUIRE_2FA_FOR_ADMINS = '0';

/** Boots the real Express app on an ephemeral port. */
async function startServer() {
  const db = require('../src/db');
  const { buildApp } = require('../src/app');
  const seed = require('../src/db/seed');

  db.migrate();
  seed.ensureSeedData();

  const server = http.createServer(buildApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    db,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(TMP, { recursive: true, force: true });
    },
  };
}

/**
 * Minimal HTTP client with a cookie jar. `jar` is a plain object; pass the same
 * object across calls to stay logged in.
 */
function makeClient(origin, jar = {}) {
  const cookieHeader = () =>
    Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

  const store = (res) => {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  };

  const request = async (method, url, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (Object.keys(jar).length) headers.Cookie = cookieHeader();
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(body).toString();
    }
    const res = await fetch(new URL(url, origin), { method, headers, body, redirect: 'manual' });
    store(res);
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      location: res.headers.get('location'),
      body: text,
      get json() { return JSON.parse(text); },
      csrf() {
        // Admin forms carry a hidden _csrf field; public pages expose the same
        // token through <meta name="csrf-token">, which site.js reads.
        const m = text.match(/name="_csrf" value="([^"]+)"/)
          || text.match(/name="csrf-token" content="([^"]+)"/);
        return m ? m[1] : null;
      },
      cookie(name) { return jar[name]; },
    };
  };

  const client = {
    jar,
    get: (u, o) => request('GET', u, o),
    post: (u, o) => request('POST', u, o),
    postJson: (u, obj, o = {}) =>
      request('POST', u, {
        ...o,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(o.headers || {}) },
        body: JSON.stringify(obj),
      }),
  };
  return client;
}

/** Logs in as the seeded admin and returns a ready client. */
async function loginAdmin(origin) {
  const c = makeClient(origin);
  const page = await c.get('/admin/login');
  const res = await c.post('/admin/login', {
    body: {
      _csrf: page.csrf(),
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      next: '/admin',
    },
  });
  if (res.status !== 302 || !c.jar.np_session) {
    throw new Error(`admin login failed: ${res.status} -> ${res.location}`);
  }
  return c;
}

/** Reads the `_csrf` field out of any admin form page. */
async function csrfFrom(c, url = '/admin/articles/new') {
  const page = await c.get(url);
  const token = page.csrf();
  if (!token) throw new Error(`no csrf token on ${url}`);
  return token;
}

module.exports = { startServer, makeClient, loginAdmin, csrfFrom, TMP };
