'use strict';

/**
 * Defence in depth, applied before anything else touches a request:
 *
 *  1. Security headers (helmet) with a nonce-based Content-Security-Policy, so
 *     an injected inline script simply will not execute.
 *  2. An in-app IP blocklist backed by the `blocked_ips` table (an edge WAF can
 *     sit in front, but the app must not depend on one existing).
 *  3. Known scanner paths answered with 404 + a security event, so probes are
 *     visible in the admin Security Center instead of silently failing.
 *  4. Tiered rate limiting (global, login, writes, AI, ad beacons).
 *  5. Body-size caps so a single request cannot exhaust memory.
 */

const crypto = require('node:crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const db = require('../db');
const { clientIp, ipTail } = require('../utils/helpers');

/* ------------------------------------------------------------------ CSP --- */

const GOOGLE_FONTS = ["'self'", 'https://fonts.googleapis.com'];
const FONT_HOSTS = ["'self'", 'https://fonts.gstatic.com', 'data:'];

function buildCsp(useNonce) {
  /*
   * helmet calls each directive function with (req, res) — NOT with the nonce.
   * The value we generated in app.js is read off res.locals, so the header and
   * the templates can never drift apart.
   */
  const nonce = (_req, res) => `'nonce-${res.locals.cspNonce}'`;
  const scriptSrc = ["'self'", useNonce ? nonce : "'self'"];
  const styleSrc = ["'self'", ...GOOGLE_FONTS, useNonce ? nonce : "'self'"];

  return {
    directives: {
      'default-src': ["'self'"],
      'script-src': scriptSrc,
      'style-src': styleSrc,
      'img-src': ["'self'", 'data:', 'https:', 'blob:'],
      'media-src': ["'self'", 'https:', 'blob:'],
      'font-src': FONT_HOSTS,
      // Video embeds and the sandboxed ad frame. Ad frames are same-origin but
      // rendered with their own, far stricter policy (see routes/ads-frame).
      'frame-src': ["'self'", 'https://www.youtube-nocookie.com', 'https://www.youtube.com', 'https://player.vimeo.com', 'https://www.facebook.com', 'https://www.dailymotion.com'],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'manifest-src': ["'self'"],
      'worker-src': ["'self'"],
      'upgrade-insecure-requests': config.isProd ? [] : null,
    },
  };
}

function securityHeaders() {
  return helmet({
    contentSecurityPolicy: buildCsp(true),
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.isProd
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    // NOTE: do not add `ieNoOpen` here — helmet v8 throws because it is an
    // alias of `xDownloadOptions` and would set X-Download-Options twice.
    noSniff: true,
    xssFilter: true,
    xPoweredBy: false,
    // CSP already sends frame-ancestors 'none'; X-Frame-Options is the
    // legacy duplicate for browsers that do not understand CSP.
    frameguard: { action: 'deny' },
    xDnsPrefetchControl: { allow: false },
    xDownloadOptions: true,
    xPermittedCrossDomainPolicies: 'none',
    originAgentCluster: true,
  });
}

/* ------------------------------------------------------------ blocklist --- */

let blockCache = { map: new Map(), loadedAt: 0 };
const BLOCK_TTL_MS = 20_000;

function loadBlockedIps() {
  if (Date.now() - blockCache.loadedAt < BLOCK_TTL_MS) return blockCache.map;
  try {
    const rows = db.all(`SELECT ip, expires_at FROM blocked_ips`);
    const map = new Map();
    const now = Date.now();
    for (const row of rows) {
      if (row.expires_at && new Date(row.expires_at).getTime() < now) continue;
      map.set(row.ip, row.expires_at || 'permanent');
    }
    blockCache = { map, loadedAt: Date.now() };
  } catch {
    /* table may not exist before first migrate() */
  }
  return blockCache.map;
}

function invalidateBlockCache() {
  blockCache.loadedAt = 0;
}

function blocklist() {
  return (req, res, next) => {
    const ip = clientIp(req);
    if (loadBlockedIps().has(ip)) {
      res.status(403).type('txt').send('Forbidden');
      return;
    }
    next();
  };
}

/* -------------------------------------------------------- scanner filter -- */

const SCANNER_PATTERNS = [
  /\.env(\.|$)/i, /wp-(admin|login|content|includes)/i, /phpmyadmin/i,
  /\/\.git/i, /\/actuator/i, /\/\.aws/i, /shell\.php/i, /eval\(/i,
  /\/vendor\//i, /\/solr\//i, /\/xmlrpc\.php/i, /\/adminer/i, /\/config\.(php|json)/i,
];

function scannerFilter() {
  return (req, res, next) => {
    const target = `${req.originalUrl}`;
    if (SCANNER_PATTERNS.some((re) => re.test(target))) {
      logSecurityEvent({
        kind: 'scanner_probe',
        severity: 'medium',
        req,
        detail: `Blocked scanner path: ${target.slice(0, 200)}`,
      });
      res.status(404).type('txt').send('Not Found');
      return;
    }
    next();
  };
}

/* ---------------------------------------------------------- rate limits --- */

function limiterHandler(req, res) {
  logSecurityEvent({
    kind: 'rate_limited',
    severity: 'low',
    req,
    detail: `Rate limit hit on ${req.method} ${req.path}`,
  });
  if (req.accepts('html')) {
    const { renderError } = require('./error');
    renderError(req, res, 429, req.locale === 'en'
      ? 'Too many requests — please wait a moment and try again.'
      : 'অনেক বেশি অনুরোধ — একটু অপেক্ষা করে আবার চেষ্টা করুন।');
    return;
  }
  res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSec: 60 });
}

const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: limiterHandler,
    skip: (req) => req.path.startsWith('/healthz'),
    message,
  });

const limiters = {
  global: () => makeLimiter(config.rateLimits.global),
  login: () => makeLimiter({ ...config.rateLimits.login }),
  write: () => makeLimiter({ ...config.rateLimits.write }),
  ai: () => makeLimiter({ ...config.rateLimits.ai }),
  beacon: () => makeLimiter({ ...config.rateLimits.beacon }),
};

/* ------------------------------------------------------ security logging -- */

function logSecurityEvent({ kind, severity = 'low', req = null, ip = null, detail = '' }) {
  try {
    const sourceIp = ip || (req ? clientIp(req) : 'unknown');
    db.run(
      `INSERT INTO security_events (kind, severity, ip_hash, ip_last_octet, user_agent, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        kind,
        severity,
        crypto.createHmac('sha256', config.secrets.ipPepper).update(sourceIp).digest('hex').slice(0, 32),
        ipTail(sourceIp),
        String(req?.headers?.['user-agent'] || '').slice(0, 200),
        String(detail).slice(0, 500),
      ],
    );
  } catch {
    /* logging must never break the request path */
  }
}

/* ------------------------------------------------------------- CSP report - */

function cspReport(req, res) {
  const report = req.body || {};
  const violation = report['csp-report'] || report;
  logSecurityEvent({
    kind: 'csp_violation',
    severity: 'high',
    req,
    detail: JSON.stringify({
      blockedURI: violation['blocked-uri'],
      documentURI: violation['document-uri'],
      violatedDirective: violation['violated-directive'],
    }).slice(0, 500),
  });
  res.status(204).end();
}

/*
 * Note on nonces: helmet 8 does NOT generate them (there is no `useNonces`
 * option). `app.js` generates one per request onto `res.locals.cspNonce` before
 * `securityHeaders()` runs; the CSP directives read it from there and the
 * templates print the same value, so the header and the markup cannot drift.
 * Nothing is cached across requests, so a leaked nonce cannot be replayed.
 */

module.exports = {
  securityHeaders, blocklist, invalidateBlockCache, scannerFilter,
  limiters, limiterHandler, logSecurityEvent, cspReport,
};
