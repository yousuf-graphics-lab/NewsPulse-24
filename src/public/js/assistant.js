/* ============================================================================
   NewsPulse 24 — AI assistant widget (bottom-right)
   Streams answers over SSE using fetch + ReadableStream, because EventSource
   cannot POST and we must never put a reader's question into a URL.
   ========================================================================== */
(function () {
  'use strict';

  var panel = document.getElementById('aiPanel');
  var fab = document.getElementById('aiFab');
  if (!panel || !fab) return;

  var body = panel.querySelector('.ai-panel__body');
  var form = panel.querySelector('.ai-panel__foot form');
  var input = panel.querySelector('#aiInput');
  var sendBtn = form.querySelector('button[type="submit"]');
  var chips = panel.querySelector('.ai-chips');
  var langNote = panel.querySelector('.ai-panel__lang');
  var csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  var busy = false;

  /* --------------------------------------------------------- markdown ---- */
  /**
   * A deliberately tiny markdown subset. Input is escaped first, so nothing in
   * the model's output can become markup — only our own formatting survives.
   */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render(text) {
    var out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // Internal links only: a URL that does not start with "/" is left as text.
    out = out.replace(/\[([^\]]+)\]\((\/[^)\s]*)\)/g, function (_, label, href) {
      return '<a href="' + href.replace(/"/g, '%22') + '">' + label + '</a>';
    });
    out = out.replace(/^\s*[-•]\s+(.+)$/gm, '• $1');
    return out;
  }

  /* ------------------------------------------------------------- UI ------ */
  function scrollDown() { body.scrollTop = body.scrollHeight; }

  function bubble(role, text) {
    var el = document.createElement('div');
    el.className = 'ai-msg ai-msg--' + (role === 'user' ? 'user' : 'bot');
    if (role !== 'user') el.innerHTML = render(text);
    else el.textContent = text;
    body.appendChild(el);
    scrollDown();
    return el;
  }

  function setBusy(on) {
    busy = on;
    sendBtn.disabled = on;
    input.disabled = on;
    panel.setAttribute('data-busy', on ? 'true' : 'false');
    if (!on) input.focus();
  }

  function open() {
    panel.setAttribute('data-open', 'true');
    document.body.classList.add('ai-open');
    fab.setAttribute('aria-expanded', 'true');
    fab.setAttribute('aria-label', 'Close assistant');
    input.focus();
  }
  function close() {
    panel.setAttribute('data-open', 'false');
    document.body.classList.remove('ai-open');
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-label', 'Open assistant');
  }

  fab.addEventListener('click', function () {
    if (panel.getAttribute('data-open') === 'true') close(); else open();
  });
  panel.querySelector('[data-close]').addEventListener('click', close);
  panel.querySelector('[data-clear]').addEventListener('click', function () {
    body.innerHTML = '';
    bubble('bot', panel.getAttribute('data-greeting') || 'Hello!');
  });

  /* ------------------------------------------------------- streaming ----- */
  function stream(question) {
    var target = bubble('assistant', '');
    target.classList.add('typing');
    var buffer = '';

    return fetch('/api/assistant/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      body: JSON.stringify({ message: question }),
    }).then(function (res) {
      if (!res.ok || !res.body) throw new Error('bad_response');
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var pending = '';

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return finish();
          pending += decoder.decode(result.value, { stream: true });
          var frames = pending.split('\n\n');
          pending = frames.pop() || '';
          frames.forEach(function (frame) {
            var event = 'message';
            var data = '';
            frame.split('\n').forEach(function (line) {
              if (line.indexOf('event:') === 0) event = line.slice(6).trim();
              else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
            });
            if (!data) return;
            var parsed;
            try { parsed = JSON.parse(data); } catch (e) { return; }
            if (event === 'delta' && parsed.text) {
              buffer += parsed.text;
              target.innerHTML = render(buffer);
              scrollDown();
            } else if (event === 'done') {
              if (langNote) {
                var names = { bn: 'বাংলা', en: 'English', bnlish: 'Banglish' };
                langNote.textContent = (names[parsed.lang] || '') + ' • ' + (parsed.engine === 'local' ? 'নিউজপালস লোকাল ইঞ্জিন' : parsed.engine) + ' • ' + parsed.ms + 'ms';
              }
            } else if (event === 'error') {
              buffer += '\n(দুঃখিত, কিছু একটা সমস্যা হয়েছে।)';
              target.innerHTML = render(buffer);
            }
          });
          return pump();
        });
      }

      function finish() {
        target.classList.remove('typing');
        return buffer;
      }
      return pump();
    }).catch(function () {
      target.classList.remove('typing');
      target.textContent = 'সংযোগ পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।';
    });
  }

  function ask(question) {
    var text = String(question || '').trim();
    if (!text || busy) return;
    bubble('user', text);
    setBusy(true);
    input.value = '';
    input.style.height = 'auto';
    stream(text).then(function () { setBusy(false); });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(96, input.scrollHeight) + 'px';
  });

  if (chips) {
    chips.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) ask(b.textContent);
    });
  }

  /* First paint: greeting + provider state. */
  (function init() {
    var greeting = panel.getAttribute('data-greeting') || 'Hello!';
    bubble('bot', greeting);
    fetch('/api/assistant/config', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!cfg.ok) return;
        if (langNote) langNote.textContent = cfg.provider === 'local'
          ? 'নিউজপালস লোকাল ইঞ্জিন চালু আছে'
          : 'সংযুক্ত মডেল: ' + cfg.provider;
        if (chips && cfg.suggestions) {
          chips.innerHTML = '';
          cfg.suggestions.forEach(function (s) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = s;
            chips.appendChild(b);
          });
        }
        if (cfg.enabled === false) {
          fab.setAttribute('hidden', 'hidden');
          close();
        }
      })
      .catch(function () { /* keep the default chips from the server render */ });
  }());
}());
