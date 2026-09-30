'use strict';

/**
 * Client fingerprinting + geolocation.
 *
 * Both are written to answer one question — "where did this visit come from?" —
 * with the smallest amount of personal data possible. The raw IP is hashed
 * before storage and only its last octet is kept for admin triage.
 *
 * Geo resolution order (each step optional, each step cheap):
 *   1. CDN header (Cloudflare `CF-IPCountry`, Vercel, AWS) — free, no lookup.
 *   2. MaxMind GeoLite2 mmdb file, if the operator supplies one.
 *   3. Online lookup (ipwho.is) with an in-memory cache — off by default.
 *   4. "unknown".
 */

const fs = require('node:fs');
const config = require('../config');
const { clientIp } = require('../utils/helpers');

/* ------------------------------------------------------- user-agent parse -- */

const BROWSERS = [
  [/edg\//i, 'Edge'], [/opr\/|opera/i, 'Opera'], [/samsungbrowser/i, 'Samsung Internet'],
  [/ucbrowser/i, 'UC Browser'], [/firefox|fxios/i, 'Firefox'], [/chrome|crios/i, 'Chrome'],
  [/safari/i, 'Safari'], [/msie|trident/i, 'Internet Explorer'],
];
const OSES = [
  [/windows nt/i, 'Windows'], [/android/i, 'Android'], [/iphone|ipad|ipod/i, 'iOS'],
  [/mac os x|macintosh/i, 'macOS'], [/cros/i, 'ChromeOS'], [/linux/i, 'Linux'],
];
const BOT_RE = /(bot|crawl|spider|slurp|baiduspider|yandex|duckduckgo|facebookexternalhit|whatsapp|telegrambot|discordbot|google-extended|gptbot|claudebot|perplexitybot|bingpreview|curl|wget|python-requests|httpclient|headlesschrome)/i;

function parseUserAgent(ua) {
  const agent = String(ua || '');
  if (!agent) return { device: 'unknown', browser: 'Unknown', os: 'Unknown', isBot: false };
  const isBot = BOT_RE.test(agent);

  let browser = 'Other';
  for (const [re, name] of BROWSERS) if (re.test(agent)) { browser = name; break; }

  let os = 'Other';
  for (const [re, name] of OSES) if (re.test(agent)) { os = name; break; }

  let device = 'desktop';
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(agent)) device = 'tablet';
  else if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(agent)) device = 'mobile';

  return { device, browser, os, isBot };
}

/* --------------------------------------------------------------- geoip ---- */

let mmdbReader = null;
let mmdbTried = false;
const ipCache = new Map();
const IP_CACHE_MAX = 5000;

function isPrivateIp(ip) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc00|fe80|localhost)/i.test(String(ip || ''));
}

function loadMmdb() {
  if (mmdbTried) return mmdbReader;
  mmdbTried = true;
  const file = config.geo.mmdbPath;
  if (!file || !fs.existsSync(file)) return null;
  try {
    // Optional dependency: only required when the operator supplies a database.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const maxmind = require('maxmind');
    mmdbReader = maxmind.openSync(file);
  } catch {
    mmdbReader = null;
  }
  return mmdbReader;
}

function fromHeader(req) {
  const header = config.geo.header;
  if (!header) return null;
  const raw = req.headers[header];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string' || value.length !== 2) return null;
  return { country: value.toUpperCase(), city: '', source: 'cdn' };
}

function fromMmdb(ip) {
  const reader = loadMmdb();
  if (!reader) return null;
  try {
    const res = reader.get(ip);
    if (!res?.country?.iso_code) return null;
    return {
      country: res.country.iso_code,
      city: res.city?.names?.en || '',
      source: 'mmdb',
    };
  } catch {
    return null;
  }
}

async function fromOnline(ip) {
  if (config.geo.online !== 'ipwhois') return null;
  if (ipCache.has(ip)) return ipCache.get(ip);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    const json = await res.json();
    const out = json?.success
      ? { country: json.country_code || 'unknown', city: json.city || '', source: 'online' }
      : null;
    if (out) {
      if (ipCache.size > IP_CACHE_MAX) ipCache.clear();
      ipCache.set(ip, out);
    }
    return out;
  } catch {
    return null;
  }
}

const UNKNOWN = { country: 'unknown', city: '', source: 'none' };

async function resolveGeo(req) {
  const ip = clientIp(req);
  if (isPrivateIp(ip)) return { country: 'local', city: 'Local network', source: 'private' };
  return fromHeader(req) || fromMmdb(ip) || (await fromOnline(ip)) || UNKNOWN;
}

const COUNTRY_NAMES_BN = {
  BD: 'বাংলাদেশ', IN: 'ভারত', US: 'যুক্তরাষ্ট্র', GB: 'যুক্তরাজ্য', SA: 'সৌদি আরব',
  AE: 'সংযুক্ত আরব আমিরাত', MY: 'মালয়েশিয়া', SG: 'সিংগাপুর', AU: 'অস্ট্রেলিয়া',
  CA: 'কানাডা', IT: 'ইতালি', JP: 'জাপান', KR: 'দক্ষিণ কোরি', QA: 'কাতার',
  KW: 'কুয়েত', OM: 'ওমান', BH: 'বাহরাইন', PK: 'পাকিস্তান', NP: 'নেপাল',
  CN: 'চীন', DE: 'জার্মানি', FR: 'ফ্রান্স', ES: 'স্পেন', NL: 'নেদারল্যান্ডস',
  SE: 'সুইডেন', ZA: 'দক্ষিণ আফ্রিকা', local: 'লোকাল নেটওয়ার্ক', unknown: 'অজানা',
};

function countryName(code, locale = 'bn') {
  if (!code) return locale === 'bn' ? 'অজানা' : 'Unknown';
  if (locale === 'bn' && COUNTRY_NAMES_BN[code]) return COUNTRY_NAMES_BN[code];
  return code;
}

module.exports = { resolveGeo, parseUserAgent, countryName, isPrivateIp };
