'use strict';

/**
 * Admin panel.
 *
 * Everything under /admin passes through: session auth → RBAC permission check
 * → CSRF token check → zod validation → sanitisation → prepared statement.
 * Every mutating action writes an audit row (who, what, when, from where).
 */

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const db = require('../db');
const config = require('../config');
const auth = require('../middleware/auth');
const security = require('../middleware/security');
const analytics = require('../services/analytics');
const repo = require('../services/content-repo');
const ads = require('../services/ads');
const media = require('../services/media');
const newsletter = require('../services/newsletter');
const trending = require('../services/trending');
const ai = require('../services/ai');
const totp = require('../services/totp');
const content = require('../services/content');
const V = require('../utils/validate');
const {
  slugify, uniqueSlug, formatDate, formatDateTime, timeAgo, bnNumber, compactNumber,
  pick, hashIp, clientIp, ipTail, parseJson, csvToArray, arrayToCsv, safeUrl,
} = require('../utils/helpers');

const router = express.Router();
const BREADCRUMB = 'admin';

/* ============================================================ plumbing === */

function adminLocals(req, extra = {}) {
  const locale = req.locale || 'bn';
  return {
    locale,
    layout: 'admin',
    user: req.user,
    site: content.getSettings(),
    settings: content.getSettings(),
    csrfToken: req.csrfToken(),
    currentPath: req.originalUrl.split('?')[0],
    query: req.query,
    flash: {
      ok: req.query.ok ? decodeURIComponent(String(req.query.ok)) : null,
      err: req.query.err ? decodeURIComponent(String(req.query.err)) : null,
      errors: req.flashErrors || null,
      values: req.flashValues || null,
    },
    h: { formatDate, formatDateTime, timeAgo, bnNumber, compactNumber, pick, safeUrl },
    can: (perm) => auth.can(req.user, perm),
    isDev: config.env !== 'production',
    adSlots: config.adSlots,
    roles: config.roles,
    ...extra,
  };
}

const render = (req, res, view, extra = {}) => res.render(`admin/${view}`, adminLocals(req, extra));

function redirectBack(req, res, fallback, { ok, err } = {}) {
  const target = req.get('referer') && req.get('referer').startsWith('/') ? req.get('referer') : fallback;
  const url = new URL(target, config.publicUrl);
  if (ok) url.searchParams.set('ok', encodeURIComponent(ok));
  if (err) url.searchParams.set('err', encodeURIComponent(err));
  res.redirect(`${url.pathname}${url.search}`);
}

const badRequest = (req, res, message) => {
  if (req.accepts('html')) return redirectBack(req, res, '/admin', { err: message });
  return res.status(400).json({ ok: false, error: message });
};

/* ============================================================== login ==== */

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/admin');
  res.render('admin/login', adminLocals(req, {
    layout: 'blank',
    next: req.query.next || '/admin',
    error: req.query.err ? decodeURIComponent(String(req.query.err)) : null,
  }));
});

router.post('/login', security.limiters.login(), V.validate(V.loginSchema, 'body', { redirect: '/admin/login' }), async (req, res, next) => {
  try {
    const { email, password } = req.validated;
    const user = db.get(`SELECT * FROM users WHERE lower(email) = lower(?)`, [email]);

    // Same response for "no such user" and "wrong password" — do not help an
    // attacker enumerate accounts. The bcrypt call still runs so timing is flat.
    const hash = user?.password_hash || '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7sBzR0pS8jJ6lBqQ1l1mNqK1y0h0h0h';
    const ok = auth.verifyPassword(password, hash);

    if (!user || !ok) {
      auth.registerFailedLogin(email, req);
      return res.status(401).render('admin/login', adminLocals(req, {
        layout: 'blank', next: req.body.next || '/admin',
        error: 'ইমেইল বা পাসওয়ার্ড সঠিক নয়।',
      }));
    }
    if (user.status !== 'active') {
      security.logSecurityEvent({ kind: 'login_suspended', severity: 'medium', req, detail: email });
      return res.status(403).render('admin/login', adminLocals(req, {
        layout: 'blank', next: '/admin', error: 'এই অ্যাকাউন্টটি স্থগিত আছে।',
      }));
    }
    if (auth.isLocked(user)) {
      const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
      return res.status(429).render('admin/login', adminLocals(req, {
        layout: 'blank', next: '/admin', error: `অনেকবার ব্যর্থ চেষ্টা। ${mins} মিনিট পর আবার চেষ্টা করুন।`,
      }));
    }

    auth.registerSuccessfulLogin(user, req);

    if (user.two_factor_on) {
      // Session row is created but not handed to the browser yet: until the
      // second factor is verified this id is worthless to anyone who has it.
      const pendingId = auth.createSession(req, res, user.id, { setCookie: false });
      res.cookie('np_2fa_pending', pendingId, {
        httpOnly: true, sameSite: 'strict', secure: config.isProd, maxAge: 5 * 60 * 1000, path: '/admin',
      });
      return res.render('admin/two-factor', adminLocals(req, { layout: 'blank' }));
    }
    if (config.auth.require2faForAdmins && ['superadmin', 'editor'].includes(user.role) && !user.two_factor_on) {
      auth.createSession(req, res, user.id);
      auth.audit(req, 'auth.login', { user });
      return res.redirect('/admin/account?setup2fa=1');
    }

    auth.createSession(req, res, user.id);
    auth.audit(req, 'auth.login', { user });
    const next = String(req.body.next || '/admin');
    return res.redirect(next.startsWith('/admin') ? next : '/admin');
  } catch (err) { next(err); }
});

router.get('/2fa', (req, res) => {
  if (!req.cookies?.np_2fa_pending) return res.redirect('/admin/login');
  res.render('admin/two-factor', adminLocals(req, { layout: 'blank' }));
});

router.post('/2fa', security.limiters.login(), (req, res) => {
  const pending = req.cookies?.np_2fa_pending;
  if (!pending) return res.redirect('/admin/login');
  const row = db.get(
    `SELECT s.id AS session_id, u.id AS user_id, u.email, u.totp_secret
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    [pending],
  );
  res.clearCookie('np_2fa_pending', { path: '/admin' });
  if (!row?.totp_secret || !totp.verify(row.totp_secret, req.body?.token)) {
    // A wrong code invalidates the pending session so it cannot be retried
    // indefinitely with the same hand-off ticket.
    if (row) db.run(`UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [row.session_id]);
    security.logSecurityEvent({ kind: 'totp_failed', severity: 'high', req, detail: row?.email });
    return res.status(401).render('admin/two-factor', adminLocals(req, { layout: 'blank', error: 'কোডটি সঠিক নয়। আবার লগইন করুন।' }));
  }
  auth.activateSession(res, row.session_id);
  auth.audit(req, 'auth.login.2fa', { user: { id: row.user_id, email: row.email } });
  return res.redirect('/admin');
});

router.post('/logout', auth.requireAuth, (req, res) => {
  auth.audit(req, 'auth.logout');
  auth.destroySession(req, res);
  res.clearCookie('np_2fa_pending', { path: '/admin' });
  res.redirect('/admin/login?ok=' + encodeURIComponent('সফলভাবে লগআউট হয়েছে'));
});

/* ------------------------------------------- everything below needs auth -- */
router.use(auth.requireAuth);

/* ========================================================== dashboard ==== */

router.get('/', async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const data = analytics.dashboard({ days });
    render(req, res, 'dashboard', {
      pageTitle: 'ড্যাশবোর্ড',
      days,
      ...data,
      audit: db.all(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 12`),
      commentsToReview: db.all(`SELECT c.*, a.slug, a.title_bn FROM comments c JOIN articles a ON a.id = c.article_id WHERE c.status='pending' ORDER BY c.id DESC LIMIT 8`),
      draftCount: db.get(`SELECT COUNT(*) AS n FROM articles WHERE status='draft'`)?.n || 0,
    });
  } catch (err) { next(err); }
});

router.get('/api/overview', async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json({ ok: true, overview: analytics.overview({ days }), live: analytics.liveNow() });
});

/* ========================================================== articles ===== */

router.get('/articles', auth.requirePermission('article.create', 'article.editOwn', 'article.editAny', 'analytics.view'), (req, res) => {
  const status = ['draft', 'pending', 'published', 'archived'].includes(req.query.status) ? req.query.status : '';
  const q = String(req.query.q || '').slice(0, 100);
  const where = [];
  const params = [];
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (q) { where.push('(a.title_bn LIKE ? OR a.title_en LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 25;
  const total = db.get(
    `SELECT COUNT(*) AS n FROM articles a ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  ).n;

  render(req, res, 'articles', {
    pageTitle: 'সংবাদ ব্যবস্থাপনা',
    status, q, page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    total,
    rows: db.all(
      `SELECT a.id, a.slug, a.title_bn, a.title_en, a.status, a.is_breaking, a.is_featured,
              a.views, a.comments_count, a.published_at, a.updated_at, a.is_demo, a.is_sponsored,
              c.name_bn AS category_bn, u.name AS author_name
         FROM articles a
         LEFT JOIN categories c ON c.id = a.category_id
         LEFT JOIN authors u ON u.id = a.author_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    ),
    counts: db.all(`SELECT status, COUNT(*) AS n FROM articles GROUP BY status`),
  });
});

function articleForm(req, res, article = null, values = null) {
  render(req, res, 'article-edit', {
    pageTitle: article ? 'সংবাদ সম্পাদনা' : 'নতুন সংবাদ',
    article,
    values: values || article,
    categories: repo.categories({ activeOnly: false }),
    authors: db.all(`SELECT * FROM authors ORDER BY name`),
    recentMedia: media.list({ limit: 24 }),
    corrections: article ? repo.correctionsFor(article.id) : [],
  });
}

router.get('/articles/new', auth.requirePermission('article.create'), (req, res) => articleForm(req, res));

function buildArticlePayload(data) {
  return {
    title_bn: data.title_bn,
    title_en: data.title_en || '',
    subtitle: data.subtitle || '',
    excerpt: data.excerpt || '',
    body_bn: content.sanitizeArticleHtml(data.body_bn),
    body_en: data.body_en ? content.sanitizeArticleHtml(data.body_en) : '',
    cover_image: safeUrl(data.cover_image),
    cover_caption: data.cover_caption || '',
    cover_credit: data.cover_credit || '',
    category_id: data.category_id || null,
    author_id: data.author_id || null,
    status: data.status,
    is_breaking: data.is_breaking ? 1 : 0,
    is_featured: data.is_featured ? 1 : 0,
    is_sponsored: data.is_sponsored ? 1 : 0,
    sponsor_label: data.sponsor_label || '',
    media_type: data.media_type,
    video_url: data.video_url || '',
    gallery_json: data.gallery_json || '',
    tags: csvToArray(data.tags).join(','),
    source_name: data.source_name || '',
    source_url: data.source_url || '',
    seo_title: data.seo_title || '',
    seo_desc: data.seo_desc || '',
    canonical_url: data.canonical_url || '',
    noindex: data.noindex ? 1 : 0,
    read_minutes: require('../utils/helpers').readingTime(data.body_bn),
  };
}

router.post('/articles', auth.requirePermission('article.create'), V.validate(V.articleSchema, 'body', { redirect: '/admin/articles/new' }), (req, res, next) => {
  try {
    const data = req.validated;
    const payload = buildArticlePayload(data);
    const slug = uniqueSlug(data.slug || data.title_bn, (s) => !!db.get(`SELECT id FROM articles WHERE slug = ?`, [s]));
    const publishedAt = data.status === 'published'
      ? new Date().toISOString()
      : null;

    const { lastInsertRowid } = db.run(
      `INSERT INTO articles (slug, title_bn, title_en, subtitle, excerpt, body_bn, body_en,
        cover_image, cover_caption, cover_credit, category_id, author_id, status, is_breaking,
        is_featured, is_sponsored, sponsor_label, media_type, video_url, gallery_json, tags,
        source_name, source_url, seo_title, seo_desc, canonical_url, noindex, read_minutes, published_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        slug, payload.title_bn, payload.title_en, payload.subtitle, payload.excerpt,
        payload.body_bn, payload.body_en, payload.cover_image, payload.cover_caption, payload.cover_credit,
        payload.category_id, payload.author_id, payload.status, payload.is_breaking, payload.is_featured,
        payload.is_sponsored, payload.sponsor_label, payload.media_type, payload.video_url, payload.gallery_json,
        payload.tags, payload.source_name, payload.source_url, payload.seo_title, payload.seo_desc,
        payload.canonical_url, payload.noindex, payload.read_minutes, publishedAt,
      ],
    );

    auth.audit(req, 'article.create', { entity: 'article', entityId: lastInsertRowid, meta: { slug } });
    res.redirect(`/admin/articles/${lastInsertRowid}/edit?ok=${encodeURIComponent('সংবাদ সংরক্ষিত হয়েছে')}`);
  } catch (err) { next(err); }
});

router.get('/articles/:id/edit', auth.requirePermission('article.editOwn', 'article.editAny'), (req, res, next) => {
  const article = db.get(`SELECT * FROM articles WHERE id = ?`, [Number(req.params.id)]);
  if (!article) return res.status(404).send('Not found');
  if (!auth.can(req.user, 'article.editAny') && article.author_id) {
    const author = db.get(`SELECT user_id FROM authors WHERE id = ?`, [article.author_id]);
    if (author?.user_id && author.user_id !== req.user.id) {
      return res.status(403).send('অনুমতি নেই');
    }
  }
  return articleForm(req, res, article);
});

router.post('/articles/:id', auth.requirePermission('article.editOwn', 'article.editAny'), (req, res, next) => V.validate(V.articleSchema, 'body', { redirect: `/admin/articles/${req.params.id}/edit` })(req, res, next), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = db.get(`SELECT * FROM articles WHERE id = ?`, [id]);
    if (!existing) return res.status(404).send('Not found');

    const data = req.validated;
    const payload = buildArticlePayload(data);
    const wasPublished = existing.status === 'published';
    const publishedAt = data.status === 'published'
      ? (existing.published_at || new Date().toISOString())
      : null;

    db.run(
      `UPDATE articles SET slug=?, title_bn=?, title_en=?, subtitle=?, excerpt=?, body_bn=?, body_en=?,
        cover_image=?, cover_caption=?, cover_credit=?, category_id=?, author_id=?, status=?,
        is_breaking=?, is_featured=?, is_sponsored=?, sponsor_label=?, media_type=?, video_url=?,
        gallery_json=?, tags=?, source_name=?, source_url=?, seo_title=?, seo_desc=?, canonical_url=?,
        noindex=?, read_minutes=?, published_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=?`,
      [
        data.slug ? slugify(data.slug) : existing.slug,
        payload.title_bn, payload.title_en, payload.subtitle, payload.excerpt, payload.body_bn, payload.body_en,
        payload.cover_image, payload.cover_caption, payload.cover_credit, payload.category_id, payload.author_id,
        payload.status, payload.is_breaking, payload.is_featured, payload.is_sponsored, payload.sponsor_label,
        payload.media_type, payload.video_url, payload.gallery_json, payload.tags, payload.source_name,
        payload.source_url, payload.seo_title, payload.seo_desc, payload.canonical_url, payload.noindex,
        payload.read_minutes, publishedAt, id,
      ],
    );

    if (!wasPublished && data.status === 'published' && data.is_breaking) {
      db.run(`INSERT INTO ticker_items (article_id, text_bn, text_en, priority) VALUES (?, ?, ?, 10)`, [id, payload.title_bn, payload.title_en]);
    }
    auth.audit(req, wasPublished ? 'article.update' : 'article.publish', { entity: 'article', entityId: id });
    res.redirect(`/admin/articles/${id}/edit?ok=${encodeURIComponent('পরিবর্তন সংরক্ষিত হয়েছে')}`);
  } catch (err) { next(err); }
});

router.post('/articles/:id/delete', auth.requirePermission('article.delete'), (req, res) => {
  const id = Number(req.params.id);
  db.run(`DELETE FROM articles WHERE id = ?`, [id]);
  auth.audit(req, 'article.delete', { entity: 'article', entityId: id });
  res.redirect('/admin/articles?ok=' + encodeURIComponent('সংবাদ মুছে ফেলা হয়েছে'));
});

router.post('/articles/:id/correction', auth.requirePermission('corrections.create', 'corrections.manage'), (req, res) => {
  const id = Number(req.params.id);
  const kind = ['correction', 'clarification', 'update', 'retraction'].includes(req.body.kind) ? req.body.kind : 'correction';
  const note = String(req.body.note || '').trim().slice(0, 2000);
  if (!note) return badRequest(req, res, 'সংশোধনীর বিবরণ লিখুন');
  db.run(
    `INSERT INTO corrections (article_id, kind, note, created_by) VALUES (?, ?, ?, ?)`,
    [id, kind, note, req.user.id],
  );
  db.run(
    `UPDATE articles SET corrected_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), correction_note = ? WHERE id = ?`,
    [note.slice(0, 500), id],
  );
  auth.audit(req, 'correction.create', { entity: 'article', entityId: id });
  res.redirect(`/admin/articles/${id}/edit?ok=${encodeURIComponent('সংশোধনী যুক্ত হয়েছে')}`);
});

/* ============================================================ media ====== */

router.get('/media', auth.requirePermission('media.upload', 'article.editAny', 'analytics.view'), (req, res) => {
  render(req, res, 'media', {
    pageTitle: 'মিডিয়া লাইব্রери',
    items: media.list({ limit: 120 }),
    totals: media.count(),
  });
});

router.post('/media', auth.requirePermission('media.upload'), media.upload('file', 1), (req, res, next) => {
  try {
    if (!req.file) return badRequest(req, res, 'কোনো ফাইল পাওয়া যায়নি');
    const saved = media.finalise(req, req.file, { alt: req.body.alt || '' });
    auth.audit(req, 'media.upload', { entity: 'media', entityId: saved.id, meta: { name: saved.url } });
    if (req.accepts('html')) {
      return res.redirect('/admin/media?ok=' + encodeURIComponent('আপলোড সফল'));
    }
    return res.json({ ok: true, ...saved });
  } catch (err) {
    if (err.code === 'BAD_FILE_TYPE' || err.code === 'FILE_CONTENT_MISMATCH') return badRequest(req, res, err.message);
    return next(err);
  }
});

router.post('/media/:id/delete', auth.requirePermission('media.delete'), (req, res) => {
  const id = Number(req.params.id);
  media.remove(id);
  auth.audit(req, 'media.delete', { entity: 'media', entityId: id });
  res.redirect('/admin/media?ok=' + encodeURIComponent('ফাইল মুছে ফেলা হয়েছে'));
});

/* ============================================================== ads ====== */

router.get('/ads', auth.requirePermission('ads.manage', 'analytics.view'), (req, res) => {
  render(req, res, 'ads', {
    pageTitle: 'বিজ্ঞাপন ব্যবস্থাপনা',
    rows: ads.listAds(),
    stats: ads.stats({ days: 30 }),
  });
});

function adForm(req, res, ad = null) {
  render(req, res, 'ad-edit', {
    pageTitle: ad ? 'বিজ্ঞাপন সম্পাদনা' : 'নতুন বিজ্ঞাপন',
    ad,
    categories: repo.categories({ activeOnly: false }),
    recentMedia: media.list({ limit: 24 }),
  });
}

router.get('/ads/new', auth.requirePermission('ads.manage'), (req, res) => adForm(req, res));

router.post('/ads', auth.requirePermission('ads.manage'), V.validate(V.adSchema, 'body', { redirect: '/admin/ads/new' }), (req, res, next) => {
  try {
    const d = req.validated;
    // A script creative must point at an allowlisted domain, otherwise it is
    // refused here rather than blocked later at render time.
    if (d.kind === 'script' && d.script_src) {
      let host = '';
      try { host = new URL(d.script_src).hostname; } catch { host = ''; }
      if (!config.ads.scriptAllowlist.includes(host)) {
        return badRequest(req, res, `স্ক্রিপ্ট ডোমেইন অনুমোদিত নয়: ${host}`);
      }
    }
    const { lastInsertRowid } = db.run(
      `INSERT INTO ads (name, advertiser, slot, kind, headline, body, cta, image_url, link_url, html,
        script_src, video_url, target_devices, target_countries, target_categories, priority, weight,
        daily_cap, starts_at, ends_at, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        d.name, d.advertiser, d.slot, d.kind, d.headline, d.body, d.cta, safeUrl(d.image_url) || null,
        d.link_url || null, d.html, d.script_src || null, d.video_url || null, d.target_devices, d.target_countries,
        d.target_categories, d.priority, d.weight, d.daily_cap || null, d.starts_at || null,
        d.ends_at || null, d.status,
      ],
    );
    auth.audit(req, 'ads.create', { entity: 'ad', entityId: lastInsertRowid });
    res.redirect('/admin/ads?ok=' + encodeURIComponent('বিজ্ঞাপন যুক্ত হয়েছে'));
  } catch (err) { next(err); }
});

router.get('/ads/:id/edit', auth.requirePermission('ads.manage'), (req, res) => {
  const ad = ads.adById(Number(req.params.id));
  if (!ad) return res.status(404).send('Not found');
  return adForm(req, res, ad);
});

router.post('/ads/:id', auth.requirePermission('ads.manage'), (req, res, next) => V.validate(V.adSchema, 'body', { redirect: `/admin/ads/${req.params.id}/edit` })(req, res, next), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const d = req.validated;
    if (d.kind === 'script' && d.script_src) {
      let host = '';
      try { host = new URL(d.script_src).hostname; } catch { host = ''; }
      if (!config.ads.scriptAllowlist.includes(host)) return badRequest(req, res, `স্ক্রিপ্ট ডোমেইন অনুমোদিত নয়: ${host}`);
    }
    db.run(
      `UPDATE ads SET name=?, advertiser=?, slot=?, kind=?, headline=?, body=?, cta=?, image_url=?,
        link_url=?, html=?, script_src=?, video_url=?, target_devices=?, target_countries=?,
        target_categories=?, priority=?, weight=?, daily_cap=?, starts_at=?, ends_at=?, status=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=?`,
      [
        d.name, d.advertiser, d.slot, d.kind, d.headline, d.body, d.cta, safeUrl(d.image_url) || null,
        d.link_url || null, d.html, d.script_src || null, d.video_url || null, d.target_devices, d.target_countries,
        d.target_categories, d.priority, d.weight, d.daily_cap || null, d.starts_at || null,
        d.ends_at || null, d.status, id,
      ],
    );
    auth.audit(req, 'ads.update', { entity: 'ad', entityId: id });
    res.redirect('/admin/ads?ok=' + encodeURIComponent('বিজ্ঞাপন হালনাগাদ হয়েছে'));
  } catch (err) { next(err); }
});

router.post('/ads/:id/delete', auth.requirePermission('ads.manage'), (req, res) => {
  const id = Number(req.params.id);
  db.run(`DELETE FROM ads WHERE id = ?`, [id]);
  auth.audit(req, 'ads.delete', { entity: 'ad', entityId: id });
  res.redirect('/admin/ads?ok=' + encodeURIComponent('বিজ্ঞাপন মুছে ফেলা হয়েছে'));
});

/* ========================================================= comments ====== */

router.get('/comments', auth.requirePermission('comment.moderate', 'analytics.view'), (req, res) => {
  const status = ['pending', 'approved', 'spam', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  render(req, res, 'comments', {
    pageTitle: 'মন্তব্য ব্যবস্থাপনা',
    status,
    rows: db.all(
      `SELECT c.*, a.slug, a.title_bn FROM comments c JOIN articles a ON a.id = c.article_id
        WHERE c.status = ? ORDER BY c.id DESC LIMIT 200`,
      [status],
    ),
    counts: db.all(`SELECT status, COUNT(*) AS n FROM comments GROUP BY status`),
  });
});

router.post('/comments/:id/status', auth.requirePermission('comment.moderate'), (req, res) => {
  const id = Number(req.params.id);
  const status = ['pending', 'approved', 'spam', 'rejected'].includes(req.body.status) ? req.body.status : null;
  if (!status) return badRequest(req, res, 'অবৈধ স্ট্যাটাস');
  const comment = db.get(`SELECT * FROM comments WHERE id = ?`, [id]);
  if (!comment) return res.status(404).send('Not found');

  db.run(`UPDATE comments SET status = ? WHERE id = ?`, [status, id]);
  const approved = db.get(`SELECT COUNT(*) AS n FROM comments WHERE article_id = ? AND status='approved'`, [comment.article_id]).n;
  db.run(`UPDATE articles SET comments_count = ? WHERE id = ?`, [approved, comment.article_id]);
  auth.audit(req, `comment.${status}`, { entity: 'comment', entityId: id });
  redirectBack(req, res, '/admin/comments', { ok: 'মন্তব্য হালনাগাদ হয়েছে' });
});

/* ======================================================== newsletter ===== */

router.get('/newsletter', auth.requirePermission('newsletter.manage', 'analytics.view'), (req, res) => {
  render(req, res, 'newsletter', {
    pageTitle: 'নিউজলেটার',
    stats: newsletter.stats(),
    subscribers: newsletter.list({ limit: 200 }),
    campaigns: newsletter.campaigns(),
    digestPreview: newsletter.buildDigest('bn'),
  });
});

router.post('/newsletter/campaign', auth.requirePermission('newsletter.manage'), async (req, res, next) => {
  try {
    const subject = String(req.body.subject || '').trim().slice(0, 200);
    const body = req.body.body === '__digest__' ? newsletter.buildDigest(req.locale) : content.sanitizeArticleHtml(req.body.body || '');
    if (!subject || !body) return badRequest(req, res, 'বিষয় ও বিষয়বস্তু আবশ্যক');
    const id = newsletter.createCampaign({ subject, preview: String(req.body.preview || '').slice(0, 300), body });
    auth.audit(req, 'newsletter.create', { entity: 'campaign', entityId: id });
    if (req.body.send === '1') await newsletter.sendCampaign(id);
    res.redirect('/admin/newsletter?ok=' + encodeURIComponent('ক্যাম্পেইন তৈরি হয়েছে'));
  } catch (err) { next(err); }
});

router.post('/newsletter/:id/send', auth.requirePermission('newsletter.manage'), async (req, res) => {
  const result = await newsletter.sendCampaign(Number(req.params.id));
  auth.audit(req, 'newsletter.send', { entity: 'campaign', entityId: req.params.id, meta: result });
  res.redirect('/admin/newsletter?ok=' + encodeURIComponent(`পাঠানো হয়েছে: ${result.sent || 0}`));
});

router.post('/newsletter/:id/delete', auth.requirePermission('newsletter.manage'), (req, res) => {
  db.run(`DELETE FROM subscribers WHERE id = ?`, [Number(req.params.id)]);
  auth.audit(req, 'newsletter.remove_subscriber', { entity: 'subscriber', entityId: req.params.id });
  res.redirect('/admin/newsletter?ok=' + encodeURIComponent('সাবস্ক্রাইবার মুছে ফেলা হয়েছে'));
});

/* ============================================================ users ======= */

router.get('/users', auth.requirePermission('*'), (req, res) => {
  render(req, res, 'users', {
    pageTitle: 'ব্যবহারকারী ও দল',
    rows: db.all(
      `SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS active_sessions
         FROM users u ORDER BY u.id ASC`,
    ),
    sessions: db.all(
      `SELECT s.*, u.name AS user_name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.revoked_at IS NULL ORDER BY s.last_seen_at DESC LIMIT 50`,
    ),
  });
});

router.post('/users', auth.requirePermission('*'), V.validate(V.userSchema, 'body', { redirect: '/admin/users' }), (req, res, next) => {
  try {
    const d = req.validated;
    const problems = auth.passwordProblems(d.password);
    if (problems.length) return badRequest(req, res, problems[0]);
    if (db.get(`SELECT id FROM users WHERE lower(email) = lower(?)`, [d.email])) {
      return badRequest(req, res, 'এই ইমেইল দিয়ে ইতোমধ্যে একটি অ্যাকাউন্ট আছে');
    }
    const { lastInsertRowid } = db.run(
      `INSERT INTO users (name, email, password_hash, role, status, designation, bio) VALUES (?,?,?,?,?,?,?)`,
      [d.name, d.email, auth.hashPassword(d.password), d.role, d.status, d.designation, d.bio],
    );
    db.run(
      `INSERT INTO authors (user_id, name, slug, designation, bio) VALUES (?, ?, ?, ?, ?)`,
      [lastInsertRowid, d.name, uniqueSlug(d.name, (s) => !!db.get(`SELECT id FROM authors WHERE slug = ?`, [s])), d.designation, d.bio],
    );
    auth.audit(req, 'user.create', { entity: 'user', entityId: lastInsertRowid, meta: { email: d.email, role: d.role } });
    res.redirect('/admin/users?ok=' + encodeURIComponent('নতুন ব্যবহারকারী যুক্ত হয়েছে'));
  } catch (err) { next(err); }
});

router.post('/users/:id', auth.requirePermission('*'), (req, res) => {
  const id = Number(req.params.id);
  const user = db.get(`SELECT * FROM users WHERE id = ?`, [id]);
  if (!user) return res.status(404).send('Not found');
  const role = config.roles[req.body.role] ? req.body.role : user.role;
  const status = ['active', 'suspended', 'invited'].includes(req.body.status) ? req.body.status : user.status;
  // An admin must not be able to demote or suspend themselves — that is how a
  // newsroom loses its last set of keys.
  if (id === req.user.id && (role !== user.role || status !== user.status)) {
    return badRequest(req, res, 'নিজের ভূমিকা বা স্ট্যাটাস নিজে পরিবর্তন করা যাবে না');
  }

  db.run(`UPDATE users SET name=?, role=?, status=?, designation=?, bio=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, [
    String(req.body.name || user.name).slice(0, 80), role, status,
    String(req.body.designation || '').slice(0, 120), String(req.body.bio || '').slice(0, 1000), id,
  ]);

  if (req.body.password) {
    const problems = auth.passwordProblems(req.body.password);
    if (problems.length) return badRequest(req, res, problems[0]);
    db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [auth.hashPassword(req.body.password), id]);
    auth.destroyUserSessions(id);
  }
  auth.audit(req, 'user.update', { entity: 'user', entityId: id, meta: { role, status } });
  res.redirect('/admin/users?ok=' + encodeURIComponent('ব্যবহারকারী হালনাগাদ হয়েছে'));
});

router.post('/users/:id/delete', auth.requirePermission('*'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return badRequest(req, res, 'নিজের অ্যাকাউন্ট মুছা যাবে না');
  const admins = db.get(`SELECT COUNT(*) AS n FROM users WHERE role='superadmin' AND status='active'`).n;
  const target = db.get(`SELECT role FROM users WHERE id = ?`, [id]);
  if (target?.role === 'superadmin' && admins <= 1) return badRequest(req, res, 'শেষ সুপার অ্যাডমিন মুছা যাবে না');
  db.run(`DELETE FROM users WHERE id = ?`, [id]);
  auth.audit(req, 'user.delete', { entity: 'user', entityId: id });
  res.redirect('/admin/users?ok=' + encodeURIComponent('ব্যবহারকারী মুছে ফেলা হয়েছে'));
});

router.post('/users/:id/sessions/revoke', auth.requirePermission('*'), (req, res) => {
  const id = Number(req.params.id);
  auth.destroyUserSessions(id);
  auth.audit(req, 'user.sessions_revoke', { entity: 'user', entityId: id });
  res.redirect('/admin/users?ok=' + encodeURIComponent('সব সেশন বাতিল করা হয়েছে'));
});

/* ======================================================== analytics ====== */

router.get('/analytics', auth.requirePermission('analytics.view', 'article.editAny'), (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  render(req, res, 'analytics', {
    pageTitle: 'অ্যানালিটিক্স',
    days,
    data: analytics.dashboard({ days }),
    recentEvents: analytics.events({ limit: 60 }),
    searches: trending.topSearches({ days }),
  });
});

/* ========================================================= security ======= */

router.get('/security', auth.requirePermission('*'), (req, res) => {
  render(req, res, 'security', {
    pageTitle: 'নিরাপত্তা কেন্দ্র',
    events: db.all(`SELECT * FROM security_events ORDER BY id DESC LIMIT 200`),
    blocked: db.all(`SELECT * FROM blocked_ips ORDER BY blocked_at DESC`),
    kinds: db.all(
      `SELECT kind, severity, COUNT(*) AS n, MAX(created_at) AS last FROM security_events
        GROUP BY kind ORDER BY n DESC`,
    ),
    audit: db.all(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 100`),
  });
});

router.post('/security/block', auth.requirePermission('*'), (req, res) => {
  const ip = String(req.body.ip || '').trim().slice(0, 45);
  const reason = String(req.body.reason || '').slice(0, 200);
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return badRequest(req, res, 'অবৈধ আইপি');
  db.run(
    `INSERT INTO blocked_ips (ip, reason, blocked_by) VALUES (?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, blocked_by = excluded.blocked_by`,
    [ip, reason, req.user.id],
  );
  security.invalidateBlockCache();
  auth.audit(req, 'security.block_ip', { meta: { ip: ipTail(ip) } });
  res.redirect('/admin/security?ok=' + encodeURIComponent('আইপি ব্লক করা হয়েছে'));
});

router.post('/security/unblock', auth.requirePermission('*'), (req, res) => {
  db.run(`DELETE FROM blocked_ips WHERE ip = ?`, [String(req.body.ip || '').slice(0, 45)]);
  security.invalidateBlockCache();
  auth.audit(req, 'security.unblock_ip', { meta: { ip: ipTail(req.body.ip) } });
  res.redirect('/admin/security?ok=' + encodeURIComponent('ব্লক সরানো হয়েছে'));
});

/* ========================================================= settings ======= */

router.get('/settings', auth.requirePermission('*'), (req, res) => {
  render(req, res, 'settings', {
    pageTitle: 'সাইট সেটিংস',
    values: content.getSettings(true),
    categories: repo.categories({ activeOnly: false }),
  });
});

const SETTINGS_KEYS = Object.keys(content.DEFAULTS);

router.post('/settings', auth.requirePermission('*'), (req, res) => {
  const body = req.body || {};
  for (const key of SETTINGS_KEYS) {
    if (body[key] === undefined) continue;
    let value = String(body[key]).slice(0, 4000);
    if (key.endsWith('_url') || key === 'live_tv_url') value = safeUrl(value, { allowRelative: true });
    content.setSetting(key, value);
  }
  auth.audit(req, 'settings.update', { meta: { keys: SETTINGS_KEYS.filter((k) => body[k] !== undefined) } });
  res.redirect('/admin/settings?ok=' + encodeURIComponent('সেটিংস সংরক্ষিত হয়েছে'));
});

router.post('/categories', auth.requirePermission('*'), (req, res) => {
  const nameBn = String(req.body.name_bn || '').trim().slice(0, 80);
  const nameEn = String(req.body.name_en || '').trim().slice(0, 80) || nameBn;
  if (!nameBn) return badRequest(req, res, 'বিভাগের নাম দিন');
  const slug = req.body.slug ? slugify(req.body.slug) : uniqueSlug(nameEn, (s) => !!db.get(`SELECT id FROM categories WHERE slug = ?`, [s]));
  db.run(
    `INSERT INTO categories (slug, name_bn, name_en, description, color, sort_order, is_active)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(slug) DO UPDATE SET name_bn=excluded.name_bn, name_en=excluded.name_en,
       description=excluded.description, color=excluded.color, sort_order=excluded.sort_order,
       is_active=excluded.is_active`,
    [
      slug, nameBn, nameEn, String(req.body.description || '').slice(0, 300),
      /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#e11d2e',
      Number(req.body.sort_order) || 0, req.body.is_active === '0' ? 0 : 1,
    ],
  );
  auth.audit(req, 'category.upsert', { entity: 'category', entityId: slug });
  res.redirect('/admin/settings?ok=' + encodeURIComponent('বিভাগ সংরক্ষিত হয়েছে'));
});

router.post('/categories/:id/delete', auth.requirePermission('*'), (req, res) => {
  const id = Number(req.params.id);
  const used = db.get(`SELECT COUNT(*) AS n FROM articles WHERE category_id = ?`, [id]).n;
  if (used) return badRequest(req, res, `এই বিভাগে ${used}টি সংবাদ আছে — আগে সেগুলো সরান`);
  db.run(`DELETE FROM categories WHERE id = ?`, [id]);
  auth.audit(req, 'category.delete', { entity: 'category', entityId: id });
  res.redirect('/admin/settings?ok=' + encodeURIComponent('বিভাগ মুছে ফেলা হয়েছে'));
});

/* ============================================================ pages ======= */

router.get('/pages', auth.requirePermission('pages.manage', 'analytics.view'), (req, res) => {
  render(req, res, 'pages', {
    pageTitle: 'স্ট্যাটিক পেজ',
    rows: db.all(`SELECT * FROM pages ORDER BY slug`),
    editing: req.query.slug ? db.get(`SELECT * FROM pages WHERE slug = ?`, [String(req.query.slug).slice(0, 80)]) : null,
  });
});

router.post('/pages', auth.requirePermission('pages.manage'), V.validate(V.pageSchema, 'body', { redirect: '/admin/pages' }), (req, res) => {
  const d = req.validated;
  db.run(
    `INSERT INTO pages (slug, title_bn, title_en, body_bn, body_en, updated_at)
     VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(slug) DO UPDATE SET title_bn=excluded.title_bn, title_en=excluded.title_en,
       body_bn=excluded.body_bn, body_en=excluded.body_en, updated_at=excluded.updated_at`,
    [d.slug, d.title_bn, d.title_en, content.sanitizeArticleHtml(d.body_bn), d.body_en ? content.sanitizeArticleHtml(d.body_en) : ''],
  );
  auth.audit(req, 'page.upsert', { entity: 'page', entityId: d.slug });
  res.redirect('/admin/pages?ok=' + encodeURIComponent('পেজ সংরক্ষিত হয়েছে'));
});

router.post('/pages/:slug/delete', auth.requirePermission('pages.manage'), (req, res) => {
  db.run(`DELETE FROM pages WHERE slug = ?`, [String(req.params.slug).slice(0, 80)]);
  auth.audit(req, 'page.delete', { entity: 'page', entityId: req.params.slug });
  res.redirect('/admin/pages?ok=' + encodeURIComponent('পেজ মুছে ফেলা হয়েছে'));
});

/* =========================================================== ticker ======= */

router.get('/ticker', auth.requirePermission('ticker.manage', 'article.editAny'), (req, res) => {
  render(req, res, 'ticker', {
    pageTitle: 'ব্রেকিং নিউজ টিকার',
    rows: db.all(
      `SELECT t.*, a.title_bn AS article_title, a.slug FROM ticker_items t
        LEFT JOIN articles a ON a.id = t.article_id ORDER BY t.priority ASC, t.id DESC LIMIT 100`,
    ),
    breaking: repo.publishedArticles({ breakingOnly: true, limit: 30 }),
  });
});

router.post('/ticker', auth.requirePermission('ticker.manage'), V.validate(V.tickerSchema, 'body', { redirect: '/admin/ticker' }), (req, res) => {
  const d = req.validated;
  db.run(
    `INSERT INTO ticker_items (article_id, text_bn, text_en, priority, active, starts_at, ends_at)
     VALUES (?,?,?,?,?,?,?)`,
    [d.article_id || null, d.text_bn, d.text_en, d.priority, d.active ? 1 : 0, d.starts_at || null, d.ends_at || null],
  );
  auth.audit(req, 'ticker.create', { meta: { text: d.text_bn.slice(0, 60) } });
  res.redirect('/admin/ticker?ok=' + encodeURIComponent('টিকারে যুক্ত হয়েছে'));
});

router.post('/ticker/:id/delete', auth.requirePermission('ticker.manage'), (req, res) => {
  db.run(`DELETE FROM ticker_items WHERE id = ?`, [Number(req.params.id)]);
  auth.audit(req, 'ticker.delete', { entity: 'ticker', entityId: req.params.id });
  res.redirect('/admin/ticker?ok=' + encodeURIComponent('টিকার থেকে সরানো হয়েছে'));
});

router.post('/ticker/:id/toggle', auth.requirePermission('ticker.manage'), (req, res) => {
  db.run(`UPDATE ticker_items SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id = ?`, [Number(req.params.id)]);
  auth.audit(req, 'ticker.toggle', { entity: 'ticker', entityId: req.params.id });
  res.redirect('/admin/ticker?ok=' + encodeURIComponent('হালনাগাদ হয়েছে'));
});

/* ============================================================ polls ======= */

router.get('/polls', auth.requirePermission('poll.manage', 'article.editAny'), (req, res) => {
  render(req, res, 'polls', {
    pageTitle: 'পোল / ভোট',
    rows: db.all(`SELECT * FROM polls ORDER BY id DESC LIMIT 50`).map((p) => ({ ...p, options: parseJson(p.options, []) })),
  });
});

router.post('/polls', auth.requirePermission('poll.manage'), V.validate(V.pollSchema, 'body', { redirect: '/admin/polls' }), (req, res) => {
  const d = req.validated;
  const lines = String(d.options).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8);
  if (lines.length < 2) return badRequest(req, res, 'কমপক্ষে ২টি অপশন দিন (প্রতি লাইনে একটি)');
  const options = lines.map((line, i) => ({ id: `o${i + 1}`, bn: line, en: line, votes: 0 }));
  db.run(
    `INSERT INTO polls (question_bn, question_en, options, active) VALUES (?,?,?,?)`,
    [d.question_bn, d.question_en, JSON.stringify(options), d.active ? 1 : 0],
  );
  auth.audit(req, 'poll.create', { meta: { q: d.question_bn.slice(0, 60) } });
  res.redirect('/admin/polls?ok=' + encodeURIComponent('পোল তৈরি হয়েছে'));
});

router.post('/polls/:id/delete', auth.requirePermission('poll.manage'), (req, res) => {
  db.run(`DELETE FROM polls WHERE id = ?`, [Number(req.params.id)]);
  auth.audit(req, 'poll.delete', { entity: 'poll', entityId: req.params.id });
  res.redirect('/admin/polls?ok=' + encodeURIComponent('পোল মুছে ফেলা হয়েছে'));
});

/* ========================================================== assistant ===== */

router.get('/assistant', auth.requirePermission('analytics.view'), (req, res) => {
  render(req, res, 'assistant', {
    pageTitle: 'এআই অ্যাসিস্ট',
    stats: ai.stats({ days: 30 }),
    provider: ai.providerConfig(),
    recent: db.all(
      `SELECT chat_id, role, content, lang, engine, created_at FROM assistant_chats ORDER BY id DESC LIMIT 120`,
    ),
  });
});

/* =========================================================== account ====== */

router.get('/account', auth.requireAuth, (req, res) => {
  const user = db.get(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
  // A brand-new secret is generated only when the operator explicitly asks to
  // set 2FA up; it is shown once and never stored until they confirm a code.
  const startingSetup = !user.two_factor_on && req.query.setup2fa === '1';
  const pendingSecret = startingSetup ? totp.randomSecret() : null;

  render(req, res, 'account', {
    pageTitle: 'আমার অ্যাকাউন্ট',
    account: user,
    pendingSecret,
    otpauthUrl: pendingSecret ? totp.otpauthUrl({ secret: pendingSecret, email: user.email }) : null,
    sessions: db.all(`SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 20`, [req.user.id]),
  });
});

router.post('/account/password', auth.requireAuth, (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  const user = db.get(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
  if (!auth.verifyPassword(current, user.password_hash)) return badRequest(req, res, 'বর্তমান পাসওয়ার্ড সঠিক নয়');
  const problems = auth.passwordProblems(next);
  if (problems.length) return badRequest(req, res, problems[0]);
  db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [auth.hashPassword(next), req.user.id]);
  auth.destroyUserSessions(req.user.id, req.session.id);
  auth.audit(req, 'auth.password_change');
  res.redirect('/admin/account?ok=' + encodeURIComponent('পাসওয়ার্ড পরিবর্তিত হয়েছে'));
});

router.post('/account/2fa/setup', auth.requireAuth, (req, res) => {
  const secret = String(req.body.secret || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z2-7]{16,64}$/.test(secret)) return badRequest(req, res, 'অবৈধ সিক্রেট');
  db.run(`UPDATE users SET totp_secret = ? WHERE id = ?`, [secret, req.user.id]);
  auth.audit(req, 'auth.2fa_secret_stored');
  res.redirect('/admin/account?ok=' + encodeURIComponent('সিক্রেট সংরক্ষিত — এখন কোড দিয়ে নিশ্চিত করুন'));
});

router.post('/account/2fa/enable', auth.requireAuth, (req, res) => {
  const user = db.get(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
  if (!user.totp_secret) return badRequest(req, res, 'আগে সিক্রেট সংরক্ষণ করুন');
  if (!totp.verify(user.totp_secret, req.body.token)) return badRequest(req, res, 'কোড মেলেনি');
  db.run(`UPDATE users SET two_factor_on = 1 WHERE id = ?`, [req.user.id]);
  auth.audit(req, 'auth.2fa_enabled');
  res.redirect('/admin/account?ok=' + encodeURIComponent('টু-ফ্যাক্টর চালু হয়েছে'));
});

router.post('/account/2fa/disable', auth.requireAuth, (req, res) => {
  const user = db.get(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
  if (!auth.verifyPassword(String(req.body.current || ''), user.password_hash)) {
    return badRequest(req, res, 'পাসওয়ার্ড সঠিক নয়');
  }
  db.run(`UPDATE users SET two_factor_on = 0, totp_secret = NULL WHERE id = ?`, [req.user.id]);
  auth.audit(req, 'auth.2fa_disabled');
  security.logSecurityEvent({ kind: '2fa_disabled', severity: 'medium', req, detail: req.user.email });
  res.redirect('/admin/account?ok=' + encodeURIComponent('টু-ফ্যাক্টর বন্ধ হয়েছে'));
});

/* =========================================================== backups ====== */

router.post('/backup', auth.requirePermission('*'), (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(config.paths.backups, `newspulse24-${stamp}.db`);
  try {
    db.backup(dest);
    auth.audit(req, 'system.backup', { meta: { file: path.basename(dest) } });
    res.redirect('/admin/settings?ok=' + encodeURIComponent(`ব্যাকআপ তৈরি: ${path.basename(dest)}`));
  } catch (err) {
    res.redirect('/admin/settings?err=' + encodeURIComponent(`ব্যাকআপ ব্যর্থ: ${err.message}`));
  }
});

module.exports = router;
