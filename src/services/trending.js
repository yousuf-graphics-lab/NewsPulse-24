'use strict';

/**
 * Trending + hot-topic engine.
 *
 * "Trending" is deliberately transparent (an editor can explain any ranking to
 * a reader): velocity of views over the last 24 hours, weighted against
 * freshness, plus a manual boost from the breaking-news flag. The same
 * computation feeds the ticker, the "hot topics" rail and the AI assistant.
 */

const db = require('../db');
const repo = require('./content-repo');
const { dayKey, toDhaka } = require('../utils/helpers');

/** Velocity: views in the last N hours, normalised by article age. */
function trending({ limit = 8, hours = 24 } = {}) {
  const today = dayKey();
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));
  return db.all(
    `SELECT a.id, a.slug, a.title_bn, a.title_en, a.excerpt, a.cover_image, a.views,
            a.published_at, a.is_breaking, a.media_type,
            c.name_bn AS category_bn, c.name_en AS category_en, c.slug AS category_slug, c.color AS category_color,
            COALESCE(s.views, 0) AS recent_views,
            (COALESCE(s.views, 0) * 1.0
               + CASE WHEN a.is_breaking = 1 THEN 25 ELSE 0 END
               + CASE WHEN a.published_at >= datetime('now', '-6 hours') THEN 15 ELSE 0 END
               + a.comments_count * 3 + a.likes * 2
            ) AS heat
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN (
            SELECT article_id, SUM(views) AS views FROM article_stats_daily
             WHERE day IN (?, ?) GROUP BY article_id
       ) s ON s.article_id = a.id
      WHERE a.status = 'published'
      ORDER BY heat DESC, a.published_at DESC
      LIMIT ?`,
    [today, yesterday, limit],
  );
}

function topCategories({ limit = 6, days = 7 } = {}) {
  return db.all(
    `SELECT c.slug, c.name_bn, c.name_en, c.color, COUNT(e.id) AS views
       FROM analytics_events e
       JOIN categories c ON c.slug = e.category
      WHERE e.day >= date('now', ?) AND e.category IS NOT NULL
      GROUP BY c.slug ORDER BY views DESC LIMIT ?`,
    [`-${days} days`, limit],
  );
}

function topSearches({ limit = 10, days = 7 } = {}) {
  return db.all(
    `SELECT term, SUM(hits) AS hits FROM search_log
      WHERE day >= date('now', ?) AND term <> ''
      GROUP BY lower(term) ORDER BY hits DESC LIMIT ?`,
    [`-${days} days`, limit],
  );
}

/**
 * A compact "state of the newsroom" snapshot the AI assistant (and the
 * homepage) can quote directly. Kept small on purpose: it goes into a prompt.
 */
function digest({ limit = 8, locale = 'bn' } = {}) {
  const hot = trending({ limit });
  const mostRead = repo.mostRead(5);
  const cats = topCategories({ limit: 5 });
  return {
    generatedAt: new Date().toISOString(),
    localDate: toDhaka(new Date()).toISOString().slice(0, 10),
    breaking: repo.breakingTicker(6).map((t) => t.text_bn || t.text_en),
    trending: hot.map((a) => ({
      title: locale === 'bn' ? a.title_bn : (a.title_en || a.title_bn),
      category: locale === 'bn' ? a.category_bn : (a.category_en || a.category_bn),
      url: `/news/${a.slug}`,
      views24h: a.recent_views,
    })),
    mostRead: mostRead.map((a) => ({
      title: locale === 'bn' ? a.title_bn : (a.title_en || a.title_bn),
      url: `/news/${a.slug}`,
      views: a.views,
    })),
    hotCategories: cats.map((c) => (locale === 'bn' ? c.name_bn : c.name_en)),
  };
}

function logSearch(term, hits, country) {
  try {
    db.run(`INSERT INTO search_log (term, hits, day, country) VALUES (?, ?, ?, ?)`, [
      String(term).slice(0, 120), Number(hits) || 0, dayKey(), country || null,
    ]);
  } catch { /* noop */ }
}

module.exports = { trending, topCategories, topSearches, digest, logSearch };
