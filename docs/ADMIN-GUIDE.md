# Admin Guide

The newsroom control panel at `/admin`. Sign in with the seeded account, then change the
password immediately.

---

## Signing in

```bash
# Set these before first boot; they are used once to create the account.
ADMIN_EMAIL=editor@yourdomain.com ADMIN_PASSWORD='ChangeMe#2026' npm start
```

Or create an account later:

```bash
npm run admin:create
```

The login page is `/admin/login`. Unauthenticated visitors are redirected there; the whole
panel is `noindex`.

**Two-factor authentication.** `/admin/account` → enable 2FA. Scan the QR code with any TOTP
app (Google Authenticator, Authy, 1Password). Set `REQUIRE_2FA_FOR_ADMINS=1` to make it
mandatory for `superadmin` and `editor` roles.

---

## Roles and permissions

| Role | Can do |
| --- | --- |
| `superadmin` | Everything, including users, settings and security |
| `editor` | Publish and edit anyone's articles, moderate comments, manage ticker and polls |
| `reporter` | Create and edit **their own** articles only |
| `ad_manager` | Campaigns and newsletter; no editorial access |
| `viewer` | Read-only analytics |

Permissions are defined in `config.roles` and enforced server-side on every route by
`requirePermission()`. A `reporter` who requests `/admin/users` is refused — not hidden with
CSS, actually refused.

Two guards you cannot override, because they exist to stop you locking yourself out:

- You cannot demote or suspend **your own** account.
- The last `superadmin` cannot be deleted.

---

## Publishing an article

`/admin/articles/new`

1. **Bangla title** is required; the English title is optional and used for the `en` locale.
2. **Body.** The editor accepts HTML. On save it passes through an allowlist sanitiser —
   `<script>`, `<iframe>`, `<object>`, `<embed>`, event handlers and `javascript:` URLs are
   stripped silently. Paste from Word and the markup comes out clean.
3. **Excerpt** drives the card on listing pages and the meta description. If left empty it is
   derived from the body.
4. **Category** and **author.** Author is optional; without one the article shows no byline.
5. **Tags**, comma-separated. They become `/tag/:slug` archive pages.
6. **Cover image.** Upload through the media library first, or paste a URL.
7. **Media type.** `article`, `video` (YouTube/Vimeo/Facebook/Dailymotion link) or `gallery`
   (JSON array of image URLs).
8. **Breaking** puts it in the ticker. **Featured** puts it on the home hero. **Sponsored**
   adds a visible sponsor label — use it, do not hide paid content.
9. **SEO** title, description, canonical URL and `noindex`.
10. **Status.** `draft` is invisible everywhere including the sitemap and feed. `published`
    goes live immediately — there is no cache to wait for.

Reading time and the slug are computed for you. The slug keeps Bangla characters, so URLs
stay readable: `/news/বাজেট-২০২৬-নতুন-কর-প্রস্তাব`.

---

## Corrections

Corrections are a first-class editorial record, never a silent edit.

On any article's edit page there is a **corrections panel**, deliberately outside the main
form so saving the article does not accidentally save a correction.

- Write what was wrong and what the correct information is.
- The original text stays in the article body — mark it up yourself if you want a
  strikethrough.
- The correction appears on the article page under the byline and is collected at
  `/corrections`.

A correction cannot be saved with an empty note.

---

## Breaking news ticker

`/admin/ticker`

Add a one-line item, set a priority, and it appears on every page within seconds — the client
polls `/api/ticker` (served `no-store`), so no deploy is needed. Toggle items on and off, or
delete them. Articles flagged **breaking** appear in the same ticker automatically.

---

## Comments

`/admin/comments`

New comments are `pending` by default (`comments_moderation` setting). Approve, mark spam, or
delete. Comment bodies are **text only** — all markup is stripped on save, so a comment can
never inject HTML.

Submissions come with a hashed IP, country and user agent to help spot spam waves. The
public form has a honeypot field named `website`; bots fill it and their submission is
silently discarded.

---

## Advertising

`/admin/ads`

Create a campaign, pick a slot, set targeting (device, country, category, dates), a daily cap,
priority and weight. `priority` decides who wins; `weight` splits inventory fairly between
campaigns of equal priority.

**Script creatives are restricted.** Only these hosts are allowed:

- `pagead2.googlesyndication.com`
- `tpc.googlesyndication.com`
- `cdn.ampproject.org`

Anything else is refused when you try to save it. If you have a legitimate new ad partner,
add the host to `config.ads.scriptAllowlist` in code — not through the panel.

---

## Analytics

`/admin/analytics` — 7 / 30 / 90 / 180 day windows:

- Pageviews, unique visitors, returning visitors
- **Country** breakdown (needs `GEO_MMDB_PATH` for city-level detail)
- **Device** breakdown — desktop, mobile, tablet
- Browser and operating system
- Referrer sources (Google, Facebook, YouTube, WhatsApp, …)
- Top pages, search terms readers actually used
- The raw event log

The dashboard (`/admin`) adds content counts, moderation queue depth, subscriber totals, AI
assistant usage, and **ad impressions and clicks per campaign, slot and country**. It polls
`/admin/api/overview` every 30 seconds.

> Analytics is entirely first-party. No third-party script runs on the site for it, so no
> consent banner is required.

---

## Newsletter

`/admin/newsletter`

Subscribers are double opt-in: they receive a confirmation link, and nothing is sent until
they click it. Unsubscribe links carry a per-subscriber token, so nobody can unsubscribe
anyone else.

Compose a campaign, choose a segment, preview, then send. In development the mail transport
logs to the console — wire a real provider (SES, Postmark, Resend) in `src/services/newsletter.js`.

---

## Security log

`/admin/security`

Everything the in-app WAF saw: login failures, CSRF rejections, CSP violations, scanner
probes, TOTP failures. Block an IP from here; unblock it the same way. Blocks take effect
immediately — the list is checked before any other middleware does work.

---

## Settings

`/admin/settings`

Site identity, contact details, social links, ticker speed, comment moderation, analytics
retention, AI assistant toggle and greeting, and the live TV stream URL.

**Backups** are taken from this page. A snapshot is written to `backups/`, checksummed with
SHA-256, and the directory is pruned to the most recent 14. From the command line:

```bash
npm run backup
```

---

## Media library

`/admin/media`

Uploads are validated by extension, MIME type **and** magic bytes. Filenames are replaced with
random values and files are stored outside the web root, served through `/media/:filename`.
Executables are rejected.

---

## Daily routine

1. Check `/admin` — moderation queue depth, overnight traffic, any security events.
2. Clear the comment queue.
3. Push anything genuinely urgent to the ticker.
4. Review `/admin/analytics` search terms — that is your story-ideas list.
5. Once a week, review `/admin/security` and take a backup.
