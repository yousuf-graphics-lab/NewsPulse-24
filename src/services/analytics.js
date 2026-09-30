'use strict';

/**
 * Analytics aggregation for the admin dashboard.
 *
 * All queries are bounded by a day range and use the indexes declared in
 * schema.sql. Nothing scans the full events table without a `day` predicate.
 */

const db = require('../db');
const repo = require('./content-repo');
const ads = require('./ads');
const newsletter = require('./newsletter');
const ai = require('./ai');
const { dayKey } = require('../utils/helpers');

function rangeClause(days) {
  return [`-${Number(days) || 30} days`];
}

function overview({ days = 30 } = {}) {
  const [range] = rangeClause(days);
  const prev = `-${(Number(days) || 30) * 2} days`;

  const cur = db.get(
    `SELECT COUNT(*) AS pageviews,
            COUNT(DISTINCT visitor_id) AS visitors,
            COUNT(DISTINCT ip_hash) AS uniques
       FROM analytics_events
      WHERE event_type = 'pageview' AND day >= date('now', ?) AND device <> 'bot'`,
    [range],
  ) || {};
  const old = db.get(
    `SELECT COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors
       FROM analytics_events
      WHERE event_type = 'pageview' AND day >= date('now', ?) AND day < date('now', ?) AND device <> 'bot'`,
    [prev, range],
  ) || {};

  const delta = (a, b) => {
    const n = Number(a || 0);
    const o = Number(b || 0);
    if (!o) return n ? 100 : 0;
    return Math.round(((n - o) / o) * 100);
  };

  const today = db.get(
    `SELECT COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors
       FROM analytics_events WHERE event_type='pageview' AND day = ? AND device <> 'bot'`,
    [dayKey()],
  ) || {};

  const content = db.get(
    `SELECT
       SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published,
       SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS drafts,
       SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN is_breaking=1 THEN 1 ELSE 0 END) AS breaking,
       COALESCE(SUM(views),0) AS total_views,
       COALESCE(SUM(comments_count),0) AS total_comments
       FROM articles`,
  ) || {};

  const pendingComments = db.get(`SELECT COUNT(*) AS n FROM comments WHERE status='pending'`)?.n || 0;
  const subscribers = newsletter.stats();
  const adStats = ads.stats({ days });
  const assistant = ai.stats({ days });

  return {
    range: days,
    pageviews: Number(cur.pageviews || 0),
    pageviewsDelta: delta(cur.pageviews, old.pageviews),
    visitors: Number(cur.visitors || 0),
    visitorsDelta: delta(cur.visitors, old.visitors),
    uniques: Number(cur.uniques || 0),
    todayPageviews: Number(today.pageviews || 0),
    todayVisitors: Number(today.visitors || 0),
    content,
    pendingComments,
    subscribers,
    ads: adStats,
    assistant,
    staff: db.get(`SELECT COUNT(*) AS n FROM users WHERE status='active'`)?.n || 0,
  };
}

function timeSeries({ days = 30 } = {}) {
  return db.all(
    `SELECT day,
            COUNT(*) AS pageviews,
            COUNT(DISTINCT visitor_id) AS visitors
       FROM analytics_events
      WHERE event_type = 'pageview' AND day >= date('now', ?) AND device <> 'bot'
      GROUP BY day ORDER BY day ASC`,
    rangeClause(days),
  );
}

function byCountry({ days = 30, limit = 15 } = {}) {
  return db.all(
    `SELECT country, COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors
       FROM analytics_events
      WHERE event_type='pageview' AND day >= date('now', ?) AND device <> 'bot'
      GROUP BY country ORDER BY pageviews DESC LIMIT ?`,
    [...rangeClause(days), limit],
  );
}

function byDevice({ days = 30 } = {}) {
  return db.all(
    `SELECT device, COUNT(*) AS pageviews FROM analytics_events
      WHERE event_type='pageview' AND day >= date('now', ?) AND device <> 'bot'
      GROUP BY device ORDER BY pageviews DESC`,
    rangeClause(days),
  );
}

function byBrowser({ days = 30, limit = 10 } = {}) {
  return db.all(
    `SELECT browser, os, COUNT(*) AS n FROM analytics_events
      WHERE event_type='pageview' AND day >= date('now', ?) AND device <> 'bot'
      GROUP BY browser, os ORDER BY n DESC LIMIT ?`,
    [...rangeClause(days), limit],
  );
}

function bySource({ days = 30, limit = 12 } = {}) {
  return db.all(
    `SELECT source, COUNT(*) AS n FROM analytics_events
      WHERE event_type='pageview' AND day >= date('now', ?) AND device <> 'bot'
      GROUP BY source ORDER BY n DESC LIMIT ?`,
    [...rangeClause(days), limit],
  );
}

function topArticles({ days = 30, limit = 15 } = {}) {
  return db.all(
    `SELECT a.id, a.slug, a.title_bn, a.title_en, a.views, a.comments_count,
            c.name_bn AS category_bn, c.name_en AS category_en,
            COALESCE(t.n, 0) AS period_views
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN (
            SELECT article_id, COUNT(*) AS n FROM analytics_events
             WHERE event_type='pageview' AND day >= date('now', ?) AND article_id IS NOT NULL
             GROUP BY article_id
       ) t ON t.article_id = a.id
      ORDER BY period_views DESC, a.views DESC LIMIT ?`,
    [...rangeClause(days), limit],
  );
}

function topPages({ days = 30, limit = 20 } = {}) {
  return db.all(
    `SELECT path, COUNT(*) AS views FROM analytics_events
      WHERE event_type='pageview' AND day >= date('now', ?) AND device <> 'bot'
      GROUP BY path ORDER BY views DESC LIMIT ?`,
    [...rangeClause(days), limit],
  );
}

function categoryBreakdown({ days = 30 } = {}) {
  return db.all(
    `SELECT category, COUNT(*) AS views FROM analytics_events
      WHERE event_type='pageview' AND day >= date('now', ?) AND category IS NOT NULL AND device <> 'bot'
      GROUP BY category ORDER BY views DESC`,
    rangeClause(days),
  );
}

function liveNow({ minutes = 10 } = {}) {
  return db.all(
    `SELECT path, title, COUNT(*) AS hits FROM analytics_events
      WHERE event_type='pageview' AND ts >= datetime('now', ?) AND device <> 'bot'
      GROUP BY path ORDER BY hits DESC LIMIT 12`,
    [`-${Number(minutes)} minutes`],
  );
}

function events({ limit = 40, offset = 0, type = null } = {}) {
  const where = [];
  const params = [];
  if (type) { where.push('event_type = ?'); params.push(type); }
  return db.all(
    `SELECT * FROM analytics_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
}

function retention({ days = 30 } = {}) {
  return db.all(
    `SELECT visit_count, COUNT(*) AS visitors FROM (
        SELECT visitor_id, COUNT(DISTINCT day) AS visit_count
          FROM analytics_events
         WHERE event_type='pageview' AND day >= date('now', ?) AND device <> 'bot'
         GROUP BY visitor_id
     ) GROUP BY visit_count ORDER BY visit_count ASC LIMIT 10`,
    rangeClause(days),
  );
}

/** Everything the dashboard needs, in one call. */
function dashboard({ days = 30 } = {}) {
  return {
    overview: overview({ days }),
    timeSeries: timeSeries({ days }),
    countries: byCountry({ days }),
    devices: byDevice({ days }),
    browsers: byBrowser({ days }),
    sources: bySource({ days }),
    topArticles: topArticles({ days }),
    topPages: topPages({ days }),
    categories: categoryBreakdown({ days }),
    live: liveNow(),
    retention: retention({ days }),
    trending: repo.mostRead(8),
  };
}

module.exports = {
  overview, timeSeries, byCountry, byDevice, byBrowser, bySource,
  topArticles, topPages, categoryBreakdown, liveNow, events, retention, dashboard,
};
