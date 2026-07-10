/* UAP Dashboard core — app shell, data channels, tab router, shared UI helpers.
 * Loaded before tabs.js. tabs.js registers each tab then calls UAP.start(). */
(function () {
  'use strict';

  var BOOT = window.__UAP_BOOT || { token: '', refreshMs: 2000 };
  var WS_URL = 'ws://' + location.host;
  var API_URL = location.origin;
  var MUTATION_HEADERS = { 'X-Uap-Dashboard-Token': BOOT.token || '' };
  var REFRESH_MS = Number(BOOT.refreshMs) > 0 ? Number(BOOT.refreshMs) : 2000;

  // ── Canonical tab order (bar is built from this; tabs.js supplies renderers) ──
  var TAB_DEFS = [
    { id: 'overview', label: 'Overview' },
    { id: 'tasks', label: 'Tasks & Epics' },
    { id: 'agents', label: 'Agents & Sessions' },
    { id: 'orchestration', label: 'Orchestration' },
    { id: 'deliver', label: 'Deliver' },
    { id: 'policies', label: 'Policies' },
    { id: 'models', label: 'Models' },
    { id: 'memory', label: 'Memory' },
  ];

  // ─────────────────────────── helpers ───────────────────────────
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function fmtNum(n) { if (typeof n !== 'number' || isNaN(n)) { n = Number(n) || 0; } return Math.round(n).toLocaleString(); }
  function fmtBytes(b) { b = b || 0; if (b < 1024) return b + ' B'; if (b < 1048576) return Math.round(b / 1024) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
  function fmtKB(b) { return Math.round((b || 0) / 1024) + ' KB'; }
  function fmtUsd(n) { return '$' + (typeof n === 'number' ? n.toFixed(4) : '0.0000'); }
  function fmtDur(ms) { ms = ms || 0; var s = Math.floor(ms / 1000); if (s < 60) return s + 's'; var m = Math.floor(s / 60); if (m < 60) return m + 'm'; var h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; }
  function timeAgo(iso) {
    if (!iso) return '-';
    var t = new Date(iso).getTime(); if (isNaN(t)) return '-';
    var d = Date.now() - t; if (d < 0) d = 0;
    var s = Math.floor(d / 1000); if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function shortTime(iso) { if (!iso) return '-'; var d = new Date(iso); return isNaN(d.getTime()) ? String(iso).slice(11, 19) : d.toLocaleTimeString(); }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  var MODEL_NAMES = { 'fable-5': 'Fable 5', 'opus-4.8': 'Claude Opus 4.8', 'opus-4.6': 'Claude Opus 4.6', 'sonnet-5': 'Claude Sonnet 5', 'sonnet-4.6': 'Claude Sonnet 4.6', 'haiku-4.5': 'Claude Haiku 4.5', 'qwen36-a3b': 'Qwen 3.6 35B A3B', 'qwen35-a3b': 'Qwen 3.5 35B A3B', 'qwen35': 'Qwen 3.5 35B A3B', 'gpt-5.4': 'GPT 5.4', 'gpt-5.3-codex': 'GPT 5.3 Codex' };
  function modelName(id) { return MODEL_NAMES[id] || id || 'unknown'; }

  // Hyperscript DOM builder — XSS-safe by construction: strings only ever land
  // in textContent / text nodes, never innerHTML.
  function el(tag, attrs) {
    var e = document.createElement(tag), i;
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'style' && typeof v === 'object') { for (var sk in v) e.style[sk] = v[sk]; }
        else if (k === 'dataset' && typeof v === 'object') { for (var dk in v) e.dataset[dk] = v[dk]; }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
        else e.setAttribute(k, v);
      }
    }
    for (i = 2; i < arguments.length; i++) {
      var kids = arguments[i];
      if (!Array.isArray(kids)) kids = [kids];
      for (var j = 0; j < kids.length; j++) {
        var kid = kids[j];
        if (kid == null || kid === false) continue;
        if (kid && kid.nodeType) e.appendChild(kid);
        else e.appendChild(document.createTextNode(String(kid)));
      }
    }
    return e;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  // ─────────────────────────── toast ───────────────────────────
  function toast(msg, kind) {
    var c = document.getElementById('toast-container');
    if (!c) return;
    var t = el('div', { class: 'toast ' + (kind || 'ok'), text: msg });
    c.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  // ─────────────────────────── modal (confirm + form) ───────────────────────────
  function modalShell(build) {
    return new Promise(function (resolve) {
      var backdrop = el('div', { class: 'modal-backdrop' });
      function close(val) { backdrop.remove(); document.removeEventListener('keydown', onKey); resolve(val); }
      function onKey(e) { if (e.key === 'Escape') close(null); }
      document.addEventListener('keydown', onKey);
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(null); });
      backdrop.appendChild(build(close));
      document.body.appendChild(backdrop);
    });
  }
  function confirmDialog(message, opts) {
    opts = opts || {};
    return modalShell(function (close) {
      return el('div', { class: 'modal' },
        el('h3', { text: opts.title || 'Confirm' }),
        el('div', { class: 'modal-msg', text: message }),
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn', onclick: function () { close(false); } }, 'Cancel'),
          el('button', { class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), onclick: function () { close(true); } }, opts.okLabel || (opts.danger ? 'Delete' : 'Confirm'))
        )
      );
    });
  }
  // fields: [{name,label,type:'text|textarea|select|number',options?,value?,placeholder?}]
  function formDialog(title, fields, opts) {
    opts = opts || {};
    return modalShell(function (close) {
      var inputs = {};
      var fieldNodes = fields.map(function (f) {
        var input;
        if (f.type === 'textarea') input = el('textarea', { placeholder: f.placeholder || '' });
        else if (f.type === 'select') { input = el('select'); (f.options || []).forEach(function (o) { var v = typeof o === 'string' ? o : o.value; var lb = typeof o === 'string' ? o : o.label; input.appendChild(el('option', { value: v }, lb)); }); }
        else input = el('input', { type: f.type || 'text', placeholder: f.placeholder || '' });
        if (f.value != null) input.value = f.value;
        inputs[f.name] = input;
        return el('label', { class: 'field' }, f.label || f.name, input);
      });
      return el('div', { class: 'modal' },
        el('h3', { text: title }),
        el('div', { class: 'modal-fields' }, fieldNodes),
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn', onclick: function () { close(null); } }, 'Cancel'),
          el('button', { class: 'btn btn-primary', onclick: function () { var out = {}; for (var n in inputs) out[n] = inputs[n].value; close(out); } }, opts.okLabel || 'Submit')
        )
      );
    });
  }

  // ─────────────────────────── drawer ───────────────────────────
  var drawerEl = null, drawerBackdrop = null;
  function ensureDrawer() {
    if (drawerEl) return;
    drawerBackdrop = el('div', { class: 'drawer-backdrop', onclick: closeDrawer });
    drawerEl = el('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'drawer-head' }, el('h3', { id: 'drawer-title' }), el('button', { class: 'drawer-close', title: 'Close', onclick: closeDrawer }, '×')),
      el('div', { class: 'drawer-body', id: 'drawer-body' })
    );
    document.body.appendChild(drawerBackdrop);
    document.body.appendChild(drawerEl);
  }
  function drawer(title, contentNode) {
    ensureDrawer();
    drawerEl.querySelector('#drawer-title').textContent = title;
    var body = drawerEl.querySelector('#drawer-body');
    clear(body);
    if (typeof contentNode === 'string') body.textContent = contentNode; else if (contentNode) body.appendChild(contentNode);
    drawerEl.classList.add('open');
    drawerBackdrop.classList.add('open');
  }
  function closeDrawer() { if (drawerEl) { drawerEl.classList.remove('open'); drawerBackdrop.classList.remove('open'); } }

  // ─────────────────────────── collapsible ───────────────────────────
  function collapsible(title, bodyNode, opts) {
    opts = opts || {};
    var open = !!opts.open;
    var header = el('div', { class: 'collapsible-header' + (open ? ' open' : '') }, title);
    var inner = el('div', { class: 'cb-inner' });
    if (typeof bodyNode === 'string') inner.textContent = bodyNode; else if (bodyNode) inner.appendChild(bodyNode);
    var body = el('div', { class: 'collapsible-body' + (open ? ' open' : '') }, inner);
    header.addEventListener('click', function () { header.classList.toggle('open'); body.classList.toggle('open'); });
    return el('div', { class: 'collapsible' }, header, body);
  }

  // ─────────────────────────── api ───────────────────────────
  function api(path, body) {
    var opts = { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, MUTATION_HEADERS) };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(API_URL + path, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      }, function () { if (!r.ok) throw new Error('HTTP ' + r.status); return {}; });
    }).catch(function (e) { toast(e.message || 'Request failed', 'err'); throw e; });
  }

  // ─────────────────────────── charts ───────────────────────────
  // uPlot chart + sparkline builders live in charts.js (loaded before core.js):
  // mkChart / initSparkline / addTooltip / updateAllCharts ported 1:1 from the
  // original dashboard, plus the syncHero/syncSpark registry adapters the tabs
  // use. Re-exported here as UAP.charts so tab modules have a single entry point.
  var charts = window.UAPCharts || {
    ready: false, CC: {},
    syncHero: function () {}, syncSpark: function () {}, resetCharts: function () {},
    mkChart: function () { return null; }, initSparkline: function () { return null; },
    addTooltip: function () {}, updateAllCharts: function () {},
    parseHR: function () { return 0; }, parseBR: function () { return 0; },
  };
  function resetCharts() { charts.resetCharts(); }

  // ─────────────────────────── tab registry + router ───────────────────────────
  var tabs = {}; // id -> { label, render, update }
  var activeId = null, activeRoot = null, enteredId = null;
  function registerTab(id, def) { tabs[id] = def; }
  function buildTabBar() {
    var bar = document.getElementById('tabbar'); if (!bar) return;
    clear(bar);
    TAB_DEFS.forEach(function (d) {
      var badge = el('span', { class: 'tab-badge', id: 'tabbadge-' + d.id, style: { display: 'none' } });
      var btn = el('button', { class: 'tab', id: 'tab-' + d.id, onclick: function () { goto(d.id); } }, d.label, badge);
      bar.appendChild(btn);
    });
  }
  function setActiveTabButton(id) {
    TAB_DEFS.forEach(function (d) { var b = document.getElementById('tab-' + d.id); if (b) b.classList.toggle('active', d.id === id); });
  }
  function currentHashTab() { var h = (location.hash || '').replace(/^#/, ''); return tabs[h] ? h : 'overview'; }
  function goto(id) { if (location.hash.replace(/^#/, '') === id) { onRoute(); } else { location.hash = id; } }
  function onRoute() {
    var id = currentHashTab();
    activeId = id; activeRoot = document.getElementById('view');
    setActiveTabButton(id);
    if (!activeRoot) return;
    clear(activeRoot);
    enteredId = id;
    var def = tabs[id];
    if (!def) { activeRoot.appendChild(el('div', { class: 'empty' }, 'Loading…')); return; }
    try { def.render(activeRoot, state || {}); } catch (e) { activeRoot.appendChild(el('div', { class: 'empty', text: 'Render error: ' + (e.message || e) })); console.error(e); }
  }
  function refreshActive() {
    if (!activeId || !activeRoot) return;
    var def = tabs[activeId]; if (!def) return;
    try {
      if (def.update && enteredId === activeId) def.update(activeRoot, state || {});
      else { clear(activeRoot); enteredId = activeId; def.render(activeRoot, state || {}); }
    } catch (e) { console.error('tab update', e); }
  }

  // ─────────────────────────── snapshot + header ───────────────────────────
  var state = null;
  var snapSubs = [];
  function onSnapshot(fn) { snapSubs.push(fn); }
  function badge(id, count, alert) {
    var b = document.getElementById('tabbadge-' + id); if (!b) return;
    if (!count) { b.style.display = 'none'; return; }
    b.style.display = ''; b.textContent = count; b.classList.toggle('alert', !!alert);
  }
  function updateHeader(d) {
    var sys = d.system || {};
    setText('sys-version', sys.version || '?');
    setText('sys-branch', sys.branch || '?');
    var el2 = document.getElementById('sys-dirty');
    if (el2) { var dd = sys.dirty || 0; el2.textContent = dd > 0 ? dd + ' files' : 'clean'; el2.className = 'val ' + (dd > 0 ? 'yellow' : 'green'); }
    if (d.timestamp) setText('data-ts', new Date(d.timestamp).toLocaleTimeString());
  }
  function updateBadges(d) {
    var coord = d.coordination || {}, tasks = d.tasks || {}, runs = d.deliverRuns || [];
    badge('agents', coord.activeAgents || 0);
    badge('tasks', (tasks.inProgress || 0) + (tasks.blocked || 0));
    badge('deliver', runs.filter(function (r) { return r.status === 'running'; }).length);
    var blocks = (d.compliance && d.compliance.totalBlocks) || 0;
    badge('policies', blocks, blocks > 0);
  }
  function applySnapshot(d) {
    if (!d) return;
    state = d; UAP.state = d;
    try { updateHeader(d); } catch (e) {}
    try { updateBadges(d); } catch (e) {}
    refreshActive();
    for (var i = 0; i < snapSubs.length; i++) { try { snapSubs[i](d); } catch (e) {} }
  }
  function setText(id, val) { var e = document.getElementById(id); if (e) e.textContent = String(val); }

  // ─────────────────────────── data channels ───────────────────────────
  var ws = null, reconnectTimer = null, reconnectDelay = 1000, MAX_DELAY = 30000;
  function setConn(cls, txt, title) {
    var dot = document.getElementById('ws-status'); if (dot) { dot.className = 'status-dot ' + cls; dot.setAttribute('aria-label', 'Connection: ' + txt); }
    var info = document.getElementById('refresh-info'); if (info) info.textContent = txt;
    if (title) document.title = 'UAP Dashboard - ' + title;
  }
  function connectWS() {
    clearTimeout(reconnectTimer);
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = function () { reconnectDelay = 1000; setConn('connected', 'Live', 'Live'); };
    ws.onmessage = function (e) { try { applySnapshot(JSON.parse(e.data)); setConn('connected', 'Live - ' + new Date().toLocaleTimeString(), 'Live'); } catch (err) { console.error(err); } };
    ws.onclose = function () { setConn('disconnected', 'Disconnected - reconnecting…', 'Disconnected'); reconnectTimer = setTimeout(connectWS, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_DELAY); };
    ws.onerror = function () { ws.close(); };
  }
  var eventSource = null, liveEvents = [];
  function connectSSE() {
    try {
      eventSource = new EventSource(API_URL + '/api/events');
      eventSource.onmessage = function (e) {
        try { var ev = JSON.parse(e.data); if (ev.id != null && liveEvents.some(function (x) { return x.id === ev.id; })) return; liveEvents.unshift(ev); if (liveEvents.length > 40) liveEvents.pop(); for (var i = 0; i < evSubs.length; i++) { try { evSubs[i](liveEvents); } catch (_) {} } } catch (_) {}
      };
      eventSource.addEventListener('snapshot', function (e) { if (ws && ws.readyState === WebSocket.OPEN) return; try { applySnapshot(JSON.parse(e.data)); setConn('connected', 'Live (SSE) - ' + new Date().toLocaleTimeString(), 'Live'); } catch (_) {} });
      eventSource.onerror = function () { eventSource.close(); setTimeout(connectSSE, 5000); };
    } catch (_) {}
  }
  var evSubs = [];
  function onEvents(fn) { evSubs.push(fn); }
  function startPoll() {
    setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) return;
      fetch(API_URL + '/api/dashboard').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) { applySnapshot(d); setConn('polling', 'Polling - ' + new Date().toLocaleTimeString(), 'Polling'); } }).catch(function () {});
    }, REFRESH_MS);
  }
  var resizeT;
  window.addEventListener('resize', function () { clearTimeout(resizeT); resizeT = setTimeout(function () { resetCharts(); refreshActive(); }, 300); });
  window.addEventListener('hashchange', onRoute);

  function start() {
    buildTabBar();
    onRoute();
    // Kick an immediate fetch so the first paint doesn't wait for the WS handshake.
    fetch(API_URL + '/api/dashboard').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d && !state) applySnapshot(d); }).catch(function () {});
    connectWS();
    connectSSE();
    startPoll();
  }

  window.UAP = {
    get state() { return state; }, set state(v) { state = v; },
    esc: esc, fmtNum: fmtNum, fmtBytes: fmtBytes, fmtKB: fmtKB, fmtUsd: fmtUsd, fmtDur: fmtDur, timeAgo: timeAgo, shortTime: shortTime, capitalize: capitalize, modelName: modelName,
    el: el, clear: clear, toast: toast, confirm: confirmDialog, form: formDialog, drawer: drawer, closeDrawer: closeDrawer, collapsible: collapsible,
    api: api, registerTab: registerTab, goto: goto, onSnapshot: onSnapshot, onEvents: onEvents, get liveEvents() { return liveEvents; }, charts: charts, start: start, API_URL: API_URL,
  };
})();
