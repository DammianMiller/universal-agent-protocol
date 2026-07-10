/* UAP Dashboard tabs — 8 views registered against the core UAP shell.
 * Loaded after core.js; calls UAP.start() at the end. */
(function () {
  'use strict';
  var U = window.UAP;
  var el = U.el, esc = U.esc, fmtNum = U.fmtNum, fmtUsd = U.fmtUsd, fmtKB = U.fmtKB, modelName = U.modelName;

  // ── shared render helpers ──
  function h(tag, cls, txt) { return el(tag, { class: cls, text: txt }); }
  function kv(label, value, cls) { return el('div', { class: 'kv' }, el('span', { class: 'label', text: label }), el('span', { class: 'value ' + (cls || ''), text: value })); }
  function empty(msg) { return el('div', { class: 'empty', text: msg || 'No data' }); }
  function panel(title, actions) {
    var head = el('h2', {}, title);
    if (actions) { var wrap = el('span', { class: 'h2-actions' }); actions.forEach(function (a) { wrap.appendChild(a); }); head.appendChild(wrap); }
    var p = el('div', { class: 'panel' }, head);
    return p;
  }
  function statusBadge(s) { s = s || 'idle'; var map = { active: 'active', in_progress: 'active', completed: 'completed', done: 'completed', running: 'running', delivered: 'delivered', failed: 'failed', interrupted: 'interrupted', blocked: 'failed', idle: 'idle', open: 'idle', pending: 'idle', wont_do: 'idle' }; return el('span', { class: 'badge ' + (map[s] || 'idle'), text: s }); }
  // Build a <table> node from header list + row builder returning an array of cells (nodes/strings).
  function tableNode(headers, items, rowFn, rowClick) {
    var thead = el('tr', {}); headers.forEach(function (hd) { thead.appendChild(el('th', { text: hd })); });
    var t = el('table', {}, thead);
    items.forEach(function (it, i) {
      var cells = rowFn(it, i);
      var tr = el('tr', rowClick ? { class: 'clickable', onclick: function () { rowClick(it); } } : {});
      cells.forEach(function (c) { tr.appendChild(el('td', {}, c)); });
      t.appendChild(tr);
    });
    return el('div', { class: 'table-wrap' }, t);
  }
  function sig(obj) { try { return JSON.stringify(obj); } catch (e) { return String(Date.now()); } }
  // DeliverRunState has no scalar 'phase'; derive a display string from phases/checkpoint.
  function runPhase(r) {
    if (r.phases && r.phases.length) { var i = r.phaseIndex || 0; var ph = r.phases[Math.min(i, r.phases.length - 1)]; if (ph) return 'phase ' + (i + 1) + '/' + r.phases.length + ': ' + (ph.title || ph.id); }
    if (r.checkpoint && r.checkpoint.turn) return 'turn ' + r.checkpoint.turn;
    return '-';
  }

  // ═══════════════════════════ OVERVIEW ═══════════════════════════
  U.registerTab('overview', (function () {
    function tile(label, value, cls, sub, goId) {
      return el('div', { class: 'tile', tabindex: '0', role: 'button', onclick: function () { if (goId) U.goto(goId); }, onkeydown: function (e) { if ((e.key === 'Enter' || e.key === ' ') && goId) { e.preventDefault(); U.goto(goId); } } },
        el('div', { class: 'tile-label', text: label }), el('div', { class: 'tile-value ' + (cls || ''), text: value }), sub ? el('div', { class: 'tile-sub', text: sub }) : null);
    }
    function fillTiles(host, d) {
      var t = d.tasks || {}, coord = d.coordination || {}, runs = d.deliverRuns || [], led = d.orchestrationTree && d.orchestrationTree.ledger, sv = d.savingsByInfluence || {}, mem = d.memory || {}, comp = d.compliance || {};
      var pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
      var running = runs.filter(function (r) { return r.status === 'running'; }).length;
      var orchPct = led ? (led.total ? Math.round((led.done / led.total) * 100) : 0) : ((d.orchestrationTree && d.orchestrationTree.ledger) ? d.orchestrationTree.ledger.pct : 0);
      var memEntries = ((mem.l1 && mem.l1.entries) || 0) + ((mem.l2 && mem.l2.entries) || 0) + ((mem.l4 && mem.l4.entities) || 0);
      U.clear(host);
      [
        tile('Tasks', pct + '%', pct >= 100 ? 'green' : 'cyan', (t.done || 0) + '/' + (t.total || 0) + ' done', 'tasks'),
        tile('Active Agents', String(coord.activeAgents || 0), 'purple', (coord.totalAgents || 0) + ' total', 'agents'),
        tile('Deliver Runs', String(running), running ? 'cyan' : '', (runs.length) + ' tracked', 'deliver'),
        tile('Orchestration', orchPct + '%', orchPct >= 100 ? 'green' : 'cyan', led ? (led.done + '/' + led.total + ' items') : 'no active build', 'orchestration'),
        tile('Tokens Saved', fmtNum(sv.totalTokensSaved || 0), 'green', fmtUsd(sv.totalCostSavedUsd || 0) + ' saved', 'memory'),
        tile('Memory', fmtNum(memEntries), 'cyan', ((mem.l3 && mem.l3.status) || 'Qdrant') + '', 'memory'),
        tile('Policy Blocks', String(comp.totalBlocks || 0), (comp.totalBlocks ? 'red' : 'green'), (comp.blockRate || '0%') + ' rate', 'policies'),
        tile('Worktrees', String(coord.activeWorktrees || 0), '', (coord.activeClaims || 0) + ' claims', 'agents'),
      ].forEach(function (n) { host.appendChild(n); });
    }
    function fillSummaries(host, d) {
      U.clear(host);
      var coord = d.coordination || {}, agents = (coord.agents || []).slice(0, 8);
      var ap = panel('Active Agents');
      ap.appendChild(agents.length ? tableNode(['Name', 'Status', 'Task', 'Started'], agents, function (a) {
        return [a.name || a.id || '?', statusBadge(a.status), el('span', { class: 'muted', text: (a.task || '-') }), U.timeAgo(a.startedAt)];
      }, function () { U.goto('agents'); }) : empty('No active agents'));
      host.appendChild(ap);

      var runs = (d.deliverRuns || []).slice(0, 6);
      var rp = panel('Deliver Runs');
      rp.appendChild(runs.length ? tableNode(['Run', 'Status', 'Phase', 'Updated'], runs, function (r) {
        return [el('span', { class: 'mono-sm', text: (r.runId || '').slice(0, 10) }), statusBadge(r.status), runPhase(r), U.timeAgo(r.updatedAt || r.createdAt)];
      }, function () { U.goto('deliver'); }) : empty('No deliver runs tracked'));
      host.appendChild(rp);

      var led = d.orchestrationTree && d.orchestrationTree.ledger;
      var op = panel('Orchestration');
      if (led && led.total) {
        var pct = led.pct != null ? led.pct : Math.round((led.done / led.total) * 100);
        op.appendChild(el('div', {}, el('div', { class: 'kv' }, el('span', { class: 'label', text: (led.mission || 'Active build').slice(0, 60) }), el('span', { class: 'value cyan', text: led.done + '/' + led.total + ' (' + pct + '%)' })),
          el('div', { class: 'progress-track' }, el('div', { class: 'progress-fill', style: { width: pct + '%' } }))));
      } else op.appendChild(empty('No active orchestration'));
      host.appendChild(op);

      var ev = (U.liveEvents || []).slice(0, 10);
      var ep = panel('Recent Activity');
      var feed = el('div', { class: 'event-feed' });
      if (ev.length) ev.forEach(function (e) { feed.appendChild(eventRow(e)); }); else feed.appendChild(empty('Waiting for events…'));
      ep.appendChild(feed); host.appendChild(ep);
    }
    function build(root, d) {
      var tiles = el('div', { class: 'tile-grid', id: 'ov-tiles' });
      var hero = el('div', { class: 'hero-row' },
        panelWith('Tasks & Agents', el('div', { class: 'chart-container chart-hero', id: 'ov-chart-tasks' })),
        panelWith('Compression & Memory', el('div', { class: 'chart-container chart-hero', id: 'ov-chart-comp' })));
      var summaries = el('div', { class: 'metrics-row', id: 'ov-summaries', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' } });
      root.appendChild(tiles); root.appendChild(hero); root.appendChild(summaries);
      fillTiles(tiles, d); fillSummaries(summaries, d); paintCharts(d);
    }
    function panelWith(title, node) { var p = panel(title); p.appendChild(node); return p; }
    function paintCharts(d) { var ts = d.timeSeries || []; U.charts.syncHero('ov-chart-tasks', 'tasks', ts); U.charts.syncHero('ov-chart-comp', 'comp', ts); }
    return {
      label: 'Overview',
      render: function (root, d) { build(root, d); },
      update: function (root, d) { var t = document.getElementById('ov-tiles'), s = document.getElementById('ov-summaries'); if (!t || !s) { U.clear(root); build(root, d); return; } fillTiles(t, d); fillSummaries(s, d); paintCharts(d); },
    };
  })());

  function eventRow(ev) {
    var cat = ev.category || ev.type || 'system';
    var ts = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '';
    var title = ev.title || ev.message || '';
    var detail = ev.detail || '';
    var msg = (title && detail) ? (title + ' — ' + detail) : (title || detail || String((ev.data && JSON.stringify(ev.data)) || '').slice(0, 80));
    return el('div', { class: 'event-row' }, el('span', { class: 'event-time', text: ts }), el('span', { class: 'event-cat cat-' + cat, text: cat }), el('span', { class: 'event-msg', text: msg }));
  }

  // ═══════════════════════════ TASKS & EPICS ═══════════════════════════
  U.registerTab('tasks', (function () {
    var TYPE_ICONS = { task: '◆', bug: '🐛', feature: '✨', epic: '🎯', chore: '🔧', story: '📖' };
    var PRIO = ['P0', 'P1', 'P2', 'P3', 'P4'];
    var COLS = [['open', 'Open'], ['in_progress', 'In Progress'], ['blocked', 'Blocked'], ['done', 'Done'], ['wont_do', "Won't Do"]];
    var filterStatus = 'all', lastSig = null;

    function openTaskDrawer(task, d) {
      var body = el('div', {});
      body.appendChild(kv('ID', task.id, 'cyan'));
      body.appendChild(kv('Type', task.type || 'task'));
      body.appendChild(kv('Status', task.status || '-'));
      body.appendChild(kv('Priority', PRIO[task.priority] || 'P2'));
      body.appendChild(kv('Assignee', task.assignee || 'unassigned'));
      if (task.parentTitle) body.appendChild(kv('Parent', task.parentTitle));
      body.appendChild(el('h3', {}, 'Title'));
      body.appendChild(el('div', { class: 'muted', text: task.title || '-' }));

      body.appendChild(el('h3', {}, 'Change status'));
      var statusRow = el('div', { class: 'toolbar' });
      ['open', 'in_progress', 'blocked', 'done', 'wont_do'].forEach(function (s) {
        statusRow.appendChild(el('button', { class: 'btn' + (s === task.status ? ' btn-primary' : ''), onclick: function () { U.api('/api/tasks/' + encodeURIComponent(task.id) + '/update', { status: s }).then(function () { U.toast('Status → ' + s, 'ok'); U.closeDrawer(); }); } }, s));
      });
      body.appendChild(statusRow);

      body.appendChild(el('h3', {}, 'Actions'));
      var actions = el('div', { class: 'toolbar' });
      actions.appendChild(el('button', { class: 'btn', onclick: function () {
        U.form('Set assignee', [{ name: 'assignee', label: 'Assignee', value: task.assignee || '' }]).then(function (v) { if (v) U.api('/api/tasks/' + encodeURIComponent(task.id) + '/update', { assignee: v.assignee }).then(function () { U.toast('Assignee updated', 'ok'); U.closeDrawer(); }); });
      } }, 'Set assignee'));
      actions.appendChild(el('button', { class: 'btn', onclick: function () {
        U.form('Edit title', [{ name: 'title', label: 'Title', value: task.title || '' }]).then(function (v) { if (v) U.api('/api/tasks/' + encodeURIComponent(task.id) + '/update', { title: v.title }).then(function () { U.toast('Title updated', 'ok'); U.closeDrawer(); }); });
      } }, 'Edit title'));
      if (task.status !== 'done') actions.appendChild(el('button', { class: 'btn btn-primary', onclick: function () { U.api('/api/tasks/' + encodeURIComponent(task.id) + '/close', {}).then(function () { U.toast('Task closed', 'ok'); U.closeDrawer(); }); } }, 'Close (done)'));
      actions.appendChild(el('button', { class: 'btn btn-danger', onclick: function () {
        U.confirm('Delete task ' + task.id + '? This removes its dependencies, history and activity. This cannot be undone.', { danger: true }).then(function (ok) { if (ok) U.api('/api/tasks/' + encodeURIComponent(task.id) + '/delete', {}).then(function () { U.toast('Task deleted', 'ok'); U.closeDrawer(); }); });
      } }, 'Delete'));
      body.appendChild(actions);

      var epicLed = d.orchestrationTree && d.orchestrationTree.ledger;
      if (task.type === 'epic' && epicLed && epicLed.items) {
        body.appendChild(el('h3', {}, 'Epic ledger'));
        body.appendChild(ledgerItems(epicLed));
      }
      U.drawer((TYPE_ICONS[task.type] || '◆') + ' ' + (task.title || task.id).slice(0, 40), body);
    }

    function card(item, d) {
      var pc = 'p' + (item.priority != null ? item.priority : 2);
      var crumb = (item.depth || 0) > 1 && item.parentId ? el('div', { class: 'card-crumb', text: '↳ ' + (item.parentTitle || item.parentId) }) : null;
      var c = el('div', { class: 'kanban-card' + ((item.depth || 0) > 0 ? ' card-child' : ''), dataset: { id: item.id }, onclick: function () { openTaskDrawer(item, d); } },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, el('span', { class: 'card-id', text: item.id }), el('span', {}, TYPE_ICONS[item.type] || '◆')),
        crumb,
        el('div', { class: 'card-title', text: item.title || 'Untitled' }),
        el('div', { class: 'card-meta' }, el('span', { class: 'card-priority ' + pc, text: PRIO[item.priority] || 'P2' }), el('span', { text: (item.type || 'task') + (item.assignee ? ' · ' + item.assignee : '') })));
      return c;
    }
    function renderBoard(board, d) {
      var tasks = d.tasks || {}, items = tasks.items || [];
      if (filterStatus !== 'all') items = items.filter(function (i) { return i.status === filterStatus; });
      var byCol = {}; COLS.forEach(function (c) { byCol[c[0]] = []; });
      var groupCounts = {}, families = {};
      items.forEach(function (i) { if (byCol[i.status]) byCol[i.status].push(i); var g = i.groupId || i.id; groupCounts[g] = (groupCounts[g] || 0) + 1; if ((i.depth || 0) > 0) families[g] = true; });
      for (var g in groupCounts) if (groupCounts[g] > 1) families[g] = true;
      U.clear(board);
      COLS.forEach(function (col) {
        var list = byCol[col[0]] || [];
        var colEl = el('div', { class: 'kanban-col' }, el('div', { class: 'kanban-col-header ' + col[0] }, el('span', { text: col[1] }), el('span', { class: 'col-count', text: String(list.length) })));
        var cards = el('div', { class: 'kanban-cards' });
        if (!list.length) cards.appendChild(el('div', { class: 'kanban-empty', text: 'No tasks' }));
        else {
          var sorted = list.slice().sort(function (a, b) {
            var ga = families[a.groupId || a.id] ? 0 : 1, gb = families[b.groupId || b.id] ? 0 : 1;
            if (ga !== gb) return ga - gb;
            if ((a.groupId || a.id) !== (b.groupId || b.id)) return String(a.groupTitle || a.title || '').localeCompare(String(b.groupTitle || b.title || '')) || String(a.groupId || a.id).localeCompare(String(b.groupId || b.id));
            if ((a.depth || 0) !== (b.depth || 0)) return (a.depth || 0) - (b.depth || 0);
            return (a.priority != null ? a.priority : 2) - (b.priority != null ? b.priority : 2);
          });
          var lastGroup = null;
          sorted.forEach(function (item) {
            var gid = item.groupId || item.id;
            if (families[gid] && gid !== lastGroup) cards.appendChild(el('div', { class: 'kanban-group', text: '▸ ' + (item.groupTitle || gid) }));
            lastGroup = gid;
            cards.appendChild(card(item, d));
          });
        }
        colEl.appendChild(cards); board.appendChild(colEl);
      });
    }
    function build(root, d) {
      var tasks = d.tasks || {};
      var filterSel = el('select', { onchange: function (e) { filterStatus = e.target.value; var b = document.getElementById('kanban-board'); if (b) renderBoard(b, U.state || d); } });
      [['all', 'All statuses']].concat(COLS.map(function (c) { return [c[0], c[1]]; })).forEach(function (o) { filterSel.appendChild(el('option', { value: o[0] }, o[1])); });
      filterSel.value = filterStatus;
      var p = panel('Task Board', [
        el('button', { class: 'btn btn-primary', onclick: function () {
          U.form('New task', [
            { name: 'title', label: 'Title', placeholder: 'What needs doing' },
            { name: 'type', label: 'Type', type: 'select', options: ['task', 'feature', 'bug', 'epic', 'chore', 'story'] },
            { name: 'priority', label: 'Priority (0-4)', type: 'number', value: '2' },
            { name: 'assignee', label: 'Assignee (optional)' },
          ]).then(function (v) { if (v && v.title) U.api('/api/tasks', { title: v.title, type: v.type, priority: Number(v.priority) || 2, assignee: v.assignee || undefined }).then(function () { U.toast('Task created', 'ok'); }); });
        } }, '+ New Task'),
      ]);
      var counts = el('div', { class: 'section-note', text: (tasks.total || 0) + ' tasks · ' + (tasks.done || 0) + ' done · ' + (tasks.inProgress || 0) + ' active · ' + (tasks.blocked || 0) + ' blocked · ' + (tasks.open || 0) + ' open' });
      p.appendChild(counts);
      p.appendChild(el('div', { class: 'toolbar' }, el('span', { class: 'label', text: 'Filter:' }), filterSel));
      var board = el('div', { class: 'kanban', id: 'kanban-board' });
      p.appendChild(board);
      root.appendChild(p);
      lastSig = sig((d.tasks || {}).items);
      renderBoard(board, d);
    }
    return {
      label: 'Tasks & Epics',
      render: function (root, d) { build(root, d); },
      update: function (root, d) { var b = document.getElementById('kanban-board'); if (!b) { U.clear(root); build(root, d); return; } var s = sig((d.tasks || {}).items); if (s !== lastSig) { lastSig = s; renderBoard(b, d); } },
    };
  })());

  function ledgerItems(led) {
    var wrap = el('div', {});
    (led.items || []).forEach(function (it) {
      var row = el('div', { class: 'kv' },
        el('span', { class: 'label' }, (it.kind === 'epic' ? '🎯 ' : '• ') + esc0(it.title || it.id), el('span', { class: 'mono-sm', text: ' ' + (it.status || '') })),
        el('span', {},
          el('button', { class: 'btn', title: 'Mark done', onclick: function () { U.api('/api/ledger/item/' + encodeURIComponent(it.id), { status: 'done' }).then(function () { U.toast('Item done', 'ok'); }); } }, '✓'),
          ' ',
          el('button', { class: 'btn btn-danger', title: 'Mark failed', onclick: function () { U.api('/api/ledger/item/' + encodeURIComponent(it.id), { status: 'failed' }).then(function () { U.toast('Item failed', 'warn'); }); } }, '✗')));
      wrap.appendChild(row);
    });
    return wrap;
  }
  function esc0(s) { return s == null ? '' : String(s); }

  // ═══════════════════════════ AGENTS & SESSIONS ═══════════════════════════
  U.registerTab('agents', (function () {
    var lastSig = null;
    function mergeAgents(d) {
      var out = {}, order = [];
      var coord = (d.coordination && d.coordination.agents) || [];
      coord.forEach(function (a) { out[a.id] = { id: a.id, name: a.name, status: a.status, task: a.task || a.type || '', type: a.type || 'main' }; order.push(a.id); });
      var sess = (d.session && d.session.agents) || [];
      sess.forEach(function (a) { var e = out[a.id] || { id: a.id, name: a.name, status: a.status, task: a.task, type: a.type }; e.tokensIn = a.tokensIn; e.tokensOut = a.tokensOut; e.tokensUsed = a.tokensUsed; e.model = a.model; e.cost = a.cost; e.durationMs = a.durationMs; e.taskCount = a.taskCount; if (!out[a.id]) order.push(a.id); out[a.id] = e; });
      return order.map(function (id) { return out[id]; });
    }
    function agentDrawer(a, d) {
      var body = el('div', {});
      body.appendChild(kv('ID', a.id, 'cyan'));
      body.appendChild(kv('Name', a.name || '-'));
      body.appendChild(kv('Type', a.type || 'main'));
      body.appendChild(kv('Status', a.status || '-'));
      body.appendChild(kv('Task', a.task || '-'));
      if (a.model) body.appendChild(kv('Model', modelName(a.model), 'purple'));
      body.appendChild(el('h3', {}, 'Tokens & cost'));
      body.appendChild(kv('Tokens In', fmtNum(a.tokensIn || 0), 'cyan'));
      body.appendChild(kv('Tokens Out', fmtNum(a.tokensOut || 0), 'green'));
      body.appendChild(kv('Total', fmtNum((a.tokensIn || 0) + (a.tokensOut || 0) || a.tokensUsed || 0), 'purple'));
      body.appendChild(kv('Cost', fmtUsd(a.cost || 0), 'green'));
      if (a.taskCount != null) body.appendChild(kv('Tasks', String(a.taskCount)));
      if (a.durationMs) body.appendChild(kv('Duration', U.fmtDur(a.durationMs)));
      var skills = (d.coordination && d.coordination.skillsPerAgent && d.coordination.skillsPerAgent[a.id]) || [];
      if (skills.length) { body.appendChild(el('h3', {}, 'Skills')); var sc = el('div', { class: 'chip-list' }); skills.forEach(function (s) { sc.appendChild(el('span', { class: 'chip', text: s })); }); body.appendChild(sc); }
      var pats = (d.coordination && d.coordination.patternsPerAgent && d.coordination.patternsPerAgent[a.id]) || [];
      if (pats.length) { body.appendChild(el('h3', {}, 'Patterns')); var pc = el('div', { class: 'chip-list' }); pats.forEach(function (p) { pc.appendChild(el('span', { class: 'chip', text: (p.id || p) + (p.uses ? ' ×' + p.uses : '') })); }); body.appendChild(pc); }
      body.appendChild(el('h3', {}, 'Actions'));
      body.appendChild(el('div', { class: 'toolbar' }, el('button', { class: 'btn btn-danger', onclick: function () {
        U.confirm('Deregister agent ' + (a.name || a.id) + '? Marks its registry row completed and releases its claims (does not kill the OS process).', { danger: true, okLabel: 'Deregister' }).then(function (ok) { if (ok) U.api('/api/agents/' + encodeURIComponent(a.id) + '/deregister', {}).then(function () { U.toast('Agent deregistered', 'ok'); U.closeDrawer(); }); });
      } }, 'Deregister')));
      U.drawer('Agent: ' + (a.name || a.id).slice(0, 40), body);
    }
    function sessionDrawer(s, d) {
      var body = el('div', {});
      var isLive = d.session && d.session.sessionId === s.sessionId;
      var src = isLive ? d.session : s;
      body.appendChild(kv('Session', s.sessionId, 'cyan'));
      body.appendChild(kv('Status', s.status || '-'));
      body.appendChild(kv('Model', modelName(s.model || (src.modelBreakdown && src.modelBreakdown[0] && src.modelBreakdown[0].modelId) || '-'), 'purple'));
      body.appendChild(kv('Tokens In', fmtNum(s.tokensIn || src.tokensIn || 0), 'cyan'));
      body.appendChild(kv('Tokens Out', fmtNum(s.tokensOut || src.tokensOut || 0), 'green'));
      body.appendChild(kv('Cost', fmtUsd(s.totalCost != null ? s.totalCost : src.totalCostUsd || 0), 'green'));
      body.appendChild(kv('Agents', String(s.agentCount != null ? s.agentCount : (src.agents ? src.agents.length : 0))));
      body.appendChild(kv('Tasks', String(s.taskCount || 0)));
      if (isLive && src.agents && src.agents.length) {
        body.appendChild(el('h3', {}, 'Agents (live session)'));
        body.appendChild(tableNode(['Agent', 'Model', 'In', 'Out', 'Cost'], src.agents, function (a) { return [a.name || a.id, modelName(a.model || '?'), fmtNum(a.tokensIn || 0), fmtNum(a.tokensOut || 0), fmtUsd(a.cost || 0)]; }));
      }
      U.drawer('Session: ' + (s.sessionId || '').slice(0, 20), body);
    }
    function build(root, d) {
      var agents = mergeAgents(d);
      var ap = panel('Agents', [el('button', { class: 'btn', onclick: function () { U.confirm('Clean up stale agents (stale heartbeats)?').then(function (ok) { if (ok) U.api('/api/agents/clean', {}).then(function (r) { U.toast('Cleaned ' + ((r && r.cleaned) || 0) + ' stale agents', 'ok'); }); }); } }, 'Clean stale')]);
      if (!agents.length) ap.appendChild(empty('No agents registered'));
      else { var grid = el('div', { class: 'card-grid' }); agents.forEach(function (a) {
        grid.appendChild(el('div', { class: 'entity-card', tabindex: '0', role: 'button', onclick: function () { agentDrawer(a, d); }, onkeydown: function (e) { if (e.key === 'Enter') agentDrawer(a, d); } },
          el('div', { class: 'ec-head' }, el('span', { class: 'badge ' + (a.type || 'main') }, a.type || 'agent'), el('span', { class: 'ec-name', text: a.name || a.id }), statusBadge(a.status)),
          el('div', { class: 'ec-task', text: a.task || '-' }),
          el('div', { class: 'ec-metrics' }, el('span', {}, fmtNum((a.tokensIn || 0) + (a.tokensOut || 0) || a.tokensUsed || 0) + ' tok'), a.model ? el('span', { class: 'muted', text: modelName(a.model) }) : null, el('span', {}, fmtUsd(a.cost || 0)))));
      }); ap.appendChild(grid); }
      root.appendChild(ap);

      var sessions = d.sessions || [];
      var sp = panel('Session History');
      sp.appendChild(sessions.length ? tableNode(['Session', 'Status', 'Model', 'In', 'Out', 'Cost', 'Agents', 'Tasks'], sessions, function (s) {
        return [el('span', {}, (s.sessionId || '-').slice(0, 14), s.status === 'active' ? el('span', { class: 'mono-sm', text: ' (live)' }) : null), statusBadge(s.status), modelName(s.model || '-'), fmtNum(s.tokensIn || 0), fmtNum(s.tokensOut || 0), fmtUsd(s.totalCost || 0), String(s.agentCount || 0), String(s.taskCount || 0)];
      }, function (s) { sessionDrawer(s, d); }) : empty('No session history'));
      root.appendChild(sp);
    }
    return {
      label: 'Agents & Sessions',
      render: function (root, d) { build(root, d); },
      update: function (root, d) { var s = sig({ a: (d.coordination || {}).agents, se: (d.session || {}).agents, h: d.sessions }); if (s !== lastSig) { lastSig = s; U.clear(root); build(root, d); } },
    };
  })());

  // ═══════════════════════════ ORCHESTRATION ═══════════════════════════
  U.registerTab('orchestration', (function () {
    function node(n, depth) {
      var sc = { done: 'green', in_progress: 'cyan', blocked: 'red', failed: 'red', open: '', pending: '' }[n.status] || '';
      var icon = n.type === 'epic' ? '🎯' : n.type === 'feature' ? '✨' : n.type === 'phase' ? '▶' : '•';
      var agents = (n.agents && n.agents.length) ? el('span', { class: 'mono-sm', text: ' [' + n.agents.join(', ') + ']' }) : null;
      var line = el('div', { style: { padding: '3px 0 3px ' + (depth * 16) + 'px', borderLeft: '1px solid var(--border)' } },
        el('span', { class: 'value ' + sc, text: '●' }), ' ' + icon + ' ', el('span', { text: (n.title || n.id).slice(0, 70) }), el('span', { class: 'mono-sm', text: ' ' + (n.status || '') }), agents);
      var wrap = el('div', {}, line);
      (n.children || []).forEach(function (c) { wrap.appendChild(node(c, depth + 1)); });
      return wrap;
    }
    function build(root, d) {
      var ot = d.orchestrationTree || { missions: [], ledger: null, agents: [], hasHierarchy: false };
      var cur = d.orchestrate || 'auto';
      var p = panel('Orchestrator');
      var ctl = el('div', { class: 'toolbar' }, el('span', { class: 'label', text: 'Mode:' }));
      ['on', 'off', 'auto'].forEach(function (st) { ctl.appendChild(el('button', { class: 'btn' + (st === cur ? ' btn-primary' : ''), onclick: function () { U.api('/api/orchestrator', { state: st }).then(function () { U.toast('Orchestrator: ' + st, 'ok'); }); } }, st)); });
      p.appendChild(ctl);
      p.appendChild(el('div', { class: 'section-note', text: (ot.missions || []).length + ' root mission(s) · ' + (ot.agents || []).length + ' agent(s)' }));
      root.appendChild(p);

      var led = ot.ledger;
      if (led && led.total) {
        var lp = panel('Active Build Ledger');
        var pct = led.pct != null ? led.pct : Math.round((led.done / led.total) * 100);
        lp.appendChild(el('div', { class: 'kv' }, el('span', { class: 'label', text: (led.mission || '-').slice(0, 70) }), el('span', { class: 'value cyan', text: led.done + '/' + led.total + ' (' + pct + '%)' })));
        lp.appendChild(el('div', { class: 'progress-track' }, el('div', { class: 'progress-fill', style: { width: pct + '%' } })));
        lp.appendChild(ledgerItems(led));
        lp.appendChild(el('div', { class: 'toolbar' }, el('button', { class: 'btn btn-danger', onclick: function () { U.confirm('Reset the completion ledger? Clears the active multi-epic build state.', { danger: true, okLabel: 'Reset' }).then(function (ok) { if (ok) U.api('/api/ledger/reset', {}).then(function () { U.toast('Ledger reset', 'ok'); }); }); } }, 'Reset ledger')));
        root.appendChild(lp);
      }

      var tp = panel('Mission Hierarchy');
      var withKids = (ot.missions || []).filter(function (m) { return (m.children || []).length > 0; });
      var shown = (withKids.length ? withKids : (ot.missions || [])).slice(0, 30);
      if (!shown.length) tp.appendChild(empty('No orchestrations yet — run an epic/orchestrated build'));
      else shown.forEach(function (m) { tp.appendChild(node(m, 0)); });
      root.appendChild(tp);
    }
    return { label: 'Orchestration', render: build };
  })());

  // ═══════════════════════════ DELIVER ═══════════════════════════
  U.registerTab('deliver', (function () {
    function runDrawer(r) {
      var body = el('div', {});
      body.appendChild(kv('Run ID', r.runId, 'cyan'));
      body.appendChild(kv('Status', r.status || '-'));
      if (r.instruction || r.mission) { body.appendChild(el('h3', {}, 'Instruction')); body.appendChild(el('div', { class: 'muted', text: r.instruction || r.mission })); }
      var _ph = runPhase(r); if (_ph !== '-') body.appendChild(kv('Phase', _ph));
      if (r.taskId) body.appendChild(kv('Task', r.taskId));
      if (r.pid) body.appendChild(kv('PID', String(r.pid)));
      body.appendChild(kv('Started', U.shortTime(r.createdAt)));
      body.appendChild(kv('Updated', U.timeAgo(r.updatedAt || r.createdAt)));
      if (Array.isArray(r.phases) && r.phases.length) { body.appendChild(el('h3', {}, 'Phases')); r.phases.forEach(function (p, i) { body.appendChild(kv((i + 1) + '. ' + (p.title || p.id || '-'), i === (r.phaseIndex || 0) ? 'active' : '')); }); }
      body.appendChild(el('h3', {}, 'Actions'));
      var actions = el('div', { class: 'toolbar' });
      if (r.status === 'running') actions.appendChild(el('button', { class: 'btn btn-danger', onclick: function () { U.confirm('Cancel deliver run ' + r.runId + '? Writes a stop-file (cooperative) and signals the process.', { danger: true, okLabel: 'Cancel run' }).then(function (ok) { if (ok) U.api('/api/deliver/' + encodeURIComponent(r.runId) + '/cancel', {}).then(function () { U.toast('Cancel requested', 'ok'); U.closeDrawer(); }); }); } }, 'Cancel'));
      if (r.status === 'interrupted' || r.status === 'failed') actions.appendChild(el('button', { class: 'btn btn-primary', onclick: function () { U.api('/api/deliver/' + encodeURIComponent(r.runId) + '/resume', {}).then(function () { U.toast('Resume launched', 'ok'); U.closeDrawer(); }); } }, 'Resume'));
      body.appendChild(actions);
      U.drawer('Deliver run ' + (r.runId || '').slice(0, 16), body);
    }
    function build(root, d) {
      var runs = d.deliverRuns || [];
      var p = panel('Deliver Runs', [el('button', { class: 'btn btn-primary', onclick: function () {
        U.form('Launch deliver run', [
          { name: 'instruction', label: 'Instruction', type: 'textarea', placeholder: 'One-line description of what to build' },
          { name: 'model', label: 'Model preset (optional)', placeholder: 'qwen35-a3b' },
          { name: 'maxTurns', label: 'Max turns', type: 'number', value: '5' },
        ]).then(function (v) {
          if (!v || !v.instruction) return;
          U.confirm('Launch a deliver run on this host? This spawns a `uap deliver` subprocess that writes files and runs gates.', { okLabel: 'Launch' }).then(function (ok) {
            if (ok) U.api('/api/deliver/launch', { instruction: v.instruction, model: v.model || undefined, maxTurns: Number(v.maxTurns) || undefined }).then(function (res) { U.toast('Launched' + (res && res.runId ? ' (' + String(res.runId).slice(0, 10) + ')' : ''), 'ok'); });
          });
        });
      } }, '▶ Launch run')]);
      p.appendChild(el('div', { class: 'section-note', text: 'Runs are read from .uap/deliver-runs. Launch spawns a host process; cancel writes a cooperative stop-file and signals the PID.' }));
      p.appendChild(runs.length ? tableNode(['Run', 'Status', 'Phase', 'Task', 'Updated', ''], runs, function (r) {
        var act = el('span', {});
        if (r.status === 'running') act.appendChild(el('button', { class: 'btn btn-danger', onclick: function (e) { e.stopPropagation(); U.confirm('Cancel run ' + r.runId + '?', { danger: true, okLabel: 'Cancel run' }).then(function (ok) { if (ok) U.api('/api/deliver/' + encodeURIComponent(r.runId) + '/cancel', {}).then(function () { U.toast('Cancel requested', 'ok'); }); }); } }, 'Cancel'));
        else if (r.status === 'interrupted' || r.status === 'failed') act.appendChild(el('button', { class: 'btn', onclick: function (e) { e.stopPropagation(); U.api('/api/deliver/' + encodeURIComponent(r.runId) + '/resume', {}).then(function () { U.toast('Resume launched', 'ok'); }); } }, 'Resume'));
        return [el('span', { class: 'mono-sm', text: (r.runId || '').slice(0, 12) }), statusBadge(r.status), runPhase(r), el('span', { class: 'mono-sm', text: r.taskId || '-' }), U.timeAgo(r.updatedAt || r.createdAt), act];
      }, function (r) { runDrawer(r); }) : empty('No deliver runs tracked yet'));
      root.appendChild(p);
    }
    return { label: 'Deliver', render: build };
  })());

  // ═══════════════════════════ POLICIES & COMPLIANCE ═══════════════════════════
  U.registerTab('policies', (function () {
    function build(root, d) {
      var policies = d.policies || [], policyFiles = d.policyFiles || [], compliance = d.compliance || {}, audit = d.auditTrail || [];
      var pm = {}, order = [];
      policies.forEach(function (p) { var key = p.name || p.id; pm[key] = Object.assign({}, p, { source: 'db' }); order.push(key); });
      policyFiles.forEach(function (pf) { if (!pm[pf.name]) { pm[pf.name] = { id: pf.filename, name: pf.name, category: pf.category, level: '-', enforcementStage: '-', isActive: null, source: 'file' }; order.push(pf.name); } });
      var all = order.map(function (k) { return pm[k]; });

      var pp = panel('Policies');
      var thead = el('tr', {}); ['Name', 'Category', 'Level', 'Stage', 'Status', 'Actions'].forEach(function (x) { thead.appendChild(el('th', { text: x })); });
      var tbl = el('table', {}, thead);
      all.forEach(function (p) {
        var isDb = p.source === 'db';
        var actions = el('span', {});
        if (isDb) {
          actions.appendChild(el('button', { class: 'btn', onclick: function () { U.api('/api/policy/' + encodeURIComponent(p.id) + '/toggle', undefined).then(function (r) { U.toast('Policy ' + (r.isActive ? 'enabled' : 'disabled'), 'ok'); }); } }, p.isActive ? 'Disable' : 'Enable'));
          var stageSel = el('select', { onchange: function (e) { U.api('/api/policy/' + encodeURIComponent(p.id) + '/stage', { stage: e.target.value }).then(function () { U.toast('Stage: ' + e.target.value, 'ok'); }); } });
          ['pre-exec', 'post-exec', 'review', 'always'].forEach(function (s) { stageSel.appendChild(el('option', { value: s }, s)); }); stageSel.value = p.enforcementStage;
          var lvlSel = el('select', { onchange: function (e) { U.api('/api/policy/' + encodeURIComponent(p.id) + '/level', { level: e.target.value }).then(function () { U.toast('Level: ' + e.target.value, 'ok'); }); } });
          ['REQUIRED', 'RECOMMENDED', 'OPTIONAL'].forEach(function (l) { lvlSel.appendChild(el('option', { value: l }, l)); }); lvlSel.value = p.level;
          actions.appendChild(document.createTextNode(' ')); actions.appendChild(stageSel); actions.appendChild(document.createTextNode(' ')); actions.appendChild(lvlSel);
        } else actions.appendChild(el('span', { class: 'mono-sm', text: 'file-only' }));
        var status = isDb ? el('span', { class: 'badge ' + (p.isActive ? 'on' : 'off') }, p.isActive ? 'ON' : 'OFF') : el('span', { class: 'badge file-only' }, 'FILE');
        var tr = el('tr', {},
          el('td', {}, el('span', { style: { fontWeight: '500' }, text: p.name || '-' })),
          el('td', { text: p.category || '-' }),
          el('td', {}, el('span', { class: 'badge ' + (p.level || '').toLowerCase() }, p.level || '-')),
          el('td', { text: p.enforcementStage || '-' }),
          el('td', {}, status),
          el('td', {}, actions));
        tbl.appendChild(tr);
      });
      pp.appendChild(all.length ? el('div', { class: 'table-wrap' }, tbl) : empty('No policies'));
      root.appendChild(pp);

      var cp = panel('Compliance & Audit');
      cp.appendChild(el('h3', {}, 'Block Rate Trend'));
      cp.appendChild(el('div', { class: 'chart-container chart-spark', id: 'pol-chart-block' }));
      cp.appendChild(el('h3', {}, 'Failures by Mechanism'));
      var fbm = compliance.failuresByMechanism || {}; var me = Object.keys(fbm).map(function (k) { return [k, fbm[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
      if (me.length) { var max = Math.max.apply(null, me.map(function (x) { return x[1]; }).concat([1])); var mb = el('div', {}); me.forEach(function (m) { mb.appendChild(el('div', { class: 'bar-container' }, el('span', { class: 'bar-label', style: { width: '120px' }, text: m[0] }), el('div', { class: 'bar red', style: { width: Math.round((m[1] / max) * 180) + 'px' } }), el('span', { class: 'bar-value', text: String(m[1]) }))); }); cp.appendChild(mb); }
      else cp.appendChild(empty('No failure mechanisms'));
      cp.appendChild(el('h3', {}, 'Recent Failures'));
      var rf = compliance.recentFailures || [];
      cp.appendChild(rf.length ? tableNode(['Time', 'Policy', 'Op', 'Mechanism', 'Reason'], rf.slice(0, 10), function (f) { return [el('span', { class: 'mono-sm', text: (f.executedAt || '').slice(11, 19) }), el('span', { class: 'value red', text: f.policyName || f.policyId || '-' }), f.operation || '-', el('span', { class: 'badge required' }, f.defeatedMechanism || '-'), el('span', { class: 'muted', text: (f.reason || '-').slice(0, 60) })]; }) : empty('No recent failures'));
      cp.appendChild(el('h3', {}, 'Audit Trail'));
      var at = el('div', {});
      if (audit.length) audit.slice(0, 15).forEach(function (e) { var ts = (typeof e.executedAt === 'string' && e.executedAt.length >= 19) ? e.executedAt.slice(11, 19) : (e.executedAt || '-'); at.appendChild(el('div', { class: 'audit-row' }, el('span', { class: 'audit-time', text: ts }), el('span', { class: 'audit-icon ' + (e.allowed ? 'pass' : 'block'), text: e.allowed ? 'PASS' : 'BLOCK' }), el('span', { class: 'audit-policy', text: (e.policyId || '').slice(0, 8) }), el('span', { class: 'audit-op', text: e.operation || '' }), el('span', { class: 'audit-reason', text: e.reason || '' }))); });
      else at.appendChild(empty('No audit entries'));
      cp.appendChild(at);
      cp.appendChild(el('h3', {}, 'Live Events'));
      var feed = el('div', { class: 'event-feed', id: 'pol-live-events' });
      fillEvents(feed);
      cp.appendChild(feed);
      root.appendChild(cp);
      U.charts.syncSpark('pol-chart-block', d.timeSeries || [], U.charts.parseBR, U.charts.CC.blockRate, 'Block Rate %');
    }
    function fillEvents(feed) {
      U.clear(feed);
      var ev = (U.liveEvents || []).slice(0, 20);
      if (!ev.length) { feed.appendChild(empty('Waiting for events…')); return; }
      ev.forEach(function (e) { feed.appendChild(eventRow(e)); });
    }
    U.onEvents(function () { var f = document.getElementById('pol-live-events'); if (f) fillEvents(f); });
    return { label: 'Policies', render: build };
  })());

  // ═══════════════════════════ MODELS ═══════════════════════════
  U.registerTab('models', (function () {
    function build(root, d) {
      var m = d.models || { roles: {}, sessionUsage: [], totalCost: 0, strategy: 'unknown' };
      var p = panel('Models & Routing');
      p.appendChild(el('h3', {}, 'Roles'));
      var roles = m.roles || {}; var rk = Object.keys(roles);
      if (rk.length) rk.forEach(function (role) { var c = role === 'planner' ? 'green' : role === 'executor' ? 'cyan' : role === 'reviewer' ? 'purple' : ''; p.appendChild(kv(U.capitalize(role), roles[role] ? modelName(String(roles[role])) : '—', c)); });
      else p.appendChild(empty('No roles configured'));
      p.appendChild(el('h3', {}, 'Router'));
      p.appendChild(kv('Strategy', m.strategy || 'unknown', 'cyan'));
      p.appendChild(kv('Available', String((m.availableModels || []).length)));
      p.appendChild(kv('Enabled', m.enabled ? 'Yes' : 'No', m.enabled ? 'green' : 'yellow'));
      p.appendChild(kv('Total Cost', fmtUsd(m.totalCost || 0), 'green'));
      var co = m.costOptimization || {};
      p.appendChild(el('h3', {}, 'Cost Optimization'));
      p.appendChild(kv('Enabled', co.enabled ? 'Yes' : 'No', co.enabled ? 'green' : 'yellow'));
      p.appendChild(kv('Target Reduction', co.targetReduction ? co.targetReduction.toFixed(0) + '%' : 'N/A'));
      p.appendChild(kv('Max Degradation', co.maxPerformanceDegradation ? co.maxPerformanceDegradation.toFixed(0) + '%' : 'N/A'));
      root.appendChild(p);

      var mx = m.routingMatrix || {}; var mk = Object.keys(mx);
      var rp = panel('Routing Matrix');
      if (mk.length) rp.appendChild(tableNode(['Task Type', 'Planner', 'Executor'], mk, function (k) { var v = mx[k]; var isObj = v && typeof v === 'object'; return [k, el('span', { class: 'value green', text: isObj ? modelName(v.planner || '-') : '-' }), el('span', { class: 'value cyan', text: isObj ? modelName(v.executor || '-') : modelName(String(v)) })]; }));
      else rp.appendChild(empty('No routing matrix'));
      root.appendChild(rp);

      var rd = m.recentRoutingDecisions || [];
      var dp = panel('Recent Routing Decisions');
      dp.appendChild(rd.length ? tableNode(['Time', 'Model', 'Task', 'Tokens', 'Cost', 'Result'], rd.slice(0, 12), function (r) { return [el('span', { class: 'mono-sm', text: (r.timestamp || '').slice(11, 19) }), el('span', { class: 'value purple', text: modelName(r.modelUsed) }), r.taskType || '?', fmtNum((r.tokensIn || 0) + (r.tokensOut || 0)), el('span', { class: 'value green', text: fmtUsd(r.cost || 0) }), el('span', { class: 'value ' + (r.success ? 'green' : 'red'), text: r.success ? 'OK' : 'FAIL' })]; }) : empty('No routing decisions yet'));
      root.appendChild(dp);

      var usage = m.sessionUsage || [];
      var up = panel('Session Usage by Model');
      up.appendChild(usage.length ? tableNode(['Model', 'Tasks', 'In', 'Out', 'Cost', 'Success'], usage, function (u) { var rate = typeof u.successRate === 'number' ? (u.successRate * 100).toFixed(0) : '0'; return [el('span', { class: 'value cyan', text: modelName(u.modelId) }), String(u.taskCount || 0), fmtNum(u.totalTokensIn || 0), fmtNum(u.totalTokensOut || 0), fmtUsd(u.totalCost || 0), el('span', { class: 'value ' + (rate >= 90 ? 'green' : rate >= 70 ? 'yellow' : 'red'), text: rate + '%' })]; }) : empty('No usage recorded'));
      root.appendChild(up);
    }
    return { label: 'Models', render: build };
  })());

  // ═══════════════════════════ MEMORY ═══════════════════════════
  U.registerTab('memory', (function () {
    function build(root, d) {
      var mem = d.memory || {}, l1 = mem.l1 || {}, l2 = mem.l2 || {}, l3 = mem.l3 || {}, l4 = mem.l4 || {}, comp = mem.compression || {}, hm = mem.hitsMisses || {};
      var g = el('div', { class: 'grid-2' });
      var lp = panel('Memory Tiers');
      lp.appendChild(kv('L1 Working', (l1.entries || 0) + ' entries (' + (l1.sizeKB || 0) + ' KB)'));
      lp.appendChild(kv('L2 Session', (l2.entries || 0) + ' entries'));
      lp.appendChild(kv('L3 Semantic', l3.status === 'Running' ? 'Qdrant ' + (l3.uptime || '') : (l3.status || 'Stopped'), l3.status === 'Running' ? 'green' : 'yellow'));
      lp.appendChild(kv('L4 Knowledge', (l4.entities || 0) + ' entities, ' + (l4.relationships || 0) + ' rels'));
      lp.appendChild(el('h3', {}, 'Hit Rate'));
      var hrStr = String(hm.hitRate || 'N/A'); var hrVal = parseFloat(hrStr) || 0;
      lp.appendChild(kv('Hits', String(hm.hits || 0), 'green'));
      lp.appendChild(kv('Misses', String(hm.misses || 0), 'red'));
      lp.appendChild(kv('Rate', hrStr.indexOf('%') >= 0 ? hrStr : (hrStr === 'N/A' ? hrStr : hrStr + '%'), hrVal > 80 ? 'green' : hrVal > 50 ? 'yellow' : 'red'));
      lp.appendChild(el('div', { class: 'gauge-track' }, el('div', { class: 'gauge-fill', style: { width: Math.min(hrVal, 100) + '%', background: hrVal > 80 ? 'var(--green)' : hrVal > 50 ? 'var(--yellow)' : 'var(--red)' } })));
      lp.appendChild(el('div', { class: 'chart-container chart-spark', id: 'mem-chart-hit' }));
      g.appendChild(lp);

      var cp = panel('Context Compression');
      cp.appendChild(kv('Raw', fmtKB(comp.rawBytes || 0)));
      cp.appendChild(kv('Compressed', fmtKB(comp.contextBytes || 0)));
      cp.appendChild(kv('Savings', comp.savingsPercent || '0%', 'green'));
      cp.appendChild(kv('Tool Calls', String(comp.totalCalls || 0)));
      cp.appendChild(el('h3', {}, 'Recent Queries'));
      var rq = mem.recentQueries || [];
      cp.appendChild(rq.length ? tableNode(['Type', 'Query', 'Time'], rq.slice(0, 10), function (q) { return [el('span', { class: 'badge active' }, q.type || 'memory'), el('span', { class: 'muted', text: (q.query || '-').slice(0, 40) }), el('span', { class: 'mono-sm', text: (q.timestamp || '').slice(11, 19) })]; }) : empty('No recent queries'));
      g.appendChild(cp);
      root.appendChild(g);

      var sv = d.savingsByInfluence || { influences: [], totalTokensSaved: 0, totalCostSavedUsd: 0 };
      var sp = panel('Token Savings by Influence');
      sp.appendChild(el('div', { style: { marginBottom: '12px', fontSize: '14px' } }, el('strong', { class: 'value cyan', style: { fontSize: '18px' }, text: fmtNum(sv.totalTokensSaved || 0) }), ' tokens · ', el('strong', { class: 'value green', style: { fontSize: '18px' }, text: fmtUsd(sv.totalCostSavedUsd || 0) }), ' saved across all UAP influences'));
      sp.appendChild((sv.influences || []).length ? tableNode(['Influence', 'Tokens saved', 'Cost saved', 'Quality', 'Detail'], sv.influences, function (i) {
        var idle = i.quality === 'unmeasured';
        var tok = idle ? el('span', { class: 'muted', text: '—' }) : fmtNum(i.tokensSaved);
        var cost = idle ? el('span', { class: 'muted', text: '—' }) : el('span', { class: 'value green', text: fmtUsd(i.costSavedUsd || 0) });
        var qc = i.quality === 'measured' ? 'green' : i.quality === 'estimated' ? 'yellow' : '';
        return [i.influence, tok, cost, el('span', { class: 'value ' + qc, text: i.quality }), el('span', { class: 'muted', text: i.detail || '' })];
      }) : empty('No savings data'));
      root.appendChild(sp);
      U.charts.syncSpark('mem-chart-hit', d.timeSeries || [], U.charts.parseHR, U.charts.CC.hitRate, 'Hit Rate %');
    }
    return { label: 'Memory', render: build };
  })());

  // ── boot ──
  U.start();
})();
