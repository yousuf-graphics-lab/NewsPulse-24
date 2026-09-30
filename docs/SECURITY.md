# Security

Every control described here is implemented in the code and covered by a test in
`tests/security.test.js`. If a test fails, this document is wrong too.

```bash
npm test          # 98 tests, including 20 security-specific ones
```

---

## Threat model

| Threat | Control | Verified by |
| --- | --- | --- |
| Cross-site scripting (stored, in article HTML) | Allowlist sanitiser on save | `a malicious article body is sanitised on save` |
| Cross-site request forgery | Signed synchroniser token + Origin check | 3 CSRF tests |
| Third-party ad creative escaping its slot | Sandboxed iframe without `allow-same-origin` | `the ad slot iframe never grants same-origin access` |
| Malicious script creative | Host allowlist at save **and** at render | `a script creative from a non-allowlisted host is refused` |
| SQL injection | 100% parameterised queries | injection tests + a source audit |
| Session hijacking / fixation | Signed DB sessions, HttpOnly, idle + absolute expiry | `a session cookie with a tampered signature is rejected` |
| Credential stuffing | bcrypt + lockout + rate limit | `repeated failed logins are rate limited` |
| User enumeration | Identical response for unknown-user and wrong-password | `a wrong password is rejected and does not reveal which half was wrong` |
| Scanner / vulnerability probing | Blocklist + scanner filter + tiered rate limits | `common scanner paths are refused` |
| Upload of executable content | Extension + MIME + magic-byte validation | `an upload outside the allowed types is refused` |
| IP-address retention (privacy) | HMAC hash only, never the address | `raw visitor IPs are never stored` |
| Admin takeover | RBAC + TOTP 2FA + audit log + self-demotion guard | `an admin cannot lock themselves out…` |
| Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | `security headers are present on every response` |
| Information disclosure | Generic error pages, no stack traces in production | `unknown routes 404 without leaking a stack trace` |

---

## HTTP headers

Observed on every response:

```
Content-Security-Policy: default-src 'self'; base-uri 'self'; form-action 'self';
  frame-ancestors 'none'; object-src 'none'; script-src 'self' 'nonce-…'; …
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-site
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload   (production only)
```

`X-Powered-By` is removed. HSTS is off in development so `localhost` over HTTP still works.

### The CSP nonce

**helmet 8 does not generate nonces.** There is no `useNonces` option and no
`res.locals.cspNonce`. Directive functions are called with `(req, res)`.

`src/app.js` therefore generates the nonce itself, *before* helmet runs:

```js
app.use((req, res, next) => {
  res.locals.cspNonce = randomBytes(16).toString('base64');
  next();
});
app.use(security.securityHeaders());
```

and the directive reads it back:

```js
const nonce = (_req, res) => `'nonce-${res.locals.cspNonce}'`;
```

The templates print the same value, so header and markup cannot drift. Verify:

```bash
curl -sD - http://localhost:3000/ -o /tmp/b.html | grep -o "nonce-[A-Za-z0-9+/=]\{8,\}"
grep -o 'nonce="[^"]*"' /tmp/b.html | sort -u
```

Both must show the same value, and a second request must differ.

> **Why this mattered.** The original code wrote `(nonce) => \`'nonce-${nonce}'\``, so the
> first argument was `req` and the header said `'nonce-[object Object]'`. Every inline script
> was being blocked by our own CSP — including both JSON-LD structured-data blocks — and
> nothing visibly broke, because external scripts still load under `'self'`.

---

## CSRF

Signed synchroniser pattern (`src/middleware/csrf.js`):

1. Every visitor gets an httpOnly `np_csrfid` cookie with random bytes.
2. The token is `HMAC(csrfSecret, csrfId + ':' + sessionId)`, compared with
   `timingSafeEqual`.
3. Accepted from a `_csrf` body field, a `_csrf` query param, or an `X-CSRF-Token` header.
4. Requests carrying an `Origin` header that is not our own origin are rejected outright.

**The order is load-bearing.** Because the token includes the session id, the session must be
loaded *before* the token is verified:

```js
app.use(csrf.ensureCsrfId);
app.use(auth.loadSession);      // must come first
app.use(csrf.csrfProtect({ exempt: ['/csp-report'] }));
```

> Putting `csrfProtect` before `loadSession` made every logged-in form return 403, because the
> form's token was signed with a session id the verifier did not know about.

---

## Authentication and sessions

- Passwords hashed with **bcryptjs**. Rounds are configurable (`BCRYPT_ROUNDS`, default 12).
- Sessions live in the **database**, so a single device can be revoked from the admin panel.
- The cookie is `np_session=<id>.<HMAC(id, sessionSecret)>` — tampering invalidates it.
- Both **idle** and **absolute** expiry are enforced.
- `pruneSessions()` runs every 30 minutes.
- Login lockout after `LOGIN_MAX_ATTEMPTS` failures for `LOGIN_LOCK_MINUTES`.
- **TOTP 2FA** (RFC 6238, SHA-1, 30 s, 6 digits) implemented on `node:crypto` alone — no
  dependency. Enforced for `superadmin` and `editor` when `REQUIRE_2FA_FOR_ADMINS=1`.

An unknown email and a wrong password produce **identical** responses, and the bcrypt
comparison still runs for unknown users so the timing does not differ either.

---

## Injection

Every query uses bound parameters. Dynamic `WHERE` clauses are assembled from **hardcoded
literal fragments** with values pushed into a params array:

```js
if (status) { where.push('a.status = ?'); params.push(status); }
```

Two guards in the test suite keep it that way:

- `SQL interpolation is limited to reviewed, non-user-controlled fragments` — scans `src/`
  for `${` inside a SQL statement and fails on anything not explicitly reviewed.
- `every dynamic WHERE fragment is a literal, never an interpolated value`.

Live check:

```bash
curl -s "http://localhost:3000/search?q=%27%20OR%20%271%27%3D%271" | grep -ci "sqlite"   # -> 0
```

---

## XSS and the sanitiser

Article HTML passes through `sanitize-html` with a strict allowlist
(`src/services/content.js`). Comments are text-only — all markup is stripped.

Verified removed: `<script>`, `<iframe>`, `<object>`, `<embed>`, `on*` handlers,
`javascript:` and `data:` URLs.

The ad sandbox is the second layer: third-party `html` and `script` creatives never touch the
main document. They are served from `/ads/frame/:id` inside

```html
<iframe src="/ads/frame/…" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"></iframe>
```

No `allow-same-origin`, so the creative cannot read our cookies, our DOM, or our storage.
That frame sets its own `Content-Security-Policy: default-src 'none'; …` and re-checks any
script host against `config.ads.scriptAllowlist`. An off-allowlist creative is refused both
when saved and when served (HTTP 403).

---

## Uploads

`src/services/media.js` validates, in order: file extension against an allowlist, declared
MIME type, and the file's **magic bytes**. Filenames are replaced with random values, and
files are stored outside the web root, then served through `/media/:filename`.

A `.php` file with a PHP MIME type is rejected; nothing is written to the media table.

---

## Privacy

- **Raw visitor IPs are never stored.** Only `HMAC(ip, ipPepper)`.
- The admin security log shows a masked partial last octet (`…42`) for support queries.
- `analytics_events`, `comments` and `subscribers` have no `ip` column — asserted by test.
- Newsletter unsubscribe uses a per-subscriber token, so nobody can unsubscribe anyone else.
- Admin pages send `noindex, nofollow, noarchive` and `referrer: no-referrer`.

---

## Application-layer WAF

- `blocked_ips` is checked before any other work, and can be managed from
  `/admin/security`.
- A scanner filter 404s obvious probes (`/wp-admin`, `/phpmyadmin`, `/.env`) and records them
  in `security_events`.
- Tiered rate limits: `global`, `write`, `login` (strictest), `beacon` (loosest).
- CSP violations posted to `/csp-report` are stored and surfaced in the admin panel.
- Every state-changing admin action writes to `audit_log`.

---

## Production checklist

- [ ] `SESSION_SECRET`, `CSRF_SECRET`, `IP_HASH_PEPPER` set — the app refuses to boot without
      them when `NODE_ENV=production`.
- [ ] `ADMIN_PASSWORD` is not the seeded value; rotate it after first login.
- [ ] `REQUIRE_2FA_FOR_ADMINS=1`.
- [ ] TLS terminated at nginx with HSTS enabled (automatic in production).
- [ ] The app binds `127.0.0.1`; only nginx faces the internet.
- [ ] `npm audit --omit=dev` is clean or triaged.
- [ ] Nightly `scripts/backup.js`, and the restore has actually been rehearsed.
- [ ] `/.well-known/security.txt` lists a monitored mailbox.
- [ ] The `audit_log` and `security_events` tables are reviewed weekly.
