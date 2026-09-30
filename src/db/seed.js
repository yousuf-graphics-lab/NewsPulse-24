'use strict';

/**
 * Starter data.
 *
 * Idempotent: safe to run on every boot. Everything it writes is flagged
 * `is_demo = 1` so the reader-facing UI can label it and the editor can purge
 * it in one click. No seed story presents a fabricated fact as reporting —
 * each one opens by declaring that it is placeholder copy.
 */

const crypto = require('node:crypto');
const db = require('./index');
const config = require('../config');
const { slugify, readingTime } = require('../utils/helpers');
const { sanitizeArticleHtml } = require('../services/content');
const auth = require('../middleware/auth');

const DEMO_NOTE = '<p class="demo-note">⚠️ এটি নিউজপালস ২৪-এর <strong>নমুনা (ডেমো) কনটেন্ট</strong> — শুধু লেআউট ও ফিচার যাচাইয়ের জন্য। অ্যাডমিন প্যানেল থেকে নিজের সংবাদ প্রকাশ করলেই এটি বদলে যাবে।</p>';

const AUTHORS = [
  { name: 'রাহাত হোসেন', slug: 'rahat-hossain', designation: 'প্রধান প্রতিবেদক', bio: 'রাজনীতি ও জাতীয় বিষয়ে প্রায় এক দশক ধরে সংবাদ করছেন।' },
  { name: 'নুসরাত জাহান', slug: 'nusrat-jahan', designation: 'সিনিয়র করেসপন্ডেন্ট', bio: 'অর্থনীতি, বাণিজ্য ও প্রবাসী কল্যাণ নিয়ে লেখেন।' },
  { name: 'তানভীর আহমেদ', slug: 'tanvir-ahmed', designation: 'স্পোর্টস এডিটর', bio: 'ক্রিকেট ও ফুটবল কভার করেন, বিশ্বকাপ নিয়ে একাধিক বিশেষ প্রতিবেদন।' },
  { name: 'সাবরিনা আক্তার', slug: 'sabrina-akter', designation: 'প্রযুক্তি প্রতিবেদক', bio: 'সাইবার নিরাপত্তা, স্টার্টআপ ও কৃত্রিম বুদ্ধিমত্তা নিয়ে লেখেন।' },
];

const ARTICLES = [
  {
    cat: 'national', author: 0, breaking: true, featured: true, type: 'text',
    bn: 'শহরের যানজট কমাতে নতুন ট্রাফিক পরিকল্পনা ঘোষণার দাবি নাগরিকদের',
    en: 'Citizens press for a new traffic plan to ease city congestion',
    excerpt: 'রাজধানীর প্রধান সড়কগুলোতে সকাল ও সন্ধ্যার যানজট কমাতে সমন্বিত পরিকল্পনার দাবি জানিয়েছেন যাত্রী ও পরিবহন সংশ্লিষ্টরা।',
    body: `${DEMO_NOTE}
<p>রাজধানীর প্রধান সড়কগুলোতে প্রতিদিন সকাল ও সন্ধ্যায় দীর্ঘ যানজটের অভিযোগ দীর্ঘদিনের। যাত্রী, পরিবহন শ্রমিক ও নগর পরিকল্পনাবিদরা বলছেন, সমস্যার সমাধানে শুধু সড়ক বাড়ালেই হবে না — দরকার সমন্বিত পরিকল্পনা।</p>
<h3>প্রস্তাব যা উঠে এসেছে</h3>
<p>বিশেষজ্ঞরা তিনটি বিষয়ে জোর দিচ্ছেন: সিগনাল ব্যবস্থার আধুনিকায়ন, বাস রুট যুক্তিকরণ এবং ফুটপাত দখলমুক্ত রাখা। তাঁদের মতে, ছোট ছোট পদক্ষেপেও ভ্রমণ সময় উল্লেখযোগ্য কমানো সম্ভব।</p>
<blockquote>“যানজট শুধু সময় নষ্ট করে না, জ্বালানি ও স্বাস্থ্যের ওপরও চাপ ফেলে। সমাধানটি হতে হবে দীর্ঘমেয়াদি।”</blockquote>
<p>নগরবাসী আশা করছেন, আগামী বাজেটে এ খাতে সুনির্দিষ্ট বরাদ্দ ও বাস্তবায়নের সময়সীমা উল্লেখ থাকবে।</p>`,
    tags: 'যানজট,ঢাকা,নগর পরিকল্পনা',
  },
  {
    cat: 'national', author: 1, breaking: true, type: 'text',
    bn: 'দেশজুড়ে ভারী বৃষ্টির পূর্বাভাস, নিম্নাঞ্চলে সতর্কতা জারি',
    en: 'Heavy rain forecast nationwide, low-lying areas on alert',
    excerpt: 'আগামী ৪৮ ঘণ্টায় দেশের বেশিরভাগ অঞ্চলে মাঝারি থেকে ভারী বৃষ্টির সম্ভাবনা রয়েছে বলে জানিয়েছেন আবহাওয়া বিশেষজ্ঞরা।',
    body: `${DEMO_NOTE}
<p>মৌসুমি বায়ুর প্রভাবে আগামী ৪৮ ঘণ্টায় দেশের বেশিরভাগ অঞ্চলে মাঝারি থেকে ভারী বৃষ্টির সম্ভাবনা রয়েছে। নিম্নাঞ্চলের বাসিন্দাদের সতর্ক থাকতে বলা হয়েছে।</p>
<p>স্থানীয় প্রশাসনকে প্রস্তুত থাকতে বলা হয়েছে এবং প্রয়োজনে আশ্রয়কেন্দ্র খোলার নির্দেশনা দেওয়া হয়েছে। কৃষকদের পাকা ফসল দ্রুত তুলে আনার পরামর্শ দেওয়া হয়েছে।</p>
<p>জরুরি প্রয়োজনে হটলাইনে যোগাযোগের জন্য অনুরোধ জানানো হয়েছে।</p>`,
    tags: 'আবহাওয়া,বৃষ্টি,সতর্কতা',
  },
  {
    cat: 'politics', author: 0, featured: true, type: 'text',
    bn: 'সংসদ অধিবেশনে নতুন বিল উত্থাপন, কমিটিতে পাঠানো হয়েছে',
    en: 'New bill tabled in parliament, referred to committee',
    excerpt: 'দীর্ঘ আলোচনার পর বিলটি পরীক্ষা করে প্রতিবেদন দিতে সংশ্লিষ্ট সংসদীয় স্থায়ী কমিটিতে পাঠানো হয়েছে।',
    body: `${DEMO_NOTE}
<p>সংসদ অধিবেশনে একটি নতুন বিল উত্থাপন করা হয়েছে। উত্থাপনের পর বিভিন্ন দলের সদস্যরা নিজেদের মতামত তুলে ধরেন।</p>
<p>বিলটি পরীক্ষা করে নির্ধারিত সময়ের মধ্যে প্রতিবেদন দিতে সংসদীয় স্থায়ী কমিটিতে পাঠানো হয়েছে। কমিটি জনমত যাচাই করতে পারে বলে জানানো হয়েছে।</p>
<p>বিশ্লেষকদের মতে, বিলটির কিছু ধারা নিয়ে আলোচনা চলবে এবং চূড়ান্ত রূপ দিতে আরও কয়েক সপ্তাহ লাগতে পারে।</p>`,
    tags: 'সংসদ,আইন,রাজনীতি',
  },
  {
    cat: 'economy', author: 1, featured: true, type: 'text',
    bn: 'রপ্তানি আয়ে প্রবৃদ্ধি, রেমিট্যান্স প্রবাহও ঊর্ধ্বমুখী',
    en: 'Export earnings grow as remittance inflow climbs',
    excerpt: 'চলতি অর্থবছরের শুরুতে রপ্তানি আয় ও রেমিট্যান্স — দুটি খাতেই ইতিবাচক ধারা দেখা যাচ্ছে।',
    body: `${DEMO_NOTE}
<p>চলতি অর্থবছরের শুরুতে রপ্তানি আয় ও রেমিট্যান্স — দুটি খাতেই ইতিবাচক ধারা দেখা যাচ্ছে। সংশ্লিষ্টরা বলছেন, এই ধারা ধরে রাখতে হলে পণ্য বৈচিত্র্য ও বাজার সম্প্রসারণ জরুরি।</p>
<h3>কোন খাত এগিয়ে</h3>
<p>তৈরি পোশাক এখনও প্রধান খাত, তবে হিমায়িত খাদ্য, চামড়াজাত পণ্য ও তথ্যপ্রযুক্তি সেবা রপ্তানিতে নতুন সম্ভাবনা দেখাচ্ছে।</p>
<p>অর্থনীতিবিদরা বলছেন, বিনিময় হারের স্থিতিশীলতা ও আমদানি খরচ নিয়ন্ত্রণে রাখা গেলে মূল্যস্ফীতি সহনীয় পর্যায়ে রাখা সম্ভব হবে।</p>`,
    tags: 'অর্থনীতি,রপ্তানি,রেমিট্যান্স',
  },
  {
    cat: 'sports', author: 2, breaking: true, featured: true, type: 'text',
    bn: 'ঘরোয়া ক্রিকেটে নতুন প্রতিভার উত্থান, নির্বাচকদের নজরে তরুণরা',
    en: 'New talent rises in domestic cricket, catching selectors’ eyes',
    excerpt: 'ঘরোয়া আসরে কয়েকজন তরুণ ক্রিকেটারের ধারাবাহিক পারফরম্যান্সে আলোচনায় এসেছে নতুন প্রজন্ম।',
    body: `${DEMO_NOTE}
<p>ঘরোয়া ক্রিকেটে চলতি মৌসুমে কয়েকজন তরুণ ক্রিকেটার ধারাবাহিক পারফরম্যান্স করে নজর কেড়েছেন। নির্বাচকরা তাঁদের অগ্রগতি পর্যবেক্ষণ করছেন।</p>
<p>বিশেষজ্ঞদের মতে, ঘরোয়া আসরে সুযোগ বাড়লে জাতীয় দলের বেঞ্চ শক্তিশালী হবে। পেস বোলিং ও মিডল অর্ডার ব্যাটিং — দুই জায়গাতেই নতুন মুখ উঠে আসছে।</p>
<blockquote>“ঘরোয়া ক্রিকেটই জাতীয় দলের ভিত্তি। এখানে প্রতিযোগিতা বাড়লে লাভ পুরো দেশের।”</blockquote>`,
    tags: 'ক্রিকেট,ঘরোয়া ক্রিকেট,খেলা',
  },
  {
    cat: 'sports', author: 2, type: 'text',
    bn: 'ফুটবল লিগের মৌসুম শুরুর প্রস্তুতি চূড়ান্ত পর্যায়ে',
    en: 'Football league season enters final preparations',
    excerpt: 'ক্লাবগুলোর নিবন্ধন ও ভেনু চূড়ান্ত করার কাজ প্রায় শেষ পর্যায়ে বলে জানিয়েছে আয়োজকরা।',
    body: `${DEMO_NOTE}
<p>আগামী মাস থেকে শুরু হতে যাওয়া ফুটবল লিগের প্রস্তুতি চূড়ান্ত পর্যায়ে। ক্লাবগুলোর খেলোয়াড় নিবন্ধন ও ভেনু নির্ধারণের কাজ প্রায় শেষ।</p>
<p>আয়োজকরা জানিয়েছেন, এবারের আসরে দর্শক উপস্থিতি বাড়াতে টিকিট ব্যবস্থা সহজ করা হচ্ছে এবং অনলাইনে টিকিট কেনার সুযোগ থাকবে।</p>`,
    tags: 'ফুটবল,লিগ,খেলা',
  },
  {
    cat: 'technology', author: 3, featured: true, type: 'text',
    bn: 'সাইবার প্রতারণা থেকে বাঁচতে যে সতর্কতা মানছেন না বেশিরভাগ ব্যবহারকারী',
    en: 'Most users still ignore the basics of cyber-fraud protection',
    excerpt: 'এক জরিপে দেখা গেছে, অধিকাংশ ব্যবহারকারীই দুই-স্তরের নিরাপত্তা চালু করেননি এবং একই পাসওয়ার্ড একাধিক জায়গায় ব্যবহার করছেন।',
    body: `${DEMO_NOTE}
<p>অনলাইন প্রতারণার শিকার হওয়ার ঘটনা বাড়ছে, অথচ মৌলিক সতর্কতা মানছেন না বেশিরভাগ ব্যবহারকারী। একটি জরিপে দেখা গেছে, অধিকাংশ মানুষই দুই-স্তরের নিরাপত্তা (2FA) চালু করেননি।</p>
<h3>যে পাঁচটি অভ্যাস জরুরি</h3>
<ul>
<li>প্রতিটি গুরুত্বপূর্ণ অ্যাকাউন্টে আলাদা ও শক্তিশালী পাসওয়ার্ড ব্যবহার করুন।</li>
<li>সম্ভব হলে পাসওয়ার্ড ম্যানেজার ব্যবহার করুন।</li>
<li>দুই-স্তরের নিরাপত্তা চালু রাখুন।</li>
<li>অচেনা লিংকে ক্লিক করার আগে ঠিকানা যাচাই করুন।</li>
<li>অ্যাপ বা সফটওয়্যার হালনাগাদ রাখুন।</li>
</ul>
<p>বিশেষজ্ঞরা বলছেন, বেশিরভাগ আক্রমণই সাধারণ ভুলের সুযোগ নিয়ে হয় — তাই সচেতনতাই সবচেয়ে বড় সুরক্ষা।</p>`,
    tags: 'সাইবার নিরাপত্তা,প্রযুক্তি,২এফএ',
  },
  {
    cat: 'technology', author: 3, type: 'text',
    bn: 'দেশীয় স্টার্টআপে বিনিয়োগ বাড়ছে, এগিয়ে ফিনটেক ও স্বাস্থ্যসেবা',
    en: 'Local startup investment grows, fintech and healthtech lead',
    excerpt: 'চলতি বছরে দেশীয় স্টার্টআপে বিনিয়োগের পরিমাণ বেড়েছে, সবচেয়ে বেশি আগ্রহ ফিনটেক ও স্বাস্থ্যসেবা খাতে।',
    body: `${DEMO_NOTE}
<p>দেশীয় স্টার্টআপ খাতে বিনিয়োগের পরিমাণ বাড়ছে। ফিনটেক, স্বাস্থ্যসেবা ও কৃষিপ্রযুক্তি খাতে সবচেয়ে বেশি আগ্রহ দেখাচ্ছেন বিনিয়োগকারীরা।</p>
<p>উদ্যোক্তারা বলছেন, প্রতিভা ধরে রাখা ও নিয়ন্ত্রক কাঠামো সহজ করা গেলে এই খাত আরও দ্রুত এগোবে।</p>`,
    tags: 'স্টার্টআপ,ফিনটেক,বিনিয়োগ',
  },
  {
    cat: 'international', author: 0, type: 'text',
    bn: 'আন্তর্জাতিক বাণিজ্য আলোচনায় নতুন প্রস্তাব, আলোচনা চলছে',
    en: 'New proposal tabled at international trade talks',
    excerpt: 'বহুপাক্ষিক বাণিজ্য আলোচনায় উন্নয়নশীল দেশগুলোর জন্য বিশেষ সুবিধা রাখার প্রস্তাব উঠেছে।',
    body: `${DEMO_NOTE}
<p>বহুপাক্ষিক বাণিজ্য আলোচনায় উন্নয়নশীল দেশগুলোর জন্য বিশেষ সুবিধা ও প্রযুক্তি হস্তান্তরের প্রস্তাব উঠেছে।</p>
<p>কূটনৈতিক সূত্র বলছে, আলোচনা এখনও চলমান এবং চূড়ান্ত ঘোষণাপত্র তৈরিতে আরও কয়েক দফা বৈঠক হতে পারে।</p>`,
    tags: 'আন্তর্জাতিক,বাণিজ্য,কূটনীতি',
  },
  {
    cat: 'bangladesh-abroad', author: 1, type: 'text',
    bn: 'প্রবাসীদের জন্য সেবা সহজ করতে নতুন অনলাইন পোর্টালের দাবি',
    en: 'Diaspora call for a simpler online service portal',
    excerpt: 'প্রবাসীরা বলছেন, জমি, পাসপোর্ট ও ব্যাংকিং সংক্রান্ত সেবা এক পোর্টালে পেলে সময় ও খরচ দুটোই কমবে।',
    body: `${DEMO_NOTE}
<p>বিদেশে বসবাসরত বাংলাদেশিরা বলছেন, জমি, পাসপোর্ট, ব্যাংকিং ও কনস্যুলার সেবা এক অনলাইন পোর্টালে পেলে হয়রানি কমবে।</p>
<p>রেমিট্যান্স পাঠানোর খরচ কমানো এবং দূতাবাসে অ্যাপয়েন্টমেন্ট ব্যবস্থা সহজ করার দাবিও উঠেছে।</p>`,
    tags: 'প্রবাস,রেমিট্যান্স,সেবা',
  },
  {
    cat: 'health', author: 1, type: 'text',
    bn: 'মৌসুমি জ্বরে সতর্কতা, চিকিৎসকদের পরামর্শ কী',
    en: 'Seasonal fever: what doctors advise',
    excerpt: 'মৌসুম পরিবর্তনের সময়ে জ্বর ও শ্বাসতন্ত্রের সংক্রমণ বাড়ায় সতর্ক থাকার পরামর্শ দিয়েছেন চিকিৎসকরা।',
    body: `${DEMO_NOTE}
<p>মৌসুম পরিবর্তনের সময়ে জ্বর ও শ্বাসতন্ত্রের সংক্রমণ বাড়ে। চিকিৎসকরা বলছেন, বেশিরভাগ ক্ষেত্রেই পর্যাপ্ত বিশ্রাম, পানি ও প্রয়োজনে চিকিৎসকের পরামর্শে সুস্থ হওয়া যায়।</p>
<p>তিন দিনের বেশি জ্বর থাকলে, শ্বাসকষ্ট হলে বা শরীরে অস্বাভাবিক দুর্বলতা দেখা দলে দেরি না করে চিকিৎসকের শরণাপন্ন হওয়ার পরামর্শ দেওয়া হয়েছে।</p>
<p class="note">এই প্রতিবেদন সাধারণ সচেতনতার জন্য — নির্দিষ্ট কোনো সমস্যায় অবশ্যই নিবন্ধিত চিকিৎসকের পরামর্শ নিন।</p>`,
    tags: 'স্বাস্থ্য,জ্বর,সচেতনতা',
  },
  {
    cat: 'education', author: 0, type: 'text',
    bn: 'উচ্চশিক্ষায় গবেষণা বাড়াতে নতুন তহবিল গঠনের প্রস্তাব',
    en: 'Proposal for a new fund to boost higher-education research',
    excerpt: 'বিশ্ববিদ্যালয়গুলোতে গবেষণার মান বাড়াতে আলাদা তহবিল ও শিল্প-বিশ্ববিদ্যালয় সহযোগিতার প্রস্তাব উঠেছে।',
    body: `${DEMO_NOTE}
<p>উচ্চশিক্ষায় গবেষণার মান বাড়াতে আলাদা তহবিল গঠনের প্রস্তাব উঠেছে। শিক্ষাবিদরা বলছেন, গবেষণা বাজেট বাড়ানো এবং শিল্পখাতের সঙ্গে বিশ্ববিদ্যালয়ের যোগসূত্র তৈরি করা জরুরি।</p>
<p>শিক্ষার্থীরাও বলছেন, ল্যাব সুবিধা ও তথ্যভাণ্ডারে প্রবেশাধিকার বাড়লে গবেষণার পরিধি বিস্তৃত হবে।</p>`,
    tags: 'শিক্ষা,গবেষণা,বিশ্ববিদ্যালয়',
  },
  {
    cat: 'entertainment', author: 2, type: 'video',
    bn: 'নতুন ওয়েব সিরিজ ঘিরে দর্শকের আগ্রহ, ট্রেলার প্রকাশ',
    en: 'New web series draws interest as trailer drops',
    excerpt: 'আসন্ন ওয়েব সিরিজের ট্রেলার প্রকাশের পর সামাজিক মাধ্যমে আলোচনা শুরু হয়েছে।',
    body: `${DEMO_NOTE}
<p>আসন্ন একটি ওয়েব সিরিজের ট্রেলার প্রকাশ পেয়েছে। প্রকাশের কয়েক ঘণ্টার মধ্যেই সামাজিক মাধ্যমে দর্শকদের মতামত আসতে শুরু করেছে।</p>
<p>নির্মাতারা জানিয়েছেন, গল্পের ভিত্তি শহুরে জীবন এবং চরিত্রগুলো বাস্তবধর্মী রাখার চেষ্টা করা হয়েছে।</p>`,
    tags: 'বিনোদন,ওয়েব সিরিজ,নাটক',
    video: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
  {
    cat: 'opinion', author: 0, type: 'text',
    bn: 'মতামত: স্থানীয় সাংবাদিকতাকে শক্তিশালী করা কেন জরুরি',
    en: 'Opinion: why strengthening local journalism matters',
    excerpt: 'জাতীয় সংবাদের ভিড়ে স্থানীয় খবর হারিয়ে যাচ্ছে — অথচ নাগরিকের দৈনন্দিন জীবনের সঙ্গে সেটিই সবচেয়ে বেশি যুক্ত।',
    body: `${DEMO_NOTE}
<p>জাতীয় ও আন্তর্জাতিক সংবাদের ভিড়ে স্থানীয় খবর প্রায় হারিয়ে যায়। অথচ রাস্তা, স্কুল, হাসপাতাল, পানি ও বিদ্যুৎ — নাগরিকের দৈনন্দিন জীবনের সঙ্গে স্থানীয় সংবাদই সবচেয়ে বেশি যুক্ত।</p>
<p>স্থানীয় সাংবাদিকতা শক্তিশালী হলে দায়বদ্ধতা বাড়ে। তথ্য যাচাই, সম্প্রদায়ের অংশগ্রহণ এবং দীর্ঘমেয়াদি প্রতিবেদন — এই তিনটি স্তম্ভ দাঁড় করানো গেলে ফল পাওয়া সম্ভব।</p>
<p class="note">এই লেখা লেখকের ব্যক্তিগত মতামত, নিউজপালস ২৪-এর সম্পাদকীয় অবস্থান নয়।</p>`,
    tags: 'মতামত,সাংবাদিকতা',
  },
  {
    cat: 'lifestyle', author: 1, type: 'gallery',
    bn: 'বর্ষায় ঘর সাজানো: কম খরচে যেভাবে বদলে দেবেন পরিবেশ',
    en: 'Monsoon home styling: small changes, big difference',
    excerpt: 'বর্ষার দিনে ঘরের পরিবেশ বদলাতে খুব বেশি খরচ লাগে না — দরকার কিছু ছোট পরিবর্তন।',
    body: `${DEMO_NOTE}
<p>বর্ষার দিনে ঘর ভেজা, স্যাঁতসেঁতে পরিবেশ — সব মিলিয়ে ক্লান্তিকর। কিছু ছোট পরিবর্তনেই পরিবেশ বদলে দেওয়া সম্ভব।</p>
<ul>
<li>প্রাকৃতিক আলো ঢোকার পথ খোলা রাখুন।</li>
<li>স্যাঁত কমাতে ঘরে বায়ু চলাচল নিশ্চিত করুন।</li>
<li>সহজ পরিচর্যার সবুজ গাছ রাখুন।</li>
<li>হালকা রঙের পর্দা ও বিছানার চাদর ব্যবহার করুন।</li>
</ul>`,
    tags: 'জীবনযাপন,ঘর সাজানো,বর্ষা',
    gallery: [
      { src: '', alt: 'নমুনা ছবি ১' },
      { src: '', alt: 'নমুনা ছবি ২' },
    ],
  },
];

const PAGES = [
  {
    slug: 'about',
    title_bn: 'আমাদের সম্পর্কে',
    title_en: 'About us',
    body_bn: `<p>নিউজপালস ২৪ বাংলাদেশের একটি ডিজিটাল সংবাদ মাধ্যম। আমাদের লক্ষ্য দ্রুত, নির্ভুল ও নিরপেক্ষ সংবাদ পাঠকের কাছে পৌঁছে দেওয়া।</p>
<h3>আমাদের নীতি</h3>
<ul><li>সত্য যাচাই ছাড়া কোনো সংবাদ প্রকাশ নয়।</li><li>উৎস উল্লেখ করা বাধ্যতামূলক।</li><li>ভুল হলে দ্রুত ও প্রকাশ্যে সংশোধন।</li><li>সংবাদ ও বিজ্ঞাপনের মধ্যে স্পষ্ট বিভাজন।</li></ul>`,
  },
  {
    slug: 'editorial-policy',
    title_bn: 'সম্পাদকীয় নীতি ও সংশোধন নীতিমালা',
    title_en: 'Editorial & Corrections Policy',
    body_bn: `<h3>যাচাই</h3><p>প্রতিটি সংবাদ প্রকাশের আগে কমপক্ষে একটি নির্ভরযোগ্য উৎস থেকে যাচাই করা হয়। সম্ভব হলে দুটি স্বাধীন উৎস ব্যবহার করা হয়।</p>
<h3>সংশোধন</h3><p>কোনো ভুল প্রমাণিত হলে আমরা সংশোধনী প্রকাশ করি, সংশোধনের সময় উল্লেখ করি এবং সংশোধনের পুরনো রেকর্ড মুছে ফেলি না। পুরনো সংস্করণের পরিবর্তনও সংরক্ষণ করা হয়।</p>
<h3>বিজ্ঞাপন ও সংবাদের বিভাজন</h3><p>স্পনসর করা কনটেন্ট স্পষ্টভাবে "বিজ্ঞাপন" বা "স্পনসরড" লেবেল দেওয়া হয়। বিজ্ঞাপনদাতা সংবাদীয় সিদ্ধান্তে হস্তক্ষেপ করতে পারেন না।</p>
<h3>ভুল জানান</h3><p>কোনো ভুল চোখে পড়লে <strong>corrections@newspulse24.com</strong> ঠিকানায় লিখুন।</p>`,
  },
  {
    slug: 'privacy-policy',
    title_bn: 'গোপনীয়তা নীতি',
    title_en: 'Privacy Policy',
    body_bn: `<p>আমরা পাঠকের তথ্য সীমিতভাবে সংগ্রহ করি। ভিজিটরদের আইপি ঠিকানা সরাসরি সংরক্ষণ করা হয় না — এটিকে হ্যাশ করে রাখা হয়, যা থেকে ব্যক্তিকে শনাক্ত করা যায় না।</p>
<h3>কুকি</h3><p>সাইটটি ভাষা পছন্দ, ভিজিট গণনা ও নিরাপত্তার জন্য কুকি ব্যবহার করে। বিজ্ঞাপনের পরিমাপের জন্যও কুকি ব্যবহৃত হতে পারে।</p>
<h3>তথ্য শেয়ার</h3><p>ব্যক্তিগত তথ্য বিক্রি করা হয় না। আইনি বাধ্যবাধকতা ছাড়া তৃতীয় পক্ষের কাছে হস্তান্তর করা হয় না।</p>`,
  },
  {
    slug: 'terms',
    title_bn: 'ব্যবহারের শর্তাবলি',
    title_en: 'Terms of Use',
    body_bn: `<p>এই সাইটের কনটেন্ট ব্যক্তিগত ব্যবহারের জন্য। অনুমতি ছাড়া বাণিজ্যিকভাবে পুনঃপ্রকাশ করা যাবে না।</p><p>মন্তব্যের ক্ষেত্রে অশালীন, মিথ্যা বা কারও প্রতি ঘৃণা ছড়ায় এমন বক্তব্য গ্রহণযোগ্য নয়। এমন মন্তব্য অপসারণ করা হবে।</p>`,
  },
  {
    slug: 'contact',
    title_bn: 'যোগাযোগ',
    title_en: 'Contact',
    body_bn: `<p><strong>সংবাদ কক্ষ:</strong> news@newspulse24.com<br><strong>সংশোধন:</strong> corrections@newspulse24.com<br><strong>বিজ্ঞাপন:</strong> ads@newspulse24.com</p><p>ঠিকানা: নিউজপালস ২৪, ঢাকা, বাংলাদেশ।</p>`,
  },
];

function ensureCategories() {
  let n = 0;
  config.categories.forEach((c, i) => {
    db.run(
      `INSERT INTO categories (slug, name_bn, name_en, color, sort_order)
       VALUES (?,?,?,?,?)
       ON CONFLICT(slug) DO NOTHING`,
      [c.slug, c.bn, c.en, c.color, i],
    );
    n += 1;
  });
  return n;
}

function ensureAuthors() {
  const ids = [];
  for (const a of AUTHORS) {
    const existing = db.get(`SELECT id FROM authors WHERE slug = ?`, [a.slug]);
    if (existing) { ids.push(existing.id); continue; }
    const { lastInsertRowid } = db.run(
      `INSERT INTO authors (name, slug, designation, bio) VALUES (?,?,?,?)`,
      [a.name, a.slug, a.designation, a.bio],
    );
    ids.push(lastInsertRowid);
  }
  return ids;
}

function ensurePages() {
  for (const p of PAGES) {
    db.run(
      `INSERT INTO pages (slug, title_bn, title_en, body_bn)
       VALUES (?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET body_bn = excluded.body_bn`,
      [p.slug, p.title_bn, p.title_en, sanitizeArticleHtml(p.body_bn)],
    );
  }
  return PAGES.length;
}

function ensureArticles(authorIds) {
  const cats = new Map(repo_categories().map((c) => [c.slug, c.id]));
  let created = 0;
  const now = Date.now();

  // A bundled, category-appropriate cover so a fresh install already reads like
  // the channel's on-air look. Editors replace these via the media library.
  const COVER_BY_CAT = {
    national: '/assets/img/news-city.jpg',
    politics: '/assets/img/news-city.jpg',
    economy: '/assets/img/news-market.jpg',
    sports: '/assets/img/news-sport.jpg',
    technology: '/assets/img/news-tech.jpg',
    international: '/assets/img/news-globe.jpg',
    'bangladesh-abroad': '/assets/img/news-globe.jpg',
    health: '/assets/img/news-health.jpg',
    education: '/assets/img/news-city.jpg',
    entertainment: '/assets/img/news-tech.jpg',
    opinion: '/assets/img/news-city.jpg',
    lifestyle: '/assets/img/news-health.jpg',
  };
  const coverFor = (a, i) => COVER_BY_CAT[a.cat] || ['/assets/img/news-globe.jpg', '/assets/img/news-city.jpg'][i % 2];

  ARTICLES.forEach((a, index) => {
    const slug = slugify(a.bn);
    /*
     * Idempotency guard. Match on slug OR title: if the slug algorithm ever
     * changes, a slug-only check would silently insert the whole demo set a
     * second time on the next boot.
     */
    if (db.get(`SELECT id FROM articles WHERE slug = ? OR title_bn = ?`, [slug, a.bn])) return;

    // Spread publication times so the layout and "most read" logic have shape.
    const publishedAt = new Date(now - index * 47 * 60 * 1000 - (index % 5) * 3600 * 1000).toISOString();
    const { lastInsertRowid } = db.run(
      `INSERT INTO articles (slug, title_bn, title_en, excerpt, body_bn, cover_image, category_id, author_id,
        status, is_breaking, is_featured, media_type, video_url, gallery_json, tags, read_minutes,
        views, is_demo, published_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        slug, a.bn, a.en, a.excerpt, sanitizeArticleHtml(a.body), coverFor(a, index),
        cats.get(a.cat) || null, authorIds[a.author] ?? authorIds[0],
        'published', a.breaking ? 1 : 0, a.featured ? 1 : 0, a.type,
        a.video || '', a.gallery ? JSON.stringify(a.gallery) : '', a.tags,
        readingTime(a.body), 120 + index * 37, 1, publishedAt,
      ],
    );
    // Seed the daily counter so "most read" is not empty on a fresh install.
    const day = new Date().toISOString().slice(0, 10);
    db.run(
      `INSERT INTO article_stats_daily (article_id, day, views) VALUES (?,?,?)
       ON CONFLICT(article_id, day) DO UPDATE SET views = views + excluded.views`,
      [lastInsertRowid, day, 40 + index * 11],
    );
    created += 1;
  });
  return created;
}

function repo_categories() {
  return db.all(`SELECT * FROM categories`);
}

function ensureTicker() {
  const count = db.get(`SELECT COUNT(*) AS n FROM ticker_items`).n;
  if (count) return 0;
  const rows = db.all(`SELECT id, title_bn, title_en FROM articles WHERE is_breaking = 1 AND status='published' ORDER BY published_at DESC LIMIT 6`);
  rows.forEach((r, i) => {
    db.run(`INSERT INTO ticker_items (article_id, text_bn, text_en, priority) VALUES (?,?,?,?)`, [r.id, r.title_bn, r.title_en, 10 + i]);
  });
  return rows.length;
}

function ensurePoll() {
  if (db.get(`SELECT COUNT(*) AS n FROM polls`).n) return 0;
  db.run(
    `INSERT INTO polls (question_bn, question_en, options) VALUES (?,?,?)`,
    [
      'আজকের সবচেয়ে গুরুত্বপূর্ণ খবর কোনটি?',
      'Which story matters most today?',
      JSON.stringify([
        { id: 'o1', bn: 'যানজট ও নগর পরিকল্পনা', en: 'Traffic & urban planning', votes: 34 },
        { id: 'o2', bn: 'অর্থনীতি ও রেমিট্যান্স', en: 'Economy & remittance', votes: 28 },
        { id: 'o3', bn: 'ক্রিকেট', en: 'Cricket', votes: 22 },
        { id: 'o4', bn: 'সাইবার নিরাপত্তা', en: 'Cyber security', votes: 16 },
      ]),
    ],
  );
  return 1;
}

function ensureDemoAds() {
  if (db.get(`SELECT COUNT(*) AS n FROM ads`).n) return 0;
  const demo = [
    { name: 'হাউজ অ্যাড — সাবস্ক্রাইব', slot: 'sidebar-top', kind: 'text', headline: 'প্রতিদিন সকালে খবরের সারসংক্ষেপ', body: 'নিউজলেটারে সাবস্ক্রাইব করুন — একদম ফ্রি।', cta: 'সাবস্ক্রাইব', link: '/#newsletter', advertiser: 'NewsPulse 24' },
    { name: 'হাউজ অ্যাড — লাইভ টিভি', slot: 'below-ticker', kind: 'text', headline: 'সরাসরি সম্প্রচার চলছে', body: 'নিউজপালস ২৪ লাইভ দেখুন এখনই।', cta: 'লাইভ দেখুন', link: '/live', advertiser: 'NewsPulse 24' },
    { name: 'হাউজ অ্যাড — বিজ্ঞাপন দিন', slot: 'in-article', kind: 'text', headline: 'আপনার ব্যবসা এখানে পৌঁছে দিন', body: 'নিউজপালস ২৪-এ বিজ্ঞাপনের রেট কার্ড দেখুন।', cta: 'রেট কার্ড', link: '/advertise', advertiser: 'NewsPulse 24' },
  ];
  for (const d of demo) {
    db.run(
      `INSERT INTO ads (name, advertiser, slot, kind, headline, body, cta, link_url, priority, weight, status)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'active')`,
      [d.name, d.advertiser, d.slot, d.kind, d.headline, d.body, d.cta, d.link, 50, 100],
    );
  }
  return demo.length;
}

function ensureAdmin() {
  const existing = db.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'`).n;
  if (existing) return null;

  const email = process.env.ADMIN_EMAIL || 'admin@newspulse24.com';
  const provided = process.env.ADMIN_PASSWORD;
  const generated = provided ? null : crypto.randomBytes(9).toString('base64url');
  const password = provided || generated;

  const { lastInsertRowid } = db.run(
    `INSERT INTO users (name, email, password_hash, role, status, designation, must_change_pw)
     VALUES (?,?,?,?,?,?,?)`,
    [
      process.env.ADMIN_NAME || 'Site Owner',
      email,
      auth.hashPassword(password),
      'superadmin',
      'active',
      'সম্পাদক',
      provided ? 0 : 1,
    ],
  );
  db.run(
    `INSERT INTO authors (user_id, name, slug, designation, bio) VALUES (?,?,?,?,?)`,
    [lastInsertRowid, process.env.ADMIN_NAME || 'Site Owner', 'site-owner', 'সম্পাদক', ''],
  );
  return { email, password: generated, generated: !!generated };
}

/** Runs on every boot; only creates what is missing. */
function ensureSeedData() {
  const categories = ensureCategories();
  const authorIds = ensureAuthors();
  const articles = ensureArticles(authorIds);
  const pages = ensurePages();
  const ticker = ensureTicker();
  const polls = ensurePoll();
  const demoAds = ensureDemoAds();
  const admin = ensureAdmin();

  if (admin?.generated) {
    console.log(`\n  ┌─ Admin account created ─────────────────────────`);
    console.log(`  │  email:    ${admin.email}`);
    console.log(`  │  password: ${admin.password}`);
    console.log(`  └─ Sign in at /admin and change it immediately.\n`);
  }

  return { created: articles > 0, categories, articles, pages, ticker, polls, ads: demoAds, admin };
}

/** Wipes only the demo rows — called from the admin "purge demo content" action. */
function purgeDemoContent() {
  const ids = db.all(`SELECT id FROM articles WHERE is_demo = 1`).map((r) => r.id);
  for (const id of ids) db.run(`DELETE FROM articles WHERE id = ?`, [id]);
  db.run(`DELETE FROM ads WHERE advertiser = 'NewsPulse 24'`);
  return ids.length;
}

module.exports = { ensureSeedData, purgeDemoContent, ensureAdmin, ensureCategories, DEMO_NOTE };
