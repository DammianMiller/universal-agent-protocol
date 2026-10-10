/**
 * tab-clients.js — Clients fleet panel.
 *
 * Loaded AFTER tabs.js (the tab-policies.js precedent) so it owns the
 * 'clients' tab outright — there is no inline stub in tabs.js. Shows one
 * card per discovered client folder (auto-scan of the scan root + manual
 * entries in ~/.uap/clients.json): deliver-run states, task queue depth,
 * git branch/dirty, last activity, and a link-out to that client's OWN
 * dashboard. "Open dashboard" spawns the client's `uap dashboard serve`
 * on demand (registry-only, loopback, token-gated on the spawned instance
 * exactly like this one) — full control for every client, but the host
 * server never mutates another project itself.
 *
 * Fleet reads hit many client DBs, so this tab throttles its own polling
 * (10s) rather than riding the 2s refresh tick, and rebuilds only when the
 * payload actually changes (sig gate — same trick as the Deliver tab).
 *
 * All DOM is built with UAP.el (no innerHTML); the one mutation (spawn)
 * goes through UAP.api (token-gated); reads use fetch on UAP.API_URL.
 */
(function () {
  'use strict';
  if (typeof UAP === 'undefined' || !UAP.registerTab) return;
  var U = window.UAP;
  var el = U.el;

  var REFRESH_MS = 10000;
  var lastFetch = 0;
  var inFlight = false;
  var lastSig = null;
  var rootEl = null;

  function get(path) {
    return fetch(UAP.API_URL + path).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ── local render helpers (same shapes as tabs.js) ──
  function panel(title) {
    return el('div', { class: 'panel' }, el('h2', {}, title));
  }
  function kv(label, value, cls) {
    return el('div', { class: 'kv' }, el('span', { class: 'label', text: label }), el('span', { class: 'value ' + (cls || ''), text: value }));
  }
  function chip(text, cls) {
    return el('span', { class: 'chip ' + (cls || ''), text: text });
  }
  function empty(msg) {
    return el('div', { class: 'empty', text: msg || 'No data' });
  }
  function sig(clients) {
    return JSON.stringify((clients || []).map(function (c) {
      return [c.path, c.name, c.port, c.manual, c.branch, c.dirty, c.dashboardAlive, c.degraded, c.lastActivity,
        c.deliver.running, c.deliver.interrupted, c.deliver.failed, c.deliver.total,
        c.tasks.open, c.tasks.inProgress, c.tasks.blocked];
    }));
  }

  // ── card ──
  function clientCard(c) {
    var card = panel(c.name || c.path);

    // Status chips: color carries meaning only (status hues, primary for action).
    var chips = el('div', { class: 'chip-list' });
    if (c.host) chips.appendChild(chip('this dashboard', 'active'));
    else if (c.dashboardAlive) chips.appendChild(chip('dashboard up', 'active'));
    else if (!c.managed) chips.appendChild(chip('unmanaged', 'inactive'));
    if (c.branch && c.branch !== '?') chips.appendChild(chip(c.branch));
    if (c.dirty > 0) chips.appendChild(chip(c.dirty + ' dirty'));
    if (c.manual) chips.appendChild(chip('pinned'));
    if (c.degraded) chips.appendChild(chip('degraded', 'inactive'));
    card.appendChild(chips);

    if (!c.managed) {
      card.appendChild(el('div', { class: 'section-note', text: 'Git repo without .uap — run `uap init` inside it to make it a managed client.' }));
      return card;
    }

    // Deliver runs — green running, yellow interrupted, red failed.
    var d = c.deliver || { running: 0, interrupted: 0, failed: 0, total: 0 };
    card.appendChild(kv('Deliver runs',
      (d.running ? d.running + ' running' : '') +
      (d.interrupted ? (d.running ? ' · ' : '') + d.interrupted + ' interrupted' : '') +
      (d.failed ? (d.running || d.interrupted ? ' · ' : '') + d.failed + ' failed' : '') ||
      (d.total ? 'all quiet (' + d.total + ' done)' : 'none'),
      d.running ? 'green' : d.failed ? 'red' : d.interrupted ? 'yellow' : ''));

    // Job queue depth.
    var t = c.tasks || { open: 0, inProgress: 0, blocked: 0, total: 0 };
    card.appendChild(kv('Queue',
      (t.inProgress || 0) + ' in progress · ' + (t.open || 0) + ' open · ' + (t.blocked || 0) + ' blocked',
      t.blocked ? 'yellow' : ''));

    card.appendChild(kv('Last activity', U.timeAgo(c.lastActivity)));
    if (c.error) card.appendChild(el('div', { class: 'section-note', text: c.error }));

    // Action: link out. Alive → straight to the client's dashboard; down →
    // spawn on demand first. The host entry links back to this dashboard.
    var actions = el('div', { class: 'toolbar', style: { marginBottom: '0' } });
    var url = c.host ? U.API_URL : 'http://127.0.0.1:' + c.port + '/';
    var btn = el('button', {
      class: 'btn btn-primary',
      onclick: function () { openClient(c, url); },
    }, c.dashboardAlive || c.host ? 'Open dashboard' : 'Launch dashboard');
    actions.appendChild(btn);
    card.appendChild(actions);
    return card;
  }

  function openClient(c, url) {
    if (c.dashboardAlive || c.host) { window.open(url, '_blank'); return; }
    // Open the placeholder synchronously (inside the user-activation window):
    // the spawn wait runs seconds, and window.open from a promise callback
    // would be popup-blocked.
    var win = window.open('', '_blank');
    U.api('/api/clients/serve', { path: c.path }).then(function (res) {
      if (res && res.alive) {
        if (win) win.location = 'http://127.0.0.1:' + res.port + '/';
        refresh();
      } else {
        if (win) win.close();
        U.toast('Dashboard is starting — refresh the tab in a few seconds and open it again', 'err');
      }
    }).catch(function () { if (win) win.close(); /* U.api already toasted the failure */ });
  }

  function build(clients) {
    if (!rootEl) return;
    U.clear(rootEl);
    rootEl.appendChild(el('div', { class: 'section-note', style: { marginBottom: '12px' },
      text: 'Client folders: auto-scan of the parent directory + manual entries in ~/.uap/clients.json (uap clients add/remove). Opening a client starts ITS OWN dashboard — full control stays on that instance, loopback-only and token-gated.' }));
    if (!clients || !clients.length) {
      rootEl.appendChild(empty('No client folders discovered'));
      return;
    }
    var grid = el('div', { class: 'card-grid' });
    clients.forEach(function (c) { grid.appendChild(clientCard(c)); });
    rootEl.appendChild(grid);
  }

  function refresh() {
    if (inFlight) return; // a hung fetch must not wedge the tab permanently
    lastFetch = Date.now();
    inFlight = true;
    get('/api/clients').then(function (d) {
      inFlight = false;
      var clients = (d && d.clients) || [];
      var s = sig(clients);
      if (s === lastSig) return;
      lastSig = s;
      build(clients);
    }).catch(function (e) {
      inFlight = false;
      if (rootEl) {
        U.clear(rootEl);
        rootEl.appendChild(el('div', { class: 'empty', text: 'Fleet unavailable: ' + (e.message || e) }));
      }
    });
  }

  U.registerTab('clients', {
    label: 'Clients',
    render: function (root) {
      rootEl = root;
      lastSig = null;
      U.clear(root);
      root.appendChild(el('div', { class: 'empty', text: 'Loading client fleet…' }));
      refresh();
    },
    update: function () {
      if (Date.now() - lastFetch >= REFRESH_MS) refresh();
    },
  });
})();
