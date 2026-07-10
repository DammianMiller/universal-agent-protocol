/* UAP Dashboard charts — uPlot chart + sparkline builders.
 *
 * The builder functions (addTooltip, mkChart, initChartTasks, initChartCompression,
 * initSparkline, seedLegends, updateAllCharts) are ported 1:1 from the original
 * monolithic web/dashboard.html inline <script>. On top of them sit the
 * registry-based adapters (syncHero / syncSpark) that the tabbed views use to
 * create-or-update charts idempotently on every snapshot.
 *
 * Loaded BEFORE core.js; exposes window.UAPCharts. core.js re-exports it as
 * UAP.charts for the tab modules. */
(function () {
  'use strict';

  var uplotReady = typeof uPlot !== 'undefined';

  // ── Chart colors (ported 1:1) ──
  const CC = {
    done:'#3fb950', inProg:'#58a6ff', blocked:'#f85149', open:'#484f58', agents:'#bc8cff',
    raw:'#58a6ff', ctx:'#3fb950', hitRate:'#bc8cff', deploy:'#58a6ff', blockRate:'#f85149',
  };

  function tsUnix(arr) { return arr.map(p => new Date(p.timestamp).getTime() / 1000); }

  // ── Tooltip (ported 1:1) ──
  function addTooltip(u, colors, labels, fmtVal) {
    const tt = document.createElement('div');
    tt.className = 'u-tooltip'; tt.style.display = 'none';
    u.root.appendChild(tt);
    u.hooks.setCursor = u.hooks.setCursor || [];
    u.hooks.setCursor.push(() => {
      const { idx, left, top } = u.cursor;
      if (idx == null) { tt.style.display = 'none'; return; }
      const date = new Date(u.data[0][idx] * 1000);
      let rows = `<div class="tt-time">${date.toLocaleTimeString()}</div>`;
      for (let i = 1; i < u.series.length; i++) {
        if (!u.series[i].show) continue;
        const val = u.data[i][idx];
        if (val == null) continue;
        const c = colors[i-1] || '#fff', l = labels[i-1] || '';
        const v = fmtVal ? fmtVal(val, i) : val.toLocaleString();
        rows += `<div class="tt-row"><span class="tt-dot" style="background:${c}"></span><span class="tt-label">${l}</span><span class="tt-val">${v}</span></div>`;
      }
      tt.innerHTML = rows; tt.style.display = '';
      tt.style.left = (left + 16) + 'px'; tt.style.top = Math.max(0, top - 10) + 'px';
    });
  }

  // ── Generic chart builder (ported 1:1) ──
  function mkChart(elId, ts, extractors, opts) {
    if (!uplotReady || !ts || ts.length < 2) return null;
    const el = document.getElementById(elId);
    if (!el) return null;
    el.innerHTML = '';
    const timestamps = tsUnix(ts);
    const data = [timestamps, ...extractors.map(fn => ts.map(fn))];
    const u = new uPlot(opts(el.clientWidth), data, el);
    return u;
  }

  function initChartTasks(ts) {
    const colors = [CC.done, CC.inProg, CC.blocked, CC.open, CC.agents];
    const labels = ['Done', 'In Progress', 'Blocked', 'Open', 'Active Agents'];
    const extractors = [
      p => p.tasks?.done || 0, p => p.tasks?.inProgress || 0,
      p => p.tasks?.blocked || 0, p => p.tasks?.open || 0,
      p => p.coordination?.activeAgents || 0,
    ];
    const u = mkChart('chart-tasks', ts, extractors, (w) => ({
      width: w, height: 260,
      cursor: { sync: { key: 'uap' }, focus: { prox: 30 } },
      scales: { x: { time: true }, y: { min: 0 }, agents: { min: 0 } },
      axes: [
        { stroke: '#484f58', grid: { stroke: '#21262d' }, ticks: { stroke: '#21262d' }, font: '10px SF Mono,monospace' },
        { stroke: '#484f58', grid: { stroke: '#21262d' }, ticks: { stroke: '#21262d' }, font: '10px SF Mono,monospace', size: 50 },
        { stroke: CC.agents, grid: { show: false }, side: 1, font: '10px SF Mono,monospace', size: 50, scale: 'agents' },
      ],
      series: [
        {},
        { label: 'Done', stroke: CC.done, fill: CC.done+'30', width: 2 },
        { label: 'In Prog', stroke: CC.inProg, fill: CC.inProg+'30', width: 2 },
        { label: 'Blocked', stroke: CC.blocked, fill: CC.blocked+'20', width: 2 },
        { label: 'Open', stroke: CC.open, fill: CC.open+'20', width: 1, dash: [4,2] },
        { label: 'Agents', stroke: CC.agents, width: 2, dash: [6,3], scale: 'agents' },
      ],
    }));
    if (u) addTooltip(u, colors, labels);
    return u;
  }

  function initChartCompression(ts) {
    const colors = [CC.raw, CC.ctx, CC.hitRate];
    const labels = ['Raw KB', 'Compressed KB', 'Hit Rate %'];
    const extractors = [
      p => Math.round((p.compression?.rawBytes||0)/1024),
      p => Math.round((p.compression?.contextBytes||0)/1024),
      parseHR,
    ];
    const u = mkChart('chart-compression', ts, extractors, (w) => ({
      width: w, height: 260,
      cursor: { sync: { key: 'uap' }, focus: { prox: 30 } },
      scales: { x: { time: true }, y: { min: 0 }, pct: { min: 0, max: 100 } },
      axes: [
        { stroke: '#484f58', grid: { stroke: '#21262d' }, ticks: { stroke: '#21262d' }, font: '10px SF Mono,monospace' },
        { stroke: '#484f58', grid: { stroke: '#21262d' }, ticks: { stroke: '#21262d' }, font: '10px SF Mono,monospace', size: 50, values: (_,v) => v.map(x => x+' KB') },
        { stroke: CC.hitRate, grid: { show: false }, side: 1, font: '10px SF Mono,monospace', size: 50, scale: 'pct', values: (_,v) => v.map(x => x+'%') },
      ],
      series: [
        {},
        { label: 'Raw', stroke: CC.raw, fill: CC.raw+'20', width: 2 },
        { label: 'Compressed', stroke: CC.ctx, fill: CC.ctx+'20', width: 2 },
        { label: 'Hit Rate', stroke: CC.hitRate, width: 2, dash: [6,3], scale: 'pct' },
      ],
    }));
    if (u) addTooltip(u, colors, labels, (v,i) => i===3 ? v+'%' : v+' KB');
    return u;
  }

  // ── Sparkline builder (ported 1:1) ──
  function initSparkline(elId, ts, fn, color, label) {
    if (!uplotReady || !ts || ts.length < 2) return null;
    const el = document.getElementById(elId);
    if (!el) return null;
    el.innerHTML = '';
    const timestamps = tsUnix(ts);
    const values = ts.map(fn);
    const data = [timestamps, values];
    const u = new uPlot({
      width: el.clientWidth, height: 60,
      cursor: { sync: { key: 'uap' }, focus: { prox: 30 }, points: { show: false } },
      legend: { show: false },
      scales: { x: { time: true }, y: { min: 0 } },
      axes: [{ show: false }, { show: false }],
      series: [{}, { stroke: color, fill: color+'25', width: 1.5 }],
    }, data, el);
    // Sparkline tooltip
    const tt = document.createElement('div');
    tt.className = 'u-tooltip'; tt.style.display = 'none';
    u.root.appendChild(tt);
    u.hooks.setCursor = u.hooks.setCursor || [];
    u.hooks.setCursor.push(() => {
      const { idx } = u.cursor;
      if (idx == null) { tt.style.display = 'none'; return; }
      tt.innerHTML = `<div class="tt-time">${new Date(data[0][idx]*1000).toLocaleTimeString()}</div><div class="tt-row"><span class="tt-label">${label}</span><span class="tt-val">${typeof values[idx]==='number'?values[idx].toLocaleString():values[idx]}</span></div>`;
      tt.style.display = ''; tt.style.left = (u.cursor.left+12)+'px'; tt.style.top = '0px';
    });
    return u;
  }

  // ── Snapshot field parsers (ported 1:1) ──
  const parseHR = p => { const h = p.memoryHitsMisses?.hitRate; return typeof h === 'string' ? parseFloat(h)||0 : h||0; };
  const parseBR = p => { const b = p.compliance?.blockRate; return typeof b === 'string' ? parseFloat(b)||0 : b||0; };

  // ── Fixed chart set + updateAllCharts (ported 1:1) ──
  let chartTasks = null, chartCompression = null, chartDeploy = null, chartHitrate = null, chartCompliance = null;
  let chartsInit = false;
  // Seed each uPlot legend to the LATEST data point so the values read as
  // live numbers instead of '--' until the user hovers. Fail-safe per chart.
  function seedLegends() {
    [chartTasks, chartCompression, chartDeploy, chartHitrate, chartCompliance].forEach(u => {
      try { if (u && u.data && u.data[0] && u.data[0].length) u.setLegend({ idx: u.data[0].length - 1 }); } catch (e) { /* legend seed best-effort */ }
    });
  }
  function updateAllCharts(ts) {
    if (!uplotReady || !ts || ts.length < 2) return;
    if (!chartsInit) {
      chartTasks = initChartTasks(ts);
      chartCompression = initChartCompression(ts);
      chartDeploy = initSparkline('chart-deploy', ts, p=>(p.deployBuckets?.queued||0)+(p.deployBuckets?.executing||0)+(p.deployBuckets?.batched||0), CC.deploy, 'Active Deploys');
      chartHitrate = initSparkline('chart-hitrate', ts, parseHR, CC.hitRate, 'Hit Rate %');
      chartCompliance = initSparkline('chart-compliance', ts, parseBR, CC.blockRate, 'Block Rate %');
      chartsInit = true;
      seedLegends();
      return;
    }
    // Update data
    const timestamps = tsUnix(ts);
    if (chartTasks) chartTasks.setData([timestamps, ts.map(p=>p.tasks?.done||0), ts.map(p=>p.tasks?.inProgress||0), ts.map(p=>p.tasks?.blocked||0), ts.map(p=>p.tasks?.open||0), ts.map(p=>p.coordination?.activeAgents||0)]);
    if (chartCompression) chartCompression.setData([timestamps, ts.map(p=>Math.round((p.compression?.rawBytes||0)/1024)), ts.map(p=>Math.round((p.compression?.contextBytes||0)/1024)), ts.map(parseHR)]);
    if (chartDeploy) chartDeploy.setData([timestamps, ts.map(p=>(p.deployBuckets?.queued||0)+(p.deployBuckets?.executing||0)+(p.deployBuckets?.batched||0))]);
    if (chartHitrate) chartHitrate.setData([timestamps, ts.map(parseHR)]);
    if (chartCompliance) chartCompliance.setData([timestamps, ts.map(parseBR)]);
    seedLegends();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Registry-based adapters for the tabbed views. Tab renders are re-entrant
  // (hosts are recreated on tab switch), so charts are keyed by host id and
  // recreated when the host node changes, else updated in place via setData.
  // ─────────────────────────────────────────────────────────────────────────
  var chartReg = {}; // id -> { u, host }
  var AXIS = { stroke: '#484f58', grid: { stroke: '#21262d' }, ticks: { stroke: '#21262d' }, font: '10px SF Mono,monospace' };
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

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
  function resetCharts() {
    for (var id in chartReg) { try { chartReg[id].u.destroy(); } catch (e) {} }
    chartReg = {};
    // Also reset the fixed chart set (mirrors the original resize handler).
    chartsInit = false;
    chartTasks = chartCompression = chartDeploy = chartHitrate = chartCompliance = null;
  }

  // ── Exports ──
  window.UAPCharts = {
    // 1:1 ported builders
    mkChart: mkChart,
    initSparkline: initSparkline,
    addTooltip: addTooltip,
    updateAllCharts: updateAllCharts,
    initChartTasks: initChartTasks,
    initChartCompression: initChartCompression,
    seedLegends: seedLegends,
    tsUnix: tsUnix,
    // registry adapters + shared parsers/colors
    syncHero: syncHero,
    syncSpark: syncSpark,
    resetCharts: resetCharts,
    parseHR: parseHR,
    parseBR: parseBR,
    CC: CC,
    ready: uplotReady,
  };
})();
