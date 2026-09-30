'use strict';

/**
 * Input validation schemas (zod).
 *
 * Rule of the house: nothing reaches the database without passing a schema.
 * Every string is length-capped, every URL scheme-checked, every enum closed.
 */

const { z } = require('zod');
const config = require('../config');

const slugRe = /^[a-z0-9\u0980-\u09FF-]+$/;

/*
 * NOTE: `httpUrl` already carries `.default('')`. Do NOT chain `.optional()`
 * onto it — ZodOptional short-circuits on `undefined` before ZodDefault can
 * run, so the field would stay `undefined` and node:sqlite refuses to bind it.
 * Empty string means "not set" and is normalised to NULL at bind time.
 */
const httpUrl = z.string().trim().max(600).refine(
  (v) => v === '' || /^https?:\/\//i.test(v),
  { message: 'URL must start with http:// or https://' },
).default('');

const articleSchema = z.object({
  title_bn: z.string().trim().min(8, 'শিরোনাম কমপক্ষে ৮ অক্ষরের হতে হবে').max(300),
  title_en: z.string().trim().max(300).optional().default(''),
  slug: z.string().trim().max(140).regex(slugRe, 'স্লাগে শুধু ছোট হাতের অক্ষর, সংখ্যা, বাংলা অক্ষর ও ড্যাশ থাকতে পারবে').optional(),
  subtitle: z.string().trim().max(400).optional().default(''),
  excerpt: z.string().trim().max(600).optional().default(''),
  body_bn: z.string().min(20, 'সংবাদটি আরেকটু বিস্তারিত লিখুন').max(200_000),
  body_en: z.string().max(200_000).optional().default(''),
  cover_image: z.string().trim().max(600).optional().default(''),
  cover_caption: z.string().trim().max(300).optional().default(''),
  cover_credit: z.string().trim().max(120).optional().default(''),
  category_id: z.coerce.number().int().positive().optional().nullable(),
  author_id: z.coerce.number().int().positive().optional().nullable(),
  status: z.enum(['draft', 'pending', 'published', 'archived']).default('draft'),
  is_breaking: z.coerce.boolean().optional().default(false),
  is_featured: z.coerce.boolean().optional().default(false),
  is_sponsored: z.coerce.boolean().optional().default(false),
  sponsor_label: z.string().trim().max(60).optional().default(''),
  media_type: z.enum(['text', 'video', 'gallery', 'audio']).default('text'),
  video_url: httpUrl,
  gallery_json: z.string().max(50_000).optional().default(''),
  tags: z.string().trim().max(400).optional().default(''),
  source_name: z.string().trim().max(120).optional().default(''),
  source_url: httpUrl,
  seo_title: z.string().trim().max(120).optional().default(''),
  seo_desc: z.string().trim().max(220).optional().default(''),
  canonical_url: httpUrl,
  noindex: z.coerce.boolean().optional().default(false),
});

const adSchema = z.object({
  name: z.string().trim().min(2).max(120),
  advertiser: z.string().trim().max(120).optional().default(''),
  slot: z.enum(config.adSlots.map((s) => s.id)),
  kind: z.enum(['image', 'html', 'script', 'text', 'video']).default('image'),
  headline: z.string().trim().max(120).optional().default(''),
  body: z.string().trim().max(500).optional().default(''),
  cta: z.string().trim().max(40).optional().default(''),
  image_url: z.string().trim().max(600).optional().default(''),
  link_url: httpUrl,
  html: z.string().max(50_000).optional().default(''),
  script_src: httpUrl,
  video_url: httpUrl,
  target_devices: z.string().trim().max(60).optional().default(''),
  target_countries: z.string().trim().max(200).optional().default(''),
  target_categories: z.string().trim().max(400).optional().default(''),
  priority: z.coerce.number().int().min(1).max(1000).default(50),
  weight: z.coerce.number().int().min(1).max(10000).default(100),
  daily_cap: z.coerce.number().int().min(0).max(10_000_000).optional().default(0),
  starts_at: z.string().trim().max(40).optional().default(''),
  ends_at: z.string().trim().max(40).optional().default(''),
  status: z.enum(['active', 'paused', 'expired']).default('active'),
});

const userSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email('সঠিক ইমেইল দিন').max(160),
  password: z.string().min(config.auth.passwordMinLength, `পাসওয়ার্ড কমপক্ষে ${config.auth.passwordMinLength} অক্ষর`).max(200).optional(),
  role: z.enum(Object.keys(config.roles)),
  status: z.enum(['active', 'suspended', 'invited']).default('active'),
  designation: z.string().trim().max(120).optional().default(''),
  bio: z.string().trim().max(1000).optional().default(''),
});

const commentSchema = z.object({
  article_id: z.coerce.number().int().positive(),
  parent_id: z.coerce.number().int().positive().optional().nullable(),
  name: z.string().trim().min(2, 'নাম লিখুন').max(60),
  email: z.string().trim().max(160).optional().default(''),
  body: z.string().trim().min(3, 'মন্তব্য লিখুন').max(1500),
  website: z.string().max(200).optional().default(''), // honeypot: must stay empty
});

const newsletterSchema = z.object({
  email: z.string().trim().email('সঠিক ইমেইল দিন').max(160),
  lang: z.enum(['bn', 'en']).default('bn'),
});

const pageSchema = z.object({
  slug: z.string().trim().max(80).regex(slugRe),
  title_bn: z.string().trim().min(2).max(160),
  title_en: z.string().trim().max(160).optional().default(''),
  body_bn: z.string().max(100_000).default(''),
  body_en: z.string().max(100_000).optional().default(''),
});

const pollSchema = z.object({
  question_bn: z.string().trim().min(5).max(200),
  question_en: z.string().trim().max(200).optional().default(''),
  options: z.string().min(2).max(2000),
  active: z.coerce.boolean().default(true),
});

const tickerSchema = z.object({
  text_bn: z.string().trim().min(4).max(200),
  text_en: z.string().trim().max(200).optional().default(''),
  article_id: z.coerce.number().int().positive().optional().nullable(),
  priority: z.coerce.number().int().min(1).max(999).default(50),
  active: z.coerce.boolean().default(true),
  starts_at: z.string().max(40).optional().default(''),
  ends_at: z.string().max(40).optional().default(''),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(160),
  password: z.string().min(1).max(200),
  token: z.string().trim().max(10).optional().default(''),
});

const searchSchema = z.object({
  q: z.string().trim().min(1).max(120),
  page: z.coerce.number().int().min(1).max(500).default(1),
  category: z.string().trim().max(60).optional().default(''),
});

/**
 * Express helper: validate, or stop the request with a useful reply.
 *
 * IMPORTANT: on failure this middleware must TERMINATE the request. Calling
 * `next()` would let the route handler run with `req.validated === undefined`,
 * which turns a bad form into a 500. HTML form posts are redirected back to
 * the page they came from with the first error in the query string; anything
 * else gets a JSON 400 with field-level detail.
 */
function validate(schema, source = 'body', opts = {}) {
  return (req, res, next) => {
    const result = schema.safeParse(req[source] || {});
    if (result.success) {
      req.validated = result.data;
      return next();
    }

    const errors = result.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    req.flashErrors = errors;
    req.flashValues = req[source];

    if (opts.redirect && req.accepts('html')) {
      const message = `${errors[0].field}: ${errors[0].message}`;
      const target = new URL(opts.redirect, 'http://internal');
      target.searchParams.set('err', message);
      return res.redirect(target.pathname + target.search);
    }
    if (req.accepts('html')) return res.status(400).send('validation_failed');
    return res.status(400).json({ ok: false, error: 'validation_failed', errors });
  };
}

module.exports = {
  z, validate, articleSchema, adSchema, userSchema, commentSchema,
  newsletterSchema, pageSchema, pollSchema, tickerSchema, loginSchema, searchSchema,
};
