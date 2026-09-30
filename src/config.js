'use strict';

/**
 * Central configuration.
 *
 * Every setting is read once, validated/coerced here, and frozen. Nothing else
 * in the codebase touches `process.env` directly — that keeps secret handling
 * auditable and makes it impossible for a typo'd env name to silently disable
 * a security control.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

require('dotenv').config({ quiet: true });

const ROOT = path.resolve(__dirname, '..');
const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';

const bool = (v, d = false) =>
  v === undefined || v === null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const list = (v, d = []) =>
  v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d;

const ROOT_DIR = ROOT;
const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');
const UPLOAD_DIR = path.resolve(ROOT_DIR, process.env.UPLOAD_DIR || 'storage/uploads');
const BACKUP_DIR = path.resolve(ROOT_DIR, process.env.BACKUP_DIR || 'backups');

for (const dir of [DATA_DIR, UPLOAD_DIR, BACKUP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o750); } catch { /* non-POSIX fs */ }
}

/**
 * Development convenience: secrets are auto-generated (and persisted) so the
 * app is runnable out of the box. In production a missing secret is fatal —
 * an app that silently falls back to a known key is an app that is already
 * compromised.
 */
function resolveSecret(name, file) {
  if (process.env[name]) return process.env[name];
  if (env === 'production') {
    throw new Error(`[config] ${name} is required in production. Generate one with:\n  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`);
  }
  const secretFile = path.join(DATA_DIR, file);
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

const config = {
  env,
  isProd: env === 'production',
  port: int(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  trustProxy: bool(process.env.TRUST_PROXY, true),
  host: process.env.HOST || '0.0.0.0',

  paths: { root: ROOT_DIR, data: DATA_DIR, uploads: UPLOAD_DIR, backups: BACKUP_DIR },
  dbFile: path.resolve(ROOT_DIR, process.env.DB_FILE || './data/newspulse24.db'),

  secrets: {
    session: resolveSecret('SESSION_SECRET', '.session-secret'),
    csrf: resolveSecret('CSRF_SECRET', '.csrf-secret'),
    ipPepper: resolveSecret('IP_HASH_PEPPER', '.ip-pepper'),
  },

  auth: {
    bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),
    loginMaxAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 5),
    loginLockMinutes: int(process.env.LOGIN_LOCK_MINUTES, 15),
    sessionIdleMinutes: int(process.env.SESSION_IDLE_MINUTES, 120),
    sessionAbsoluteHours: int(process.env.SESSION_ABSOLUTE_HOURS, 24),
    require2faForAdmins: bool(process.env.REQUIRE_2FA_FOR_ADMINS, false),
    passwordMinLength: 10,
  },

  uploads: {
    maxFileSizeMb: int(process.env.UPLOAD_MAX_MB, 8),
    allowedMime: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'],
    allowedExt: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'],
  },

  ai: {
    provider: (process.env.AI_PROVIDER || 'none').toLowerCase(),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    baseUrl: process.env.AI_BASE_URL || '',
    maxTokens: int(process.env.AI_MAX_TOKENS, 700),
    temperature: Number.parseFloat(process.env.AI_TEMPERATURE || '0.4'),
    rateLimit: int(process.env.AI_RATE_LIMIT, 20),
    maxMessageChars: 2000,
  },

  mail: {
    driver: (process.env.MAIL_DRIVER || 'log').toLowerCase(),
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'NewsPulse 24 <no-reply@newspulse24.com>',
  },

  geo: {
    header: (process.env.GEO_HEADER || '').toLowerCase(),
    mmdbPath: process.env.GEO_MMDB_PATH || '',
    online: (process.env.GEO_ONLINE || 'none').toLowerCase(),
  },

  ads: {
    enabled: bool(process.env.ADS_ENABLED, true),
    scriptAllowlist: list(process.env.AD_SCRIPT_ALLOWLIST, [
      'pagead2.googlesyndication.com',
      'tpc.googlesyndication.com',
      'cdn.ampproject.org',
    ]),
  },

  rateLimits: {
    global: { windowMs: 60_000, max: 300 },
    login: { windowMs: 15 * 60_000, max: 10 },
    write: { windowMs: 60_000, max: 20 },
    ai: { windowMs: 10 * 60_000, max: int(process.env.AI_RATE_LIMIT, 20) },
    beacon: { windowMs: 60_000, max: 200 },
  },

  site: {
    name: 'NewsPulse 24',
    nameBn: 'নিউজপালস ২৪',
    tagline: 'সংবাদে নির্ভরযোগ্য, প্রযুক্তিতে অগ্রগামী',
    taglineEn: 'Reliable news, advanced technology',
    defaultLocale: 'bn',
    timezone: 'Asia/Dhaka',
    currency: 'BDT',
    articlesPerPage: 12,
  },

  /**
   * Ad inventory. Slots are declared in code (not free-form admin input) so the
   * layout can never be broken by a mistyped slot name, and so lazy-loading and
   * viewability rules stay consistent. `view` tells the renderer where it lives.
   */
  adSlots: [
    { id: 'top-leaderboard', label: 'Top Leaderboard (970×90)', group: 'desktop', priority: 1 },
    { id: 'below-ticker', label: 'Below Breaking Ticker (728×90)', group: 'all', priority: 2 },
    { id: 'sidebar-top', label: 'Sidebar Top (300×250)', group: 'desktop', priority: 3 },
    { id: 'sidebar-sticky', label: 'Sidebar Sticky (300×600)', group: 'desktop', priority: 4 },
    { id: 'in-article', label: 'In-Article (responsive)', group: 'all', priority: 5 },
    { id: 'after-article', label: 'After Article (728×90)', group: 'all', priority: 6 },
    { id: 'between-cards', label: 'Between News Cards', group: 'all', priority: 7 },
    { id: 'mobile-banner', label: 'Mobile Sticky Bottom (320×50)', group: 'mobile', priority: 8 },
    { id: 'mobile-inline', label: 'Mobile Inline (300×250)', group: 'mobile', priority: 9 },
    { id: 'interstitial', label: 'Interstitial / Full Screen', group: 'all', priority: 10 },
    { id: 'footer-banner', label: 'Footer Banner (970×90)', group: 'all', priority: 11 },
    { id: 'native-sponsored', label: 'Native Sponsored Card', group: 'all', priority: 12 },
  ],

  roles: {
    superadmin: {
      label: 'Super Admin',
      permissions: ['*'],
    },
    editor: {
      label: 'Editor',
      permissions: [
        'article.create', 'article.editAny', 'article.delete', 'article.publish',
        'comment.moderate', 'media.upload', 'media.delete', 'ticker.manage',
        'ads.manage', 'newsletter.manage', 'pages.manage', 'corrections.manage', 'poll.manage',
      ],
    },
    reporter: {
      label: 'Reporter',
      permissions: ['article.create', 'article.editOwn', 'media.upload', 'corrections.create'],
    },
    moderator: {
      label: 'Moderator',
      permissions: ['comment.moderate', 'article.editOwn'],
    },
    analyst: {
      label: 'Analyst (read-only)',
      permissions: ['analytics.view'],
    },
  },

  categories: [
    { slug: 'national', bn: 'জাতীয়', en: 'National', color: '#e11d2e' },
    { slug: 'politics', bn: 'রাজনীতি', en: 'Politics', color: '#b01020' },
    { slug: 'international', bn: 'আন্তর্জাতিক', en: 'International', color: '#c8102e' },
    { slug: 'bangladesh-abroad', bn: 'প্রবাস', en: 'Diaspora', color: '#a30d1c' },
    { slug: 'economy', bn: 'অর্থনীতি', en: 'Economy', color: '#d4142a' },
    { slug: 'sports', bn: 'খেলাধুলা', en: 'Sports', color: '#8f0c1a' },
    { slug: 'entertainment', bn: 'বিনোদন', en: 'Entertainment', color: '#e63946' },
    { slug: 'technology', bn: 'প্রযুক্তি', en: 'Technology', color: '#1f2937' },
    { slug: 'health', bn: 'স্বাস্থ্য', en: 'Health', color: '#c1121f' },
    { slug: 'education', bn: 'শিক্ষা', en: 'Education', color: '#9d0208' },
    { slug: 'opinion', bn: 'মতামত', en: 'Opinion', color: '#6a040f' },
    { slug: 'lifestyle', bn: 'জীবনযাপন', en: 'Lifestyle', color: '#d90429' },
  ],
};

Object.freeze(config.adSlots);
Object.freeze(config.categories);

module.exports = config;
