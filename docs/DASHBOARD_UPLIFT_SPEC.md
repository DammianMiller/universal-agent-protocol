# UAP Dashboard Uplift — Architecture & UI Spec

Goal: replace the monolithic `web/dashboard.html` with a modular, tabbed dashboard that shows
aggregate high-level info AND per-agent/session drill-down, covers every UAP feature, supports
drill in/out + expand/collapse, and adds full-lifecycle management (start/stop/delete/etc) for
tasks, epics, orchestration, deliver runs, and agents.

## Design system — UAP Console (MANDATORY, design gate enforced)
Use ONLY these tokens. No off-token hex, no off-scale spacing.
```
--bg:#0d1117; --surface:#161b22; --surface-raised:#21262d; --border:#30363d;
--text:#c9d1d9; --text-muted:#8b949e; --text-subtle:#484f58; --primary:#58a6ff;
```
Existing accent tokens already in the page (keep, they are on-system):
`--cyan --green --yellow --red --purple --orange`.
Fonts: 'SF Mono','Fira Code','Cascadia Code',monospace for data; system sans for prose.
Spacing scale: 4,8,12,16,24,32 px only. Radius: var(--radius) (6px). Dark theme only.

## File layout (each file is one deliver mission — no shared-file clobbering)
```
web/dashboard.html          thin shell: <head> loads styles.css + vendored uPlot; body has
                            header, tab bar, one <main id="view"> mount, loads core.js (module).
web/dash/core.js            data layer + app shell: WS/SSE/poll channels, global `state` (last
                            snapshot), tab router (hash-based #overview,#tasks,...), renderActiveTab(),
                            confirm-dialog, toast, esc(), fmt helpers, MUTATION token+headers,
                            api() POST helper, expand/collapse helpers, drill navigation (goAgent(id)).
web/dash/charts.js          uPlot chart + sparkline builders (ported 1:1 from current behaviour).
web/dash/styles.css         all CSS (ported + new tab/drawer/table/control styles), tokens only.
web/dash/tab-overview.js    aggregate KPIs + hero charts + live summaries with drill links.
web/dash/tab-tasks.js       Tasks & Epics: kanban + table + create/edit/status/assignee/delete + epic ledger.
web/dash/tab-agents.js      Agents & Sessions: agent grid -> per-agent drawer; session history -> per-session drawer.
web/dash/tab-orchestration.js  mission->epic->task tree + agents + orchestrate on/off/auto + ledger controls.
web/dash/tab-deliver.js     deliver run registry list + launch form + cancel/resume + per-run telemetry.
web/dash/tab-policies.js    policies table (existing controls) + compliance + audit + live events.
web/dash/tab-models.js      models/routing config + session usage + routing decisions.
web/dash/tab-memory.js      L1-L4 + compression + hit/miss gauge + recent queries + savings-by-influence.
```
Server change: `server.ts` static handler currently serves `/vendor/`; extend it to ALSO serve
`/dash/` (same path-traversal guard, content types add `.css`, `.js`).

## Module contract (how tabs plug in)
`core.js` owns everything shared and exposes a global `UAP` object on `window`:
- `UAP.state` — the latest `/api/dashboard` snapshot (or null).
- `UAP.registerTab(id, {label, render(root, state), onEnter?, onLeave?})` — each tab-*.js calls this at load.
- `UAP.el(tag, attrs, ...children)` — tiny hyperscript DOM builder (avoids innerHTML XSS; sets textContent).
- `UAP.esc(s)`, `UAP.fmtNum(n)`, `UAP.fmtBytes(n)`, `UAP.fmtUsd(n)`, `UAP.fmtDur(ms)`, `UAP.timeAgo(iso)`.
- `UAP.api(path, body?)` — POST JSON with the mutation token header; returns parsed JSON or throws; shows toast on error.
- `UAP.confirm(message, {danger}) : Promise<bool>` — modal confirm; ALL destructive controls await it.
- `UAP.toast(msg, kind)` — kind: ok|warn|err.
- `UAP.drawer(title, contentNode)` / `UAP.closeDrawer()` — right-side slide-in panel for drill-down detail.
- `UAP.goto(hash)` — switch tabs programmatically (e.g. click agent row on Overview -> #agents + open drawer).
- `UAP.collapsible(title, bodyNode, {open}) : Node` — reusable expand/collapse section.
- `UAP.onSnapshot(fn)` — subscribe to every new snapshot (tabs use this to live-update if active).
- `UAP.liveEvents` — capped array of SSE activity events (for policies tab live feed).

core.js loads all tab-*.js as `<script type=module>` (or dynamic import) AFTER defining UAP, then
renders the tab from `location.hash` (default #overview). Tab bar buttons set the hash.
On each snapshot: if the active tab is live, re-render it; always update header + tab badges.

Data channels: reuse the current three (WS primary at ws://host, SSE /api/events for the activity
feed + snapshot fallback, poll /api/dashboard every REFRESH_MS when WS closed). Reconnect w/ backoff.
The `__UAP_DASHBOARD_TOKEN__` and `__UAP_DASH_REFRESH_MS__` placeholders are substituted server-side
in dashboard.html (already handled by server.ts) — read them from a small inline bootstrap script in
the shell that sets window.__UAP_BOOT = {token, refreshMs} before core.js loads.

## Tabs — content & interactions

### Overview (aggregate landing)
- KPI row (stat tiles): Tasks done/total + % ; Active agents ; Active deliver runs ; Orchestration
  progress % ; Tokens saved ; Cost saved $ ; Memory entries ; Policy block-rate. Each tile clickable ->
  goto its tab.
- Hero charts (uPlot): Tasks & Agents over time; Compression & Memory over time (from timeSeries).
- Live summaries (each a compact table with a "drill" affordance): Active Agents (click row ->
  #agents drawer), Active Deliver Runs (click -> #deliver), Orchestration ledger mini-progress
  (click -> #orchestration), Recent activity (last N events).

### Tasks & Epics
- Toolbar: "+ New Task" (opens form: title, type[task|epic|bug|...], priority, assignee), filter by
  status, expand/collapse-all groups.
- Kanban (5 cols open/in_progress/blocked/done/wont_do) grouped into families by groupId (port
  current logic incl. depth indent + breadcrumb). Each card: click -> drawer with detail + controls:
  change status (select), set assignee, claim, close(done), DELETE (danger-confirm). Epic-typed
  cards also show ledger children + "advance/fail item" + "reset ledger" (danger).
- Endpoints: POST /api/tasks (create), POST /api/tasks/:id/update {status?,assignee?,priority?,title?},
  POST /api/tasks/:id/close, POST /api/tasks/:id/delete, POST /api/tasks/:id/claim {agentId}.
  Epics/ledger: POST /api/ledger/item/:id {status:done|failed|pending}, POST /api/ledger/reset,
  POST /api/ledger/init {mission, items:[...]} (optional).

### Agents & Sessions
- Agents grid: card per coordination.agents / session.agents (id,name,type,status badge, task, model,
  tokens, cost). Click -> right drawer per-agent detail: full token IO (in/out), model, duration,
  taskCount, skills chips (from coordination.skillsPerAgent[id]), patterns (patternsPerAgent[id]),
  routing decisions if linkable. Control: Deregister agent (danger-confirm) -> POST /api/agents/:id/deregister.
  Toolbar: "Clean stale agents" -> POST /api/agents/clean.
- Sessions history table (sessions[]): per row tokens/cost/agents/tasks/model/status; click -> drawer
  with the session's detail (for the CURRENT/live session use `state.session` rich object incl agents,
  modelBreakdown, skills, patterns, deploys, step progress bar).

### Orchestration
- Header: orchestrator toggle (on/off/auto) -> POST /api/orchestrator {state:on|off|auto} (writes
  .uap.json deliver.orchestrate). Show current from state.models or a new field.
- Active build ledger block (orchestrationTree.ledger): mission, pct, done/total, items w/ deps +
  per-item advance/fail controls (reuse ledger endpoints).
- Mission tree (orchestrationTree.missions recursive): expand/collapse nodes, show assigned agents,
  status badges. Node controls where it maps to a task: jump to task drawer.

### Deliver
- Run registry list (NEW data: state.deliverRuns from listRuns()): runId, status
  (running|delivered|failed|interrupted), mission/instruction, phase, taskId, updatedAt.
- Controls per run: Cancel (running only, danger-confirm) -> POST /api/deliver/:runId/cancel
  (writes stop-file; server also attempts PID kill). Resume (interrupted) -> POST /api/deliver/:runId/resume.
- Launch form: instruction textarea + options (model preset, max-turns) -> POST /api/deliver/launch
  {instruction, model?, maxTurns?} spawns `uap deliver` detached; returns runId. Show a warning that
  this spawns a host process.
- Live telemetry: for a running run, show its RunCoordinator status from the agent registry (the
  agent whose task text carries "turn N: X% of gates").

### Policies & Compliance (port existing + keep controls)
- Policies table: name/category/level/stage/status + toggle button + stage select + level select
  (existing endpoints /api/policy/:id/{toggle,stage,level}).
- Enforcement stages bar chart. Compliance: block-rate sparkline, failuresByMechanism bars,
  recentFailures table, auditTrail list, Live Events SSE feed.

### Models
- Roles (planner/executor/reviewer/fallback), strategy, availableModels, enabled, costOptimization,
  routingMatrix (handle BOTH shapes: string tier->model AND {planner,executor}), routingRules.
- sessionUsage table (model/tasks/in/out/cost/success%), recentRoutingDecisions table, totalCost.

### Memory
- L1/L2/L3(Qdrant)/L4 cards, compression block, hit/miss gauge + hit-rate sparkline, recentQueries
  table, savingsByInfluence (summary + per-influence table with quality badges).

## Backend — new files & edits
```
src/dashboard/controls/tasks.ts      handleTaskCreate/Update/Close/Delete/Claim (import TaskService)
src/dashboard/controls/epics.ts      handleLedgerItem/Reset/Init (import completion-ledger)
src/dashboard/controls/orchestrator.ts handleOrchestratorToggle (import modifyUapConfig)
src/dashboard/controls/deliver.ts    handleDeliverLaunch/Cancel/Resume + listDeliverRuns
src/dashboard/controls/agents.ts     handleAgentDeregister/CleanStale (import CoordinationService)
```
- `run-state.ts`: add `listRuns(projectRoot): DeliverRunState[]` (readdir deliverRunsDir + loadRunState each).
- `convergence-loop.ts`: add a cooperative STOP-FILE check per turn (next to the existing guidanceFile
  poll). Stop-file path = `<projectRoot>/.uap/deliver-runs/<runId>/STOP`. If present, break the loop,
  set run status 'interrupted', return. (Cancel endpoint writes this file; also SIGTERM the PID if known.)
- `data-service.ts`: add `deliverRuns` (from listRuns) and `ledger` (loadLedger) to DashboardData +
  the interface. Add `getAgentDetail(cwd, agentId)` returning the per-agent detail (from session.agents
  or coordination) for drawer use (optional — drawer can also filter client-side from snapshot).
- `server.ts`: extend static handler to `/dash/`; add the POST routes above, ALL behind
  `mutationAuthorized(req)` (return denyMutation on fail); parse body via readBody/parseJsonBody;
  validate inputs; return JSON. Destructive ops must be idempotent-safe and never throw unhandled.

## Security & safety
- Every new mutation route: `if (!mutationAuthorized(req)) return denyMutation(res);` FIRST.
- Deliver launch spawns a subprocess — bind only when host is localhost is NOT enforced, but the token
  gate is the control. Log launches. Detach the child (unref) so the dash server isn't its parent lifetime.
- Cancel: write stop-file (cooperative) THEN best-effort SIGTERM the recorded PID if the run-state has one.
- Confirm dialog on client for every delete/cancel/reset/deregister.

## Tests (vitest, test/) — at least:
- run-state listRuns returns runs sorted newest-first; empty when dir absent.
- convergence stop-file: a loop with a pre-written STOP file exits with status interrupted after <=1 turn.
- server control routes: task create/update/delete happy-path + 401 without token; ledger item; agent
  deregister; orchestrator toggle writes config. (Use ephemeral port, temp cwd.)
- data-service: getDashboardData includes deliverRuns + ledger keys.

## Verification
- npm run build clean; tsc --noEmit clean; vitest green; design gate green (tokens only).
- Browser smoke: start `uap dash serve`, load each tab, exercise one mutation per domain, confirm
  drill-in drawer opens and closes, expand/collapse works, live update ticks.
```
```
