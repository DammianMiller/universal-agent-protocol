/**
 * tab-models.js — Models & Placement panel.
 *
 * Loaded AFTER tabs.js (the tab-policies.js precedent) so this full renderer
 * overrides the inline routing-only Models stub. Placement state comes from
 * /api/placement/state, which syncs the ledger (probes + unit reconcile) —
 * heavier than the 2s dash refresh, so this tab throttles its own polling
 * (10s) rather than riding the refresh tick.
 *
 * All DOM is built with UAP.el (no innerHTML); reads use fetch on
 * UAP.API_URL. The mutation routes (load/unload/apply) arrive with phase-3
 * enforcement; until then this panel is read-only by design.
 */
(function () {
  'use strict';
  if (typeof UAP === 'undefined' || !UAP.registerTab) return;
  var el = UAP.el;

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
  function empty(msg) {
    return el('div', { class: 'empty', text: msg || 'No data' });
  }
  function badge(text, cls) {
    return el('span', { class: 'badge ' + (cls || 'idle'), text: text });
  }
  function tableNode(headers, items, rowFn) {
    var thead = el('tr', {});
    headers.forEach(function (hd) { thead.appendChild(el('th', { text: hd })); });
    var t = el('table', {}, thead);
    items.forEach(function (it) {
      var tr = el('tr', {});
      rowFn(it).forEach(function (c) { tr.appendChild(el('td', {}, c)); });
      t.appendChild(tr);
    });
    return el('div', { class: 'table-wrap' }, t);
  }
  function mib(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString() + ' MiB';
  }

  var STATE_TONE = { hot: 'active', warming: 'running', draining: 'failed', paused: 'idle' };

  // ── throttled placement-state fetch (10s; sync is probe-heavy) ──
  var cache = { at: 0, data: null, inflight: null };
  function placementState(force) {
    if (!force && cache.data && Date.now() - cache.at < 10_000) return Promise.resolve(cache.data);
    if (cache.inflight) return cache.inflight;
    cache.inflight = get('/api/placement/state').then(function (d) {
      cache.at = Date.now();
      cache.data = d;
      cache.inflight = null;
      return d;
    }).catch(function (e) {
      cache.inflight = null;
      throw e;
    });
    return cache.inflight;
  }

  function renderPlacement(p, d) {
    var devs = d.devices || {};
    Object.keys(devs).forEach(function (k) {
      var v = devs[k] || {};
      var free = v.free_mib !== undefined ? mib(v.free_mib) : 'unprobed';
      var total = v.total_mib !== undefined ? mib(v.total_mib) : 'total unmeasured';
      var reserve = v.reserved_mib !== undefined ? mib(v.reserved_mib) : 'reserve unmeasured';
      p.appendChild(kv(k, v.kind + ' — ' + total + ', ' + free + ' free, ' + reserve + ' reserved'));
    });

    p.appendChild(el('h3', {}, 'Residents'));
    var residents = d.residents || [];
    if (!residents.length) p.appendChild(empty('No resident model — nothing is loaded'));
    else
      p.appendChild(
        tableNode(['Model / Config', 'State', 'Device', 'GPU', 'Host RSS', 'Unit'], residents, function (r) {
          return [
            el('span', { class: 'mono-sm', text: r.model + '/' + r.config }),
            badge(r.state, STATE_TONE[r.state] || 'idle'),
            r.device,
            el('span', { class: 'value ' + (r.gpu_mib ? 'green' : 'yellow'), text: r.gpu_mib ? mib(r.gpu_mib) : 'unknown' }),
            r.host_rss_mib ? mib(r.host_rss_mib) : '—',
            r.unit || '—',
          ];
        }),
      );

    p.appendChild(el('h3', {}, 'Pending requests'));
    var pending = d.pending || [];
    p.appendChild(pending.length ? tableNode(['ID', 'Requested', 'Client', 'Expires', 'Reason'], pending, function (q) {
      return [el('span', { class: 'mono-sm', text: q.id }), q.requested_model, q.client || '—', q.expires_at, q.reason || 'parked'];
    }) : empty('No requests awaiting the operator'));

    if ((d.registry_errors || []).length) {
      d.registry_errors.forEach(function (e) {
        p.appendChild(el('div', { class: 'empty', text: 'registry error: ' + e }));
      });
    }
  }

  function renderRegistry(p, d) {
    var models = d.models || [];
    if (!models.length) {
      p.appendChild(empty('Registry empty — no models declared'));
      return;
    }
    models.forEach(function (m) {
      p.appendChild(el('h3', {}, m.display + '  (' + m.model + ')'));
      if (m.engine) p.appendChild(kv('engine', m.engine));
      if (m.unit) p.appendChild(kv('unit', m.unit));
      if (m.service) p.appendChild(kv('service', m.service));
      (m.advertises || []).forEach(function (id) { p.appendChild(kv('advertises', id)); });
      p.appendChild(
        tableNode(['Config', 'Footprint', 'KV geometry', 'Measured', 'Source'], m.configs || [], function (c) {
          return [
            el('span', { class: 'mono-sm', text: c.config }),
            c.measured
              ? el('span', { class: 'value green', text: mib(c.resident_gpu_mib) + ' GPU, ' + mib(c.host_rss_mib) + ' RSS' })
              : el('span', { class: 'value yellow', text: 'unmeasured — fails closed' }),
            c.measured ? (c.kv_kind || '?') + ' ' + (c.kv_resident_cells || '?') + '/' + (c.context_pool_cells || '?') + ' cells' : '—',
            c.measured ? (c.measured_at || '').slice(0, 10) : 'never',
            c.measured ? c.source || '—' : '—',
          ];
        }),
      );
    });
  }

  function renderPreview(p) {
    p.appendChild(el('div', { class: 'muted', text: 'Ranked placement options for a requested model — the same computation the proxy gate will use. Read-only until phase-3 enforcement.' }));
    var input = el('input', { type: 'text', placeholder: 'model id, e.g. Qwen3.8-27B', style: { width: '320px', marginRight: '8px' } });
    var out = el('div', {});
    var run = function () {
      var model = (input.value || '').trim();
      if (!model) return;
      UAP.clear(out);
      out.appendChild(el('div', { class: 'muted', text: 'Computing…' }));
      get('/api/placement/preview?model=' + encodeURIComponent(model))
        .then(function (r) {
          UAP.clear(out);
          out.appendChild(kv('requested', r.requested + ' — ' + r.reason, r.reason === 'ok' ? 'green' : 'yellow'));
          (r.notes || []).forEach(function (n) { out.appendChild(el('div', { class: 'empty', text: n })); });
          var opts = r.options || [];
          if (!opts.length) return;
          out.appendChild(
            tableNode(['#', 'Kind', 'Config', 'Device', 'Cost', 'Victims'], opts, function (o, i) {
              var victims = (o.victims || []).map(function (v) { return v.model + '/' + v.config; }).join(', ');
              return [
                String(i + 1),
                badge(o.kind, o.kind === 'reuse' ? 'active' : o.kind === 'load_alongside' ? 'running' : 'failed'),
                el('span', { class: 'mono-sm', text: o.model + '/' + o.config }),
                o.device,
                o.cost_mib === null || o.cost_mib === undefined ? '—' : mib(o.cost_mib),
                victims || '—',
              ];
            }),
          );
        })
        .catch(function (e) {
          UAP.clear(out);
          out.appendChild(el('div', { class: 'empty', text: 'Preview failed: ' + e.message }));
        });
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
    var btn = el('button', { class: 'btn', text: 'Preview', onclick: run });
    p.appendChild(el('div', { style: { marginBottom: '8px' } }, input, btn));
    p.appendChild(out);
  }

  UAP.registerTab('models', {
    label: 'Models',
    render: function (root) {
      UAP.clear(root);
      var place = panel('Model Placement');
      var reg = panel('Model Registry');
      var prev = panel('Placement Preview');
      root.appendChild(place);
      root.appendChild(reg);
      root.appendChild(prev);
      placementState()
        .then(function (d) {
          UAP.clear(place);
          UAP.clear(reg);
          renderPlacement(place, d);
          renderRegistry(reg, d);
          renderPreview(prev);
        })
        .catch(function (e) {
          place.appendChild(empty('Placement state unavailable: ' + e.message));
        });
    },
  });
})();
