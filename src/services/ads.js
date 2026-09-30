'use strict';

/**
 * Ad server.
 *
 * A miniature, self-hosted ad engine so the site can monetise from day one —
 * with house campaigns, direct-sold banners and sponsored content — and be
 * swapped for AdSense/Ad Manager later without touching the templates.
 *
 * Targeting dimensions: slot, device, country, category, date window,
 * daily cap, priority and weight (weighted random among equal priorities).
 *
 * SECURITY: `script` ads are never injected into the page. They are rendered
 * inside a sandboxed same-origin frame (`/ads/frame/:id`) that carries its own
 * CSP limited to the allowlisted ad domain, so a third-party creative cannot
 * read the site's cookies or DOM.
 */

const db = require('../db');
const config = require('../config');
const { hashIp, clientIp, dayKey, parseJson } = require('../utils/helpers');
const { parseUserAgent } = require('./geo');

const SLOT_IDS = config.adSlots.map((s) => s.id);

function slotMeta(id) {
  return config.adSlots.find((s) => s.id === id) || null;
}

function listAds({ slot = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (slot) { where.push('slot = ?'); params.push(slot); }
  if (status) { where.push('status = ?'); params.push(status); }
  return db.all(
    `SELECT * FROM ads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority ASC, id DESC`,
    params,
  );
}

function adById(id) {
  return db.get(`SELECT * FROM ads WHERE id = ?`, [id]);
}

function activeForSlot(slot, { device = 'desktop', country = '', categorySlug = '', articleId = null } = {}) {
  if (!config.ads.enabled) return null;
  const meta = slotMeta(slot);
  if (!meta) return null;

  const rows = db.all(
    `SELECT * FROM ads
      WHERE slot = ? AND status = 'active'
        AND (starts_at IS NULL OR starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND (ends_at   IS NULL OR ends_at   >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ORDER BY priority ASC, id ASC`,
    [slot],
  );

  const today = dayKey();
  const eligible = rows.filter((ad) => {
    if (ad.cap_reset_day !== today) {
      db.run(`UPDATE ads SET served_today = 0, cap_reset_day = ? WHERE id = ?`, [today, ad.id]);
      ad.served_today = 0;
    }
    if (ad.daily_cap && ad.served_today >= ad.daily_cap) return false;

    const devices = String(ad.target_devices || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (devices.length && !devices.includes(device)) return false;

    const countries = String(ad.target_countries || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (countries.length && !countries.includes(String(country || '').toUpperCase())) return false;

    const cats = String(ad.target_categories || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (cats.length && categorySlug && !cats.includes(categorySlug)) return false;

    return true;
  });

  if (!eligible.length) return null;

  const best = Math.min(...eligible.map((a) => a.priority));
  const pool = eligible.filter((a) => a.priority === best);
  const totalWeight = pool.reduce((sum, a) => sum + Math.max(1, a.weight || 1), 0);
  let pick = Math.random() * totalWeight;
  for (const ad of pool) {
    pick -= Math.max(1, ad.weight || 1);
    if (pick <= 0) return ad;
  }
  return pool[pool.length - 1];
}

/**
 * Renders the slot for a template. Returns a plain object — templates must not
 * execute logic, they only describe markup.
 */
function renderSlot(req, slot, context = {}) {
  const ua = parseUserAgent(req.headers?.['user-agent'] || '');
  const device = ua.isBot ? 'bot' : ua.device;
  const ad = activeForSlot(slot, {
    device,
    country: req.geo?.country || '',
    categorySlug: context.categorySlug || '',
    articleId: context.articleId || null,
  });
  return { slot, meta: slotMeta(slot), ad, device, country: req.geo?.country || '' };
}

function recordEvent({ adId, slot, kind = 'impression', req = null, ip = null, country = '', device = '', articleId = null }) {
  try {
    db.run(
      `INSERT INTO ad_events (ad_id, slot, kind, ip_hash, country, device, article_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        adId || null, slot, kind,
        hashIp(ip || (req ? clientIp(req) : 'unknown')),
        String(country || 'unknown').slice(0, 2),
        String(device || '').slice(0, 20),
        articleId,
      ],
    );
    if (adId) {
      const col = kind === 'click' ? 'clicks' : 'impressions';
      const extra = kind === 'impression' ? `, served_today = served_today + 1` : '';
      db.run(`UPDATE ads SET ${col} = ${col} + 1${extra} WHERE id = ?`, [adId]);
    }
  } catch { /* beacons must never 500 */ }
}

function stats({ days = 30 } = {}) {
  const totals = db.get(
    `SELECT
       SUM(CASE WHEN kind='impression' THEN 1 ELSE 0 END) AS impressions,
       SUM(CASE WHEN kind='click' THEN 1 ELSE 0 END) AS clicks
       FROM ad_events WHERE created_at >= datetime('now', ?)`,
    [`-${days} days`],
  ) || { impressions: 0, clicks: 0 };
  const impressions = Number(totals.impressions || 0);
  const clicks = Number(totals.clicks || 0);
  const byAd = db.all(
    `SELECT a.id, a.name, a.advertiser, a.slot, a.kind, a.status, a.impressions, a.clicks,
            CASE WHEN a.impressions > 0 THEN ROUND(a.clicks * 100.0 / a.impressions, 2) ELSE 0 END AS ctr
       FROM ads a ORDER BY a.impressions DESC LIMIT 25`,
  );
  const bySlot = db.all(
    `SELECT slot, SUM(CASE WHEN kind='impression' THEN 1 ELSE 0 END) AS impressions,
            SUM(CASE WHEN kind='click' THEN 1 ELSE 0 END) AS clicks
       FROM ad_events WHERE created_at >= datetime('now', ?)
      GROUP BY slot ORDER BY impressions DESC`,
    [`-${days} days`],
  );
  const byCountry = db.all(
    `SELECT country, COUNT(*) AS impressions FROM ad_events
      WHERE kind='impression' AND created_at >= datetime('now', ?)
      GROUP BY country ORDER BY impressions DESC LIMIT 10`,
    [`-${days} days`],
  );
  return { impressions, clicks, ctr: impressions ? (clicks * 100 / impressions) : 0, byAd, bySlot, byCountry };
}

/** ads.txt — required by AdSense / programmatic buyers. */
function adsTxt() {
  const lines = [
    '# NewsPulse 24 — ads.txt',
    '# https://iabtechlab.com/ads-txt/',
    '',
  ];
  const publisherId = db.get(`SELECT value FROM settings WHERE key = 'adsense_publisher_id'`)?.value;
  if (publisherId) {
    lines.push(`google.com, ${publisherId}, DIRECT, f08c47fec0942fa0`);
  }
  const customs = db.all(`SELECT DISTINCT advertiser FROM ads WHERE advertiser IS NOT NULL AND advertiser <> ''`);
  if (customs.length) {
    lines.push('', '# Direct-sold inventory', '');
    for (const row of customs) lines.push(`# ${row.advertiser}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { SLOT_IDS, slotMeta, listAds, adById, activeForSlot, renderSlot, recordEvent, stats, adsTxt, parseJson };
