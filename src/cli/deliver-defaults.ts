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
const SELF_PROTECT_POLICY = 'enforcement-self-protect';
const SELF_PROTECT_ENFORCER = 'enforcement_self_protect';

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
 * Install + enable a policy and attach its Python enforcer. Idempotent:
 * find-by-name so re-running never creates duplicate rows; re-materializes the
 * enforcer code and ensures the policy is enabled. Shared by the
 * delivery-enforcement and self-protect defaults so both register the same way
 * the runtime hook (uap-policy-gate.sh) expects — a policy row JOINed to an
 * executable_tools row that points at `.policy-tools/<id>_<enforcer>.py`.
 */
async function ensurePolicyEnforcer(
  policyName: string,
  enforcerName: string,
  missingReason: string
): Promise<EnsureDeliveryResult> {
  const mdPath = resolvePackageFile(
    join('src', 'policies', 'schemas', 'policies', `${policyName}.md`)
  );
  const enforcerPath = resolvePackageFile(
    join('src', 'policies', 'enforcers', `${enforcerName}.py`)
  );

  if (!mdPath) {
    return { installed: false, enabled: false, enforcerAttached: false, reason: missingReason };
  }

  const memory = getPolicyMemoryManager();
  const existing = (await memory.getAllPolicies()).find((p) => p.name === policyName);

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
    await getPolicyToolRegistry().storeToolCode(id, enforcerName, readFileSync(enforcerPath, 'utf-8'));
    enforcerAttached = true;
  }

  await memory.togglePolicy(id, true);
  getPolicyGate().invalidateCache();

  return { installed, enabled: true, enforcerAttached };
}

/**
 * Install + enable the delivery-enforcement policy. Idempotent: re-installs the
 * enforcer code and ensures the policy is enabled without creating duplicates.
 */
export async function ensureDeliveryEnforcement(): Promise<EnsureDeliveryResult> {
  return ensurePolicyEnforcer(
    DELIVERY_POLICY,
    DELIVERY_ENFORCER,
    'delivery-enforcement policy schema not found in package'
  );
}

/**
 * Install + enable the enforcement-self-protect policy and ATTACH its enforcer
 * — the step that was missing, leaving self-protect inert (documented as active
 * but never registered, so the runtime gate never ran it; the delivery enforcer
 * meanwhile exempts src/policies/, so nothing stopped the agent editing the
 * enforcement control surface). This closes that gap: once attached, the
 * policy-gate hook runs enforcement_self_protect.py on every Edit/Write/Bash and
 * blocks writes to the policy DB tooling, enforcers, .uap.json, proxy env, and
 * the gate hook scripts (operator override: UAP_SELF_PROTECT_OFF=1).
 */
export async function ensureSelfProtect(): Promise<EnsureDeliveryResult> {
  return ensurePolicyEnforcer(
    SELF_PROTECT_POLICY,
    SELF_PROTECT_ENFORCER,
    'enforcement-self-protect policy schema not found in package'
  );
}

/** The pay2u example pack — advisory policies with no enforcer (see the
 * schema files + docs/guides/POLICY_PACK_PAY2U.md). Selectable in the setup
 * policy matrix and installable individually. */
export const PAY2U_PACK_POLICIES = [
  'pay2u-architecture-rules',
  'pay2u-quick-reference',
  'pay2u-enforcement-hooks',
] as const;

/**
 * Install + enable the pay2u policy pack. Each is advisory (no Python
 * enforcer), so ensurePolicyEnforcer installs the .md and enables it without
 * attaching a tool. Idempotent (find-by-name, no duplicates). Returns per-policy
 * results so the caller can report what installed.
 */
export async function ensurePay2uPolicies(): Promise<
  Array<{ name: string } & EnsureDeliveryResult>
> {
  const out: Array<{ name: string } & EnsureDeliveryResult> = [];
  for (const name of PAY2U_PACK_POLICIES) {
    // name===enforcerName: the enforcer .py doesn't exist for these advisory
    // policies, so ensurePolicyEnforcer skips the attach and just installs+enables.
    const r = await ensurePolicyEnforcer(name, name, `${name} policy schema not found in package`);
    out.push({ name, ...r });
  }
  return out;
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
