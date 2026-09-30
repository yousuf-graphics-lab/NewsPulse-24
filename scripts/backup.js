'use strict';

/**
 * Hot backup.
 *
 * `node:sqlite.backup()` produces a consistent snapshot even while the server
 * is writing, so this is safe to run from cron while the site is live:
 *
 *   0 3 * * *  cd /var/www/NewsPulse-24 && npm run backup >> /var/log/np24-backup.log 2>&1
 *
 * Also copies uploaded media, because the database alone is not a backup.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../src/db');
const config = require('../src/config');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(config.paths.backups, `newspulse24-${stamp}.db`);

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    count += 1;
  }
  return count;
}

function main() {
  db.migrate();
  db.backup(dest);

  const mediaDir = path.join(config.paths.backups, `media-${stamp}`);
  const mediaCount = copyDir(config.paths.uploads, mediaDir);

  const hash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex').slice(0, 16);
  const sizeMb = (fs.statSync(dest).size / 1048576).toFixed(2);

  console.log(JSON.stringify({
    ok: true,
    database: path.basename(dest),
    sizeMb: Number(sizeMb),
    sha256: hash,
    mediaFiles: mediaCount,
    at: new Date().toISOString(),
  }, null, 2));

  // Keep the newest 14 snapshots so cron never fills the disk.
  const keep = 14;
  const snapshots = fs.readdirSync(config.paths.backups)
    .filter((f) => /^newspulse24-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const old of snapshots) {
    fs.rmSync(path.join(config.paths.backups, old), { force: true });
    const media = path.join(config.paths.backups, old.replace('.db', '').replace('newspulse24-', 'media-'));
    fs.rmSync(media, { recursive: true, force: true });
  }
  if (snapshots.length) console.log(`[backup] pruned ${snapshots.length} old snapshot(s)`);

  db.close();
}

main();
