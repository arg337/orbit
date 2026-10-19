(function () {
  'use strict';

  var MAX_INPUT = 2000;       // characters per message (mirrors the server)
  var MAX_HISTORY = 12;       // recent messages sent as context (mirrors the server)
  var CLIENT_TIMEOUT = 35000; // ms; the server gives up on Groq a little sooner

  var $ = function (id) { return document.getElementById(id); };
  var log = $('log'), intro = $('intro'), form = $('composer'), input = $('composer-input');
  var sendBtn = $('send'), newBtn = $('new-chat'), themeBtn = $('theme-toggle');
  var statusEl = $('status'), countEl = $('count'), themeName = $('theme-name');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var history = [];   // [{role, content}] — only successful turns plus the pending user turn
  var busy = false;
  var runId = 0;      // bumped by New chat so late replies are ignored
  var controller = null;

  /* ---------- tone toggle (paper / parchment, both warm cream) ---------- */
  function applyTheme(name) {
    var parchment = name === 'parchment';
    if (parchment) document.documentElement.dataset.theme = 'parchment';
    else delete document.documentElement.dataset.theme;
    themeBtn.setAttribute('aria-pressed', String(parchment));
    themeName.textContent = parchment ? 'Parchment' : 'Paper';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = parchment ? '#f6ecd6' : '#fbf7ee';
  }
  applyTheme(document.documentElement.dataset.theme);
  themeBtn.addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'parchment' ? 'paper' : 'parchment';
    applyTheme(next);
    try { localStorage.setItem('orbit-theme', next); } catch (e) {}
  });

  /* ---------- tiny, safe markdown renderer (DOM only, never innerHTML) ---------- */
  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  function inline(parent, text) {
    var re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var tok = m[0];
      if (m[1]) parent.appendChild(el('code', tok.slice(1, -1)));
      else if (m[2]) parent.appendChild(el('strong', tok.slice(2, -2)));
      else {
        var parts = /^\[([^\]]+)\]\((.+)\)$/.exec(tok);
        var a = el('a', parts[1]);
        a.href = parts[2]; a.target = '_blank'; a.rel = 'noopener noreferrer';
        parent.appendChild(a);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function render(container, src) {
    var lines = src.replace(/\r\n?/g, '\n').split('\n');
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }

      var fence = /^```/.exec(line);
      if (fence) {
        var code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        var pre = el('pre'); pre.appendChild(el('code', code.join('\n')));
        container.appendChild(pre);
        continue;
      }

      var h = /^#{1,6}\s+(.*)$/.exec(line);
      if (h) { var hd = el('h3'); inline(hd, h[1]); container.appendChild(hd); i++; continue; }

      var ul = /^\s*[-*]\s+/, ol = /^\s*\d+[.)]\s+/;
      if (ul.test(line) || ol.test(line)) {
        var ordered = ol.test(line), re = ordered ? ol : ul, list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length && re.test(lines[i])) {
          var li = el('li'); inline(li, lines[i].replace(re, '')); list.appendChild(li); i++;
        }
        container.appendChild(list);
        continue;
      }

      var para = [];
      while (i < lines.length && lines[i].trim() && !/^```|^#{1,6}\s|^\s*[-*]\s+|^\s*\d+[.)]\s+/.test(lines[i])) para.push(lines[i++]);
      var p = el('p');
      para.forEach(function (l, idx) { if (idx) p.appendChild(document.createElement('br')); inline(p, l); });
      container.appendChild(p);
    }
  }

  /* ---------- conversation UI ---------- */
  function scrollDown() {
    log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function addMessage(role, content, extraClass) {
    var wrap = el('div', null, 'msg ' + role + (extraClass ? ' ' + extraClass : ''));
    wrap.appendChild(el('span', role === 'user' ? 'You' : 'Orbit', 'who'));
    var letter = el('div', null, 'letter');
    if (role === 'user') letter.textContent = content; else render(letter, content);
    wrap.appendChild(letter);
    log.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function showTyping() {
    var wrap = el('div', null, 'msg bot typing');
    wrap.appendChild(el('span', 'Orbit', 'who'));
    var letter = el('div', null, 'letter');
    var dots = el('span', null, 'dots'); dots.setAttribute('aria-hidden', 'true');
    dots.appendChild(el('i')); dots.appendChild(el('i')); dots.appendChild(el('i'));
    letter.appendChild(dots);
    letter.appendChild(el('span', 'Orbit is writing…', 'mono'));
    wrap.appendChild(letter);
    log.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function setBusy(on, text) {
    busy = on;
    sendBtn.disabled = on;
    log.setAttribute('aria-busy', String(on));
    statusEl.textContent = text || (on ? 'Writing…' : 'Ready');
  }

  function showError(message) {
    var wrap = addMessage('bot', message, 'error');
    var retry = el('button', 'Try again', 'retry');
    retry.type = 'button';
    retry.addEventListener('click', function () {
      wrap.remove();
      request();
    });
    wrap.appendChild(retry);
    statusEl.textContent = 'Something went wrong';
    scrollDown();
  }

  function request() {
    if (busy) return;
    var myRun = runId;
    var typing = showTyping();
    setBusy(true);
    controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, CLIENT_TIMEOUT);
    var timedOut = false;
    controller.signal.addEventListener('abort', function () { timedOut = true; });

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-MAX_HISTORY) }),
      signal: controller.signal
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; });
      })
      .then(function (r) {
        if (myRun !== runId) return;
        typing.remove();
        if (!r.res.ok || !r.data.reply) {
          setBusy(false);
          showError((r.data.error && r.data.error.message) || 'Orbit could not answer just now. Please try again.');
          return;
        }
        history.push({ role: 'assistant', content: r.data.reply });
        setBusy(false);
        addMessage('bot', r.data.reply);
      })
      .catch(function () {
        if (myRun !== runId) return;
        typing.remove();
        setBusy(false);
        showError(timedOut
          ? 'That took too long, so I stopped waiting. Please try again.'
          : 'I could not reach the server. Check your connection and try again.');
      })
      .then(function () {
        clearTimeout(timer);
        if (myRun === runId) input.focus({ preventScroll: true });
      });
  }

  function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    if (text.length > MAX_INPUT) text = text.slice(0, MAX_INPUT);
    if (intro.parentNode) intro.remove();
    history.push({ role: 'user', content: text });
    addMessage('user', text);
    input.value = '';
    resize();
    request();
  }

  function newChat() {
    runId++;
    if (controller) controller.abort();
    history = [];
    setBusy(false);
    log.textContent = '';
    log.appendChild(intro);
    input.value = '';
    resize();
    log.scrollTop = 0;
    input.focus();
  }

  /* ---------- composer ---------- */
  function resize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, 160) + 'px';
    var left = MAX_INPUT - input.value.length;
    countEl.textContent = left <= 300 ? String(left) : '';
    countEl.classList.toggle('near', left <= 300);
  }

  input.addEventListener('input', resize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
  newBtn.addEventListener('click', newChat);
  $('suggest').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-q]');
    if (b) send(b.getAttribute('data-q'));
  });

  resize();
})();
