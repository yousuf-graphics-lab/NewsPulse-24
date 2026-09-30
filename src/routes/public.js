'use strict';

/** Public-facing routes: the reader's entire experience. */

const express = require('express');
const config = require('../config');
const db = require('../db');
const repo = require('../services/content-repo');
const trending = require('../services/trending');
const ads = require('../services/ads');
const newsletter = require('../services/newsletter');
const media = require('../services/media');
const settings = require('../services/content');
const analytics = require('../middleware/analytics');
const { track } = analytics;
const security = require('../middleware/security');
const { HttpError } = require('../middleware/error');
const V = require('../utils/validate');
const {
  pick, formatDate, formatDateTime, timeAgo, bnNumber, compactNumber,
  readingTime, excerptFrom, embedUrl, safeUrl, slugify, escapeHtml, csvToArray,
} = require('../utils/helpers');

const router = express.Router();
const PER_PAGE = config.site.articlesPerPage;

/* ------------------------------------------------------- shared view data - */

function decorate(article, locale) {
  if (!article) return null;
  const title = pick(article, 'title', locale);
  const cover = article.cover_image ? safeUrl(article.cover_image) : '';
  return {
    ...article,
    url: `/news/${article.slug}`,
    title,
    titleAlt: pick(article, 'title', locale === 'bn' ? 'en' : 'bn'),
    category: locale === 'bn' ? article.category_bn : (article.category_en || article.category_bn),
    categorySlug: article.category_slug,
    categoryColor: article.category_color,
    excerpt: article.excerpt || excerptFrom(article.body_bn || article.body_en || '', 170),
    cover,
    timeAgo: timeAgo(article.published_at, locale),
    dateLabel: formatDate(article.published_at, locale),
    viewsLabel: compactNumber(article.views),
    embed: article.video_url ? embedUrl(article.video_url) : '',
    gallery: (() => {
      try { return JSON.parse(article.gallery_json || '[]'); } catch { return []; }
    })(),
  };
}

function decorateAll(rows, locale) {
  return (rows || []).map((r) => decorate(r, locale));
}

async function baseLocals(req) {
  const locale = req.locale || 'bn';
  const cats = repo.categories();
  const tickerEnabled = settings.getSetting('ticker_enabled', '1') === '1';
  return {
    locale,
    csrfToken: typeof req.csrfToken === 'function' ? req.csrfToken() : '',
    site: settings.getSettings(),
    categories: cats,
    ticker: tickerEnabled ? repo.breakingTicker(14) : [],
    tickerEnabled,
    user: req.user,
    currentPath: req.path,
    adsEnabled: config.ads.enabled,
    slot: (id) => ads.renderSlot(req, id, { categorySlug: req.categorySlug, articleId: req.articleId }),
    adsensePublisher: settings.getSetting('adsense_publisher_id', ''),
    h: { formatDate, formatDateTime, timeAgo, bnNumber, compactNumber, pick, escapeHtml, embedUrl, safeUrl },
  };
}

async function render(req, res, view, locals = {}) {
  res.render(view, { ...(await baseLocals(req)), ...locals });
}

/* ---------------------------------------------------------------- health -- */

router.get('/healthz', (req, res) => {
  try {
    db.get('SELECT 1 AS ok');
    res.json({ ok: true, uptime: Math.round(process.uptime()), env: config.env });
  } catch (err) {
    res.status(503).json({ ok: false, error: String(err.message).slice(0, 100) });
  }
});

/* ------------------------------------------------------------------ home -- */

router.get('/', async (req, res, next) => {
  try {
    const locale = req.locale || 'bn';
    const lead = decorateAll(repo.featured(5), locale);
    const latest = decorateAll(repo.latest(14), locale);
    const groups = repo.byCategory(4).map((g) => ({
      category: g.category,
      articles: decorateAll(g.articles, locale),
    }));
    const used = new Set([...lead, ...latest].map((a) => a.id));
    const mostRead = repo.mostRead(6).filter((a) => !used.has(a.id)).slice(0, 5);
    const videoStories = decorateAll(
      repo.publishedArticles({ limit: 40 }).filter((a) => a.media_type === 'video').slice(0, 4),
      locale,
    );

    await render(req, res, 'home', {
      pageTitle: locale === 'bn' ? 'নিউজপালস ২৪ — সর্বশেষ সংবাদ' : 'NewsPulse 24 — Latest News',
      metaDescription: settings.getSetting('tagline_bn'),
      lead,
      latest,
      groups,
      mostRead: decorateAll(mostRead, locale),
      videoStories,
      trending: trending.trending({ limit: 6 }),
      poll: db.get(`SELECT * FROM polls WHERE active = 1 ORDER BY id DESC LIMIT 1`),
      canonical: '/',
    });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- categories - */

router.get('/category/:slug', async (req, res, next) => {
  try {
    const category = repo.categoryBySlug(req.params.slug);
    if (!category) throw new HttpError(404, 'Category not found');
    req.categorySlug = category.slug;
    const locale = req.locale || 'bn';
    const page = Math.max(1, Number(req.query.page) || 1);
    const total = repo.countPublished({ categorySlug: category.slug });
    const rows = repo.publishedArticles({
      categorySlug: category.slug, limit: PER_PAGE, offset: (page - 1) * PER_PAGE,
    });

    await render(req, res, 'category', {
      pageTitle: `${locale === 'bn' ? category.name_bn : category.name_en} — নিউজপালস ২৪`,
      metaDescription: category.description || '',
      category,
      articles: decorateAll(rows, locale),
      page,
      totalPages: Math.max(1, Math.ceil(total / PER_PAGE)),
      total,
      mostRead: decorateAll(repo.mostRead(5), locale),
      canonical: `/category/${category.slug}`,
    });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- article --- */

router.get('/news/:slug', async (req, res, next) => {
  try {
    const locale = req.locale || 'bn';
    const article = repo.articleBySlug(req.params.slug);
    if (!article) throw new HttpError(404, 'Article not found');

    // Count a human read only — bots and prefetches are excluded.
    if (!req.ua?.isBot && req.method === 'GET') {
      repo.registerView(article.id);
      article.views += 1;
    }

    req.articleId = article.id;
    req.categorySlug = article.category_slug;

    const body = locale === 'bn' ? (article.body_bn || article.body_en || '') : (article.body_en || article.body_bn || '');
    const view = decorate(article, locale);

    await render(req, res, 'article', {
      pageTitle: article.seo_title || view.title,
      metaDescription: article.seo_desc || view.excerpt,
      article: view,
      bodyHtml: body,
      corrections: repo.correctionsFor(article.id),
      related: decorateAll(repo.relatedArticles(article, 5), locale),
      mostRead: decorateAll(repo.mostRead(6), locale),
      trending: trending.trending({ limit: 5 }),
      comments: db.all(
        `SELECT c.id, c.name, c.body, c.created_at, c.likes, c.parent_id
           FROM comments c WHERE c.article_id = ? AND c.status = 'approved'
          ORDER BY c.created_at DESC LIMIT 100`,
        [article.id],
      ),
      commentsEnabled: settings.getSetting('comments_enabled', '1') === '1',
      canonical: article.canonical_url || `/news/${article.slug}`,
      noindex: !!article.noindex,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        headline: view.title,
        description: view.excerpt,
        image: view.cover ? new URL(view.cover, config.publicUrl).href : undefined,
        datePublished: article.published_at,
        dateModified: article.updated_at,
        articleSection: view.category,
        inLanguage: locale === 'bn' ? 'bn' : 'en',
        author: { '@type': 'Person', name: article.author_name || settings.getSetting('site_name_en') },
        publisher: {
          '@type': 'Organization',
          name: settings.getSetting('site_name_en'),
          logo: { '@type': 'ImageObject', url: `${config.publicUrl}/assets/logo.svg` },
        },
        mainEntityOfPage: `${config.publicUrl}/news/${article.slug}`,
      },
    });
  } catch (err) { next(err); }
});

/* --------------------------------------------------- author / tag / search - */

router.get('/author/:slug', async (req, res, next) => {
  try {
    const author = repo.authorBySlug(req.params.slug);
    if (!author) throw new HttpError(404, 'Author not found');
    const locale = req.locale || 'bn';
    const rows = repo.publishedArticles({ authorSlug: author.slug, limit: 20 });
    await render(req, res, 'author', {
      pageTitle: `${author.name} — নিউজপালস ২৪`,
      metaDescription: author.bio || '',
      author,
      articles: decorateAll(rows, locale),
      canonical: `/author/${author.slug}`,
    });
  } catch (err) { next(err); }
});

router.get('/tag/:slug', async (req, res, next) => {
  try {
    const locale = req.locale || 'bn';
    const tag = req.params.slug;
    const rows = repo.publishedArticles({ tag, limit: 24 });
    await render(req, res, 'tag', {
      pageTitle: `${tag} — নিউজপালস ২৪`,
      tag,
      articles: decorateAll(rows, locale),
      canonical: `/tag/${tag}`,
    });
  } catch (err) { next(err); }
});

router.get('/search', async (req, res, next) => {
  try {
    const parsed = V.searchSchema.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'Invalid search');
    const { q, page, category } = parsed.data;
    const locale = req.locale || 'bn';
    const rows = repo.publishedArticles({
      search: q, categorySlug: category || null, limit: PER_PAGE, offset: (page - 1) * PER_PAGE,
    });
    const total = repo.countPublished({ search: q, categorySlug: category || null });
    trending.logSearch(q, rows.length, req.geo?.country);
    track(req, { type: 'search', meta: { q, results: rows.length } }).catch(() => {});

    await render(req, res, 'search', {
      pageTitle: `${q} — অনুসন্ধান`,
      query: q,
      category,
      articles: decorateAll(rows, locale),
      page,
      totalPages: Math.max(1, Math.ceil(total / PER_PAGE)),
      total,
      noindex: true,
      canonical: `/search?q=${encodeURIComponent(q)}`,
    });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------ live / pages - */

router.get('/live', async (req, res, next) => {
  try {
    const locale = req.locale || 'bn';
    await render(req, res, 'live', {
      pageTitle: locale === 'bn' ? 'সরাসরি সম্প্রচার — নিউজপালস ২৪' : 'Live TV — NewsPulse 24',
      metaDescription: 'নিউজপালস ২৪-এর সরাসরি সম্প্রচার দেখুন।',
      embed: embedUrl(settings.getSetting('live_tv_url', '')),
      trending: trending.trending({ limit: 6 }),
      canonical: '/live',
    });
  } catch (err) { next(err); }
});

router.get('/page/:slug', async (req, res, next) => {
  try {
    const locale = req.locale || 'bn';
    const page = db.get(`SELECT * FROM pages WHERE slug = ?`, [req.params.slug]);
    if (!page) throw new HttpError(404, 'Page not found');
    await render(req, res, 'static-page', {
      pageTitle: pick(page, 'title', locale),
      metaDescription: excerptFrom(page.body_bn, 150),
      page: {
        ...page,
        title: pick(page, 'title', locale),
        body: pick(page, 'body', locale),
      },
      canonical: `/page/${page.slug}`,
    });
  } catch (err) { next(err); }
});

/* ----------------------------------------------------------------- media -- */

router.get('/media/:filename', (req, res) => {
  const found = media.readSafe(req.params.filename);
  if (!found) { res.status(404).type('txt').send('Not found'); return; }
  // Served by the app (not the static dir) so headers are always correct.
  res.setHeader('Content-Type', found.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'");
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(found.path);
});

/* --------------------------------------------------- sandboxed ad frames -- */

/**
 * Third-party ad HTML/JS runs here, in a document of its own with a CSP that
 * only allows the allowlisted ad domain. The frame is loaded with
 * sandbox="allow-scripts" (no allow-same-origin) so it cannot read the parent
 * page's cookies, storage or DOM.
 */
router.get('/ads/frame/:id', (req, res) => {
  const ad = ads.adById(Number(req.params.id));
  if (!ad || ad.status !== 'active') { res.status(404).type('txt').send(''); return; }

  const scriptDomains = config.ads.scriptAllowlist.map((d) => `https://${d}`);
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${scriptDomains.join(' ')}`,
    "style-src 'unsafe-inline'",
    "img-src * data:",
    "media-src *",
    "frame-src *",
    "connect-src *",
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html');

  if (ad.kind === 'script' && ad.script_src) {
    const src = safeUrl(ad.script_src, { allowRelative: false });
    const host = (() => { try { return new URL(src).hostname; } catch { return ''; } })();
    if (!config.ads.scriptAllowlist.includes(host)) { res.status(403).send(''); return; }
    res.send(`<!doctype html><meta charset="utf-8"><script async src="${escapeHtml(src)}"><\/script>`);
    return;
  }
  if (ad.kind === 'html' && ad.html) {
    res.send(`<!doctype html><meta charset="utf-8">${ad.html}`);
    return;
  }
  res.status(404).type('txt').send('');
});

/* ------------------------------------------------------- engagement APIs -- */

router.post('/api/reaction/:id', security.limiters.write(), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false });
  db.run(`UPDATE articles SET likes = likes + 1 WHERE id = ?`, [id]);
  const likes = db.get(`SELECT likes FROM articles WHERE id = ?`, [id])?.likes || 0;
  track(req, { type: 'reaction', articleId: id }).catch(() => {});
  res.json({ ok: true, likes });
});

router.post('/api/track', security.limiters.beacon(), async (req, res) => {
  const { event, path: p, articleId, meta } = req.body || {};
  const allowed = ['share', 'scroll_depth', 'newsletter_open', 'video_play', 'ad_view'];
  if (!allowed.includes(event)) return res.status(400).json({ ok: false });
  track(req, { type: event, path: p, articleId: Number(articleId) || null, meta }).catch(() => {});
  res.json({ ok: true });
});

router.get('/api/trending', async (req, res) => {
  const locale = req.locale || 'bn';
  res.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    items: trending.trending({ limit: 8 }).map((a) => ({
      title: locale === 'bn' ? a.title_bn : (a.title_en || a.title_bn),
      url: `/news/${a.slug}`,
      category: locale === 'bn' ? a.category_bn : (a.category_en || a.category_bn),
      views: a.recent_views,
    })),
  });
});

/** The ticker polls this so an editor can push breaking news without a deploy. */
router.get('/api/ticker', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, items: repo.breakingTicker(14) });
});

router.post('/comments', security.limiters.write(), V.validate(V.commentSchema), async (req, res, next) => {
  try {
    const data = req.validated;
    // Honeypot: bots fill the hidden "website" field, humans never see it.
    if (data.website) return res.status(200).json({ ok: true, ignored: true });

    if (settings.getSetting('comments_enabled', '1') !== '1') {
      return res.status(403).json({ ok: false, error: 'comments_disabled' });
    }
    const article = db.get(`SELECT id FROM articles WHERE id = ? AND status='published'`, [data.article_id]);
    if (!article) return res.status(404).json({ ok: false, error: 'article_not_found' });

    const moderation = settings.getSetting('comments_moderation', '1') === '1';
    const body = settings.sanitizeCommentText(data.body);
    if (!body) return res.status(400).json({ ok: false, error: 'empty_comment' });

    db.run(
      `INSERT INTO comments (article_id, parent_id, name, email, body, status, ip_hash, country, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.article_id, data.parent_id || null, data.name,
        newsletter.isValidEmail(data.email) ? data.email : null,
        body, moderation ? 'pending' : 'approved',
        require('../utils/helpers').hashIp(require('../utils/helpers').clientIp(req)),
        req.geo?.country || null,
        String(req.headers['user-agent'] || '').slice(0, 200),
      ],
    );
    if (!moderation) {
      db.run(`UPDATE articles SET comments_count = comments_count + 1 WHERE id = ?`, [data.article_id]);
    }
    track(req, { type: 'comment', articleId: data.article_id }).catch(() => {});
    res.status(201).json({
      ok: true,
      pending: moderation,
      message: moderation
        ? 'মন্তব্যটি পর্যালোচনার জন্য জমা হয়েছে। ধন্যবাদ!'
        : 'মন্তব্য প্রকাশিত হয়েছে। ধন্যবাদ!',
    });
  } catch (err) { next(err); }
});

router.post('/polls/:id/vote', security.limiters.write(), async (req, res) => {
  const pollId = Number(req.params.id);
  const optionId = String(req.body?.option || '').slice(0, 40);
  const poll = db.get(`SELECT * FROM polls WHERE id = ? AND active = 1`, [pollId]);
  if (!poll || !optionId) return res.status(400).json({ ok: false });

  const visitor = req.visitorId || 'anon';
  const already = db.get(`SELECT id FROM poll_votes WHERE poll_id = ? AND visitor_id = ?`, [pollId, visitor]);
  const options = JSON.parse(poll.options || '[]');
  if (already) {
    return res.json({ ok: true, already: true, options });
  }
  const target = options.find((o) => String(o.id) === optionId);
  if (!target) return res.status(400).json({ ok: false });

  db.tx(() => {
    target.votes = (target.votes || 0) + 1;
    db.run(`INSERT INTO poll_votes (poll_id, option_id, visitor_id, ip_hash) VALUES (?, ?, ?, ?)`, [
      pollId, optionId, visitor, require('../utils/helpers').hashIp(require('../utils/helpers').clientIp(req)),
    ]);
    db.run(`UPDATE polls SET options = ? WHERE id = ?`, [JSON.stringify(options), pollId]);
  });
  track(req, { type: 'vote', meta: { pollId, optionId } }).catch(() => {});
  res.json({ ok: true, options });
});

/* ------------------------------------------------------------- newsletter - */

router.post('/newsletter/subscribe', security.limiters.write(), V.validate(V.newsletterSchema), async (req, res) => {
  const { email, lang } = req.validated;
  const result = newsletter.subscribe({ email, lang, country: req.geo?.country });
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  track(req, { type: 'subscribe' }).catch(() => {});
  res.json({
    ok: true,
    message: result.already
      ? 'আপনি ইতোমধ্যে সাবস্ক্রাইব করেছেন। ধন্যবাদ!'
      : result.pending
        ? 'নিশ্চিতকরণ ইমেইল পাঠানো হয়েছে — ইনবক্স দেখুন।'
        : 'সাবস্ক্রিপশন সফল! ধন্যবাদ।',
  });
});

router.get('/newsletter/confirm', (req, res) => {
  const ok = newsletter.confirmSubscription(req.query.token);
  res.redirect(ok ? '/?subscribed=1' : '/?subscribed=0');
});

router.get('/newsletter/unsubscribe', (req, res) => {
  const ok = newsletter.unsubscribe(req.query.token);
  res.redirect(ok ? '/?unsubscribed=1' : '/');
});

/* --------------------------------------------------- ad beacons (1x1 gif) - */

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

router.get('/api/ad/impression', security.limiters.beacon(), (req, res) => {
  ads.recordEvent({
    adId: Number(req.query.id) || null,
    slot: String(req.query.slot || '').slice(0, 40),
    kind: 'impression',
    req,
    country: req.geo?.country || '',
    device: req.ua?.device || '',
    articleId: Number(req.query.article) || null,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.type('image/gif').send(GIF);
});

router.get('/api/ad/click', security.limiters.beacon(), (req, res) => {
  const id = Number(req.query.id) || null;
  ads.recordEvent({
    adId: id,
    slot: String(req.query.slot || '').slice(0, 40),
    kind: 'click',
    req,
    country: req.geo?.country || '',
    device: req.ua?.device || '',
    articleId: Number(req.query.article) || null,
  });
  const target = id ? ads.adById(id)?.link_url : '';
  const url = safeUrl(target, { allowRelative: false });
  if (url) { res.redirect(302, url); return; }
  res.status(204).end();
});

/* ------------------------------------------------------- SEO / standards -- */

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /api/',
    'Disallow: /ads/frame/',
    'Disallow: /search',
    '',
    'Sitemap: ' + `${config.publicUrl}/sitemap.xml`,
    '',
  ].join('\n'));
});

router.get('/ads.txt', (req, res) => {
  res.type('text/plain').send(ads.adsTxt());
});

/**
 * RFC 9116 vulnerability-disclosure contact. Scanners look in BOTH locations —
 * `/.well-known/security.txt` is the canonical one and the one that must not
 * 404 — so we serve the same document from each.
 */
const securityTxt = () => [
  'Contact: mailto:security@newspulse24.com',
  'Preferred-Languages: bn, en',
  'Canonical: ' + `${config.publicUrl}/.well-known/security.txt`,
  'Policy: ' + `${config.publicUrl}/page/editorial-policy`,
  '',
].join('\n');

router.get('/security.txt', (req, res) => {
  res.type('text/plain').send(securityTxt());
});

router.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain').send(securityTxt());
});

router.get('/sitemap.xml', (req, res) => {
  const urls = [{ loc: `${config.publicUrl}/`, priority: '1.0', changefreq: 'hourly' }];
  for (const cat of repo.categories()) urls.push({ loc: `${config.publicUrl}/category/${cat.slug}`, priority: '0.8', changefreq: 'daily' });
  for (const a of repo.sitemapArticles()) {
    urls.push({
      loc: `${config.publicUrl}/news/${a.slug}`,
      lastmod: (a.updated_at || a.published_at || '').slice(0, 10),
      priority: '0.7',
      changefreq: 'weekly',
    });
  }
  for (const p of ['live', 'page/about', 'page/editorial-policy', 'advertise', 'contact']) {
    urls.push({ loc: `${config.publicUrl}/${p}`, priority: '0.5', changefreq: 'monthly' });
  }
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map((u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')
    }\n</urlset>`,
  );
});

router.get('/feed.xml', (req, res) => {
  const locale = req.locale || 'bn';
  const items = repo.latest(20);
  res.type('application/rss+xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>`
    + `<title>${escapeHtml(settings.getSetting('site_name_en'))}</title>`
    + `<link>${config.publicUrl}</link>`
    + `<description>${escapeHtml(settings.getSetting('tagline_en'))}</description>`
    + `<language>${locale}</language>`
    + `<atom:link href="${config.publicUrl}/feed.xml" rel="self" type="application/rss+xml"/>`
    + items.map((a) => {
      const d = decorate(a, locale);
      return `<item><title>${escapeHtml(d.title)}</title><link>${config.publicUrl}${d.url}</link>`
        + `<guid isPermaLink="true">${config.publicUrl}${d.url}</guid>`
        + `<pubDate>${new Date(a.published_at || Date.now()).toUTCString()}</pubDate>`
        + `<description>${escapeHtml(d.excerpt)}</description></item>`;
    }).join('')
    + `</channel></rss>`,
  );
});

router.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: settings.getSetting('site_name_en'),
    short_name: 'NewsPulse24',
    description: settings.getSetting('tagline_en'),
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0b0d',
    theme_color: '#e11d2e',
    lang: 'bn',
    icons: [
      { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
});

/* ----------------------------------------------- convenience static pages -- */

router.get('/advertise', async (req, res, next) => {
  try {
    const locale = req.locale || 'bn';
    await render(req, res, 'advertise', {
      pageTitle: locale === 'bn' ? 'বিজ্ঞাপন — নিউজপালস ২৪' : 'Advertise — NewsPulse 24',
      metaDescription: 'নিউজপালস ২৪-এ বিজ্ঞাপন দিন।',
      slots: config.adSlots,
      canonical: '/advertise',
    });
  } catch (err) { next(err); }
});

router.get('/corrections', async (req, res, next) => {
  try {
    const locale = req.locale || 'bn';
    const rows = db.all(
      `SELECT k.id, k.kind, k.note, k.created_at, a.slug, a.title_bn, a.title_en, u.name AS editor
         FROM corrections k
         JOIN articles a ON a.id = k.article_id
         LEFT JOIN users u ON u.id = k.created_by
        ORDER BY k.created_at DESC LIMIT 60`,
    );
    await render(req, res, 'corrections', {
      pageTitle: locale === 'bn' ? 'সংশোধনী ও স্পষ্টীকরণ' : 'Corrections & Clarifications',
      metaDescription: 'নিউজপালস ২৪-এর সংশোধনী ও স্পষ্টীকরণের পূর্ণ তালিকা।',
      corrections: rows.map((r) => ({
        ...r,
        title: locale === 'bn' ? r.title_bn : (r.title_en || r.title_bn),
        dateLabel: formatDate(r.created_at, locale),
        url: `/news/${r.slug}`,
      })),
      canonical: '/corrections',
    });
  } catch (err) { next(err); }
});

module.exports = router;
