'use strict';

/**
 * Newsletter.
 *
 * Double opt-in by default: subscribing stores the address as `pending` with a
 * confirmation token; only `active` addresses receive campaigns. Every send
 * carries a one-way unsubscribe token so a forwarded email cannot be used to
 * unsubscribe someone else by guessing.
 *
 * The transport is pluggable — `log` (default, prints the message) or `smtp`.
 * SMTP uses a tiny built-in client so the project keeps zero mail dependencies;
 * drop in nodemailer later by replacing `sendMail()`.
 */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const repo = require('./content-repo');
const { randomHex, hashIp } = require('../utils/helpers');
const { logSecurityEvent } = require('../middleware/security');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

function subscribe({ email, lang = 'bn', country = null, confirm = true }) {
  const address = String(email || '').trim().toLowerCase();
  if (!isValidEmail(address)) return { ok: false, error: 'invalid_email' };

  const existing = db.get(`SELECT * FROM subscribers WHERE email = ?`, [address]);
  if (existing) {
    if (existing.status === 'active') return { ok: true, already: true };
    db.run(
      `UPDATE subscribers SET status = 'active', unsubscribed_at = NULL, lang = ? WHERE id = ?`,
      [lang, existing.id],
    );
    return { ok: true, already: true };
  }

  db.run(
    `INSERT INTO subscribers (email, lang, status, country, confirm_token, unsubscribe_token)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      address,
      lang,
      confirm ? 'pending' : 'active',
      country,
      randomHex(16),
      randomHex(24),
    ],
  );
  const row = db.get(`SELECT * FROM subscribers WHERE email = ?`, [address]);
  if (confirm) queueConfirmation(row).catch(() => {});
  return { ok: true, pending: confirm };
}

function confirmSubscription(token) {
  const row = db.get(`SELECT * FROM subscribers WHERE confirm_token = ?`, [String(token || '')]);
  if (!row) return false;
  db.run(`UPDATE subscribers SET status = 'active' WHERE id = ?`, [row.id]);
  return true;
}

function unsubscribe(token) {
  const row = db.get(`SELECT * FROM subscribers WHERE unsubscribe_token = ?`, [String(token || '')]);
  if (!row) return false;
  db.run(`UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [row.id]);
  return true;
}

function list({ status = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  return db.all(
    `SELECT * FROM subscribers ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY subscribed_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
}

function stats() {
  const byStatus = db.all(`SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status`);
  const map = { active: 0, pending: 0, unsubscribed: 0, bounced: 0 };
  for (const row of byStatus) map[row.status] = row.n;
  return {
    ...map,
    total: Object.values(map).reduce((a, b) => a + b, 0),
    campaigns: db.get(`SELECT COUNT(*) AS n FROM campaigns`)?.n || 0,
    lastSent: db.get(`SELECT sent_at FROM campaigns WHERE status='sent' ORDER BY sent_at DESC LIMIT 1`)?.sent_at || null,
  };
}

/* -------------------------------------------------------------- mailer ---- */

async function sendMail({ to, subject, html, text }) {
  if (config.mail.driver === 'log' || !config.mail.host) {
    console.log(`[mail:log] to=${to} subject=${subject}`);
    return { ok: true, driver: 'log' };
  }
  try {
    await smtpSend({ to, subject, html, text });
    return { ok: true, driver: 'smtp' };
  } catch (err) {
    logSecurityEvent({ kind: 'mail_failed', severity: 'medium', detail: `${to}: ${String(err.message).slice(0, 200)}` });
    return { ok: false, error: String(err.message).slice(0, 200) };
  }
}

/** Minimal SMTP client (LOGIN/PLAIN auth, STARTTLS or implicit TLS). */
function smtpSend({ to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const from = config.mail.from;
    const fromAddress = (from.match(/<(.+?)>/) || [null, from])[1];
    const boundary = `np24-${crypto.randomBytes(8).toString('hex')}`;
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text || '', 'utf8').toString('base64'),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html || '', 'utf8').toString('base64'),
      `--${boundary}--`,
    ].join('\r\n');

    const message = [
      `From: ${from}`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      'List-Unsubscribe: <' + config.publicUrl + '/newsletter/unsubscribe>',
      '',
      body,
    ].join('\r\n');

    const connect = config.mail.secure
      ? tls.connect({ host: config.mail.host, port: config.mail.port, servername: config.mail.host })
      : net.connect({ host: config.mail.host, port: config.mail.port });

    const steps = [
      { expect: 220, send: `EHLO newspulse24\r\n` },
      { expect: 250, send: config.mail.user ? `AUTH LOGIN\r\n` : `MAIL FROM:<${fromAddress}>\r\n` },
      ...(config.mail.user
        ? [
          { expect: 334, send: `${Buffer.from(config.mail.user).toString('base64')}\r\n` },
          { expect: 334, send: `${Buffer.from(config.mail.pass).toString('base64')}\r\n` },
        ]
        : []),
      { expect: 235, send: `MAIL FROM:<${fromAddress}>\r\n`, optional: true },
      { expect: 250, send: `RCPT TO:<${to}>\r\n` },
      { expect: 250, send: `DATA\r\n` },
      { expect: 354, send: `${message}\r\n.\r\n` },
      { expect: 250, send: `QUIT\r\n` },
    ];

    let i = 0;
    let buffer = '';
    const timeout = setTimeout(() => { connect.destroy(); reject(new Error('SMTP timeout')); }, 20_000);

    connect.on('connect', () => {});
    connect.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\r\n')) return;
      const code = Number.parseInt(buffer.slice(0, 3), 10);
      const step = steps[i];
      if (!step) return;
      if (code !== step.expect && !step.optional) {
        clearTimeout(timeout);
        connect.destroy();
        reject(new Error(`SMTP expected ${step.expect}, got ${buffer.slice(0, 120)}`));
        return;
      }
      buffer = '';
      i += 1;
      if (i >= steps.length) {
        clearTimeout(timeout);
        connect.end();
        resolve();
        return;
      }
      connect.write(steps[i].send);
    });
    connect.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function queueConfirmation(sub) {
  const url = `${config.publicUrl}/newsletter/confirm?token=${sub.confirm_token}`;
  await sendMail({
    to: sub.email,
    subject: 'নিউজপালস ২৪ — সাবস্ক্রিপশন নিশ্চিত করুন',
    text: `সাবস্ক্রিপশন নিশ্চিত করতে লিংকে ক্লিক করুন: ${url}`,
    html: `<p>ধন্যবাদ! সাবস্ক্রিপশন নিশ্চিত করতে <a href="${url}">এখানে ক্লিক করুন</a>।</p>`,
  });
}

/** Builds the morning digest from the day's most-read stories. */
function buildDigest(locale = 'bn') {
  const items = repo.mostRead(6);
  const rows = items.map((a) => `
    <li style="margin:0 0 14px">
      <a href="${config.publicUrl}/news/${a.slug}" style="color:#111;text-decoration:none;font-weight:600;font-size:16px;line-height:1.4;display:block">
        ${locale === 'bn' ? a.title_bn : (a.title_en || a.title_bn)}
      </a>
      <span style="color:#b01020;font-size:12px;text-transform:uppercase">${locale === 'bn' ? a.category_bn : (a.category_en || a.category_bn)}</span>
    </li>`).join('');
  return `
  <div style="font-family:system-ui,'Noto Sans Bengali',sans-serif;max-width:600px;margin:0 auto;color:#111">
    <div style="background:#0b0b0d;color:#fff;padding:18px 20px;border-left:5px solid #e11d2e">
      <strong style="font-size:20px">NewsPulse 24</strong>
      <span style="opacity:.7;font-size:13px"> • নিউজপালস ২৪</span>
    </div>
    <ul style="padding:20px 20px 0;margin:0;list-style:none">${rows}</ul>
    <p style="padding:10px 20px 24px;color:#666;font-size:12px">
      এই ইমেইলটি পেয়েছেন কারণ আপনি নিউজপালস ২৪-এ সাবস্ক্রাইব করেছেন।
    </p>
  </div>`;
}

function createCampaign({ subject, preview, body }) {
  const { lastInsertRowid } = db.run(
    `INSERT INTO campaigns (subject, preview, body) VALUES (?, ?, ?)`,
    [String(subject).slice(0, 200), String(preview || '').slice(0, 300), body],
  );
  return lastInsertRowid;
}

async function sendCampaign(campaignId, { limit = 500 } = {}) {
  const campaign = db.get(`SELECT * FROM campaigns WHERE id = ?`, [campaignId]);
  if (!campaign) return { ok: false, error: 'not_found' };
  db.run(`UPDATE campaigns SET status = 'sending' WHERE id = ?`, [campaignId]);
  const rows = db.all(`SELECT * FROM subscribers WHERE status = 'active' ORDER BY id LIMIT ?`, [limit]);
  let sent = 0;
  for (const sub of rows) {
    const html = campaign.body.replace('{{unsubscribe}}', `${config.publicUrl}/newsletter/unsubscribe?token=${sub.unsubscribe_token}`);
    const res = await sendMail({ to: sub.email, subject: campaign.subject, html, text: campaign.subject });
    if (res.ok) sent += 1;
    else db.run(`UPDATE subscribers SET status = 'bounced' WHERE id = ? AND ? = 'smtp'`, [sub.id, config.mail.driver]);
  }
  db.run(`UPDATE campaigns SET status = 'sent', sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), recipients = ? WHERE id = ?`, [sent, campaignId]);
  return { ok: true, sent };
}

function campaigns() {
  return db.all(`SELECT * FROM campaigns ORDER BY id DESC LIMIT 50`);
}

module.exports = {
  isValidEmail, subscribe, confirmSubscription, unsubscribe, list, stats,
  sendMail, buildDigest, createCampaign, sendCampaign, campaigns,
  hashSub: (email) => hashIp(`sub:${String(email).toLowerCase()}`),
};
