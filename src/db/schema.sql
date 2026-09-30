/* ============================================================================
   NewsPulse 24 — SQLite schema
   Design notes
   - Every foreign key is declared and PRAGMA foreign_keys is ON at connect time.
   - Timestamps are stored as ISO-8601 TEXT (UTC) so they sort correctly and are
     readable in a terminal.
   - Raw visitor IPs are never stored. `ip_hash` holds HMAC(ip, server pepper),
     which is enough to count uniques without identifying a person.
   ========================================================================== */

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

/* ---------------------------------------------------------------- users --- */
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  email            TEXT    NOT NULL UNIQUE,
  password_hash    TEXT    NOT NULL,
  role             TEXT    NOT NULL DEFAULT 'reporter'
                   CHECK (role IN ('superadmin','editor','reporter','moderator','analyst')),
  status           TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','invited')),
  avatar_url       TEXT,
  bio              TEXT,
  designation      TEXT,
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until     TEXT,
  totp_secret      TEXT,
  two_factor_on    INTEGER NOT NULL DEFAULT 0,
  must_change_pw   INTEGER NOT NULL DEFAULT 0,
  last_login_at    TEXT,
  last_login_ip    TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));

/* ------------------------------------------------------------- sessions --- */
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,              /* opaque session id */
  token_hash   TEXT NOT NULL UNIQUE,          /* HMAC of the cookie value */
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_hash      TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

/* ----------------------------------------------------------- categories --- */
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name_bn     TEXT NOT NULL,
  name_en     TEXT NOT NULL,
  description TEXT,
  color       TEXT NOT NULL DEFAULT '#e11d2e',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  seo_title   TEXT,
  seo_desc    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

/* --------------------------------------------------------------- authors --- */
CREATE TABLE IF NOT EXISTS authors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  designation TEXT,
  bio         TEXT,
  avatar_url  TEXT,
  email       TEXT,
  facebook    TEXT,
  twitter     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

/* ------------------------------------------------------------- articles --- */
CREATE TABLE IF NOT EXISTS articles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  title_bn        TEXT NOT NULL,
  title_en        TEXT,
  subtitle        TEXT,
  body_bn         TEXT NOT NULL DEFAULT '',
  body_en         TEXT,
  excerpt         TEXT,
  cover_image     TEXT,
  cover_caption   TEXT,
  cover_credit    TEXT,
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  author_id       INTEGER REFERENCES authors(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','pending','published','archived')),
  is_breaking     INTEGER NOT NULL DEFAULT 0,
  is_featured     INTEGER NOT NULL DEFAULT 0,
  is_sponsored    INTEGER NOT NULL DEFAULT 0,
  sponsor_label   TEXT,
  media_type      TEXT NOT NULL DEFAULT 'text' CHECK (media_type IN ('text','video','gallery','audio')),
  video_url       TEXT,
  gallery_json    TEXT,
  tags            TEXT,                        /* comma separated, denormalised for speed */
  views           INTEGER NOT NULL DEFAULT 0,
  likes           INTEGER NOT NULL DEFAULT 0,
  comments_count  INTEGER NOT NULL DEFAULT 0,
  read_minutes    INTEGER NOT NULL DEFAULT 2,
  source_name     TEXT,
  source_url      TEXT,
  correction_of   INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  corrected_at    TEXT,
  correction_note TEXT,
  seo_title       TEXT,
  seo_desc        TEXT,
  canonical_url   TEXT,
  noindex         INTEGER NOT NULL DEFAULT 0,
  is_demo         INTEGER NOT NULL DEFAULT 0,  /* seeded placeholder content */
  published_at    TEXT,
  scheduled_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_articles_status_pub ON articles(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_category   ON articles(category_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_breaking   ON articles(is_breaking, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_views      ON articles(views DESC);
CREATE INDEX IF NOT EXISTS idx_articles_updated    ON articles(updated_at DESC);

/* Rolling daily view counter — powers "most read" without scanning events. */
CREATE TABLE IF NOT EXISTS article_stats_daily (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  day        TEXT    NOT NULL,
  views      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (article_id, day)
);
CREATE INDEX IF NOT EXISTS idx_stats_day ON article_stats_daily(day);

/* ---------------------------------------------------------- corrections --- */
CREATE TABLE IF NOT EXISTS corrections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id   INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'correction' CHECK (kind IN ('correction','clarification','update','retraction')),
  note         TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_corrections_article ON corrections(article_id);

/* ------------------------------------------------------------ breaking ---- */
CREATE TABLE IF NOT EXISTS ticker_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
  text_bn    TEXT NOT NULL,
  text_en    TEXT,
  priority   INTEGER NOT NULL DEFAULT 50,
  active     INTEGER NOT NULL DEFAULT 1,
  starts_at  TEXT,
  ends_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

/* ---------------------------------------------------------------- media --- */
CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL,             /* server-generated random name */
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  alt           TEXT,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at DESC);

/* ------------------------------------------------------------- comments --- */
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','spam','rejected')),
  likes       INTEGER NOT NULL DEFAULT 0,
  ip_hash     TEXT,
  country     TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id, status, created_at DESC);

/* ------------------------------------------------------------------ ads --- */
CREATE TABLE IF NOT EXISTS ads (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  advertiser        TEXT,
  slot              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'image'
                    CHECK (kind IN ('image','html','script','text','video')),
  headline          TEXT,
  body              TEXT,
  cta               TEXT,
  image_url         TEXT,
  link_url          TEXT,
  html              TEXT,
  script_src        TEXT,
  video_url         TEXT,
  target_devices    TEXT,                    /* csv: desktop,mobile,tablet */
  target_countries  TEXT,                    /* csv of ISO codes, empty = all */
  target_categories TEXT,                    /* csv of category slugs */
  impressions       INTEGER NOT NULL DEFAULT 0,
  clicks            INTEGER NOT NULL DEFAULT 0,
  daily_cap         INTEGER,
  served_today      INTEGER NOT NULL DEFAULT 0,
  cap_reset_day     TEXT,
  priority          INTEGER NOT NULL DEFAULT 50,
  weight            INTEGER NOT NULL DEFAULT 100,
  starts_at         TEXT,
  ends_at           TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','expired')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ads_slot ON ads(slot, status);

CREATE TABLE IF NOT EXISTS ad_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id      INTEGER REFERENCES ads(id) ON DELETE CASCADE,
  slot       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('impression','click')),
  ip_hash    TEXT,
  country    TEXT,
  device     TEXT,
  article_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ad_events_kind ON ad_events(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_events_ad   ON ad_events(ad_id, created_at);

/* ------------------------------------------------------------ newsletter --- */
CREATE TABLE IF NOT EXISTS subscribers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  lang           TEXT NOT NULL DEFAULT 'bn',
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','unsubscribed','bounced','pending')),
  country        TEXT,
  confirm_token  TEXT,
  unsubscribe_token TEXT,
  subscribed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unsubscribed_at TEXT
);

CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  preview     TEXT,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed')),
  recipients  INTEGER NOT NULL DEFAULT 0,
  opened      INTEGER NOT NULL DEFAULT 0,
  sent_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

/* -------------------------------------------------------------- analytics - */
CREATE TABLE IF NOT EXISTS analytics_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  day         TEXT NOT NULL,
  event_type  TEXT NOT NULL,          /* pageview | search | share | comment | subscribe | vote */
  path        TEXT,
  title       TEXT,
  article_id  INTEGER,
  category    TEXT,
  referrer    TEXT,
  source      TEXT,                   /* direct | google | facebook | youtube | other */
  country     TEXT,
  city        TEXT,
  device      TEXT,                   /* desktop | mobile | tablet | bot */
  browser     TEXT,
  os          TEXT,
  visitor_id  TEXT,                   /* random, cookie-based, not personal */
  ip_hash     TEXT,
  lang        TEXT,
  meta        TEXT
);
CREATE INDEX IF NOT EXISTS idx_an_day    ON analytics_events(day, event_type);
CREATE INDEX IF NOT EXISTS idx_an_path   ON analytics_events(path, ts DESC);
CREATE INDEX IF NOT EXISTS idx_an_geo    ON analytics_events(country, day);
CREATE INDEX IF NOT EXISTS idx_an_device ON analytics_events(device, day);
CREATE INDEX IF NOT EXISTS idx_an_source ON analytics_events(source, day);
CREATE INDEX IF NOT EXISTS idx_an_article ON analytics_events(article_id, day);

CREATE TABLE IF NOT EXISTS search_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  term   TEXT NOT NULL,
  hits   INTEGER NOT NULL DEFAULT 0,
  day    TEXT NOT NULL,
  country TEXT
);
CREATE INDEX IF NOT EXISTS idx_search_day ON search_log(day);

/* --------------------------------------------------------------- polling --- */
CREATE TABLE IF NOT EXISTS polls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_bn TEXT NOT NULL,
  question_en TEXT,
  options     TEXT NOT NULL,          /* JSON array of {id, bn, en, votes} */
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS poll_votes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id  TEXT NOT NULL,
  visitor_id TEXT,
  ip_hash    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (poll_id, visitor_id)
);

/* ------------------------------------------------------------ static pages - */
CREATE TABLE IF NOT EXISTS pages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  title_bn   TEXT NOT NULL,
  title_en   TEXT,
  body_bn    TEXT NOT NULL DEFAULT '',
  body_en    TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

/* -------------------------------------------------------- AI assistant ---- */
CREATE TABLE IF NOT EXISTS assistant_chats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  lang       TEXT,
  engine     TEXT,                    /* provider name or 'local' */
  model      TEXT,
  ip_hash    TEXT,
  visitor_id TEXT,
  ms         INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_id ON assistant_chats(chat_id, id);

/* ------------------------------------------------- security / governance --- */
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor      TEXT,
  action     TEXT NOT NULL,           /* e.g. article.publish */
  entity     TEXT,
  entity_id  TEXT,
  ip_hash    TEXT,
  user_agent TEXT,
  meta       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log(action);

CREATE TABLE IF NOT EXISTS security_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,           /* login_failed | rate_limited | csp_violation | csrf | upload_blocked ... */
  severity   TEXT NOT NULL DEFAULT 'low' CHECK (severity IN ('low','medium','high','critical')),
  ip_hash    TEXT,
  ip_last_octet TEXT,                 /* partial, for admin triage without exposing full IP */
  user_agent TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sec_created ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sec_kind    ON security_events(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS blocked_ips (
  ip         TEXT PRIMARY KEY,
  reason     TEXT,
  blocked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  blocked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT
);

/* ------------------------------------------------------------- settings --- */
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
