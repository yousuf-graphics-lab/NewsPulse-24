'use strict';

/**
 * Session + authentication.
 *
 * Sessions live in the database, not in a signed cookie, so they can be
 * revoked instantly from the admin panel and audited. The cookie holds
 * `<sessionId>.<HMAC(sessionSecret, sessionId)>` — signing stops an attacker
 * from guessing an id, the DB lookup stops them from replaying a revoked one.
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const { randomId, clientIp, ipTail, hashIp } = require('../utils/helpers');
const { logSecurityEvent } = require('./security');

const COOKIE = 'np_session';
const TOUCH_EVERY_MS = 60_000; // don't write on every single request

/* ------------------------------------------------------------ passwords --- */

const COMMON_WEAK = ['password', '123456', 'qwerty', 'admin', 'letmein', 'welcome', 'iloveyou', 'newspulse', 'bangladesh', '12345678'];

function passwordProblems(pw) {
  const problems = [];
  if (!pw || pw.length < config.auth.passwordMinLength) problems.push(`পাসওয়ার্ড কমপক্ষে ${config.auth.passwordMinLength} অক্ষরের হতে হবে`);
  if (pw && !/[A-Za-z]/.test(pw)) problems.push('পাসওয়ার্ডে অন্তত একটি ইংরেজি অক্ষর থাকতে হবে');
  if (pw && !/\d/.test(pw)) problems.push('পাসওয়ার্ডে অন্তত একটি সংখ্যা থাকতে হবে');
  if (pw && COMMON_WEAK.some((w) => pw.toLowerCase().includes(w))) problems.push('পাসওয়ার্ডটি খুব সাধারণ, অন্য কিছু ব্যবহার করুন');
  return problems;
}

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), config.auth.bcryptRounds);
}

function verifyPassword(plain, hash) {
  try { return bcrypt.compareSync(String(plain), String(hash)); } catch { return false; }
}

/* ------------------------------------------------------------- sessions --- */

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProd,
    maxAge: 1000 * 60 * config.auth.sessionIdleMinutes,
    path: '/',
  };
}

const signSession = (id) =>
  `${id}.${crypto.createHmac('sha256', config.secrets.session).update(id).digest('base64url')}`;

/**
 * Create a server-side session row.
 *
 * `setCookie: false` is used for the 2FA hand-off: the row exists (so the
 * pending login can be resumed) but the browser has no usable session until
 * the second factor is verified.
 */
function createSession(req, res, userId, { setCookie = true } = {}) {
  const id = randomId(24);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * config.auth.sessionAbsoluteHours).toISOString();
  db.run(
    `INSERT INTO sessions (id, token_hash, user_id, ip_hash, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      hashIp(`${id}:${userId}`),
      userId,
      hashIp(clientIp(req)),
      String(req.headers['user-agent'] || '').slice(0, 200),
      expiresAt,
    ],
  );
  if (setCookie) res.cookie(COOKIE, signSession(id), cookieOptions());
  return id;
}

/** Promote a pending (pre-2FA) session to a real one. */
function activateSession(res, sessionId) {
  const row = db.get(`SELECT id FROM sessions WHERE id = ? AND revoked_at IS NULL`, [sessionId]);
  if (!row) return false;
  res.cookie(COOKIE, signSession(sessionId), cookieOptions());
  return true;
}

function destroySession(req, res) {
  const id = req.session?.id;
  if (id) {
    db.run(`UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [id]);
  }
  res.clearCookie(COOKIE, cookieOptions());
  req.session = null;
  req.user = null;
}

function destroyUserSessions(userId, exceptId = null) {
  db.run(`UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND (revoked_at IS NULL) AND (? IS NULL OR id <> ?)`, [userId, exceptId, exceptId]);
}

/** Periodically drops dead rows so the table never grows without bound. */
function pruneSessions() {
  try {
    db.run(`DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now') OR revoked_at < strftime('%Y-%m-%dT%H:%M:%fZ','-30 days')`);
  } catch { /* noop */ }
}

function loadSession(req, res, next) {
  req.user = null;
  req.session = null;
  const raw = req.cookies?.[COOKIE];
  if (!raw || typeof raw !== 'string' || !raw.includes('.')) return next();

  const [id, sig] = raw.split('.');
  const expected = crypto.createHmac('sha256', config.secrets.session).update(id || '').digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.clearCookie(COOKIE, cookieOptions());
    return next();
  }

  const row = db.get(
    `SELECT s.id          AS session_id,
            s.expires_at  AS expires_at,
            s.last_seen_at AS last_seen_at,
            u.id          AS user_id,
            u.name        AS name,
            u.email       AS email,
            u.role        AS role,
            u.status      AS status,
            u.avatar_url  AS avatar_url,
            u.two_factor_on AS two_factor_on
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.revoked_at IS NULL`,
    [id],
  );

  if (!row || row.status !== 'active') {
    res.clearCookie(COOKIE, cookieOptions());
    return next();
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.run(`UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [id]);
    res.clearCookie(COOKIE, cookieOptions());
    return next();
  }

  const idleMs = Date.now() - new Date(row.last_seen_at).getTime();
  if (idleMs > TOUCH_EVERY_MS) {
    db.run(`UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [id]);
  }

  req.session = { id, expiresAt: row.expires_at };
  req.user = {
    id: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatarUrl: row.avatar_url,
    twoFactorOn: !!row.two_factor_on,
    permissions: new Set(config.roles[row.role]?.permissions || []),
  };
  next();
}

function can(user, permission) {
  if (!user) return false;
  if (user.permissions?.has('*')) return true;
  return !!user.permissions?.has(permission);
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.accepts('html')) {
    return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ ok: false, error: 'unauthenticated' });
}

function requirePermission(...perms) {
  return (req, res, next) => {
    if (!req.user) {
      if (req.accepts('html')) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      return res.status(401).json({ ok: false, error: 'unauthenticated' });
    }
    if (perms.some((p) => can(req.user, p))) return next();
    const { renderError } = require('./error');
    return renderError(req, res, 403, req.locale === 'en'
      ? 'Your role does not allow access to this area.'
      : 'এই অংশে প্রবেশের অনুমতি আপনার নেই।');
  };
}

/* ------------------------------------------------------------- lockout ---- */

function registerFailedLogin(email, req) {
  const user = db.get(`SELECT * FROM users WHERE lower(email) = lower(?)`, [email]);
  if (!user) return { locked: false };
  const attempts = user.failed_attempts + 1;
  const lockUntil = attempts >= config.auth.loginMaxAttempts
    ? new Date(Date.now() + config.auth.loginLockMinutes * 60_000).toISOString()
    : null;
  db.run(`UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?`, [attempts, lockUntil, user.id]);
  logSecurityEvent({
    kind: 'login_failed',
    severity: attempts >= config.auth.loginMaxAttempts ? 'high' : 'medium',
    req,
    detail: `Failed sign-in for ${email} (attempt ${attempts})`,
  });
  return { locked: !!lockUntil, attempts, lockUntil, user };
}

function registerSuccessfulLogin(user, req) {
  db.run(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_login_ip = ? WHERE id = ?`,
    [ipTail(clientIp(req)), user.id],
  );
}

function isLocked(user) {
  return !!user.locked_until && new Date(user.locked_until).getTime() > Date.now();
}

/* ----------------------------------------------------------- audit trail -- */

function audit(req, action, { entity = null, entityId = null, meta = null, user = null } = {}) {
  try {
    const actor = user || req.user;
    db.run(
      `INSERT INTO audit_log (user_id, actor, action, entity, entity_id, ip_hash, user_agent, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actor?.id || null,
        actor?.email || 'anonymous',
        action,
        entity,
        entityId === null ? null : String(entityId),
        hashIp(clientIp(req)),
        String(req.headers?.['user-agent'] || '').slice(0, 200),
        meta ? JSON.stringify(meta).slice(0, 2000) : null,
      ],
    );
  } catch { /* never break a request over a log line */ }
}

module.exports = {
  COOKIE, loadSession, createSession, activateSession, destroySession, destroyUserSessions, pruneSessions,
  requireAuth, requirePermission, can,
  hashPassword, verifyPassword, passwordProblems,
  registerFailedLogin, registerSuccessfulLogin, isLocked, audit,
};
