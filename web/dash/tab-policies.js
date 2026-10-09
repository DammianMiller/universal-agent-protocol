/**
 * tab-policies.js — Policy management panel.
 *
 * Lists every policy ordered by firing priority (fires-earliest first) and lets
 * the operator: view each policy's description + full prompt, toggle it, change
 * level/stage, duplicate it, drag-and-drop to reorder (manual), ask for an
 * intelligent order (heuristic + AI refine), dedupe, and import/export the whole
 * set. All DOM is built with UAP.el (no innerHTML), mutations go through UAP.api
 * (token-guarded); GET reads use fetch on UAP.API_URL.
 */
(function () {
  'use strict';
  if (typeof UAP === 'undefined' || !UAP.registerTab) return;
  var el = UAP.el, api = UAP.api, toast = UAP.toast;

  function get(path) {
    return fetch(UAP.API_URL + path).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  var LEVELS = ['REQUIRED', 'RECOMMENDED', 'OPTIONAL'];
  var STAGES = ['pre-exec', 'always', 'post-exec', 'review'];

  function badge(text, cls) { return el('span', { class: 'pol-badge ' + (cls || ''), text: text }); }

  function reloadInto(listEl) {
    UAP.clear(listEl);
    listEl.appendChild(el('div', { class: 'muted', text: 'Loading policies…' }));
    return get('/api/policies').then(function (d) {
      renderList(listEl, (d && d.policies) || []);
    }).catch(function (e) {
      UAP.clear(listEl);
      listEl.appendChild(el('div', { class: 'empty', text: 'Failed to load policies: ' + e.message }));
    });
  }

  // Drag-and-drop reorder: track the dragged row, reorder DOM on hover, then
  // persist the new id order via /api/policies/reorder on drop.
  function attachDnD(row, listEl) {
    row.setAttribute('draggable', 'true');
    row.addEventListener('dragstart', function (e) {
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', row.dataset.id); } catch (_) {}
    });
    row.addEventListener('dragend', function () {
      row.classList.remove('dragging');
      persistOrder(listEl);
    });
    row.addEventListener('dragover', function (e) {
      e.preventDefault();
      var dragging = listEl.querySelector('.pol-row.dragging');
      if (!dragging || dragging === row) return;
      var rect = row.getBoundingClientRect();
      var after = (e.clientY - rect.top) > rect.height / 2;
      listEl.insertBefore(dragging, after ? row.nextSibling : row);
    });
  }

  function persistOrder(listEl) {
    var ids = [];
    listEl.querySelectorAll('.pol-row').forEach(function (r) { ids.push(r.dataset.id); });
    api('/api/policies/reorder', { order: ids })
      .then(function () { toast('Order saved', 'ok'); })
      .catch(function () {});
  }

  function policyRow(p, listEl) {
    var row = el('div', { class: 'pol-row' + (p.isActive ? '' : ' off') });
    row.dataset.id = p.id;
    var handle = el('span', { class: 'pol-handle', title: 'Drag to reorder' }, '⠿');
    var main = el('div', { class: 'pol-main' },
      el('div', { class: 'pol-name', text: p.name }),
      el('div', { class: 'pol-desc', text: p.description || '(no description)' }),
      el('div', { class: 'pol-badges' },
        badge(p.level, 'lvl-' + String(p.level || '').toLowerCase()),
        badge(p.stage, 'stage'),
        badge(p.category, 'cat'),
        badge('prio ' + p.priority, 'prio')
      )
    );
    var actions = el('div', { class: 'pol-actions' },
      el('button', { class: 'btn btn-sm', title: 'View description + prompt', onclick: function () { openDetail(p.id, listEl); } }, 'View'),
      el('button', { class: 'btn btn-sm', title: 'Duplicate', onclick: function () { duplicate(p.id, listEl); } }, 'Duplicate'),
      el('button', {
        class: 'btn btn-sm ' + (p.isActive ? 'btn-on' : 'btn-off'),
        title: p.isActive ? 'Enabled — click to disable' : 'Disabled — click to enable',
        onclick: function () { toggle(p.id, listEl); }
      }, p.isActive ? 'On' : 'Off')
    );
    row.appendChild(handle);
    row.appendChild(main);
    row.appendChild(actions);
    attachDnD(row, listEl);
    return row;
  }

  function renderList(listEl, policies) {
    UAP.clear(listEl);
    if (!policies.length) {
      listEl.appendChild(el('div', { class: 'empty', text: 'No policies installed. Import a bundle or run setup.' }));
      return;
    }
    policies.forEach(function (p) { listEl.appendChild(policyRow(p, listEl)); });
  }

  function toggle(id, listEl) {
    api('/api/policy/' + id + '/toggle').then(function () { reloadInto(listEl); }).catch(function () {});
  }

  function duplicate(id, listEl) {
    api('/api/policy/' + id + '/duplicate').then(function () {
      toast('Policy duplicated', 'ok');
      reloadInto(listEl);
    }).catch(function () {});
  }

  function openDetail(id, listEl) {
    get('/api/policy/' + id).then(function (p) {
      var after = function () { if (listEl) reloadInto(listEl); };
      var prioInput = el('input', { type: 'number', min: '0', step: '1', value: String(p.priority == null ? '' : p.priority), style: { width: '60px' } });
      prioInput.addEventListener('change', function () {
        var n = Math.max(0, Math.round(Number(prioInput.value)));
        if (!isFinite(n)) return;
        api('/api/policy/' + id + '/priority', { priority: n }).then(function () { toast('Priority updated', 'ok'); after(); });
      });
      var body = el('div', { class: 'pol-detail' },
        el('div', { class: 'pol-badges' },
          badge(p.level, 'lvl-' + String(p.level || '').toLowerCase()),
          badge(p.stage, 'stage'),
          badge(p.category, 'cat'),
          badge('prio ' + p.priority, 'prio'),
          badge(p.isActive ? 'enabled' : 'disabled', p.isActive ? 'on' : 'off')
        ),
        el('label', { class: 'field' }, 'Priority',
          prioInput),
        el('label', { class: 'field' }, 'Level',
          selectFor(LEVELS, p.level, function (v) { api('/api/policy/' + id + '/level', { level: v }).then(function () { toast('Level updated', 'ok'); after(); }); })),
        el('label', { class: 'field' }, 'Stage',
          selectFor(STAGES, p.stage, function (v) { api('/api/policy/' + id + '/stage', { stage: v }).then(function () { toast('Stage updated', 'ok'); after(); }); })),
        el('div', { class: 'pol-section-label', text: 'Description' }),
        el('div', { class: 'pol-desc-full', text: p.description || '(none)' }),
        el('div', { class: 'pol-section-label', text: 'Prompt (rawMarkdown)' }),
        el('pre', { class: 'pol-prompt', text: p.rawMarkdown || '' })
      );
      UAP.drawer(p.name, body);
    }).catch(function (e) { toast('Failed to load policy: ' + e.message, 'err'); });
  }

  function selectFor(options, current, onChange) {
    var sel = el('select', { class: 'pol-select' });
    options.forEach(function (o) {
      var opt = el('option', { value: o, text: o });
      if (o === current) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }

  function suggestOrder(listEl) {
    toast('Computing intelligent order…', 'ok');
    api('/api/policies/suggest-order', { ai: true }).then(function (res) {
      var order = res.order || [];
      var list = el('ol', { class: 'pol-suggest-list' });
      order.forEach(function (o) { list.appendChild(el('li', { text: o.name })); });
      var body = el('div', { class: 'pol-suggest' },
        el('div', { class: 'pol-badges' }, badge(res.source === 'ai' ? 'AI refined' : 'heuristic', res.source === 'ai' ? 'on' : 'cat')),
        el('div', { class: 'pol-section-label', text: 'Rationale' }),
        el('div', { class: 'pol-desc-full', text: res.rationale || '' }),
        el('div', { class: 'pol-section-label', text: 'Proposed firing order (first fires earliest)' }),
        list,
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn btn-primary', onclick: function () {
            api('/api/policies/reorder', { order: order.map(function (o) { return o.id; }) }).then(function () {
              toast('Applied intelligent order', 'ok');
              UAP.closeDrawer();
              reloadInto(listEl);
            });
          } }, 'Apply this order'))
      );
      UAP.drawer('Intelligent policy order', body);
    }).catch(function (e) { toast('Suggest failed: ' + e.message, 'err'); });
  }

  function dedupe(listEl) {
    api('/api/policies/dedupe').then(function (res) {
      toast(res.removed ? ('Removed ' + res.removed + ' duplicate(s)') : 'No duplicates found', 'ok');
      reloadInto(listEl);
    }).catch(function () {});
  }

  function exportPolicies() {
    // GET download — navigate to the export endpoint (Content-Disposition attachment).
    var a = el('a', { href: UAP.API_URL + '/api/policies/export', download: 'uap-policies.json' });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function importPolicies(listEl) {
    var input = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var bundle;
        try { bundle = JSON.parse(String(reader.result)); }
        catch (e) { toast('Invalid JSON bundle', 'err'); return; }
        api('/api/policies/import', bundle).then(function (res) {
          toast('Imported ' + (res.imported || 0) + ' policies', 'ok');
          reloadInto(listEl);
        }).catch(function () {});
      };
      reader.readAsText(file);
    });
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  }

  // ── Compliance & Audit (restored from the inline tab this file overrides —
  // the override dropped it, but the data still ships in every snapshot) ──
  function fillEvents(feed) {
    UAP.clear(feed);
    var ev = (UAP.liveEvents || []).slice(0, 20);
    if (!ev.length) { feed.appendChild(el('div', { class: 'empty', text: 'Waiting for events…' })); return; }
    ev.forEach(function (e) {
      if (typeof UAP.eventRow === 'function') feed.appendChild(UAP.eventRow(e));
      else feed.appendChild(el('div', { class: 'audit-row', text: (e.title || e.message || '') + ' — ' + (e.detail || '') }));
    });
  }
  UAP.onEvents(function () {
    var f = document.getElementById('pol-live-events');
    if (f) fillEvents(f);
  });

  function renderCompliance(root) {
    var d = UAP.state || {};
    var compliance = d.compliance || {};
    var audit = d.auditTrail || [];
    var cp = el('div', { class: 'panel' }, el('h2', {}, 'Compliance & Audit'));
    cp.appendChild(el('h3', {}, 'Block Rate Trend'));
    cp.appendChild(el('div', { class: 'chart-container chart-spark', id: 'pol-chart-block' }));
    cp.appendChild(el('h3', {}, 'Failures by Mechanism'));
    var fbm = compliance.failuresByMechanism || {};
    var me = Object.keys(fbm).map(function (k) { return [k, fbm[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    if (me.length) {
      var max = Math.max.apply(null, me.map(function (x) { return x[1]; }).concat([1]));
      var mb = el('div', {});
      me.forEach(function (m) {
        mb.appendChild(el('div', { class: 'bar-container' },
          el('span', { class: 'bar-label', style: { width: '120px' }, text: m[0] }),
          el('div', { class: 'bar red', style: { width: Math.round((m[1] / max) * 180) + 'px' } }),
          el('span', { class: 'bar-value', text: String(m[1]) })));
      });
      cp.appendChild(mb);
    } else cp.appendChild(el('div', { class: 'empty', text: 'No failure mechanisms' }));
    cp.appendChild(el('h3', {}, 'Recent Failures'));
    var rf = compliance.recentFailures || [];
    var thead = el('tr', {}); ['Time', 'Policy', 'Op', 'Mechanism', 'Reason'].forEach(function (x) { thead.appendChild(el('th', { text: x })); });
    var ft = el('table', {}, thead);
    rf.slice(0, 10).forEach(function (f) {
      var tr = el('tr', {},
        el('td', { text: (f.executedAt || '').slice(11, 19) }),
        el('td', { text: f.policyName || f.policyId || '-' }),
        el('td', { text: f.operation || '-' }),
        el('td', { text: f.defeatedMechanism || '-' }),
        el('td', { text: (f.reason || '-').slice(0, 60) }));
      ft.appendChild(tr);
    });
    cp.appendChild(rf.length ? el('div', { class: 'table-wrap' }, ft) : el('div', { class: 'empty', text: 'No recent failures' }));
    cp.appendChild(el('h3', {}, 'Audit Trail'));
    var at = el('div', {});
    if (audit.length) {
      audit.slice(0, 15).forEach(function (e) {
        var ts = (typeof e.executedAt === 'string' && e.executedAt.length >= 19) ? e.executedAt.slice(11, 19) : (e.executedAt || '-');
        at.appendChild(el('div', { class: 'audit-row' },
          el('span', { class: 'audit-time', text: ts }),
          el('span', { class: 'audit-icon ' + (e.allowed ? 'pass' : 'block'), text: e.allowed ? 'PASS' : 'BLOCK' }),
          el('span', { class: 'audit-policy', text: (e.policyId || '').slice(0, 8) }),
          el('span', { class: 'audit-op', text: e.operation || '' }),
          el('span', { class: 'audit-reason', text: e.reason || '' })));
      });
    } else at.appendChild(el('div', { class: 'empty', text: 'No audit entries' }));
    cp.appendChild(at);
    cp.appendChild(el('h3', {}, 'Live Events'));
    var feed = el('div', { class: 'event-feed', id: 'pol-live-events' });
    fillEvents(feed);
    cp.appendChild(feed);
    root.appendChild(cp);
    UAP.charts.syncSpark('pol-chart-block', d.timeSeries || [], UAP.charts.parseBR, UAP.charts.CC.blockRate, 'Block Rate %');
  }

  function render(root) {
    UAP.clear(root);
    var listEl = el('div', { class: 'pol-list' });
    var toolbar = el('div', { class: 'pol-toolbar' },
      el('button', { class: 'btn btn-primary', onclick: function () { suggestOrder(listEl); } }, '✨ AI suggest order'),
      el('button', { class: 'btn', onclick: function () { dedupe(listEl); } }, 'Dedupe'),
      el('button', { class: 'btn', onclick: function () { importPolicies(listEl); } }, 'Import'),
      el('button', { class: 'btn', onclick: function () { exportPolicies(); } }, 'Export'),
      el('button', { class: 'btn', onclick: function () { reloadInto(listEl); } }, 'Refresh')
    );
    root.appendChild(el('div', { class: 'pol-hint', text: 'Drag rows to reorder (earlier = fires first). Order minimizes wasted turns: cheap, high-block gates fire first.' }));
    root.appendChild(toolbar);
    root.appendChild(listEl);
    reloadInto(listEl);
    renderCompliance(root);
  }

  UAP.registerTab('policies', { label: 'Policies', render: render });
})();
