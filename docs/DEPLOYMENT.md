# Deployment

A single Node process behind nginx, supervised by PM2. No containers required, though the
included config works fine in one.

---

## Requirements

- Node **22** or newer (the app uses `node:sqlite`).
- 1 vCPU / 1 GB RAM is enough to start; 2 vCPU / 2 GB is comfortable.
- nginx with TLS (Let's Encrypt is fine).
- A directory that survives restarts for `data/`, `storage/uploads/` and `backups/`.

---

## First deploy

```bash
git clone <your-repo> /var/www/newspulse24
cd /var/www/newspulse24
npm ci --omit=dev

cp .env.example .env
# Edit .env. In production a missing secret is FATAL — that is deliberate.
```

Required in production:

```ini
NODE_ENV=production
PORT=3000
HOST=127.0.0.1          # nginx faces the internet, not the app
PUBLIC_URL=https://news.yourdomain.com

SESSION_SECRET=<64 random bytes, base64>
CSRF_SECRET=<64 random bytes, base64>
IP_HASH_PEPPER=<64 random bytes, base64>

ADMIN_EMAIL=editor@yourdomain.com
ADMIN_PASSWORD=<strong, unique, rotate after first login>
REQUIRE_2FA_FOR_ADMINS=1
```

Generate the secrets:

```bash
node -e "for (const n of ['SESSION','CSRF','IP']) console.log(n, require('crypto').randomBytes(48).toString('base64url'))"
```

Then migrate, seed and start:

```bash
npm run db:init
npx pm2 start deploy/ecosystem.config.js
npx pm2 save && npx pm2 startup
```

---

## nginx

`deploy/nginx.conf` in this repository. The parts that matter:

- **TLS with HTTP/2**, HTTP→HTTPS redirect, HSTS.
- **Gzip** for text assets; the app also compresses, so nginx is the outer layer.
- **Long cache headers for `/assets/`**, which are versioned by query string
  (`/assets/css/site.css?v=1.0.0`) so a deploy invalidates them.
- **`no-store` for `/api/` and `/ads/frame/`** — the ticker and ad frames must never be
  cached, or an editor's breaking news will not appear.
- **A second rate-limit zone** in front of the app's own limiter, for `/admin/login` and the
  comment/newsletter endpoints.
- **`client_max_body_size`** sized for image uploads (default 8 MB, matching
  `UPLOAD_MAX_MB`).
- The app is proxied on `127.0.0.1`; it is not reachable from outside.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/newspulse24
sudo ln -s /etc/nginx/sites-available/newspulse24 /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d news.yourdomain.com
```

---

## PM2

`deploy/ecosystem.config.js` runs two workers in cluster mode with log rotation.

```bash
npx pm2 status
npx pm2 logs newspulse24
npx pm2 reload newspulse24      # zero-downtime reload after a deploy
```

The app also handles `SIGTERM` gracefully: it flushes the analytics buffer, closes the
database, then exits. PM2's default restart-on-crash plus `pm2 startup` covers the rest.

> Do not scale to more than one machine without moving off SQLite. See below.

---

## Deploying an update

```bash
cd /var/www/newspulse24
git pull
npm ci --omit=dev
npm run db:init                 # migrations are idempotent
npx pm2 reload newspulse24
curl -s https://news.yourdomain.com/healthz
```

`/healthz` returns 200 with a JSON status; use it as your load-balancer or uptime check.

---

## Backups

`scripts/backup.js` snapshots the database, copies uploaded media, writes a SHA-256
checksum, and prunes to the most recent 14.

```bash
npm run backup
```

Cron it nightly:

```cron
15 3 * * *  cd /var/www/newspulse24 && /usr/bin/node scripts/backup.js >> /var/log/np24-backup.log 2>&1
```

Then copy `backups/` **off the machine**. A backup on the same disk as the database is not a
backup.

**Rehearse the restore.** Once a quarter:

```bash
systemctl stop newspulse24        # or: pm2 stop newspulse24
cp backups/<snapshot>.db data/newspulse24.db
sha256sum -c backups/<snapshot>.db.sha256
pm2 start newspulse24
```

A backup that has never been restored is a rumour.

---

## Scaling past one box

SQLite is the right choice for a single-node news site: no server to operate, no connection
pool to tune, and reads are very fast. It stops being right when you need more than one app
process writing concurrently.

To move to PostgreSQL, reimplement the eight exports of `src/db/index.js`
(`connect`, `migrate`, `all`, `get`, `run`, `tx`, `backup`, `close`) against `pg`. Every query
in the codebase is already parameterised, and `src/db/index.js` is the only file that touches
the driver — nothing else changes.

Things to convert: `strftime` → `to_char`, `ON CONFLICT` syntax differences, `AUTOINCREMENT`
→ `SERIAL`/`IDENTITY`, `typeof()` → `pg_typeof()`, and booleans stored as integers.

Also move `storage/uploads/` to object storage (S3, R2, Backblaze) and put a CDN in front of
`/assets/` and `/media/`.

---

## Performance notes

- The site is server-rendered with no build step, so there is no bundle to optimise. Home
  page HTML is ~65 KB before gzip, considerably less after.
- `compression` is at level 6 with a 1 KB threshold; SSE responses are excluded so the
  assistant stream is not buffered.
- Analytics writes are buffered in memory and flushed every 2 seconds or every 50 rows, so a
  traffic spike cannot become 500 writes per second.
- Images and ad iframes are `loading="lazy"`.
- Static assets are served with `immutable` cache headers and a version query string.

Check the real numbers rather than trusting this file:

```bash
curl -s -o /dev/null -w "ttfb %{time_starttransfer}s  total %{time_total}s  size %{size_download}B\n" \
  https://news.yourdomain.com/
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| App refuses to boot in production | A required secret is missing | Set it in `.env`; the error names the variable |
| Every admin form returns 403 | Session middleware running after CSRF | Check the order in `src/app.js` step 10 |
| Inline scripts blocked in the browser | CSP nonce mismatch | Confirm the header nonce equals the `nonce="…"` attribute |
| Ticker does not update | `/api/ticker` being cached | It must be `no-store`; check nginx |
| `ExperimentalWarning` noise | `node:sqlite` is experimental on Node 22 | The npm scripts already pass `--disable-warning` |
| Uploads rejected | Magic bytes did not match the extension | Correct file, not a renamed one |
| Ad creative not rendering | Script host not on the allowlist | Add it to `config.ads.scriptAllowlist` in code |
