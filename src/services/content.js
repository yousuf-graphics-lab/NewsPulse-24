'use strict';

/**
 * Content safety + site settings.
 *
 * Article HTML is authored by authenticated staff, but "trusted" is not
 * "sanitised": an account takeover or a sloppy paste must not be able to plant
 * a script tag that runs on every reader's browser. Everything that reaches
 * the database passes through an explicit allowlist.
 */

const sanitizeHtml = require('sanitize-html');
const db = require('../db');
const { safeUrl } = require('../utils/helpers');

const ARTICLE_TAGS = [
  'p', 'br', 'hr', 'h2', 'h3', 'h4', 'h5', 'strong', 'b', 'em', 'i', 'u', 's',
  'blockquote', 'ul', 'ol', 'li', 'a', 'figure', 'figcaption', 'img', 'span',
  'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'iframe', 'div',
  'mark', 'sup', 'sub',
];

const ALLOWED_IFRAME_HOSTS = [
  'www.youtube-nocookie.com', 'www.youtube.com', 'player.vimeo.com',
  'www.facebook.com', 'www.dailymotion.com',
];

function sanitizeArticleHtml(dirty) {
  return sanitizeHtml(String(dirty || ''), {
    allowedTags: ARTICLE_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'loading', 'width', 'height'],
      iframe: ['src', 'title', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'loading'],
      span: ['class'],
      div: ['class'],
      p: ['class'],
      blockquote: ['class', 'cite'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
      h2: ['id'], h3: ['id'], h4: ['id'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
    exclusiveFilter: (frame) => frame.tag === 'iframe' && !ALLOWED_IFRAME_HOSTS.some((h) => frame.attribs.src?.includes(h)),
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          href: safeUrl(attribs.href, { allowRelative: true }),
          rel: 'nofollow noopener noreferrer',
          target: attribs.target === '_blank' ? '_blank' : undefined,
        },
      }),
      img: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, src: safeUrl(attribs.src), loading: 'lazy', decoding: 'async' },
      }),
      iframe: (tagName, attribs) => ({
        tagName,
        attribs: {
          src: safeUrl(attribs.src, { allowRelative: false }),
          title: attribs.title || 'Embedded media',
          loading: 'lazy',
          allowfullscreen: attribs.allowfullscreen !== undefined ? 'allowfullscreen' : undefined,
          referrerpolicy: 'strict-origin-when-cross-origin',
        },
      }),
      '*': (tagName, attribs) => {
        const cleaned = { ...attribs };
        for (const key of Object.keys(cleaned)) {
          if (/^on/i.test(key)) delete cleaned[key];
          if (/^(style|srcdoc)$/i.test(key)) delete cleaned[key];
          if (typeof cleaned[key] === 'string' && /^\s*(javascript|vbscript|data:text\/html)/i.test(cleaned[key])) delete cleaned[key];
        }
        return { tagName, attribs: cleaned };
      },
    },
    disallowedTagsMode: 'discard',
  });
}

/** Comments are untrusted input from the open internet: text only. */
function sanitizeCommentText(dirty) {
  return sanitizeHtml(String(dirty || ''), {
    allowedTags: ['b', 'i', 'em', 'strong', 'br', 'a'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['https', 'http'],
    allowProtocolRelative: false,
  }).trim();
}

/* -------------------------------------------------------------- settings -- */

const DEFAULTS = {
  site_name_bn: 'নিউজপালস ২৪',
  site_name_en: 'NewsPulse 24',
  tagline_bn: 'সংবাদে নির্ভরযোগ্য, প্রযুক্তি',
  tagline_en: 'Reliable news, advanced technology',
  logo_text: 'NewsPulse 24',
  logo_sub: 'বাংলাদেশ',
  contact_email: 'news@newspulse24.com',
  contact_phone: '+880 1700-000000',
  address: 'লেভেল ৭, রূপায়ণ ট্রেড সেন্টার, ১১৪ কাজী নজরুল ইসলাম এভিনিউ, বাংলামোটর, ঢাকা ১০০০',
  facebook_url: 'https://facebook.com/newspulse24',
  twitter_url: 'https://x.com/newspulse24',
  youtube_url: 'https://youtube.com/@newspulse24',
  instagram_url: 'https://instagram.com/newspulse24',
  tiktok_url: '',
  whatsapp_channel: '',
  live_tv_url: 'https://www.youtube.com/embed/live_stream?channel=UCXXXXXXXX',
  ticker_speed: '45',
  ticker_enabled: '1',
  breaking_flash: '1',
  comments_enabled: '1',
  comments_moderation: '1',
  newsletter_enabled: '1',
  assistant_enabled: '1',
  assistant_greeting_bn: 'আসসালামু আলাইকুম! আমি নিউজপালস অ্যাসিস্ট। আজকের খবর, ট্রেন্ডিং বিষয় বা যেকোনো প্রশ্নে সাহায্য করতে পারি।',
  assistant_greeting_en: 'Assalamu Alaikum! I am the NewsPulse assistant. Ask me about today’s news, trending topics or anything else.',
  ga_measurement_id: '',
  adsense_publisher_id: '',
  footer_about_bn: 'নিউজপালস ২৪ বাংলাদেশের একটি নির্ভরযোগ্য ডিজিটাল সংবাদ মাধ্যম। আমরা সত্য, নিরপেক্ষ ও দায়বদ্ধ সাংবাদিকতায় বিশ্বাসী।',
  footer_about_en: 'NewsPulse 24 is a trusted digital newsroom from Bangladesh, committed to accurate, impartial and accountable journalism.',
  correction_policy_url: '/editorial-policy',
  maintenance_mode: '0',
};

let settingsCache = null;
let settingsLoadedAt = 0;

function getSettings(force = false) {
  if (!force && settingsCache && Date.now() - settingsLoadedAt < 15_000) return settingsCache;
  const map = { ...DEFAULTS };
  try {
    for (const row of db.all(`SELECT key, value FROM settings`)) {
      map[row.key] = row.value;
    }
  } catch { /* pre-migration */ }
  settingsCache = map;
  settingsLoadedAt = Date.now();
  return map;
}

function getSetting(key, fallback = null) {
  const value = getSettings()[key];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function setSetting(key, value) {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [String(key).slice(0, 64), value === null || value === undefined ? '' : String(value)],
  );
  settingsCache = null;
}

function setSettings(obj) {
  for (const [k, v] of Object.entries(obj || {})) setSetting(k, v);
}

module.exports = {
  sanitizeArticleHtml, sanitizeCommentText,
  getSettings, getSetting, setSetting, setSettings, DEFAULTS,
};
