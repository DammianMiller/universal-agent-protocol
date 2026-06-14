/**
 * deliver-defaults — make `uap deliver` enforcement active by default.
 *
 * Called by `uap init` and `uap setup` so every UAP-managed project ships with:
 *   1. the delivery-enforcement policy installed + enabled (so the policy gate
 *      runs its enforcer), and
 *   2. the UAP MCP router (which exposes the `deliver` tool) registered in the
 *      project's Claude / OpenCode MCP configs.
 *
 * The block-vs-advisory MODE is governed at runtime by the UAP_ENFORCE_DELIVERY
 * env var, which the policy-gate hook (templates/hooks/uap-policy-gate.sh)
 * defaults to `block`. Set UAP_ENFORCE_DELIVERY=advisory to soften without
 * uninstalling. Escape hatches: UAP_DELIVER_ACTIVE=1 / UAP_DELIVER_BYPASS=1.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { getPolicyToolRegistry } from '../policies/policy-tools.js';
import { getPolicyGate } from '../policies/policy-gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DELIVERY_POLICY = 'delivery-enforcement';
const DELIVERY_ENFORCER = 'delivery_enforcement';

/**
 * Resolve a package data file, trying the installed package root (dist/cli ->
 * ../..) first, then the current working directory (running inside the repo).
 */
function resolvePackageFile(relPath: string): string | null {
  const candidates = [join(__dirname, '..', '..', relPath), join(process.cwd(), relPath)];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export interface EnsureDeliveryResult {
  installed: boolean;
  enabled: boolean;
  enforcerAttached: boolean;
  reason?: string;
}

/**
 * Install + enable the delivery-enforcement policy. Idempotent: re-installs the
 * enforcer code and ensures the policy is enabled without creating duplicates.
 */
export async function ensureDeliveryEnforcement(): Promise<EnsureDeliveryResult> {
  const mdPath = resolvePackageFile(
    join('src', 'policies', 'schemas', 'policies', `${DELIVERY_POLICY}.md`)
  );
  const enforcerPath = resolvePackageFile(
    join('src', 'policies', 'enforcers', `${DELIVERY_ENFORCER}.py`)
  );

  if (!mdPath) {
    return {
      installed: false,
      enabled: false,
      enforcerAttached: false,
      reason: 'delivery-enforcement policy schema not found in package',
    };
  }

  const memory = getPolicyMemoryManager();
  const existing = (await memory.getAllPolicies()).find((p) => p.name === DELIVERY_POLICY);

  let id: string;
  let installed = false;
  if (existing) {
    id = existing.id;
  } else {
    id = await memory.storeRawPolicy(readFileSync(mdPath, 'utf-8'));
    installed = true;
  }

  let enforcerAttached = false;
  if (enforcerPath) {
    await getPolicyToolRegistry().storeToolCode(
      id,
      DELIVERY_ENFORCER,
      readFileSync(enforcerPath, 'utf-8')
    );
    enforcerAttached = true;
  }

  await memory.togglePolicy(id, true);
  getPolicyGate().invalidateCache();

  return { installed, enabled: true, enforcerAttached };
}

export interface WireDeliverMcpResult {
  claude: boolean;
  opencode: boolean;
}

function mergeJsonServer(
  path: string,
  apply: (cfg: Record<string, unknown>) => boolean
): boolean {
  try {
    const cfg: Record<string, unknown> = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf-8'))
      : {};
    if (apply(cfg)) {
      writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the UAP MCP router — which exposes the `deliver` tool — in the
 * project's Claude `.mcp.json` (always) and OpenCode `opencode.json` (only when
 * an `.opencode/` dir exists, to avoid cluttering non-OpenCode projects).
 * Merges into existing configs; idempotent.
 */
export function wireDeliverMcp(cwd: string): WireDeliverMcpResult {
  // Claude Code / standard MCP: <cwd>/.mcp.json
  const claude = mergeJsonServer(join(cwd, '.mcp.json'), (cfg) => {
    const servers = (cfg.mcpServers as Record<string, unknown>) || {};
    if (servers['uap-router']) return false;
    servers['uap-router'] = { command: 'uap', args: ['mcp-router', 'start'] };
    cfg.mcpServers = servers;
    return true;
  });

  // OpenCode: <cwd>/opencode.json (only if the project uses OpenCode)
  let opencode = false;
  if (existsSync(join(cwd, '.opencode')) || existsSync(join(cwd, 'opencode.json'))) {
    opencode = mergeJsonServer(join(cwd, 'opencode.json'), (cfg) => {
      if (!cfg.$schema) cfg.$schema = 'https://opencode.ai/config.json';
      const mcp = (cfg.mcp as Record<string, unknown>) || {};
      if (mcp['uap-router']) return false;
      mcp['uap-router'] = {
        type: 'local',
        command: ['uap', 'mcp-router', 'start'],
        enabled: true,
      };
      cfg.mcp = mcp;
      return true;
    });
  }

  return { claude, opencode };
}
