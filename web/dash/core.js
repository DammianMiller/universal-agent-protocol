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

  // Hyperscript DOM builder (textContent-safe; pass {html} only for pre-escaped strings).
  function el(tag, attrs) {
    var e = document.createElement(tag), i;
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
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
    if (typeof contentNode === 'string') body.innerHTML = contentNode; else if (contentNode) body.appendChild(contentNode);
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
    if (typeof bodyNode === 'string') inner.innerHTML = bodyNode; else if (bodyNode) inner.appendChild(bodyNode);
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

  // ─────────────────────────── charts (uPlot) ───────────────────────────
  var uplotReady = typeof uPlot !== 'undefined';
  var CC = { done: '#3fb950', inProg: '#58a6ff', blocked: '#f85149', open: '#484f58', agents: '#bc8cff', raw: '#58a6ff', ctx: '#3fb950', hitRate: '#bc8cff', deploy: '#58a6ff', blockRate: '#f85149' };
  var chartReg = {}; // id -> { u, host }
  function tsUnix(arr) { return arr.map(function (p) { return new Date(p.timestamp).getTime() / 1000; }); }
  function addTooltip(u, colors, labels, fmtVal) {
    var tt = el('div', { class: 'u-tooltip' }); tt.style.display = 'none'; u.root.appendChild(tt);
    u.hooks.setCursor = u.hooks.setCursor || [];
    u.hooks.setCursor.push(function () {
      var idx = u.cursor.idx, left = u.cursor.left, top = u.cursor.top;
      if (idx == null) { tt.style.display = 'none'; return; }
      var date = new Date(u.data[0][idx] * 1000);
      var rows = '<div class="tt-time">' + date.toLocaleTimeString() + '</div>';
      for (var i = 1; i < u.series.length; i++) {
        if (!u.series[i].show) continue;
        var val = u.data[i][idx]; if (val == null) continue;
        var c = colors[i - 1] || '#fff', l = labels[i - 1] || '';
        var v = fmtVal ? fmtVal(val, i) : val.toLocaleString();
        rows += '<div class="tt-row"><span class="tt-dot" style="background:' + c + '"></span><span class="tt-label">' + l + '</span><span class="tt-val">' + v + '</span></div>';
      }
      tt.innerHTML = rows; tt.style.display = ''; tt.style.left = (left + 16) + 'px'; tt.style.top = Math.max(0, top - 10) + 'px';
    });
  }
  var AXIS = { stroke: '#484f58', grid: { stroke: '#21262d' }, ticks: { stroke: '#21262d' }, font: '10px SF Mono,monospace' };
  function heroOpts(kind, w) {
    if (kind === 'tasks') return {
      width: w, height: 260, cursor: { sync: { key: 'uap' }, focus: { prox: 30 } },
      scales: { x: { time: true }, y: { min: 0 }, agents: { min: 0 } },
      axes: [AXIS, Object.assign({}, AXIS, { size: 50 }), { stroke: CC.agents, grid: { show: false }, side: 1, font: '10px SF Mono,monospace', size: 50, scale: 'agents' }],
      series: [{}, { label: 'Done', stroke: CC.done, fill: CC.done + '30', width: 2 }, { label: 'In Prog', stroke: CC.inProg, fill: CC.inProg + '30', width: 2 }, { label: 'Blocked', stroke: CC.blocked, fill: CC.blocked + '20', width: 2 }, { label: 'Open', stroke: CC.open, fill: CC.open + '20', width: 1, dash: [4, 2] }, { label: 'Agents', stroke: CC.agents, width: 2, dash: [6, 3], scale: 'agents' }],
    };
    return {
      width: w, height: 260, cursor: { sync: { key: 'uap' }, focus: { prox: 30 } },
      scales: { x: { time: true }, y: { min: 0 }, pct: { min: 0, max: 100 } },
      axes: [AXIS, Object.assign({}, AXIS, { size: 50, values: function (_, v) { return v.map(function (x) { return x + ' KB'; }); } }), { stroke: CC.hitRate, grid: { show: false }, side: 1, font: '10px SF Mono,monospace', size: 50, scale: 'pct', values: function (_, v) { return v.map(function (x) { return x + '%'; }); } }],
      series: [{}, { label: 'Raw', stroke: CC.raw, fill: CC.raw + '20', width: 2 }, { label: 'Compressed', stroke: CC.ctx, fill: CC.ctx + '20', width: 2 }, { label: 'Hit Rate', stroke: CC.hitRate, width: 2, dash: [6, 3], scale: 'pct' }],
    };
  }
  var parseHR = function (p) { var h = p.memoryHitsMisses && p.memoryHitsMisses.hitRate; return typeof h === 'string' ? parseFloat(h) || 0 : h || 0; };
  var parseBR = function (p) { var b = p.compliance && p.compliance.blockRate; return typeof b === 'string' ? parseFloat(b) || 0 : b || 0; };
  function heroData(kind, ts) {
    var x = tsUnix(ts);
    if (kind === 'tasks') return [x, ts.map(function (p) { return (p.tasks && p.tasks.done) || 0; }), ts.map(function (p) { return (p.tasks && p.tasks.inProgress) || 0; }), ts.map(function (p) { return (p.tasks && p.tasks.blocked) || 0; }), ts.map(function (p) { return (p.tasks && p.tasks.open) || 0; }), ts.map(function (p) { return (p.coordination && p.coordination.activeAgents) || 0; })];
    return [x, ts.map(function (p) { return Math.round(((p.compression && p.compression.rawBytes) || 0) / 1024); }), ts.map(function (p) { return Math.round(((p.compression && p.compression.contextBytes) || 0) / 1024); }), ts.map(parseHR)];
  }
  function syncHero(id, kind, ts) {
    if (!uplotReady || !ts || ts.length < 2) return;
    var host = document.getElementById(id); if (!host) return;
    var reg = chartReg[id], data = heroData(kind, ts);
    if (!reg || reg.host !== host || !document.body.contains(reg.u.root)) {
      if (reg && reg.u) { try { reg.u.destroy(); } catch (e) {} }
      clear(host);
      var u = new uPlot(heroOpts(kind, host.clientWidth || 600), data, host);
      addTooltip(u, kind === 'tasks' ? [CC.done, CC.inProg, CC.blocked, CC.open, CC.agents] : [CC.raw, CC.ctx, CC.hitRate], kind === 'tasks' ? ['Done', 'In Progress', 'Blocked', 'Open', 'Active Agents'] : ['Raw KB', 'Compressed KB', 'Hit Rate %'], kind === 'tasks' ? null : function (v, i) { return i === 3 ? v + '%' : v + ' KB'; });
      chartReg[id] = { u: u, host: host };
    } else { reg.u.setData(data); }
    seedLegend(chartReg[id].u);
  }
  function syncSpark(id, ts, fn, color, label) {
    if (!uplotReady || !ts || ts.length < 2) return;
    var host = document.getElementById(id); if (!host) return;
    var reg = chartReg[id], data = [tsUnix(ts), ts.map(fn)];
    if (!reg || reg.host !== host || !document.body.contains(reg.u.root)) {
      if (reg && reg.u) { try { reg.u.destroy(); } catch (e) {} }
      clear(host);
      var u = new uPlot({ width: host.clientWidth || 300, height: 60, cursor: { sync: { key: 'uap' }, focus: { prox: 30 }, points: { show: false } }, legend: { show: false }, scales: { x: { time: true }, y: { min: 0 } }, axes: [{ show: false }, { show: false }], series: [{}, { stroke: color, fill: color + '25', width: 1.5 }] }, data, host);
      chartReg[id] = { u: u, host: host, label: label };
    } else { reg.u.setData(data); }
    seedLegend(chartReg[id].u);
  }
  function seedLegend(u) { try { if (u && u.data && u.data[0] && u.data[0].length) u.setLegend({ idx: u.data[0].length - 1 }); } catch (e) {} }
  function resetCharts() { for (var id in chartReg) { try { chartReg[id].u.destroy(); } catch (e) {} } chartReg = {}; }
  var charts = { syncHero: syncHero, syncSpark: syncSpark, parseHR: parseHR, parseBR: parseBR, CC: CC, ready: uplotReady };

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
  // A missing/incompatible better-sqlite3 binding makes every DB-backed panel
  // silently empty. Surface it as a fixed banner instead of a dead-looking UI.
  function renderHealth(hh) {
    var existing = document.getElementById('db-health-banner');
    if (!hh || hh.ok) { if (existing) existing.remove(); return; }
    if (!existing) {
      existing = el('div', { id: 'db-health-banner', role: 'alert', style: { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2000', background: 'var(--red)', color: '#fff', padding: '8px 16px', fontSize: '12px', textAlign: 'center' } });
      document.body.appendChild(existing);
      document.body.style.paddingTop = '34px';
    }
    existing.textContent = '\u26A0 Dashboard database unavailable — panels read empty. ' + (hh.remediation || hh.error || '');
  }

  function applySnapshot(d) {
    if (!d) return;
    state = d; UAP.state = d;
    try { updateHeader(d); } catch (e) {}
    try { updateBadges(d); } catch (e) {}
    try { renderHealth(d.health); } catch (e) {}
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
