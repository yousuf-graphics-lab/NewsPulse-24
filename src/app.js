'use strict';

/**
 * Express application assembly.
 *
 * Middleware order is deliberate and load-bearing:
 *   headers → compression → body limits → cookies → IP blocklist → scanner
 *   filter → locale → geo → visitor/analytics → CSRF → session → routes →
 *   404 → error handler.
 * Reordering these (for example putting CSRF before the cookie parser, or the
 * blocklist after the routes) silently removes a protection.
 */

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const config = require('./config');
const security = require('./middleware/security');
const csrf = require('./middleware/csrf');
const auth = require('./middleware/auth');
const { pageviewTracker } = require('./middleware/analytics');
const { notFound, errorHandler } = require('./middleware/error');
const { resolveGeo } = require('./services/geo');
const publicRoutes = require('./routes/public');
const assistRoutes = require('./routes/assist');
const adminRoutes = require('./routes/admin');
const settings = require('./services/content');

function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('view cache', config.isProd);
  app.set('etag', 'strong');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.set('json spaces', 0);

  /* ------------------------------------------------------ 1. headers ----- */
  /*
   * A fresh CSP nonce per request, generated BEFORE helmet so the header and
   * the templates agree on the same value. helmet 8 does not generate nonces
   * for you — it only calls each directive function with (req, res), so the
   * value has to exist on res.locals by the time the header is built.
   */
  app.use((req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    next();
  });
  app.use(security.securityHeaders());

  /* --------------------------------------------------- 2. compression ---- */
  app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      if (res.getHeader('Content-Type') === 'text/event-stream') return false;
      return compression.filter(req, res);
    },
  }));

  /* ------------------------------------------------------- 3. bodies ----- */
  // Size caps first: an oversized body is rejected before it is parsed.
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 120 }));
  app.use('/csp-report', express.text({ type: () => true, limit: '16kb' }), (req, res) => {
    try { security.cspReport({ ...req, body: JSON.parse(req.body || '{}'), headers: req.headers }); } catch { /* ignore */ }
    res.status(204).end();
  });

  /* ------------------------------------------------------ 4. cookies ----- */
  app.use(cookieParser());

  /* ------------------------------------------------- 5. edge controls ---- */
  app.use(security.blocklist());
  app.use(security.scannerFilter());
  app.use(security.limiters.global());

  /* ------------------------------------------------------ 6. locale ------ */
  const LOCALE_COOKIE = 'np_lang';
  app.use((req, res, next) => {
    const requested = String(req.query.lang || '').toLowerCase();
    if (requested === 'bn' || requested === 'en') {
      res.cookie(LOCALE_COOKIE, requested, { httpOnly: false, sameSite: 'lax', secure: config.isProd, maxAge: 1000 * 60 * 60 * 24 * 365, path: '/' });
      req.locale = requested;
    } else if (req.cookies?.[LOCALE_COOKIE] === 'en') {
      req.locale = 'en';
    } else {
      req.locale = config.site.defaultLocale;
    }
    res.locals.locale = req.locale;
    next();
  });

  /* --------------------------------------------------------- 7. geo ------ */
  app.use(async (req, res, next) => {
    try { req.geo = await resolveGeo(req); } catch { req.geo = { country: 'unknown', city: '' }; }
    next();
  });

  /* ---------------------------------------------------- 8. analytics ----- */
  app.use(pageviewTracker());

  /* ------------------------------------------------------ 9. static ------ */
  app.use('/assets', express.static(path.join(__dirname, 'public'), {
    maxAge: config.isProd ? '30d' : 0,
    immutable: config.isProd,
    etag: true,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }));

  /* ------------------------------------------------- 10. csrf + session -- */
  /*
   * ORDER MATTERS. The CSRF token is HMAC(csrfSecret, csrfId + sessionId), so
   * the session must be loaded before the token is verified — otherwise every
   * logged-in form is rejected. `ensureCsrfId` only issues the cookie, so it
   * can safely run first.
   */
  app.use(csrf.ensureCsrfId);
  app.use(auth.loadSession);
  app.use(csrf.csrfProtect({
    // The CSP report endpoint is called by the browser itself and carries no
    // privileged action, so it is exempt from the token requirement.
    exempt: ['/csp-report'],
  }));

  // Shared locals for every template.
  app.use((req, res, next) => {
    res.locals.nonce = res.locals.cspNonce;
    res.locals.currentYear = new Date().getFullYear();
    res.locals.publicUrl = config.publicUrl;
    res.locals.settings = settings.getSettings();
    next();
  });

  /* ------------------------------------------------------- 12. routes ---- */
  app.use('/', publicRoutes);
  app.use('/', assistRoutes);
  app.use('/admin', adminRoutes);

  /* --------------------------------------------------- 13. error paths --- */
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { buildApp };
