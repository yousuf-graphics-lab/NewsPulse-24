'use strict';

/**
 * TOTP two-factor authentication (RFC 6238 / Google Authenticator compatible).
 *
 * Implemented directly on `node:crypto` — no third-party 2FA dependency, which
 * keeps the attack surface small and means the algorithm is auditable in one
 * short file. SHA-1 / 30 s / 6 digits, the defaults every authenticator app
 * already supports.
 */

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

function randomSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  const clean = String(input).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generate(secret, at = Date.now()) {
  const key = base32Decode(secret);
  const counter = Math.floor(at / 1000 / PERIOD);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Accepts the current window plus one either side (clock skew tolerance). */
function verify(secret, token, { window = 1 } = {}) {
  const clean = String(token || '').replace(/\D/g, '');
  if (clean.length !== DIGITS) return false;
  const now = Date.now();
  for (let i = -window; i <= window; i += 1) {
    const expected = generate(secret, now + i * PERIOD * 1000);
    const a = Buffer.from(clean);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function otpauthUrl({ secret, email, issuer = 'NewsPulse 24' }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

module.exports = { randomSecret, generate, verify, otpauthUrl, PERIOD, DIGITS };
