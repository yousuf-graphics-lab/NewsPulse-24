'use strict';

/**
 * Unit tests for the shared helpers — the pure functions every page depends on.
 * No server, no database.
 */

const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const {
  bnNumber, slugify, uniqueSlug, detectLang, replyLang, escapeHtml, safeUrl, embedUrl,
  stripTags, excerptFrom, csvToArray, arrayToCsv, ipTail, clamp, truncate,
  compactNumber, readingTime,
} = require('../src/utils/helpers');
const { toBanglish } = require('../src/services/ai');

test('bnNumber converts ASCII digits to Bangla digits and leaves other text alone', () => {
  assert.strictEqual(bnNumber(123), '১২৩');
  assert.strictEqual(bnNumber('2026'), '২০২৬');
  assert.strictEqual(bnNumber(0), '০');
  assert.strictEqual(bnNumber(null), '');
  assert.strictEqual(bnNumber('৭৮৯'), '৭৮৯', 'already-Bangla digits pass through');
  assert.strictEqual(bnNumber('abc 12'), 'abc ১২', 'only digits are rewritten');
});

test('compactNumber shortens large counts', () => {
  assert.strictEqual(compactNumber(0), '০');
  assert.match(compactNumber(1500), /^১/);
  assert.ok(compactNumber(2_500_000).length < 8, 'a 2.5M count stays short');
});

test('slugify keeps Bangla characters and strips unsafe ones', () => {
  const s = slugify('বাজেট ২০২৬: নতুন Tax Rules!');
  assert.match(s, /বাজেট/);
  assert.match(s, /২০২৬/);
  assert.doesNotMatch(s, /[!:\s]/, 'no punctuation or whitespace');
  assert.strictEqual(slugify('Hello World'), 'hello-world');
  // An empty slug would be unusable in a URL, so the function guarantees a
  // non-empty fallback instead. Uniqueness is uniqueSlug's job, not slugify's.
  assert.match(slugify('   '), /^n-[a-z0-9]+$/, 'whitespace-only input gets a fallback');
});

test('uniqueSlug disambiguates when a slug is already taken', () => {
  const taken = new Set(['বাজেট-২০২৬', 'বাজেট-২০২৬-2', 'বাজেট-২০২৬-3']);
  assert.strictEqual(uniqueSlug('বাজেট ২০২৬', (s) => taken.has(s)), 'বাজেট-২০২৬-4');
  assert.strictEqual(uniqueSlug('Fresh Title', () => false), 'fresh-title');
});

test('stripTags removes markup without decoding entities into markup', () => {
  assert.strictEqual(stripTags('<p>সংবাদ <b>শিরোনাম</b></p>'), 'সংবাদ শিরোনাম');
  assert.strictEqual(stripTags('<script>alert(1)</script>x').includes('<script'), false);
});

test('escapeHtml neutralises the five dangerous characters', () => {
  assert.strictEqual(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('excerptFrom truncates on a word boundary and appends an ellipsis', () => {
  const out = excerptFrom('<p>' + 'শব্দ '.repeat(80) + '</p>', 60);
  assert.ok(out.length <= 64, `excerpt is bounded (got ${out.length})`);
  assert.match(out, /…$/);
  assert.doesNotMatch(out, /</);
});

test('readingTime scales with Bangla word count', () => {
  assert.strictEqual(readingTime(''), 1, 'never zero minutes');
  assert.ok(readingTime('শব্দ '.repeat(900)) > 2);
});

test('detectLang identifies Bangla, English and Banglish', () => {
  assert.strictEqual(detectLang('আজকের আবহাওয়া কেমন?'), 'bn');
  assert.strictEqual(detectLang('What is the weather today?'), 'en');
  assert.strictEqual(detectLang('ajker abohawa kemon?'), 'bnlish');
});

test('replyLang mirrors the user and never downgrades Banglish to English', () => {
  assert.strictEqual(replyLang('আজকের আবহাওয়া কেমন?'), 'bn');
  assert.strictEqual(replyLang('ajker abohawa kemon?'), 'bnlish', 'Banglish stays Latin-script');
  assert.strictEqual(replyLang('What is the weather today?'), 'en');
  assert.strictEqual(replyLang('Quelle est la météo?'), 'en', 'unrecognised input falls back to English');
  assert.strictEqual(replyLang(''), 'en');
});

test('toBanglish transliterates Bangla script to Latin', () => {
  const out = toBanglish('সর্বশেষ সংবাদ');
  assert.doesNotMatch(out, /[\u0980-\u09FF]/, 'no Bangla codepoints remain');
  assert.match(out, /[a-z]/i);
  assert.strictEqual(toBanglish('plain english'), 'plain english', 'Latin text is untouched');
});

test('safeUrl accepts http(s), blocks javascript: and data: schemes', () => {
  assert.strictEqual(safeUrl('https://example.com/a'), 'https://example.com/a');
  assert.strictEqual(safeUrl('http://example.com'), 'http://example.com');
  assert.strictEqual(safeUrl('javascript:alert(1)'), '');
  assert.strictEqual(safeUrl('data:text/html,<script>'), '');
  assert.strictEqual(safeUrl(''), '');
});

test('safeUrl keeps site-relative paths but refuses look-alike off-site ones', () => {
  assert.strictEqual(safeUrl('/news/abc'), '/news/abc', 'relative allowed by default');
  assert.strictEqual(safeUrl('/news/abc', { allowRelative: false }), '', 'refused for embeds');
  // Both of these LOOK relative but browsers resolve them off-site, so they are
  // rejected rather than trusted as local paths (classic open-redirect tricks).
  assert.strictEqual(safeUrl('//evil.example.com'), '', 'protocol-relative refused');
  assert.strictEqual(safeUrl('/\\evil.example.com'), '', 'no backslash bypass');
  // An explicit absolute URL is of course fine.
  assert.strictEqual(safeUrl('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&c=2');
});

test('embedUrl normalises YouTube and Vimeo links into embed URLs', () => {
  // Privacy-enhanced host: no cookies are set on our readers by the player.
  assert.match(embedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  assert.match(embedUrl('https://youtu.be/dQw4w9WgXcQ'), /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  assert.match(embedUrl('https://vimeo.com/76979871'), /player\.vimeo\.com\/video\/76979871/);
  assert.strictEqual(embedUrl('https://evil.example.com/x'), '', 'unknown hosts are refused');
  assert.strictEqual(embedUrl(''), '');
});

test('csv helpers round-trip and ignore blanks', () => {
  assert.deepStrictEqual(csvToArray('a, b ,,c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(csvToArray(''), []);
  assert.deepStrictEqual(csvToArray(null), []);
  assert.strictEqual(arrayToCsv(['x', 'y']), 'x,y');
  assert.strictEqual(arrayToCsv([]), '');
});

test('ipTail keeps only a partial last octet, never a full address', () => {
  const t = ipTail('203.0.113.42');
  assert.ok(t.length <= 8, `tail is short (got ${JSON.stringify(t)})`);
  assert.strictEqual(t.includes('203.0.113.42'), false, 'full IP is not retained');
  assert.strictEqual(ipTail('not-an-ip'), '…', 'unparseable input gets a placeholder');
  assert.strictEqual(ipTail(''), '…', 'empty input is masked, not echoed');
  assert.strictEqual(ipTail('2001:db8::42').includes('2001:db8::42'), false, 'IPv6 is masked too');
});

test('clamp and truncate stay inside their bounds', () => {
  assert.strictEqual(clamp(150, 1, 100), 100);
  assert.strictEqual(clamp(-5, 1, 100), 1);
  assert.strictEqual(clamp(Number.NaN, 1, 100), 1, 'NaN falls back to the minimum');
  assert.strictEqual(truncate('abcdefghij', 4).length <= 5, true);
});
