'use strict';

/**
 * Shared helpers: formatting, slugs, language detection, redaction.
 * Bangla-first, but every function handles Latin text too.
 */

const crypto = require('node:crypto');
const config = require('../config');

/* ------------------------------------------------------------ numbers ---- */

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

/** 1234 -> "১,২৩৪" style localisation used across the Bangla UI. */
function bnNumber(value) {
  return String(value ?? '').replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
}

function compactNumber(n) {
  const num = Number(n) || 0;
  if (num >= 10_000_000) return bnNumber(`${(num / 10_000_000).toFixed(1)}Cr`);
  if (num >= 100_000) return bnNumber(`${(num / 100_000).toFixed(1)}L`);
  if (num >= 1000) return bnNumber(`${(num / 1000).toFixed(1)}K`);
  return bnNumber(num);
}

/* --------------------------------------------------------------- time ---- */

const BN_MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BN_DAYS = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];

function toDhaka(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike || Date.now());
  // Asia/Dhaka is a fixed +06:00 with no DST, so the offset is exact.
  return new Date(d.getTime() + 6 * 60 * 60 * 1000);
}

function formatDate(dateLike, locale = 'bn') {
  if (!dateLike) return '';
  const d = toDhaka(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getUTCDate();
  const month = locale === 'bn' ? BN_MONTHS[d.getUTCMonth()] : EN_MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return locale === 'bn' ? bnNumber(`${day} ${month} ${year}`) : `${day} ${month} ${year}`;
}

function formatDateTime(dateLike, locale = 'bn') {
  if (!dateLike) return '';
  const d = toDhaka(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  const h24 = d.getUTCHours();
  const suffix = h24 < 12 ? (locale === 'bn' ? 'সকাল' : 'AM') : h24 < 17 ? (locale === 'bn' ? 'দুপুর' : 'PM') : locale === 'bn' ? 'সন্ধ্যা' : 'PM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const time = locale === 'bn' ? `${suffix} ${bnNumber(h)}:${bnNumber(m)}` : `${h}:${m} ${suffix}`;
  return `${formatDate(dateLike, locale)}, ${time}`;
}

function timeAgo(dateLike, locale = 'bn') {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  const secs = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
  const table = [
    [60, locale === 'bn' ? 'সেকেন্ড' : 'second', locale === 'bn' ? 'এইমাত্র' : 'just now'],
    [3600, locale === 'bn' ? 'মিনিট' : 'minute'],
    [86400, locale === 'bn' ? 'ঘণ্টা' : 'hour'],
    [604800, locale === 'bn' ? 'দিন' : 'day'],
    [2592000, locale === 'bn' ? 'সপ্তাহ' : 'week'],
    [31536000, locale === 'bn' ? 'মাস' : 'month'],
  ];
  if (secs < 60) return locale === 'bn' ? 'এইমাত্র' : 'just now';
  let unit = 60;
  let label = table[0][1];
  for (const [limit, name] of table) {
    if (secs < limit) break;
    unit = limit;
    label = name;
  }
  const value = Math.floor(secs / unit);
  return locale === 'bn' ? `${bnNumber(value)} ${label} আগে` : `${value} ${label}${value > 1 ? 's' : ''} ago`;
}

function dayKey(dateLike = new Date()) {
  return toDhaka(dateLike).toISOString().slice(0, 10);
}

/* -------------------------------------------------------------- slugs ---- */

/**
 * Slugifier that keeps Bangla readable in URLs (SEO-friendly for a Bangla
 * audience) while transliterating nothing — Latin input is normalised the
 * usual way. Output is limited to URL-safe characters only.
 */
function slugify(input, { keepBangla = true } = {}) {
  let s = String(input || '').trim().toLowerCase();
  if (!keepBangla) s = s.replace(/[ঀ-৿]/g, '');
  /*
   * Keep letters, NUMBERS and — critically — combining MARKS (\p{M}).
   * Bangla vowel signs (া ি ে ো, Unicode category Mc/Mn) and the hasant (্)
   * are not \p{L}, so a letter-only class mangles every word:
   * "বাজেট" would become "বজট". Marks are what make the slug readable.
   */
  s = s.replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '');
  s = s.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s.slice(0, 120) || `n-${Date.now().toString(36)}`;
}

function uniqueSlug(base, existsFn) {
  let slug = slugify(base);
  let i = 2;
  while (existsFn(slug)) {
    slug = `${slugify(base)}-${i++}`;
  }
  return slug;
}

/* --------------------------------------------------- language handling --- */

const BN_RANGE = /[\u0980-\u09FF]/;

/** Banglish = Latin script, but Bangla words written with English letters. */
const BANGLISH_MARKERS = /\b(amar|amra|ami|apni|tumii?|tumi|ki|keno|kotha?y|kemon|ache|achhe|nei|naay|hoy|cheyech?i|kori[st]?|dekhe?n?|bolen?|janab|bhai|apa|desh|dhaka|bangla|bangladesh|khobor|khabar|samachar|ajke?|kalke?|eikhane|oikhane|valo|bhalo|kharap|taka|cricket|khela|jita|hara|mantri|sorkar|nirbachon|police|hospital|skul|college|university|bazar|dam|barish|ghurnijhor|train|bus|launch|feri)\b/i;

function detectLang(text) {
  const t = String(text || '');
  if (BN_RANGE.test(t)) return 'bn';
  if (BANGLISH_MARKERS.test(t)) return 'bnlish';
  return 'en';
}

/**
 * The language an answer should be written in. Banglish input gets a Banglish
 * reply (Latin script) — that is the whole point of understanding Banglish.
 */
function replyLang(text) {
  const l = detectLang(text);
  return l === 'en' ? 'en' : l === 'bn' ? 'bn' : 'bnlish';
}

function langLabel(l) {
  return { bn: 'বাংলা', en: 'English', bnlish: 'Banglish' }[l] || 'বাংলা';
}

/** Pick the right field for a locale with graceful fallback. */
function pick(row, field, locale = 'bn') {
  if (!row) return '';
  const primary = row[`${field}_${locale}`];
  const fallback = row[`${field}_${locale === 'bn' ? 'en' : 'bn'}`];
  return (primary && String(primary).trim()) || fallback || '';
}

/* ------------------------------------------------------------- crypto ---- */

const randomId = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');
const randomHex = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/** Constant-time comparison for tokens/secrets. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hmac(value, secret = config.secrets.ipPepper) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

/** Pseudonymised visitor fingerprint — never a raw IP. */
function hashIp(ip) {
  return hmac(`ip:${ip || 'unknown'}`).slice(0, 32);
}

/* ----------------------------------------------------------- formatting -- */

function readingTime(html) {
  const words = String(html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 180));
}

function excerptFrom(html, max = 180) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Allow only http(s) — blocks javascript:/data: URLs in links and embeds. */
function safeUrl(value, { allowRelative = true } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  /*
   * Decide "is this a local path?" ourselves instead of letting URL parsing
   * decide. Two traps:
   *   "//host/x"  — protocol-relative, i.e. an off-site link, NOT a local path
   *   "/\host/x"  — browsers normalise the backslash to a slash, so this is
   *                 also an off-site link and a classic open-redirect trick
   * Anything matching either must be judged as an absolute URL.
   */
  const isLocalPath = raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\');
  if (isLocalPath) return allowRelative ? raw : '';
  try {
    const u = new URL(raw, 'https://placeholder.invalid');
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    // The value must itself be absolute; if it only resolved because of the
    // placeholder origin, it was a relative reference in disguise.
    if (!/^https?:\/\//i.test(raw)) return '';
    return raw;
  } catch {
    return '';
  }
}

function referrerSource(referrer) {
  if (!referrer) return 'direct';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    if (/(^|\.)google\./.test(host)) return 'google';
    if (/(^|\.)bing\./.test(host)) return 'bing';
    if (host.includes('facebook') || host.includes('fb.')) return 'facebook';
    if (host.includes('youtube')) return 'youtube';
    if (host.includes('twitter') || host.includes('x.com')) return 'twitter';
    if (host.includes('whatsapp')) return 'whatsapp';
    if (host.includes('messenger')) return 'messenger';
    return host;
  } catch {
    return 'direct';
  }
}

/** Extract the real client IP from the first entry of X-Forwarded-For. */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff ? String(xff).split(',')[0] : '';
  const ip = (raw || req.socket?.remoteAddress || '').trim().replace(/^::ffff:/, '');
  return ip || 'unknown';
}

/** Only the last octet is kept so admins can spot an attack pattern without
 *  the database holding anything that identifies a reader. */
function ipTail(ip) {
  const s = String(ip || '');
  if (s.includes('.')) return `…${s.split('.').pop()}`;
  if (s.includes(':')) return `…${s.split(':').filter(Boolean).pop()}`;
  return '…';
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function csvToArray(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function arrayToCsv(value) {
  return Array.isArray(value) ? value.map((s) => String(s).trim()).filter(Boolean).join(',') : '';
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function truncate(value, max = 60) {
  const s = String(value || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** YouTube / Vimeo / Facebook video URL -> safe embed URL. */
function embedUrl(url) {
  const u = safeUrl(url, { allowRelative: false });
  if (!u) return '';
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(parsed.pathname.slice(1))}`;
    if (host.endsWith('youtube.com')) {
      const v = parsed.searchParams.get('v');
      if (v) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v)}`;
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' && parts[1]) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(parts[1])}`;
    }
    if (host.endsWith('vimeo.com')) {
      const id = parsed.pathname.split('/').filter(Boolean).pop();
      if (id) return `https://player.vimeo.com/video/${encodeURIComponent(id)}`;
    }
  } catch { /* fall through */ }
  return '';
}

module.exports = {
  bnNumber, compactNumber, formatDate, formatDateTime, timeAgo, dayKey, toDhaka,
  slugify, uniqueSlug,
  detectLang, replyLang, langLabel, pick, BN_RANGE, BANGLISH_MARKERS,
  randomId, randomHex, safeEqual, hmac, hashIp,
  readingTime, excerptFrom, stripTags, escapeHtml, safeUrl, referrerSource,
  clientIp, ipTail, parseJson, csvToArray, arrayToCsv, clamp, truncate, embedUrl,
  BN_MONTHS, EN_MONTHS, BN_DAYS,
};
