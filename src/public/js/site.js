/* ============================================================================
   NewsPulse 24 — public behaviour
   Vanilla JS, one file, no dependencies, CSP-safe (no inline handlers).
   Everything is progressively enhanced: if JS fails, the site still works.
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';

  function post(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(data || {}),
      credentials: 'same-origin',
    }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }

  /* ------------------------------------------------------------- theme --- */
  var THEME_KEY = 'np24-theme';
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var btn = $('#themeToggle');
    if (btn) btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  (function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* private mode */ }
    if (!saved) saved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(saved);
    var btn = $('#themeToggle');
    if (btn) btn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* noop */ }
    });
  }());

  /* ------------------------------------------------------- sticky header - */
  var navbar = $('.navbar');
  var toTop = $('.to-top');
  var progress = $('.progress');
  var ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      var y = window.scrollY || 0;
      if (navbar) navbar.classList.toggle('scrolled', y > 10);
      if (toTop) toTop.setAttribute('data-show', y > 600 ? 'true' : 'false');
      if (progress) {
        var h = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.width = (h > 0 ? (y / h) * 100 : 0) + '%';
      }
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (toTop) toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  /* -------------------------------------------------------- mobile nav --- */
  var burger = $('#burger');
  var navIn = $('.navbar__in');
  if (burger && navIn) {
    burger.addEventListener('click', function () {
      var open = navIn.getAttribute('data-open') === 'true';
      navIn.setAttribute('data-open', open ? 'false' : 'true');
      navIn.style.display = open ? '' : 'flex';
      navIn.style.flexDirection = open ? '' : 'column';
      burger.setAttribute('aria-expanded', String(!open));
    });
  }

  /* ------------------------------------------------- search shortcut ----- */
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      var input = $('#siteSearch');
      if (input) { e.preventDefault(); input.focus(); }
    }
    if (e.key === 'Escape') {
      var panel = $('.ai-panel');
      if (panel && panel.getAttribute('data-open') === 'true') panel.setAttribute('data-open', 'false');
      document.body.classList.remove('ai-open');
    }
  });
  var searchForm = $('#searchForm');
  if (searchForm) {
    searchForm.addEventListener('submit', function (e) {
      var q = $('#siteSearch').value.trim();
      if (!q) { e.preventDefault(); return; }
      e.preventDefault();
      window.location.href = '/search?q=' + encodeURIComponent(q);
    });
  }

  /* -------------------------------------------------- breaking ticker ---- */
  var track = $('.ticker__track');
  function paintTicker(items) {
    if (!track || !items || !items.length) return;
    var html = items.map(function (it) {
      var text = (it.text_bn || it.title_bn || it.text_en || '').replace(/</g, '&lt;');
      var cat = (it.category_bn || '').replace(/</g, '&lt;');
      var href = it.slug ? '/news/' + encodeURIComponent(it.slug) : '#';
      return '<a href="' + href + '">' + (cat ? '<span class="tag">' + cat + '</span>' : '') + text + '</a>';
    }).join('');
    // Duplicated so the CSS translate(-50%) loop is seamless.
    track.innerHTML = html + html;
  }
  if (track) {
    var dur = parseInt(track.getAttribute('data-duration') || '45', 10);
    track.style.setProperty('--ticker-duration', dur + 's');
    setInterval(function () {
      fetch('/api/ticker', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.ok) paintTicker(d.items); })
        .catch(function () { /* keep the last rendered ticker */ });
    }, 90000);
  }

  /* -------------------------------------------------- ad view tracking --- */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        io.unobserve(el);
        var id = el.getAttribute('data-ad-id') || '';
        var slot = el.getAttribute('data-ad-slot') || '';
        var article = el.getAttribute('data-article') || '';
        var img = new Image();
        img.src = '/api/ad/impression?id=' + encodeURIComponent(id)
          + '&slot=' + encodeURIComponent(slot)
          + (article ? '&article=' + encodeURIComponent(article) : '')
          + '&t=' + Date.now();
      });
    }, { threshold: 0.5 });
    $$('.ad[data-ad-slot]').forEach(function (el) { io.observe(el); });
  }

  /* Ad clicks go through our beacon so CTR is measured, then redirect. */
  $$('a[data-ad-click]').forEach(function (a) {
    a.addEventListener('click', function () {
      var id = a.getAttribute('data-ad-id') || '';
      var slot = a.getAttribute('data-ad-slot') || '';
      new Image().src = '/api/ad/click?id=' + encodeURIComponent(id) + '&slot=' + encodeURIComponent(slot) + '&t=' + Date.now();
    });
  });

  /* ------------------------------------------------- sticky mobile ad ---- */
  var sticky = $('.ad--sticky-mobile');
  if (sticky) {
    document.body.classList.add('has-sticky-ad');
    var close = sticky.querySelector('.ad__close');
    if (close) close.addEventListener('click', function () {
      sticky.classList.add('hidden');
      document.body.classList.remove('has-sticky-ad');
      try { sessionStorage.setItem('np24-ad-closed', '1'); } catch (e) { /* noop */ }
    });
    try { if (sessionStorage.getItem('np24-ad-closed') === '1') { sticky.classList.add('hidden'); document.body.classList.remove('has-sticky-ad'); } } catch (e) { /* noop */ }
  }

  /* ------------------------------------------------------------- like ---- */
  $$('.btn-like').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.classList.contains('is-liked')) return;
      var id = btn.getAttribute('data-id');
      post('/api/reaction/' + encodeURIComponent(id), {}).then(function (res) {
        if (!res.ok) return;
        btn.classList.add('is-liked');
        var count = btn.querySelector('.count');
        if (count) count.textContent = res.likes;
      });
    });
  });

  /* ---------------------------------------------------------- comments --- */
  var commentForm = $('#commentForm');
  if (commentForm) {
    commentForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var box = $('#commentResult');
      var btn = commentForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      var payload = {
        article_id: commentForm.querySelector('[name="article_id"]').value,
        name: commentForm.querySelector('[name="name"]').value,
        email: commentForm.querySelector('[name="email"]').value,
        body: commentForm.querySelector('[name="body"]').value,
        website: commentForm.querySelector('[name="website"]').value, // honeypot
      };
      post('/comments', payload).then(function (res) {
        btn.disabled = false;
        if (!res.ok) {
          box.className = 'alert alert--err';
          box.textContent = 'মন্তব্য পাঠানো যায়নি। আবার চেষ্টা করুন।';
          return;
        }
        box.className = 'alert alert--ok';
        box.textContent = res.message;
        commentForm.reset();
      }).catch(function () {
        btn.disabled = false;
        box.className = 'alert alert--err';
        box.textContent = 'নেটওয়ার্ক ত্রুটি।';
      });
    });
  }

  /* --------------------------------------------------------- newsletter -- */
  var newsForm = $('#newsletterForm');
  if (newsForm) {
    newsForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var box = $('#newsletterResult');
      var input = newsForm.querySelector('input[type="email"]');
      var btn = newsForm.querySelector('button');
      btn.disabled = true;
      post('/newsletter/subscribe', { email: input.value, lang: document.documentElement.lang || 'bn' })
        .then(function (res) {
          btn.disabled = false;
          box.className = 'alert ' + (res.ok ? 'alert--ok' : 'alert--err');
          box.textContent = res.ok ? res.message : 'সাবস্ক্রিপশন ব্যর্থ হয়েছে।';
          if (res.ok) { input.value = ''; post('/api/track', { event: 'share', path: 'newsletter' }); }
        }).catch(function () { btn.disabled = false; });
    });
  }

  /* -------------------------------------------------------------- poll --- */
  var poll = $('.poll');
  if (poll) {
    poll.addEventListener('click', function (e) {
      var opt = e.target.closest('.poll__opt');
      if (!opt || poll.getAttribute('data-voted') === 'true') return;
      var id = poll.getAttribute('data-id');
      post('/polls/' + encodeURIComponent(id) + '/vote', { option: opt.getAttribute('data-option') })
        .then(function (res) {
          if (!res.ok || !res.options) return;
          poll.setAttribute('data-voted', 'true');
          var total = res.options.reduce(function (s, o) { return s + (o.votes || 0); }, 0) || 1;
          $$('.poll__opt', poll).forEach(function (el) {
            var key = el.getAttribute('data-option');
            var match = res.options.filter(function (o) { return String(o.id) === key; })[0];
            var pct = Math.round(((match ? match.votes : 0) / total) * 100);
            el.querySelector('.bar').style.width = pct + '%';
            el.querySelector('.pct').textContent = pct + '%';
          });
        });
    });
  }

  /* --------------------------------------------------------- article ----- */
  var article = $('.article');
  if (article) {
    $$('.font-ctl button').forEach(function (b) {
      b.addEventListener('click', function () { article.setAttribute('data-font', b.getAttribute('data-size')); });
    });
    var copy = $('.copy-link');
    if (copy) copy.addEventListener('click', function () {
      var url = window.location.href;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(function () { copy.textContent = 'কপি হয়েছে ✓'; setTimeout(function () { copy.textContent = 'লিংক কপি'; }, 1800); })
        .catch(function () { copy.textContent = url; });
    });
  }

  /* ---------------------------------------------------- share beacons ---- */
  $$('[data-share]').forEach(function (el) {
    el.addEventListener('click', function () {
      post('/api/track', { event: 'share', path: el.getAttribute('data-share'), articleId: el.getAttribute('data-article') });
    });
  });

  /* Scroll-depth beacon (25/50/75/100) — one request per milestone. */
  (function scrollDepth() {
    if (!article) return;
    var marks = [25, 50, 75, 100];
    var sent = {};
    window.addEventListener('scroll', function () {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      if (h <= 0) return;
      var pct = Math.round(((window.scrollY || 0) / h) * 100);
      marks.forEach(function (m) {
        if (pct >= m && !sent[m]) {
          sent[m] = true;
          post('/api/track', { event: 'scroll_depth', path: window.location.pathname, meta: { pct: m } });
        }
      });
    }, { passive: true });
  }());

  /* Lazy-load iframes (video embeds) only when they approach the viewport. */
  $$('iframe[data-src]').forEach(function (frame) {
    if (!('IntersectionObserver' in window)) { frame.src = frame.getAttribute('data-src'); return; }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        frame.src = frame.getAttribute('data-src');
        obs.disconnect();
      });
    }, { rootMargin: '300px' });
    obs.observe(frame);
  });
}());
