'use strict';

/**
 * Error handling.
 *
 * The public site never shows a stack trace: in production the visitor gets a
 * branded error page while the detail goes to the server log and the
 * `security_events` table. In development the stack is shown, because hiding
 * it from the developer makes bugs harder to fix.
 */

const config = require('../config');
const { logSecurityEvent } = require('./security');
const { flush: flushAnalytics } = require('./analytics');

class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function wantsHtml(req) {
  return !!req.accepts('html');
}

function renderError(req, res, status, message, err = null) {
  const locale = req.locale || 'bn';
  const content = require('../services/content');
  const payload = {
    status,
    locale,
    // Error pages render outside the normal locals pipeline, so everything a
    // template might touch is supplied explicitly rather than assumed.
    site: content.getSettings(),
    settings: content.getSettings(),
    csrfToken: typeof req.csrfToken === 'function' ? req.csrfToken() : '',
    publicUrl: config.publicUrl,
    currentYear: new Date().getFullYear(),
    categories: [],
    ticker: [],
    tickerEnabled: false,
    user: req.user || null,
    currentPath: req.path,
    adsEnabled: false,
    h: require('../utils/helpers'),
    title: status === 404 ? 'পেজ পাওয়া যায়নি' : 'কিছু একটা ভুল হয়েছে',
    heading: {
      400: locale === 'en' ? 'Bad request' : 'অবৈধ অনুরোধ',
      403: locale === 'en' ? 'Access denied' : 'প্রবেশাধিকার নেই',
      404: locale === 'en' ? 'Page not found' : 'পেজটি পাওয়া যায়নি',
      405: locale === 'en' ? 'Method not allowed' : 'অনুমোদিত পদ্ধতি নয়',
      413: locale === 'en' ? 'Payload too large' : 'ফাইল অনেক বড়',
      429: locale === 'en' ? 'Too many requests' : 'অনেক বেশি অনুরোধ',
      500: locale === 'en' ? 'Server error' : 'সার্ভার ত্রুটি',
    }[status] || 'Error',
    message: message || 'Unexpected error',
    stack: !config.isProd && err ? err.stack : null,
  };
  res.status(status);
  if (wantsHtml(req)) {
    res.render('errors/generic', payload, (renderErr, html) => {
      if (renderErr) {
        res.type('txt').send(`Error ${status}: ${message}`);
        return;
      }
      res.send(html);
    });
    return;
  }
  res.json({ ok: false, error: err?.code || 'error', message, status });
}

function notFound(req, res) {
  renderError(req, res, 404, req.locale === 'en'
    ? 'The page you are looking for does not exist or has been moved.'
    : 'আপনি যে পেজটি খুঁজছেন তা নেই বা সরিয়ে নেওয়া হয়েছে।');
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return;

  // express.json / body-parser errors
  if (err.type === 'entity.too.large') return renderError(req, res, 413, 'Request body too large', err);
  if (err.type === 'entity.parse.failed') return renderError(req, res, 400, 'Malformed JSON body', err);
  if (err.code === 'LIMIT_FILE_SIZE') return renderError(req, res, 413, 'File exceeds the upload size limit', err);

  const status = Number.isInteger(err.status) ? err.status : Number.isInteger(err.statusCode) ? err.statusCode : 500;

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    logSecurityEvent({
      kind: 'unhandled_error',
      severity: 'high',
      req,
      detail: `${err.name}: ${String(err.message).slice(0, 300)}`,
    });
  }

  const publicMessage = status >= 500
    ? (req.locale === 'en' ? 'Something went wrong on our side. Our team has been notified.' : 'আমাদের পক্ষ থেকে একটি সমস্যা হয়েছে। আমরা খতিয়ে দেখছি।')
    : err.message;

  return renderError(req, res, status, publicMessage, err);
}

function registerProcessHandlers() {
  const shutdown = (signal) => () => {
    console.log(`[server] ${signal} received, flushing buffers…`);
    try { flushAnalytics(); } catch { /* noop */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err);
    try { flushAnalytics(); } catch { /* noop */ }
    // A process in an unknown state must not keep serving requests.
    process.exit(1);
  });
}

module.exports = { HttpError, notFound, errorHandler, renderError, registerProcessHandlers };
