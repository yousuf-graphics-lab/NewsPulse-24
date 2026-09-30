'use strict';
/** Idempotent: seeds categories, authors, demo stories, pages, ads, poll and the first admin. */
const db = require('../src/db');
const seed = require('../src/db/seed');

db.migrate();
const out = seed.ensureSeedData();
console.log('[db:seed]', JSON.stringify({
  categories: out.categories,
  articlesCreated: out.articles,
  pages: out.pages,
  ticker: out.ticker,
  polls: out.polls,
  demoAds: out.ads,
}, null, 2));
if (out.admin) console.log(`[db:seed] admin → ${out.admin.email} / ${out.admin.password}`);
db.close();
