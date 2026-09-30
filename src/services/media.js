'use strict';

/**
 * Media uploads.
 *
 * Uploads are the single easiest way to get owned, so the pipeline is strict:
 *  • extension allowlist AND MIME allowlist AND a magic-byte sniff of the real
 *    file contents (an attacker can set any Content-Type they like);
 *  • SVG is refused outright — it is an XML document that can carry script;
 *  • the file is renamed to a random string, so the original name (which may
 *    contain path traversal or shell metacharacters) never reaches the disk;
 *  • files are stored outside the web root and served by an app route that
 *    sets `X-Content-Type-Options: nosniff` and a restrictive CSP.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const { randomHex, safeUrl } = require('../utils/helpers');
const { logSecurityEvent } = require('../middleware/security');

const SIGNATURES = [
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: '.png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/gif', ext: '.gif', test: (b) => b.slice(0, 6).toString('ascii') === 'GIF87a' || b.slice(0, 6).toString('ascii') === 'GIF89a' },
  { mime: 'image/webp', ext: '.webp', test: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'image/avif', ext: '.avif', test: (b) => b.slice(4, 12).toString('ascii').includes('ftypavif') || b.slice(4, 12).toString('ascii').includes('ftypmif1') },
];

function sniff(fdOrPath) {
  const buf = Buffer.alloc(16);
  const fd = fs.openSync(fdOrPath, 'r');
  try { fs.readSync(fd, buf, 0, 16, 0); } finally { fs.closeSync(fd); }
  return SIGNATURES.find((sig) => sig.test(buf)) || null;
}

function storage() {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.paths.uploads),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${Date.now().toString(36)}-${randomHex(8)}${config.uploads.allowedExt.includes(ext) ? ext : ''}`);
    },
  });
}

function upload(field = 'file', maxCount = 1) {
  return multer({
    storage: storage(),
    limits: {
      fileSize: config.uploads.maxFileSizeMb * 1024 * 1024,
      files: maxCount,
      fields: 40,
      fieldSize: 1024 * 64,
      parts: 60,
    },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!config.uploads.allowedExt.includes(ext) || !config.uploads.allowedMime.includes(file.mimetype)) {
        logSecurityEvent({ kind: 'upload_blocked', severity: 'high', req, detail: `Rejected ${file.originalname} (${file.mimetype})` });
        const err = new Error('অনুমোদিত নয় এমন ফাইল টাইপ');
        err.status = 400;
        err.code = 'BAD_FILE_TYPE';
        return cb(err);
      }
      cb(null, true);
    },
  }).single(field);
}

/** Verify contents after the fact and record the asset. */
function finalise(req, file, { alt = '' } = {}) {
  const sniffed = sniff(file.path);
  if (!sniffed) {
    fs.unlink(file.path, () => {});
    logSecurityEvent({ kind: 'upload_blocked', severity: 'high', req, detail: `Magic-byte mismatch for ${file.originalname}` });
    const err = new Error('ফাইলের বিষয়বস্তু যাচাই করা যায়নি');
    err.status = 400;
    err.code = 'FILE_CONTENT_MISMATCH';
    throw err;
  }
  const finalName = `${path.parse(file.filename).name}${sniffed.ext}`;
  const finalPath = path.join(config.paths.uploads, finalName);
  if (finalPath !== file.path) fs.renameSync(file.path, finalPath);

  const { lastInsertRowid } = db.run(
    `INSERT INTO media (filename, original_name, mime, size_bytes, alt, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      finalName,
      path.basename(file.originalname || 'upload').slice(0, 160),
      sniffed.mime,
      file.size,
      String(alt).slice(0, 300),
      req.user?.id || null,
    ],
  );
  return { id: lastInsertRowid, url: `/media/${finalName}`, mime: sniffed.mime, size: file.size };
}

function list({ limit = 60, offset = 0 } = {}) {
  const rows = db.all(
    `SELECT m.*, u.name AS uploader FROM media m LEFT JOIN users u ON u.id = m.uploaded_by
      ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows.map((r) => ({ ...r, url: `/media/${r.filename}` }));
}

function count() {
  return db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM media`) || { n: 0, bytes: 0 };
}

function findById(id) {
  return db.get(`SELECT * FROM media WHERE id = ?`, [id]);
}

function remove(id) {
  const row = findById(id);
  if (!row) return false;
  const target = path.join(config.paths.uploads, path.basename(row.filename));
  if (target.startsWith(config.paths.uploads) && fs.existsSync(target)) fs.unlinkSync(target);
  db.run(`DELETE FROM media WHERE id = ?`, [id]);
  return true;
}

/** Resolve an upload to a public URL (used by the article editor). */
function publicUrl(filename) {
  const safe = path.basename(String(filename || ''));
  return safe ? `/media/${safe}` : '';
}

/** Read the bytes for the media route (kept outside the static web root). */
function readSafe(filename) {
  const safe = path.basename(String(filename || ''));
  const target = path.resolve(config.paths.uploads, safe);
  if (!target.startsWith(path.resolve(config.paths.uploads) + path.sep)) return null;
  if (!fs.existsSync(target)) return null;
  return { path: target, stat: fs.statSync(target) };
}

module.exports = { upload, finalise, list, count, findById, remove, publicUrl, readSafe, safeUrl, sniff };
