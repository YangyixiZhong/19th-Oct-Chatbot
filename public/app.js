(function () {
  'use strict';

  var MAX_CHARS = 2000;
  var HISTORY_LIMIT = 12; // messages sent as context
  var TIMEOUT_MS = 30000;

  var $ = function (id) { return document.getElementById(id); };
  var messagesEl = $('messages');
  var scroller = $('scroller');
  var emptyEl = $('empty');
  var form = $('composer');
  var input = $('prompt');
  var sendBtn = $('send');
  var countEl = $('count');
  var themeBtn = $('themeToggle');
  var chipsEl = $('chips');
  var runId = 0; // bumped on New chat so stale responses are ignored

  var history = []; // {role, content}
  var busy = false;
  var controller = null;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- theme ---------- */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    var light = t === 'light';
    themeBtn.setAttribute('aria-pressed', String(light));
    themeBtn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  }
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  themeBtn.addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem('orbit-theme', next); } catch (e) {}
  });

  /* ---------- safe, minimal markdown (DOM nodes only, never innerHTML) ---------- */
  function inline(parent, text) {
    var re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var tok = m[0], el;
      if (tok[0] === '`') { el = document.createElement('code'); el.textContent = tok.slice(1, -1); }
      else { el = document.createElement('strong'); el.textContent = tok.slice(2, -2); }
      parent.appendChild(el);
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderText(container, text) {
    var lines = text.split('\n');
    var para = [], list = null;
    function flushPara() {
      if (!para.length) return;
      var p = document.createElement('p');
      para.forEach(function (l, i) { if (i) p.appendChild(document.createElement('br')); inline(p, l); });
      container.appendChild(p);
      para = [];
    }
    function flushList() { if (list) { container.appendChild(list.el); list = null; } }
    lines.forEach(function (line) {
      var ul = /^\s*[-*•]\s+(.*)/.exec(line);
      var ol = /^\s*\d+[.)]\s+(.*)/.exec(line);
      var head = /^#{1,4}\s+(.*)/.exec(line);
      if (ul || ol) {
        flushPara();
        var type = ul ? 'ul' : 'ol';
        if (!list || list.type !== type) { flushList(); list = { type: type, el: document.createElement(type) }; }
        var li = document.createElement('li');
        inline(li, (ul || ol)[1]);
        list.el.appendChild(li);
      } else if (head) {
        flushPara(); flushList();
        var p = document.createElement('p');
        var s = document.createElement('strong');
        inline(s, head[1]);
        p.appendChild(s);
        container.appendChild(p);
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(line);
      }
    });
    flushPara(); flushList();
  }

  function renderRich(container, text) {
    var parts = text.split(/```/);
    parts.forEach(function (part, i) {
      if (i % 2 === 1) {
        var code = part.replace(/^[a-zA-Z0-9_+-]*\n/, '').replace(/\n$/, '');
        var pre = document.createElement('pre');
        pre.tabIndex = 0; // keyboard-scrollable
        var c = document.createElement('code');
        c.textContent = code;
        pre.appendChild(c);
        container.appendChild(pre);
      } else if (part.trim()) {
        renderText(container, part);
      }
    });
  }

  /* ---------- messages ---------- */
  function scrollDown() {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }

  function addMessage(kind, text) {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg--' + (kind === 'user' ? 'user' : 'bot') + (kind === 'error' ? ' msg--error' : '');
    var who = document.createElement('div');
    who.className = 'msg__who';
    who.textContent = kind === 'user' ? 'You' : kind === 'error' ? 'Error' : 'Orbit';
    var body = document.createElement('div');
    body.className = 'msg__body';
    if (kind === 'bot') renderRich(body, text);
    else body.textContent = text;
    wrap.appendChild(who);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    scrollDown();
    return { wrap: wrap, body: body };
  }

  function addTyping() {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg--bot';
    wrap.innerHTML = '<div class="msg__who">Orbit</div><div class="msg__body typing" role="status"><span class="typing__dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="typing__text">Thinking…</span></div>';
    messagesEl.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function setBusy(v) {
    busy = v;
    form.setAttribute('aria-busy', String(v));
    updateSend();
  }
  function updateSend() { sendBtn.disabled = busy || !input.value.trim(); }

  /* ---------- sending ---------- */
  function send(text) {
    text = text.trim();
    if (!text || busy) return;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

    if (emptyEl) { emptyEl.remove(); emptyEl = null; }
    addMessage('user', text);
    history.push({ role: 'user', content: text });
    input.value = '';
    autosize();
    updateCount();
    request();
  }

  function request() {
    setBusy(true);
    var typing = addTyping();
    var myRun = runId;
    var myController = controller = new AbortController();
    var timer = setTimeout(function () { myController.abort(); }, TIMEOUT_MS);

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-HISTORY_LIMIT) }),
      signal: myController.signal
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || typeof data.reply !== 'string') {
            throw new Error(data.error || 'Something went wrong (' + res.status + ').');
          }
          return data.reply;
        });
      })
      .then(function (reply) {
        if (myRun !== runId) return;
        typing.remove();
        history.push({ role: 'assistant', content: reply });
        addMessage('bot', reply);
      })
      .catch(function (err) {
        typing.remove();
        if (myRun !== runId) return; // chat was reset
        var msg = err && err.name === 'AbortError'
          ? 'The request timed out. Please try again.'
          : (err && err.message && err.message !== 'Failed to fetch' ? err.message : 'Could not reach the server. Check your connection and try again.');
        var m = addMessage('error', msg);
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'retry';
        retry.textContent = 'Retry';
        retry.addEventListener('click', function () {
          if (busy) return;
          m.wrap.remove();
          request();
        });
        m.body.appendChild(retry);
        retry.focus({ preventScroll: true });
      })
      .then(function () {
        clearTimeout(timer);
        if (myRun !== runId) return;
        setBusy(false);
        if (document.activeElement === document.body) input.focus({ preventScroll: true });
      });
  }

  /* ---------- composer ---------- */
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }
  function updateCount() { countEl.textContent = input.value.length + ' / ' + MAX_CHARS; }

  input.addEventListener('input', function () { autosize(); updateCount(); updateSend(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });

  chipsEl.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) send(chip.dataset.prompt);
  });

  /* ---------- new chat ---------- */
  $('newChat').addEventListener('click', function () {
    runId++;
    if (controller) controller.abort();
    controller = null;
    history = [];
    setBusy(false);
    messagesEl.innerHTML = '';
    var fresh = document.createElement('div');
    fresh.className = 'empty';
    fresh.id = 'empty';
    fresh.innerHTML = '<p class="mono-label">TRY ONE OF THESE</p>';
    fresh.appendChild(chipsEl);
    messagesEl.appendChild(fresh);
    emptyEl = fresh;
    input.value = '';
    autosize(); updateCount(); updateSend();
    input.focus();
  });

  updateCount();
})();
