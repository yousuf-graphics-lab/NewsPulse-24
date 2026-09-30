'use strict';

/**
 * Analytics capture.
 *
 * A single middleware writes one row per HTML pageview. Event beacons (search,
 * share, vote, newsletter) reuse `track()`. Everything is queued through a
 * short-lived in-memory buffer so a burst of traffic produces one multi-row
 * INSERT instead of one transaction per hit.
 */

const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const { resolveGeo, parseUserAgent } = require('../services/geo');
const { clientIp, referrerSource, dayKey, randomId } = require('../utils/helpers');

const VID_COOKIE = 'np_vid';
const BUFFER_MAX = 50;
const FLUSH_MS = 2000;

let buffer = [];
let flushTimer = null;

const INSERT_SQL = `INSERT INTO analytics_events
  (day, event_type, path, title, article_id, category, referrer, source, country, city,
   device, browser, os, visitor_id, ip_hash, lang, meta)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function flush() {
  flushTimer = null;
  if (!buffer.length) return;
  const rows = buffer;
  buffer = [];
  try {
    db.tx(() => {
      for (const r of rows) {
        db.run(INSERT_SQL, [
          r.day, r.event_type, r.path, r.title, r.article_id, r.category,
          r.referrer, r.source, r.country, r.city, r.device, r.browser, r.os,
          r.visitor_id, r.ip_hash, r.lang, r.meta,
        ]);
      }
    });
  } catch {
    /* analytics must never take the site down */
  }
}

function push(row) {
  buffer.push(row);
  if (buffer.length >= BUFFER_MAX) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function ensureVisitorId(req, res) {
  let vid = req.cookies?.[VID_COOKIE];
  if (!vid || typeof vid !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(vid)) {
    vid = randomId(16);
    if (res && typeof res.cookie === 'function') {
      res.cookie(VID_COOKIE, vid, {
        httpOnly: false,        // harmless random id, also read by client JS
        sameSite: 'lax',
        secure: config.isProd,
        maxAge: 1000 * 60 * 60 * 24 * 400,
        path: '/',
      });
    }
  }
  return vid;
}

function hashIpSafe(ip) {
  return crypto.createHmac('sha256', config.secrets.ipPepper).update(String(ip)).digest('hex').slice(0, 32);
}

/** Core tracker — usable from any route or service. */
async function track(req, { type = 'pageview', path = null, title = null, articleId = null, category = null, meta = null, geo = null } = {}) {
  const ua = parseUserAgent(req.headers['user-agent']);
  const resolved = geo || await resolveGeo(req);
  push({
    day: dayKey(),
    event_type: type,
    path: path ? String(path).slice(0, 300) : String(req.originalUrl || '').slice(0, 300),
    title: title ? String(title).slice(0, 200) : null,
    article_id: articleId,
    category: category ? String(category).slice(0, 60) : null,
    referrer: req.get('referer') ? String(req.get('referer')).slice(0, 300) : null,
    source: referrerSource(req.get('referer')).slice(0, 60),
    country: resolved.country || 'unknown',
    city: (resolved.city || '').slice(0, 80) || null,
    device: ua.isBot ? 'bot' : ua.device,
    browser: ua.browser.slice(0, 40),
    os: ua.os.slice(0, 40),
    visitor_id: (req.visitorId || ensureVisitorId(req, req.res)).slice(0, 64),
    ip_hash: hashIpSafe(clientIp(req)),
    lang: req.locale || 'bn',
    meta: meta ? JSON.stringify(meta).slice(0, 500) : null,
  });
  return ua;
}

/** Attaches locale, visitor id and auto-logs human HTML pageviews. */
function pageviewTracker() {
  return async (req, res, next) => {
    req.visitorId = ensureVisitorId(req, res);
    req.ua = parseUserAgent(req.headers['user-agent']);
    res.on('finish', () => {
      if (req.method !== 'GET' || req.skipTracking) return;
      if (res.statusCode >= 400) return;
      if (req.ua.isBot) return;
      const ct = res.getHeader('content-type') || '';
      if (!String(ct).includes('text/html')) return;
      track(req, {
        path: req.path,
        title: res.locals?.pageTitle || null,
        articleId: req.articleId || null,
        category: req.categorySlug || null,
        geo: req.geo,
      }).catch(() => {});
    });
    next();
  };
}

module.exports = { track, pageviewTracker, flush, ensureVisitorId, VID_COOKIE };
