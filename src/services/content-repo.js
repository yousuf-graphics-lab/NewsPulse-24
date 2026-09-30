'use strict';

/**
 * Query layer for editorial content: articles, categories, authors, ticker.
 *
 * Everything here is a prepared statement; nothing interpolates user input
 * into SQL. `PUBLISHED` is repeated verbatim rather than templated because a
 * WHERE clause you can change at runtime is a WHERE clause someone can break.
 */

const db = require('../db');
const config = require('../config');
const { slugify, dayKey } = require('../utils/helpers');

const ARTICLE_SELECT = `
  SELECT a.id, a.slug, a.title_bn, a.title_en, a.subtitle, a.excerpt,
         a.cover_image, a.cover_caption, a.cover_credit, a.status,
         a.is_breaking, a.is_featured, a.is_sponsored, a.sponsor_label,
         a.media_type, a.video_url, a.gallery_json, a.tags, a.views, a.likes,
         a.comments_count, a.read_minutes, a.source_name, a.source_url,
         a.corrected_at, a.correction_note, a.is_demo, a.published_at, a.updated_at,
         a.seo_title, a.seo_desc, a.canonical_url, a.noindex,
         c.slug AS category_slug, c.name_bn AS category_bn, c.name_en AS category_en, c.color AS category_color,
         au.name AS author_name, au.slug AS author_slug, au.designation AS author_designation,
         au.avatar_url AS author_avatar
    FROM articles a
    LEFT JOIN categories c ON c.id = a.category_id
    LEFT JOIN authors au ON au.id = a.author_id`;

const PUBLISHED = `a.status = 'published' AND (a.published_at IS NULL OR a.published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/* ----------------------------------------------------------- categories --- */

function categories({ activeOnly = true } = {}) {
  return db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id AND a.status='published') AS article_count
       FROM categories c ${activeOnly ? 'WHERE c.is_active = 1' : ''}
      ORDER BY c.sort_order ASC, c.name_bn ASC`,
  );
}

function categoryBySlug(slug) {
  return db.get(`SELECT * FROM categories WHERE slug = ?`, [slug]);
}

function categoryById(id) {
  return db.get(`SELECT * FROM categories WHERE id = ?`, [id]);
}

/* ------------------------------------------------------------- articles --- */

function publishedArticles({
  categoryId = null, categorySlug = null, tag = null, authorSlug = null,
  limit = 12, offset = 0, featuredOnly = false, breakingOnly = false, excludeId = null, search = null,
} = {}) {
  const where = [`a.status = 'published'`];
  const params = [];

  if (categoryId) { where.push('a.category_id = ?'); params.push(categoryId); }
  if (categorySlug) { where.push('c.slug = ?'); params.push(categorySlug); }
  if (featuredOnly) where.push('a.is_featured = 1');
  if (breakingOnly) where.push('a.is_breaking = 1');
  if (excludeId) { where.push('a.id <> ?'); params.push(excludeId); }
  if (authorSlug) { where.push('au.slug = ?'); params.push(authorSlug); }
  if (tag) { where.push("(',' || replace(a.tags, ' ', '') || ',') LIKE ?"); params.push(`%,${tag},%`); }
  if (search) {
    where.push('(a.title_bn LIKE ? OR a.title_en LIKE ? OR a.excerpt LIKE ? OR a.body_bn LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  where.push(`(a.published_at IS NULL OR a.published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

  return db.all(
    `${ARTICLE_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY a.published_at DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
}

function countPublished(opts = {}) {
  const rows = publishedArticles({ ...opts, limit: 100000, offset: 0 });
  return rows.length;
}

function articleBySlug(slug, { includeDraft = false } = {}) {
  if (!includeDraft) return db.get(`${ARTICLE_SELECT} WHERE a.slug = ? AND ${PUBLISHED}`, [slug]);
  return db.get(`${ARTICLE_SELECT} WHERE a.slug = ?`, [slug]);
}

function articleById(id) {
  return db.get(`${ARTICLE_SELECT} WHERE a.id = ?`, [id]);
}

function relatedArticles(article, limit = 5) {
  if (!article) return [];
  const sameCat = db.all(
    `${ARTICLE_SELECT} WHERE ${PUBLISHED} AND a.category_id = ? AND a.id <> ?
      ORDER BY a.published_at DESC LIMIT ?`,
    [article.category_id ?? -1, article.id, limit],
  );
  if (sameCat.length >= limit) return sameCat;
  const tags = String(article.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (!tags.length) return sameCat;
  const likeClauses = tags.map(() => `a.title_bn LIKE ?`).join(' OR ');
  const others = db.all(
    `${ARTICLE_SELECT} WHERE ${PUBLISHED} AND a.id <> ? AND (${likeClauses})
      ORDER BY a.published_at DESC LIMIT ?`,
    [article.id, ...tags.map((t) => `%${t}%`), limit - sameCat.length],
  );
  const ids = new Set(sameCat.map((a) => a.id));
  return [...sameCat, ...others.filter((a) => !ids.has(a.id))].slice(0, limit);
}

/**
 * "Most read" blends the last 7 days of traffic with a decay on total lifetime
 * views, so a six-month-old evergreen piece cannot sit at the top forever.
 */
function mostRead(limit = 10, sinceDays = 7) {
  return db.all(
    `SELECT a.id, a.slug, a.title_bn, a.title_en, a.subtitle, a.excerpt, a.cover_image,
            a.media_type, a.video_url, a.tags, a.views, a.read_minutes, a.published_at,
            a.is_sponsored, a.sponsor_label, a.corrected_at,
            c.slug AS category_slug, c.name_bn AS category_bn, c.name_en AS category_en, c.color AS category_color,
            au.name AS author_name, au.slug AS author_slug,
            COALESCE(r.recent, 0) AS recent_views
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN authors au ON au.id = a.author_id
       LEFT JOIN (
            SELECT article_id, SUM(views) AS recent
              FROM article_stats_daily
             WHERE day >= date('now', ?)
             GROUP BY article_id
       ) r ON r.article_id = a.id
      WHERE a.status = 'published'
      ORDER BY COALESCE(r.recent, 0) * 1.0 + a.views * 0.15 DESC, a.published_at DESC
      LIMIT ?`,
    [`-${sinceDays} days`, limit],
  );
}

function breakingTicker(limit = 12) {
  const manual = db.all(
    `SELECT t.id, t.article_id, t.text_bn, t.text_en, t.priority, a.slug, a.title_bn, a.title_en,
            c.name_bn AS category_bn, c.name_en AS category_en, c.slug AS category_slug
       FROM ticker_items t
       LEFT JOIN articles a ON a.id = t.article_id
       LEFT JOIN categories c ON c.id = a.category_id
      WHERE t.active = 1
        AND (t.starts_at IS NULL OR t.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND (t.ends_at   IS NULL OR t.ends_at   >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ORDER BY t.priority ASC, t.id DESC
      LIMIT ?`,
    [limit],
  );
  if (manual.length) return manual;
  return db.all(
    `SELECT NULL AS id, a.id AS article_id, a.title_bn AS text_bn, a.title_en AS text_en, 50 AS priority,
            a.slug, a.title_bn, a.title_en, c.name_bn AS category_bn, c.name_en AS category_en, c.slug AS category_slug
       FROM articles a LEFT JOIN categories c ON c.id = a.category_id
      WHERE a.status = 'published' AND a.is_breaking = 1
      ORDER BY a.published_at DESC LIMIT ?`,
    [limit],
  );
}

function featured(limit = 5) {
  return db.all(
    `${ARTICLE_SELECT} WHERE ${PUBLISHED} AND a.is_featured = 1
      ORDER BY a.published_at DESC LIMIT ?`,
    [limit],
  );
}

function latest(limit = 10, excludeIds = []) {
  const params = [];
  let clause = '';
  if (excludeIds.length) {
    clause = `AND a.id NOT IN (${excludeIds.map(() => '?').join(',')})`;
    params.push(...excludeIds);
  }
  return db.all(`${ARTICLE_SELECT} WHERE ${PUBLISHED} ${clause} ORDER BY a.published_at DESC LIMIT ?`, [...params, limit]);
}

function byCategory(limit = 4, excludeIds = []) {
  const out = [];
  for (const cat of categories()) {
    const params = [cat.id, limit];
    let clause = '';
    if (excludeIds.length) {
      clause = `AND a.id NOT IN (${excludeIds.map(() => '?').join(',')})`;
      params.splice(1, 0, ...excludeIds);
    }
    const rows = db.all(
      `${ARTICLE_SELECT} WHERE ${PUBLISHED} AND a.category_id = ? ${clause}
        ORDER BY a.published_at DESC LIMIT ?`,
      params,
    );
    if (rows.length) out.push({ category: cat, articles: rows });
  }
  return out;
}

function authors() {
  return db.all(`SELECT * FROM authors ORDER BY name ASC`);
}

function authorBySlug(slug) {
  return db.get(`SELECT * FROM authors WHERE slug = ?`, [slug]);
}

function tags(limit = 40) {
  const rows = db.all(`SELECT tags FROM articles WHERE status = 'published' AND tags IS NOT NULL AND tags <> ''`);
  const counts = new Map();
  for (const row of rows) {
    for (const raw of String(row.tags).split(',')) {
      const t = raw.trim();
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, slug: slugify(name), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function registerView(articleId) {
  if (!articleId) return;
  const day = dayKey();
  db.run(`UPDATE articles SET views = views + 1 WHERE id = ?`, [articleId]);
  db.run(
    `INSERT INTO article_stats_daily (article_id, day, views) VALUES (?, ?, 1)
     ON CONFLICT(article_id, day) DO UPDATE SET views = views + 1`,
    [articleId, day],
  );
}

function correctionsFor(articleId) {
  return db.all(
    `SELECT k.*, u.name AS editor_name FROM corrections k LEFT JOIN users u ON u.id = k.created_by
      WHERE k.article_id = ? ORDER BY k.created_at DESC`,
    [articleId],
  );
}

function sitemapArticles(limit = 2000) {
  return db.all(
    `SELECT a.slug, a.updated_at, a.published_at, c.slug AS category_slug
       FROM articles a LEFT JOIN categories c ON c.id = a.category_id
      WHERE a.status = 'published' AND a.noindex = 0
      ORDER BY a.published_at DESC LIMIT ?`,
    [limit],
  );
}

module.exports = {
  ARTICLE_SELECT, categories, categoryBySlug, categoryById,
  publishedArticles, countPublished, articleBySlug, articleById, relatedArticles,
  mostRead, breakingTicker, featured, latest, byCategory,
  authors, authorBySlug, tags, registerView, correctionsFor, sitemapArticles,
  siteConfig: config,
};
