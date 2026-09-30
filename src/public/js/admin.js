/* ============================================================================
   NewsPulse 24 — admin panel behaviour
   Vanilla JS. Charts are drawn as inline SVG here rather than pulling in a
   chart library: the dashboard is the most-visited admin page and it should
   not pay for 200 KB of dependency.
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ------------------------------------------------------ mobile sidebar - */
  var side = $('.side');
  var toggle = $('.menu-toggle');
  if (toggle && side) {
    toggle.addEventListener('click', function () {
      var open = side.getAttribute('data-open') === 'true';
      side.setAttribute('data-open', open ? 'false' : 'true');
      var scrim = $('.scrim');
      if (open && scrim) scrim.remove();
      if (!open) {
        var el = document.createElement('div');
        el.className = 'scrim';
        el.addEventListener('click', function () { side.setAttribute('data-open', 'false'); el.remove(); });
        document.body.appendChild(el);
      }
    });
  }

  /* --------------------------------------------------- confirm on delete - */
  $$('[data-confirm]').forEach(function (el) {
    el.addEventListener('submit', function (e) {
      if (!window.confirm(el.getAttribute('data-confirm'))) e.preventDefault();
    });
  });
  $$('button[data-confirm]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (!window.confirm(el.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  /* ------------------------------------------------------ flash dismiss -- */
  $$('.flash').forEach(function (f) {
    setTimeout(function () { f.style.transition = 'opacity .4s'; f.style.opacity = '0'; setTimeout(function () { f.remove(); }, 400); }, 6000);
  });

  /* ------------------------------------------------------ slug generator - */
  var titleField = $('[data-slug-source]');
  var slugField = $('[name="slug"]');
  if (titleField && slugField && !slugField.value) {
    titleField.addEventListener('blur', function () {
      if (slugField.value) return;
      var s = titleField.value.trim().toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 110);
      if (s) slugField.value = s;
    });
  }

  /* --------------------------------------------------- editor quick tags - */
  var editor = $('#bodyEditor');
  if (editor) {
    var counter = $('.editor__foot .count');
    var updateCount = function () {
      if (!counter) return;
      var words = editor.value.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
      counter.textContent = words + ' শব্দ • প্রায় ' + Math.max(1, Math.round(words / 180)) + ' মিনিট';
    };
    editor.addEventListener('input', updateCount);
    updateCount();

    $$('.editor__tools button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tag = btn.getAttribute('data-tag');
        var start = editor.selectionStart;
        var end = editor.selectionEnd;
        var selected = editor.value.slice(start, end);
        var wrap = { b: ['<strong>', '</strong>'], i: ['<em>', '</em>'], h2: ['<h2>', '</h2>'], h3: ['<h3>', '</h3>'], q: ['<blockquote>', '</blockquote>'], ul: ['<ul>\n  <li>', '</li>\n</ul>'], a: ['<a href="https://">', '</a>'], img: ['<img src="/media/" alt="">', ''], fig: ['<figure>', '</figure>'], p: ['<p>', '</p>'] }[tag];
        if (!wrap) return;
        var text = wrap[0] + (selected || '') + wrap[1];
        editor.setRangeText(text, start, end, 'end');
        editor.focus();
        updateCount();
      });
    });
  }

  /* ---------------------------------------------------- media picker ----- */
  $$('.media-item code').forEach(function (code) {
    code.addEventListener('click', function () {
      var url = code.textContent;
      var cover = $('[name="cover_image"]');
      if (cover) { cover.value = url; cover.dispatchEvent(new Event('change')); }
      else if (navigator.clipboard) { navigator.clipboard.writeText(url); code.textContent = 'কপি ✓'; }
    });
  });

  /* ------------------------------------------------------ drag & drop ---- */
  $$('[data-dropzone]').forEach(function (zone) {
    var input = zone.querySelector('input[type="file"]');
    if (!input) return;
    zone.addEventListener('click', function () { input.click(); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('drag'); });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        zone.closest('form').submit();
      }
    });
    input.addEventListener('change', function () { if (input.files.length) zone.closest('form').submit(); });
  });

  /* ---------------------------------------------------------- charts ----- */
  function barChart(el) {
    var raw = el.getAttribute('data-series');
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data.length) { el.innerHTML = '<p class="muted small">এই সময়সীমায় কোনো তথ্য নেই।</p>'; return; }

    var w = 100; // percentage-based viewBox, so it scales without JS on resize
    var h = 60;
    var max = Math.max.apply(null, data.map(function (d) { return Number(d.v) || 0; })) || 1;
    var bw = w / data.length;
    var bars = data.map(function (d, i) {
      var v = Number(d.v) || 0;
      var bh = (v / max) * (h - 10);
      return '<rect class="bar" x="' + (i * bw + bw * 0.18) + '" y="' + (h - bh) + '" width="' + (bw * 0.64)
        + '" height="' + bh + '" rx="0.6"><title>' + (d.l || '') + ': ' + v + '</title></rect>';
    }).join('');
    var grid = [0.25, 0.5, 0.75].map(function (p) {
      return '<line class="grid-line" x1="0" x2="' + w + '" y1="' + (h * p) + '" y2="' + (h * p) + '"/>';
    }).join('');
    var first = data[0].l || '';
    var last = data[data.length - 1].l || '';
    el.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + (h + 6) + '" preserveAspectRatio="none" role="img">'
      + grid + bars
      + '<text class="axis" x="0" y="' + (h + 5) + '">' + first + '</text>'
      + '<text class="axis" x="' + w + '" y="' + (h + 5) + '" text-anchor="end">' + last + '</text>'
      + '</svg>';
  }
  $$('[data-series]').forEach(barChart);

  /* -------------------------------------------------- live dashboard ----- */
  var live = $('#liveNow');
  if (live) {
    var refresh = function () {
      fetch('/admin/api/overview?days=' + (live.getAttribute('data-days') || 30), { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res.ok) return;
          var o = res.overview;
          $$('#liveNow tr').forEach(function (tr) {
            var key = tr.getAttribute('data-key');
            if (key && o[key] !== undefined) tr.querySelector('.num').textContent = o[key];
          });
          var rows = (res.live || []).map(function (r) {
            return '<tr><td>' + String(r.path || '').replace(/</g, '&lt;') + '</td><td class="num">' + r.hits + '</td></tr>';
          }).join('');
          var tbody = $('#liveRows');
          if (tbody) tbody.innerHTML = rows || '<tr><td colspan="2" class="muted">এই মুহূর্তে কোনো ভিজিটর নেই।</td></tr>';
          var stamp = $('#liveStamp');
          if (stamp) stamp.textContent = new Date().toLocaleTimeString();
        })
        .catch(function () { /* keep the last render */ });
    };
    setInterval(refresh, 30000);
  }

  /* -------------------------------------------------- settings preview --- */
  var previewToggle = $('#previewNewsletter');
  if (previewToggle) {
    previewToggle.addEventListener('click', function () {
      var box = $('#newsletterPreview');
      var hidden = box.getAttribute('hidden') !== null;
      if (hidden) box.removeAttribute('hidden'); else box.setAttribute('hidden', 'hidden');
      previewToggle.textContent = hidden ? 'প্রিভিউ লুকান' : 'নিউজলেটার প্রিভিউ দেখুন';
    });
  }

  /* ------------------------------------------------------ copy helper ---- */
  $$('[data-copy]').forEach(function (el) {
    el.addEventListener('click', function () {
      var text = el.getAttribute('data-copy');
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () {
          var old = el.textContent;
          el.textContent = 'কপি ✓';
          setTimeout(function () { el.textContent = old; }, 1400);
        });
      }
    });
  });
}());
