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
      el('button', { class: 'btn btn-sm', title: 'View description + prompt', onclick: function () { openDetail(p.id); } }, 'View'),
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

  function openDetail(id) {
    get('/api/policy/' + id).then(function (p) {
      var body = el('div', { class: 'pol-detail' },
        el('div', { class: 'pol-badges' },
          badge(p.level, 'lvl-' + String(p.level || '').toLowerCase()),
          badge(p.stage, 'stage'),
          badge(p.category, 'cat'),
          badge('prio ' + p.priority, 'prio'),
          badge(p.isActive ? 'enabled' : 'disabled', p.isActive ? 'on' : 'off')
        ),
        el('label', { class: 'field' }, 'Level',
          selectFor(LEVELS, p.level, function (v) { api('/api/policy/' + id + '/level', { level: v }).then(function () { toast('Level updated', 'ok'); }); })),
        el('label', { class: 'field' }, 'Stage',
          selectFor(STAGES, p.stage, function (v) { api('/api/policy/' + id + '/stage', { stage: v }).then(function () { toast('Stage updated', 'ok'); }); })),
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
  }

  UAP.registerTab('policies', { label: 'Policies', render: render });
})();
