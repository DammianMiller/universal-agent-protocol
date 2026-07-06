/**
 * Token savings attributed to EACH UAP influence (mechanism) — real data, not
 * a hardcoded multiplier. Each influence reports tokens/cost saved plus whether
 * the figure is measured or estimated, so the dashboard can be honest about
 * provenance.
 *
 * Sources (all read live, fail-soft):
 *  - RTK: `rtk gain --format json` -> summary.total_saved (measured).
 *  - Model routing: model_analytics.db task_outcomes counterfactual vs the
 *    frontier model (measured spend, computed counterfactual).
 *  - Context compression: in-process session-stats (measured when present).
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { ModelPresets } from '../models/types.js';
import { globalSessionStats } from '../mcp-router/session-stats.js';

export interface InfluenceSaving {
  /** Mechanism name, e.g. "RTK (command compression)". */
  influence: string;
  /** Tokens saved by this mechanism (0 when not applicable/unmeasured). */
  tokensSaved: number;
  /** USD saved by this mechanism. */
  costSavedUsd: number;
  /** Human note on how this was computed. */
  detail: string;
  /** measured = real tracked data; estimated = derived/counterfactual. */
  quality: 'measured' | 'estimated' | 'unmeasured';
}

export interface SavingsByInfluence {
  influences: InfluenceSaving[];
  totalTokensSaved: number;
  totalCostSavedUsd: number;
}

/** Blended $/token used to value RTK/compression token savings (~sonnet input). */
const BLENDED_USD_PER_TOKEN = 3.0 / 1_000_000;

function frontierCost(): { in: number; out: number } {
  // Reference "without-UAP" model = the most expensive configured frontier model.
  const opus = ModelPresets['opus-4.8'] || ModelPresets['opus-4.6'] || ModelPresets['claude-opus-4'];
  return { in: opus?.costPer1MInput ?? 7.5, out: opus?.costPer1MOutput ?? 37.5 };
}

/** RTK savings from `rtk gain --format json` (measured). */
function rtkSaving(): InfluenceSaving {
  try {
    const raw = execFileSync('rtk', ['gain', '--format', 'json'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const data = JSON.parse(raw) as { summary?: { total_saved?: number; avg_savings_pct?: number; total_commands?: number } };
    const saved = Math.max(0, Math.round(data.summary?.total_saved ?? 0));
    const pct = Math.round(data.summary?.avg_savings_pct ?? 0);
    const cmds = data.summary?.total_commands ?? 0;
    return {
      influence: 'RTK (dev-command compression)',
      tokensSaved: saved,
      costSavedUsd: saved * BLENDED_USD_PER_TOKEN,
      detail: `${cmds.toLocaleString()} commands, ${pct}% avg reduction (rtk gain)`,
      quality: 'measured',
    };
  } catch {
    return { influence: 'RTK (dev-command compression)', tokensSaved: 0, costSavedUsd: 0, detail: 'rtk not available', quality: 'unmeasured' };
  }
}

/** Model-routing savings: counterfactual (all on frontier) minus actual spend. */
function routingSaving(cwd: string): InfluenceSaving {
  const dbPath = join(cwd, 'agents', 'data', 'memory', 'model_analytics.db');
  if (!existsSync(dbPath)) {
    return { influence: 'Model routing (cheaper models)', tokensSaved: 0, costSavedUsd: 0, detail: 'inactive — no UAP-routed tasks recorded yet (Claude Code cloud routes via /model, not UAP)', quality: 'unmeasured' };
  }
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare('SELECT COUNT(*) n, SUM(tokensIn) ti, SUM(tokensOut) to_, SUM(cost) c FROM task_outcomes')
      .get() as { n: number; ti: number | null; to_: number | null; c: number | null };
    db.close();
    // Exists-but-empty: the DB is present (a prior UAP run created it) but no
    // task has been routed THROUGH UAP's executor yet — the normal case when a
    // project drives models via opencode/the proxy. Report it honestly as
    // unmeasured (dimmed) rather than a real-looking measured $0. (D + B)
    if (!row.n || row.n === 0) {
      return {
        influence: 'Model routing (cheaper models)',
        tokensSaved: 0,
        costSavedUsd: 0,
        detail: 'no UAP-routed tasks recorded yet (this project routes via the proxy/opencode, not UAP\'s executor)',
        quality: 'unmeasured',
      };
    }
    const tokensIn = row.ti ?? 0;
    const tokensOut = row.to_ ?? 0;
    const actual = row.c ?? 0;
    const fc = frontierCost();
    const counterfactual = (tokensIn / 1_000_000) * fc.in + (tokensOut / 1_000_000) * fc.out;
    const saved = Math.max(0, counterfactual - actual);
    return {
      influence: 'Model routing (cheaper models)',
      tokensSaved: 0, // routing saves cost, not tokens
      costSavedUsd: saved,
      detail: `${row.n} tasks routed off the frontier model; $${actual.toFixed(4)} spent vs $${counterfactual.toFixed(4)} all-frontier`,
      quality: 'measured',
    };
  } catch {
    return { influence: 'Model routing (cheaper models)', tokensSaved: 0, costSavedUsd: 0, detail: 'analytics unreadable', quality: 'unmeasured' };
  }
}

/** Context-compression savings from the in-process session stats. */
function compressionSaving(): InfluenceSaving {
  try {
    const s = globalSessionStats.getSummary();
    const savedBytes = Math.max(0, (s.totalRawBytes ?? 0) - (s.totalContextBytes ?? 0));
    const tokens = Math.round(savedBytes / 4); // ~4 bytes/token
    return {
      influence: 'Context compression',
      tokensSaved: tokens,
      costSavedUsd: tokens * BLENDED_USD_PER_TOKEN,
      detail: tokens > 0 ? `${s.compressionEvents ?? 0} compressions, ${s.savingsPercent ?? '0%'} of tool output` : 'no compression this session',
      quality: tokens > 0 ? 'measured' : 'unmeasured',
    };
  } catch {
    return { influence: 'Context compression', tokensSaved: 0, costSavedUsd: 0, detail: 'unavailable', quality: 'unmeasured' };
  }
}

export function getSavingsByInfluence(cwd: string = process.cwd()): SavingsByInfluence {
  const influences = [rtkSaving(), routingSaving(cwd), compressionSaving()];
  return {
    influences,
    totalTokensSaved: influences.reduce((a, i) => a + i.tokensSaved, 0),
    totalCostSavedUsd: influences.reduce((a, i) => a + i.costSavedUsd, 0),
  };
}
