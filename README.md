# নিউজপালস ২৪ · NewsPulse 24

A production-grade news portal for a Bangladeshi television news channel: Bangla-first
publishing, a breaking-news ticker, a twelve-slot advertising engine, an admin newsroom,
and a trilingual AI assistant (বাংলা / English / Banglish) docked in the bottom-right corner.

Built with **Node 22 + Express 4 + EJS + `node:sqlite`**. Server-rendered, no build step,
no frontend framework, no native dependencies.

```bash
npm install
npm run db:init          # migrate + seed demo content
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='ChangeMe#2026' npm start
```

Then open `http://localhost:3000` and `/admin`.

---

## What is in the box

| Area | Detail |
| --- | --- |
| **Reader site** | Home, category, article, author, tag, search, live TV, static pages, corrections, advertise |
| **Breaking news** | Ticker across the top, hot off `/api/ticker`, plus most-read and trending rails |
| **Advertising** | 12 declared slots, targeting by slot/device/country/category/date, daily caps, impression & click beacons, `ads.txt` |
| **AI assistant** | Bottom-right launcher; reads and writes বাংলা, English and Banglish; streams over SSE; works with no API key via a built-in local engine |
| **Admin panel** | 17 sections: articles, media, comments, ads, newsletter, users, analytics, security, settings, pages, ticker, polls, assistant, account |
| **Analytics** | Pageviews, uniques, retention, geo, device, browser, referrer, search terms, ad impressions |
| **Security** | Nonce CSP, CSRF, bcrypt, signed DB sessions, RBAC, TOTP 2FA, in-app WAF, sanitised HTML, upload validation, audit log |
| **Editorial integrity** | Corrections table surfaced on the article page and at `/corrections`; demo content is labelled as demo |

## The nine requested features

1. **Breaking News Ticker** — `src/views/partials/header.ejs`, fed by `content-repo.breakingTicker()` and polled at `/api/ticker`.
2. **Fast page loading** — server-rendered HTML, no framework, no build step, gzip, lazy images/iframes, cache-busted static assets.
3. **Clear navigation** — sticky navbar, mega-category bar, breadcrumbs, paginated archives, Bangla-aware URLs.
4. **Multimedia** — YouTube/Vimeo/Facebook/Dailymotion embeds (privacy-enhanced host), image galleries, live TV page, media library.
5. **Robust cybersecurity** — see [`docs/SECURITY.md`](docs/SECURITY.md); every claim is covered by `tests/security.test.js`.
6. **Social & newsletter** — share buttons, follow links, double-opt-in newsletter with per-subscriber unsubscribe tokens.
7. **Corrections & transparency** — `corrections` table, correction panel in the editor, public `/corrections` page.
8. **Balanced ad placement** — slots are declared in code, labelled "বিজ্ঞাপন", and third-party creatives are sandboxed. See [`docs/MONETIZATION.md`](docs/MONETIZATION.md).
9. **User engagement** — comments (moderated, honeypot-protected), reactions, polls, search, newsletter, AI assistant.

## Documentation

| File | Contents |
| --- | --- |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | How this was built, phase by phase, with the exact AI prompts used |
| [`docs/PROMPTS.md`](docs/PROMPTS.md) | The full copy-paste prompt library |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, every control, and how to verify it |
| [`docs/ADMIN-GUIDE.md`](docs/ADMIN-GUIDE.md) | Day-to-day newsroom operations |
| [`docs/MONETIZATION.md`](docs/MONETIZATION.md) | Ad slots, targeting, rates, AdSense setup |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | nginx, PM2, TLS, backups, scaling |

## Project layout

```
src/
  app.js              middleware order — reordering silently removes a protection
  server.js           boot, Slowloris timeouts, graceful shutdown
  config.js           frozen env config, roles, ad slots, categories
  db/                 schema.sql (25 tables), node:sqlite wrapper, seed data
  middleware/         security, csrf, auth, analytics, error
  services/           content, ads, ai, trending, geo, newsletter, media, totp
  routes/             public.js, admin.js, assist.js
  views/              EJS templates (10 public pages + 1 error page, 21 admin views)
  public/             css, js, icons — hand-written, no bundler
scripts/              db-init, db-seed, create-admin, backup, make-icons
tests/                98 tests — run with `npm test`
docs/                 the documentation above
```

## Configuration

Copy `.env.example` to `.env`. In development, missing secrets are auto-generated into
`data/`. **In production a missing secret is fatal** — an app that silently falls back to a
known key is already compromised.

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST`, `PUBLIC_URL` | Listening address and canonical origin |
| `SESSION_SECRET`, `CSRF_SECRET`, `IP_HASH_PEPPER` | Required in production |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Seed account, created on first boot only |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` | `none` (local engine), `openai`, `groq`, `gemini`, `openrouter`, `custom` |
| `REQUIRE_2FA_FOR_ADMINS` | Force TOTP for `superadmin` / `editor` |
| `GEO_MMDB_PATH` | Optional MaxMind DB for city-level geo |

## Tests

```bash
npm test          # 98 tests: utils, public site, security, admin
```

Each test file boots the real Express app against a throwaway database, so the suite
exercises the actual routes, templates and middleware — not mocks.

## Switching to PostgreSQL

`src/db/index.js` is the only file that touches the database driver. Implement its eight
exports (`connect`, `migrate`, `all`, `get`, `run`, `tx`, `backup`, `close`) against `pg`
and the rest of the application is unchanged. Every query is already parameterised.

## License

MIT — see [LICENSE](LICENSE).
