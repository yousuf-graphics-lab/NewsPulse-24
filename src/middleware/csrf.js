'use strict';

/**
 * CSRF protection — signed synchroniser-token pattern.
 *
 * Flow
 *  1. Every visitor gets an httpOnly `np_csrfid` cookie holding random bytes.
 *  2. The token handed to the page is HMAC(csrfSecret, csrfid + sessionId).
 *     It is bound to the session, so stealing the cookie alone is useless.
 *  3. State-changing requests must carry the token as a form field
 *     (`_csrf`), a query param, or the `X-CSRF-Token` header, and it is
 *     compared in constant time.
 *  4. As belt-and-braces, a present `Origin`/`Sec-Fetch-Site` header that does
 *     not match our own origin is rejected before the token is even checked.
 */

const crypto = require('node:crypto');
const config = require('../config');
const { logSecurityEvent } = require('./security');

const COOKIE_NAME = 'np_csrfid';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sign(csrfId, sessionId) {
  return crypto
    .createHmac('sha256', config.secrets.csrf)
    .update(`${csrfId}:${sessionId || 'anonymous'}`)
    .digest('base64url');
}

function cookieOptions(res) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 1000 * 60 * 60 * 12,
    path: '/',
  };
}

function ensureCsrfId(req, res, next) {
  let id = req.cookies?.[COOKIE_NAME];
  if (!id || typeof id !== 'string' || id.length < 20 || id.length > 80) {
    id = crypto.randomBytes(24).toString('base64url');
    res.cookie(COOKIE_NAME, id, cookieOptions(res));
    req.cookies = req.cookies || {};
    req.cookies[COOKIE_NAME] = id;
  }
  req.csrfToken = () => sign(id, req.session?.id);
  next();
}

function readToken(req) {
  return (
    req.body?._csrf ||
    req.query?._csrf ||
    req.get('X-CSRF-Token') ||
    req.get('x-csrf-token') ||
    ''
  );
}

function csrfProtect({ exempt = [] } = {}) {
  const exemptSet = new Set(exempt);
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || exemptSet.has(req.path)) return next();

    // Origin / fetch-metadata check first: cheap and catches most blind CSRF.
    const origin = req.get('origin') || req.get('referer');
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { host = 'invalid'; }
      if (host !== req.get('host') && host !== new URL(config.publicUrl).host) {
        logSecurityEvent({ kind: 'csrf_origin_mismatch', severity: 'high', req, detail: `Origin ${host}` });
        return res.status(403).json({ ok: false, error: 'origin_mismatch' });
      }
    }
    const secFetch = req.get('sec-fetch-site');
    if (secFetch && !['same-origin', 'same-site', 'none'].includes(secFetch)) {
      logSecurityEvent({ kind: 'csrf_cross_site', severity: 'high', req, detail: `Sec-Fetch-Site: ${secFetch}` });
      return res.status(403).json({ ok: false, error: 'cross_site_request' });
    }

    const token = String(readToken(req) || '');
    const expected = req.csrfToken ? req.csrfToken() : '';
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);

    if (!ok) {
      logSecurityEvent({ kind: 'csrf_invalid_token', severity: 'high', req, detail: `${req.method} ${req.originalUrl}` });
      // Reuses the central error renderer so the page has every local a
      // template may touch — a broken CSRF page would itself be a bug.
      const { renderError } = require('./error');
      return renderError(req, res, 403, req.locale === 'en'
        ? 'Your form token has expired. Please go back and try again.'
        : 'আপনার ফর্ম টোকেনের মেয়াদ শেষ। পেছনে গিয়ে আবার চেষ্টা করুন।');
    }
    next();
  };
}

module.exports = { ensureCsrfId, csrfProtect, COOKIE_NAME };
