/**
 * tab-models.js — Models & Placement panel.
 *
 * Loaded AFTER tabs.js (the tab-policies.js precedent) so this full renderer
 * overrides the inline routing-only Models stub. Placement state comes from
 * /api/placement/state, which syncs the ledger (probes + unit reconcile) —
 * heavier than the 2s dash refresh, so this tab throttles its own polling
 * (10s) rather than riding the refresh tick.
 *
 * Full management surface (phase 3/4): pending requests resolve/dismiss (the
 * approval signature — expected_victims — rides along so enforcement only
 * evicts what the operator saw), residents unload, the phase-4 auto policy
 * (enable/disable + the displacement allowlist behind the same explicit
 * consent gate the CLI's --yes demands), and the ranked preview.
 *
 * All DOM is built with UAP.el (no innerHTML); mutations go through UAP.api
 * (token-gated); reads use fetch on UAP.API_URL.
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
  function btn(text, onclick, cls) {
    return el('button', { class: 'btn ' + (cls || ''), text: text, onclick: onclick });
  }

  var STATE_TONE = { hot: 'active', warming: 'running', draining: 'failed', paused: 'idle' };
  var REASON_TONE = {
    not_resident: 'idle', unknown_model: 'failed', no_measured_config: 'failed',
    auto_loading: 'running', auto_failed: 'failed', no_controller: 'failed',
    unroutable_target: 'failed', invalid_request: 'failed',
  };

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

  /** Render an enforce result (steps + ok) — the operator's evidence. */
  function resultBlock(res) {
    var box = el('div', { class: 'empty' });
    box.appendChild(badge(res.ok ? 'ok' : 'FAILED', res.ok ? 'active' : 'failed'));
    if (res.error) box.appendChild(el('div', { text: res.error, class: 'value failed' }));
    (res.steps || []).forEach(function (s) {
      box.appendChild(el('div', { text: (s.ok ? 'ok   ' : 'FAIL ') + s.name + (s.detail ? ' — ' + s.detail : '') }));
    });
    return box;
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
        tableNode(['Model / Config', 'State', 'Device', 'GPU', 'Host RSS', 'Unit', ''], residents, function (r) {
          return [
            el('span', { class: 'mono-sm', text: r.model + '/' + r.config }),
            badge(r.state, STATE_TONE[r.state] || 'idle'),
            r.device,
            el('span', { class: 'value ' + (r.gpu_mib ? 'green' : 'yellow'), text: r.gpu_mib ? mib(r.gpu_mib) : 'unknown' }),
            r.host_rss_mib ? mib(r.host_rss_mib) : '—',
            r.unit || '—',
            btn('Unload', function () {
              UAP.confirm('Unload ' + r.model + '/' + r.config + ' from ' + r.device + '? In-flight work on it is aborted (drain first happens automatically).').then(function (yes) {
                if (!yes) return;
                UAP.api('/api/placement/unload', { model: r.model }).then(function (res) {
                  UAP.drawer('Unload ' + r.model, resultBlock(res));
                  placementState(true);
                });
              });
            }),
          ];
        }),
      );

    p.appendChild(el('h3', {}, 'Pending requests'));
    var pending = d.pending || [];
    if (!pending.length) {
      p.appendChild(empty('No requests awaiting the operator'));
    } else {
      // Cards, not a table: each row needs its own action area (option list
      // fetched on demand, the apply approval signature, dismiss).
      pending.forEach(function (q) { p.appendChild(pendingCard(q)); });
    }

    if ((d.registry_errors || []).length) {
      d.registry_errors.forEach(function (e) {
        p.appendChild(el('div', { class: 'empty', text: 'registry error: ' + e }));
      });
    }
  }

  function pendingCard(q) {
    var tone = REASON_TONE[q.reason] || 'idle';
    var isAuto = q.reason === 'auto_loading';
    // Remaining TTL, not timeAgo: expires_at is in the FUTURE for a live
    // pending request, and timeAgo clamps future stamps to "0s ago" — which
    // read as "already expired" for the entry's whole lifetime.
    var ttlMs = q.expires_at ? Date.parse(q.expires_at) - Date.now() : NaN;
    var ttl = isNaN(ttlMs)
      ? ''
      : ttlMs <= 0
        ? 'expired'
        : 'expires in ' + UAP.fmtDur(ttlMs);
    var head = el('div', { class: 'collapsible-header open' },
      el('span', { class: 'mono-sm', text: q.id }),
      '  ',
      el('span', { text: q.requested_model }),
      '  client ' + (q.client || '?') + '  ' + ttl,
      '  ',
      badge(q.reason || 'parked', tone));
    var inner = el('div', { class: 'cb-inner' });
    var body = el('div', { class: 'collapsible-body open' }, inner);
    head.addEventListener('click', function () { head.classList.toggle('open'); body.classList.toggle('open'); });

    if (isAuto) {
      inner.appendChild(el('div', { class: 'muted', text: 'auto load in flight — retrying clients forward when it completes; a manual apply races the background run' }));
    }

    var optionsBox = el('div', {});
    inner.appendChild(optionsBox);
    var loadOptions = function () {
      UAP.clear(optionsBox);
      optionsBox.appendChild(el('div', { class: 'muted', text: 'Computing options…' }));
      get('/api/placement/preview?model=' + encodeURIComponent(q.requested_model)).then(function (r) {
        UAP.clear(optionsBox);
        optionsBox.appendChild(kv('options', r.reason + (r.matched === false ? ' — not in registry' : ''), r.reason === 'ok' ? 'green' : 'yellow'));
        (r.notes || []).forEach(function (n) { optionsBox.appendChild(el('div', { class: 'empty', text: n })); });
        (r.options || []).forEach(function (o, i) {
          var victims = (o.victims || []).map(function (v) { return v.model + '/' + v.config; }).join(', ');
          var row = el('div', { style: { margin: '4px 0' } },
            badge('#' + (i + 1) + ' ' + o.kind, o.kind === 'reuse' ? 'active' : o.kind === 'load_alongside' ? 'running' : 'failed'),
            ' ',
            el('span', { class: 'mono-sm', text: o.model + '/' + o.config + ' on ' + o.device }),
            ' ',
            el('span', { text: o.cost_mib === null || o.cost_mib === undefined ? '' : mib(o.cost_mib) }),
            ' ',
            victims ? el('span', { class: 'value failed', text: 'evicts ' + victims }) : el('span', { text: '' }),
            ' ',
            btn('Apply', function () {
              var apply = function () {
                UAP.api('/api/placement/resolve', {
                  placement_id: q.id,
                  option: i + 1,
                  expected_victims: o.victims || [],
                }).then(function (res) {
                  UAP.drawer('Apply ' + q.id, resultBlock(res));
                  placementState(true);
                });
              };
              if (o.kind === 'displace') {
                UAP.confirm('Apply #' + (i + 1) + ' — unload ' + (victims || 'the victim set') + ' and load ' + o.model + '/' + o.config + '?').then(function (yes) { if (yes) apply(); });
              } else apply();
            }, 'btn-primary'));
          optionsBox.appendChild(row);
        });
        if (!(r.options || []).length) optionsBox.appendChild(empty('No viable option — the registry/budget refuses this request'));
      }).catch(function (e) {
        UAP.clear(optionsBox);
        optionsBox.appendChild(el('div', { class: 'empty', text: 'Preview failed: ' + e.message }));
      });
    };
    loadOptions();

    inner.appendChild(el('div', { style: { marginTop: '8px' } },
      btn('Dismiss', function () {
        UAP.confirm('Dismiss parked request ' + q.id + ' for ' + q.requested_model + '?').then(function (yes) {
          if (!yes) return;
          UAP.api('/api/placement/dismiss', { placement_id: q.id }).then(function () {
            UAP.toast('Dismissed ' + q.id, 'ok');
            placementState(true);
          });
        });
      })));

    return el('div', { class: 'panel' }, head, body);
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

  // ── phase-4 auto policy (§4.4.1): the UI twin of `uap models auto` ──
  function renderAuto(p, d) {
    var auto = d.auto || { enabled: false, allow_displace: [] };
    var models = (d.models || []).map(function (m) { return m.model; });
    p.appendChild(kv('auto-load', auto.enabled ? 'ENABLED — non-displacing options load automatically' : 'disabled — every park waits for a manual apply', auto.enabled ? 'green' : 'yellow'));
    p.appendChild(el('div', { style: { margin: '8px 0' } },
      btn(auto.enabled ? 'Disable' : 'Enable', function () {
        UAP.api('/api/placement/auto', auto.enabled ? { disable: true } : { enable: true }).then(function (next) {
          UAP.toast('auto-load ' + (next.enabled ? 'enabled' : 'disabled'), 'ok');
          placementState(true);
        });
      }, auto.enabled ? '' : 'btn-primary')));

    p.appendChild(el('h3', {}, 'Displacement allowlist (standing consent)'));
    var allow = auto.allow_displace || [];
    if (!allow.length) p.appendChild(empty('Empty — displacement always parks for the operator'));
    allow.forEach(function (m) {
      p.appendChild(el('div', { style: { margin: '2px 0' } },
        el('span', { class: 'mono-sm', text: m }),
        ' ',
        btn('Remove', function () {
          UAP.api('/api/placement/auto', { disallow_displace: [m] }).then(function () {
            UAP.toast('removed ' + m + ' from the allowlist', 'ok');
            placementState(true);
          });
        })));
    });
    var unlisted = models.filter(function (m) { return allow.indexOf(m) === -1; });
    if (unlisted.length) {
      var sel = el('select', { style: { marginRight: '8px' } });
      unlisted.forEach(function (m) { sel.appendChild(el('option', { value: m, text: m })); });
      p.appendChild(el('div', { style: { margin: '8px 0' } }, sel,
        btn('Allow displacement…', function () {
          var m = sel.value;
          if (!m) return;
          UAP.confirm('Allow auto-DISPLACEMENT for ' + m + '? A parked request for it will UNLOAD the current resident(s) — the minimal set that makes room, re-evaluated at load time — and load ' + m + ' WITHOUT an operator prompt between them.').then(function (yes) {
            if (!yes) return;
            UAP.api('/api/placement/auto', { allow_displace: [m], yes: true }).then(function () {
              UAP.toast(m + ' may auto-displace', 'ok');
              placementState(true);
            });
          });
        })));
    }
  }

  function renderPreview(p, d) {
    p.appendChild(el('div', { class: 'muted', text: 'Ranked placement options for a requested model — the same computation the proxy gate uses (reuse > alongside > smallest displace).' }));
    // Dropdown from the registry (keys + advertised ids), not free text: the
    // operator should not have to remember wire ids.
    var choices = [];
    (d.models || []).forEach(function (m) {
      choices.push(m.model);
      (m.advertises || []).forEach(function (id) { choices.push(id); });
    });
    var input = el('input', { type: 'text', placeholder: 'model id, e.g. ' + (choices[0] || 'Qwen3.8-27B'), style: { width: '320px', marginRight: '8px' } });
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
    if (choices.length) {
      var sel = el('select', { style: { marginRight: '8px' }, onchange: function () { input.value = sel.value; } });
      choices.forEach(function (c) { sel.appendChild(el('option', { value: c, text: c })); });
      p.appendChild(el('div', { style: { marginBottom: '8px' } }, sel, input, el('button', { class: 'btn', text: 'Preview', onclick: run })));
    } else {
      p.appendChild(el('div', { style: { marginBottom: '8px' } }, input, el('button', { class: 'btn', text: 'Preview', onclick: run })));
    }
    p.appendChild(out);
  }

  UAP.registerTab('models', {
    label: 'Models',
    render: function (root) {
      UAP.clear(root);
      var place = panel('Model Placement');
      var reg = panel('Model Registry');
      var prev = panel('Placement Preview');
      var auto = panel('Auto-load Policy');
      root.appendChild(place);
      root.appendChild(reg);
      root.appendChild(prev);
      root.appendChild(auto);
      placementState()
        .then(function (d) {
          UAP.clear(place);
          UAP.clear(reg);
          UAP.clear(auto);
          renderPlacement(place, d);
          renderRegistry(reg, d);
          renderAuto(auto, d);
          renderPreview(prev, d);
        })
        .catch(function (e) {
          place.appendChild(empty('Placement state unavailable: ' + e.message));
        });
    },
  });
})();
