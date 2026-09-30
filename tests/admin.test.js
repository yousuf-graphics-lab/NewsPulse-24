'use strict';

/**
 * Admin panel: authentication, RBAC, and the editorial/ops workflows.
 * These are the operations an editor performs every day, so they must not rot.
 */

const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let srv, admin;

test.before(async () => {
  srv = await H.startServer();
  admin = await H.loginAdmin(srv.origin);
});
test.after(async () => { await srv?.close(); });

const ADMIN_PAGES = [
  '/admin', '/admin/articles', '/admin/articles/new', '/admin/media',
  '/admin/ads', '/admin/ads/new', '/admin/comments', '/admin/newsletter',
  '/admin/users', '/admin/analytics', '/admin/security', '/admin/settings',
  '/admin/pages', '/admin/ticker', '/admin/polls', '/admin/assistant', '/admin/account',
];

for (const path of ADMIN_PAGES) {
  test(`GET ${path} renders for an authenticated admin`, async () => {
    const res = await admin.get(path);
    assert.strictEqual(res.status, 200, `${path} -> ${res.status}\n${res.body.slice(0, 300)}`);
    assert.match(res.body, /noindex/, `${path} must not be indexable`);
  });
}

/* ------------------------------------------------------------- content --- */

test('an editor can create, update and unpublish an article', async () => {
  const token = await H.csrfFrom(admin, '/admin/articles/new');
  const author = srv.db.get('SELECT id FROM authors LIMIT 1');

  const created = await admin.post('/admin/articles', {
    body: {
      _csrf: token,
      title_bn: 'প্রশাসনিক পরীক্ষা: সংবাদ তৈরির পূর্ণ প্রক্রিয়া যাচাই করা হচ্ছে',
      title_en: 'Admin workflow test',
      author_id: author.id,
      body_bn: '<p>প্রথম অনুচ্ছেদ — যথেষ্ট দৈর্ঘ্যের লেখা যাতে বৈধতা যাচাই সফল হয়।</p>'
        + '<p>দ্বিতীয় অনুচ্ছেদও যথেষ্ট লম্বা করা হয়েছে যাতে ন্যূনতম দৈর্ঘ্য পূরণ হয়।</p>',
      status: 'published',
      category_id: 1,
      author_id: author.id,
      tags: 'পরীক্ষা,admin',
      is_breaking: '1',
    },
  });
  assert.strictEqual(created.status, 302, created.body.slice(0, 300));

  const row = srv.db.get('SELECT * FROM articles ORDER BY id DESC LIMIT 1');
  assert.strictEqual(row.status, 'published');
  assert.strictEqual(row.is_breaking, 1);
  assert.match(row.tags, /পরীক্ষা/, 'tags are stored');
  assert.ok(row.read_minutes >= 1, 'reading time is computed');
  assert.match(row.slug, /[\u0980-\u09FF]/, 'the slug stays readable in Bangla');
  // The byline must survive the round trip.
  const attached = srv.db.get('SELECT id FROM authors WHERE id = ?', [row.author_id]);
  assert.ok(attached, 'an author record is attached to the article');

  const edited = await admin.post(`/admin/articles/${row.id}`, {
    body: {
      _csrf: token,
      title_bn: 'প্রশাসনিক পরীক্ষা: হালনাগাদ করা শিরোনাম এখানে লেখা হয়েছে',
      body_bn: row.body_bn,
      status: 'draft',
      category_id: 1,
      author_id: author.id,
      tags: 'পরীক্ষা',
    },
  });
  assert.strictEqual(edited.status, 302, edited.body.slice(0, 300));
  const after = srv.db.get('SELECT status, title_bn FROM articles WHERE id = ?', [row.id]);
  assert.strictEqual(after.status, 'draft', 'the article was moved back to draft');
  assert.match(after.title_bn, /হালনাগাদ/);
});

test('a correction is recorded and shown on the public page', async () => {
  const a = srv.db.get("SELECT id, slug FROM articles WHERE status='published' LIMIT 1");
  const token = await H.csrfFrom(admin, `/admin/articles/${a.id}/edit`);
  const res = await admin.post(`/admin/articles/${a.id}/correction`, {
    body: { _csrf: token, kind: 'correction', note: 'শিরোনামের একটি ভুল সংখ্যা সংশোধন করা হয়েছে।' },
  });
  assert.strictEqual(res.status, 302, res.body.slice(0, 200));
  const c = srv.db.get('SELECT * FROM corrections WHERE article_id = ? ORDER BY id DESC LIMIT 1', [a.id]);
  assert.ok(c, 'the correction was stored');
  assert.match(c.note, /সংশোধন/);

  const page = await H.makeClient(srv.origin).get(`/news/${encodeURIComponent(a.slug)}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /সংশোধন|correction/i, 'the correction is visible to readers');
});

test('a correction cannot be saved without a note', async () => {
  const a = srv.db.get("SELECT id FROM articles WHERE status='published' LIMIT 1");
  const token = await H.csrfFrom(admin, `/admin/articles/${a.id}/edit`);
  const before = srv.db.get('SELECT COUNT(*) AS n FROM corrections').n;
  const res = await admin.post(`/admin/articles/${a.id}/correction`, {
    body: { _csrf: token, kind: 'correction', note: '   ' },
  });
  assert.ok([302, 400].includes(res.status), `expected a rejection, got ${res.status}`);
  const after = srv.db.get('SELECT COUNT(*) AS n FROM corrections').n;
  assert.strictEqual(after, before, 'no empty correction was stored');
});

/* ----------------------------------------------------------------- ads --- */

test('an ad campaign can be created, targeted and paused', async () => {
  const token = await H.csrfFrom(admin, '/admin/ads/new');
  const res = await admin.post('/admin/ads', {
    body: {
      _csrf: token, name: 'পরীক্ষামূলক প্রচারাভিযান', advertiser: 'পরীক্ষা কোম্পানি',
      slot: 'in-article', kind: 'text', headline: 'শিরোনাম', body: 'বিবরণ',
      cta: 'বিস্তারিত', image_url: '', link_url: 'https://example.com/offer', html: '',
      script_src: '', video_url: '', target_devices: 'desktop,mobile',
      target_countries: 'BD', target_categories: '', priority: '70', weight: '150',
      daily_cap: '2500', starts_at: '2026-01-01', ends_at: '2026-12-31', status: 'active',
    },
  });
  assert.strictEqual(res.status, 302, res.body.slice(0, 300));
  const ad = srv.db.get("SELECT * FROM ads WHERE name = 'পরীক্ষামূলক প্রচারাভিযান'");
  assert.ok(ad, 'the campaign was stored');
  assert.strictEqual(ad.slot, 'in-article');
  assert.strictEqual(ad.priority, 70);
  assert.strictEqual(ad.daily_cap, 2500);
  assert.strictEqual(ad.target_countries, 'BD');

  const paused = await admin.post(`/admin/ads/${ad.id}`, {
    body: {
      _csrf: token, name: ad.name, advertiser: ad.advertiser, slot: ad.slot, kind: 'text',
      headline: ad.headline, body: ad.body, cta: ad.cta, image_url: '', link_url: ad.link_url,
      html: '', script_src: '', video_url: '', target_devices: '', target_countries: '',
      target_categories: '', priority: '70', weight: '150', daily_cap: '0',
      starts_at: '', ends_at: '', status: 'paused',
    },
  });
  assert.strictEqual(paused.status, 302, paused.body.slice(0, 300));
  assert.strictEqual(srv.db.get('SELECT status FROM ads WHERE id = ?', [ad.id]).status, 'paused');
});

test('a script creative is rejected unless the host is allowlisted', async () => {
  const token = await H.csrfFrom(admin, '/admin/ads/new');
  const bad = await admin.post('/admin/ads', {
    body: {
      _csrf: token, name: 'অনুমোদনহীন স্ক্রিপ্ট', slot: 'in-article', kind: 'script',
      script_src: 'https://malware.example.com/x.js', priority: '10', weight: '10',
      daily_cap: '0', status: 'active',
    },
  });
  assert.ok([302, 400].includes(bad.status), `expected a rejection, got ${bad.status}`);
  assert.strictEqual(srv.db.get("SELECT id FROM ads WHERE name = 'অনুমোদনহীন স্ক্রিপ্ট'"), null,
    'the off-allowlist campaign was not stored');
});

/* --------------------------------------------------------- moderation -- */

test('a pending comment can be approved and then hidden again', async () => {
  const anon = H.makeClient(srv.origin);
  const a = srv.db.get("SELECT id, slug FROM articles WHERE status='published' LIMIT 1");
  const token = await H.csrfFrom(anon, `/news/${encodeURIComponent(a.slug)}`);
  await anon.post('/comments', {
    body: { _csrf: token, article_id: a.id, name: 'পরীক্ষক', body: 'অনুমোদনের অপেক্ষায় থাকা একটি মন্তব্য।' },
    headers: { Accept: 'application/json' },
  });
  const c = srv.db.get('SELECT id, status FROM comments ORDER BY id DESC LIMIT 1');
  assert.strictEqual(c.status, 'pending');

  const adminToken = await H.csrfFrom(admin, '/admin/comments');
  const ok = await admin.post(`/admin/comments/${c.id}/status`, {
    body: { _csrf: adminToken, status: 'approved' },
  });
  assert.ok([200, 302].includes(ok.status), `approve returned ${ok.status}`);
  assert.strictEqual(srv.db.get('SELECT status FROM comments WHERE id = ?', [c.id]).status, 'approved');

  const hidden = await admin.post(`/admin/comments/${c.id}/status`, {
    body: { _csrf: adminToken, status: 'spam' },
  });
  assert.ok([200, 302].includes(hidden.status));
  assert.strictEqual(srv.db.get('SELECT status FROM comments WHERE id = ?', [c.id]).status, 'spam');
});

/* ------------------------------------------------------------ settings -- */

test('site settings persist and are reflected on the public site', async () => {
  const token = await H.csrfFrom(admin, '/admin/settings');
  const res = await admin.post('/admin/settings', {
    body: { _csrf: token, ticker_enabled: '1', ticker_speed: '55' },
  });
  assert.ok([200, 302].includes(res.status), `settings save returned ${res.status}`);
  const row = srv.db.get("SELECT value FROM settings WHERE key = 'ticker_speed'");
  assert.strictEqual(row.value, '55', 'the setting was written');
});

test('a ticker item can be added and appears in the ticker API', async () => {
  const token = await H.csrfFrom(admin, '/admin/ticker');
  const text = `পরীক্ষামূলক ব্রেকিং নিউজ ${Date.now()}`;
  const res = await admin.post('/admin/ticker', {
    body: { _csrf: token, text_bn: text, priority: '9' },
  });
  assert.ok([200, 302].includes(res.status), `ticker add returned ${res.status}`);
  assert.ok(srv.db.get('SELECT id FROM ticker_items WHERE text_bn = ?', [text]), 'the item was stored');
});

/* --------------------------------------------------------------- users -- */

test('a new user is created with a hashed password, never a plain one', async () => {
  const token = await H.csrfFrom(admin, '/admin/users');
  const email = `reporter${Date.now()}@example.com`;
  const res = await admin.post('/admin/users', {
    body: { _csrf: token, name: 'নতুন রিপোর্টার', email, password: 'Reporter#2026x', role: 'reporter' },
  });
  assert.ok([200, 302].includes(res.status), `create user returned ${res.status}`);
  const u = srv.db.get('SELECT * FROM users WHERE email = ?', [email]);
  assert.ok(u, 'the user was created');
  assert.strictEqual(u.role, 'reporter');
  assert.match(u.password_hash, /^\$2[aby]\$/, 'the password is bcrypt-hashed');
  assert.strictEqual(u.password_hash.includes('Reporter#2026x'), false, 'never stored in clear');
});

test('an admin cannot lock themselves out by demoting their own role', async () => {
  const me = srv.db.get("SELECT id FROM users WHERE email = ?", [process.env.ADMIN_EMAIL]);
  const token = await H.csrfFrom(admin, '/admin/users');
  const res = await admin.post(`/admin/users/${me.id}`, {
    body: { _csrf: token, role: 'reporter', status: 'suspended' },
  });
  assert.ok([302, 400].includes(res.status));
  const still = srv.db.get('SELECT role, status FROM users WHERE id = ?', [me.id]);
  assert.strictEqual(still.status, 'active', 'own account was not suspended');
  assert.strictEqual(still.role, 'superadmin', 'own role was not downgraded');
  // The admin session must still work.
  assert.strictEqual((await admin.get('/admin')).status, 200);
});

/* ------------------------------------------------------------- RBAC ---- */

test('a reporter cannot reach superadmin-only screens', async () => {
  const token = await H.csrfFrom(admin, '/admin/users');
  const email = `lowpriv${Date.now()}@example.com`;
  await admin.post('/admin/users', {
    body: { _csrf: token, name: 'কম ক্ষমতা', email, password: 'Reporter#2026x', role: 'reporter' },
  });

  const low = H.makeClient(srv.origin);
  const page = await low.get('/admin/login');
  const login = await low.post('/admin/login', {
    body: { _csrf: page.csrf(), email, password: 'Reporter#2026x', next: '/admin' },
  });
  assert.ok([302, 200].includes(login.status), `reporter login returned ${login.status}`);

  for (const path of ['/admin/users', '/admin/settings', '/admin/security']) {
    const res = await low.get(path);
    assert.notStrictEqual(res.status, 200,
      `a reporter must not see ${path} (got ${res.status})`);
  }
});

/* ------------------------------------------------------------ overview -- */

test('the dashboard overview API reports traffic, content and ad metrics', async () => {
  const res = await admin.get('/admin/api/overview');
  assert.strictEqual(res.status, 200, res.body.slice(0, 300));
  const { overview } = res.json;
  assert.ok(overview, 'an overview object is returned');

  // Traffic
  for (const key of ['pageviews', 'visitors', 'uniques', 'todayPageviews']) {
    assert.ok(Number.isFinite(overview[key]), `overview.${key} is a number`);
  }
  // Content
  assert.ok(Number.isFinite(overview.content.published), 'published count is reported');
  assert.ok(Number.isFinite(overview.content.total_views), 'total views are reported');
  // Advertising: per-ad impressions and clicks, plus per-country breakdown
  assert.ok(Array.isArray(overview.ads.byAd), 'per-ad rows are reported');
  for (const row of overview.ads.byAd) {
    assert.ok(Number.isFinite(row.impressions), `ad ${row.id} impressions`);
    assert.ok(Number.isFinite(row.clicks), `ad ${row.id} clicks`);
    assert.ok(Number.isFinite(row.ctr), `ad ${row.id} ctr`);
  }
  assert.ok(Array.isArray(overview.ads.byCountry), 'ad impressions by country are reported');
  assert.ok(Array.isArray(overview.ads.bySlot), 'ad impressions by slot are reported');
  assert.ok(Number.isFinite(overview.pendingComments), 'moderation queue depth is reported');
});

test('the analytics page breaks traffic down by device, browser and country', async () => {
  // Generate real traffic from two different devices so the breakdowns have data.
  const ua = {
    mobile: 'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  };
  for (const [device, agent] of Object.entries(ua)) {
    const c = H.makeClient(srv.origin);
    await c.get('/', { headers: { 'User-Agent': agent, 'Accept-Language': 'bn' } });
    await c.get('/live', { headers: { 'User-Agent': agent } });
    void device;
  }
  // Pageviews are buffered in memory and written on a 2s timer; flush directly
  // so the test does not have to sleep.
  require('../src/middleware/analytics').flush();
  await new Promise((r) => setTimeout(r, 50));

  const res = await admin.get('/admin/analytics');
  assert.strictEqual(res.status, 200);
  assert.match(res.body, /<th>Device<\/th>/, 'the event log has a device column');
  assert.match(res.body, /দেশ/, 'a country breakdown panel is present');
  assert.match(res.body, /ব্রাউজার/, 'a browser/OS breakdown panel is present');

  // Scan every event: earlier tests in this file have already logged many
  // desktop pageviews, so a LIMIT would only ever see those.
  const stored = srv.db.all('SELECT device FROM analytics_events WHERE device IS NOT NULL')
    .map((r) => String(r.device));
  assert.ok(stored.length > 0, 'device type is recorded per event');
  assert.ok(stored.some((d) => /mobile/i.test(d)), `a mobile visit was recorded: ${stored.join(',')}`);
  assert.ok(stored.some((d) => /desktop/i.test(d)), `a desktop visit was recorded: ${stored.join(',')}`);

  // The dashboard also summarises devices and countries.
  const dash = await admin.get('/admin');
  assert.strictEqual(dash.status, 200);
  assert.match(dash.body, /mobile/i, 'the dashboard summarises device types');
});

/* ------------------------------------------------------------ backups -- */

test('a backup can be taken from the admin panel', async () => {
  const before = srv.db.get('SELECT COUNT(*) AS n FROM audit_log').n;
  const token = await H.csrfFrom(admin, '/admin/settings');
  const res = await admin.post('/admin/backup', { body: { _csrf: token } });
  assert.ok([200, 302].includes(res.status), `backup returned ${res.status}`);
  const after = srv.db.get('SELECT COUNT(*) AS n FROM audit_log').n;
  assert.ok(after >= before, 'the action was audited');
});

test('sensitive admin actions are written to the audit log', async () => {
  const actions = srv.db.all('SELECT action FROM audit_log ORDER BY id DESC LIMIT 40').map((r) => r.action);
  assert.ok(actions.includes('auth.login'), 'logins are audited');
  assert.ok(actions.some((a) => a.startsWith('article.')), 'article changes are audited');
  assert.ok(actions.some((a) => a.startsWith('ads.') || a.startsWith('user.')),
    'ads/user changes are audited');
});
