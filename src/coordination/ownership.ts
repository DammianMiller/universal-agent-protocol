/**
 * Path-lane ownership — conflict PREVENTION rather than detection.
 *
 * Every other layer in this system reacts to a collision that already happened:
 * the live lock fires when two agents are in the same file, the drift check fires
 * when a file moved under you, the merge queue fires when two PRs disagree. All
 * useful, all after the fact.
 *
 * Ownership works one step earlier: partition the codebase into lanes, and hand
 * concurrent agents work from DIFFERENT lanes in the first place. Two agents that
 * never touch the same lane cannot produce the conflict at all.
 *
 * Config lives at `.uap-ownership.json` in the repo root:
 *
 *   {
 *     "lanes": {
 *       "delivery": ["src/delivery/**", "test/deliver-*.test.ts"],
 *       "cli":      ["src/cli/**", "src/bin/**"],
 *       "policy":   ["src/policies/**", "policies/**"]
 *     }
 *   }
 *
 * That path is deliberately OUTSIDE `.uap/`, which is gitignored. A lane map that
 * cannot be committed cannot be shared between agents, clones, worktrees or CI —
 * which is every situation this feature exists for. A local, uncommitted
 * `.uap/ownership.json` still wins when present, for per-machine overrides.
 *
 * Unmapped paths belong to no lane and are never blocked — an incomplete map
 * degrades to today's behavior instead of freezing work.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface OwnershipMap {
  /** lane name -> glob patterns owned by that lane */
  lanes: Record<string, string[]>;
}

/** Tracked, shared across clones and worktrees. The one to document. */
export const OWNERSHIP_FILE = '.uap-ownership.json';
/** Untracked per-machine override, checked first when it exists. */
export const OWNERSHIP_LOCAL_FILE = '.uap/ownership.json';

/**
 * Minimal glob matcher: `**` (any depth, may be empty), `*` (within a segment),
 * `?` (one char). Deliberately not a dependency — the patterns here are path
 * prefixes, and a full glob engine would be a new supply-chain surface for
 * roughly twenty lines of behavior.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const normalize = (s: string): string => s.replace(/^\.\//, '').replace(/\/+$/, '');
  const pat = normalize(pattern);
  const target = normalize(path);

  // Build a regex, escaping everything that is not a wildcard we support.
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        // `**/` matches zero or more leading segments; a bare `**` matches the rest.
        if (pat[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  try {
    return new RegExp(`^${re}$`).test(target);
  } catch {
    return false;
  }
}

/**
 * Load the ownership map; returns empty lanes when absent or malformed.
 * A local `.uap/ownership.json` overrides the tracked `.uap-ownership.json`.
 */
export function loadOwnershipMap(root: string): OwnershipMap {
  const local = join(root, OWNERSHIP_LOCAL_FILE);
  const shared = join(root, OWNERSHIP_FILE);
  const file = existsSync(local) ? local : shared;
  if (!existsSync(file)) {
    return { lanes: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<OwnershipMap>;
    const lanes = parsed.lanes;
    if (!lanes || typeof lanes !== 'object') {
      return { lanes: {} };
    }
    // Drop malformed entries rather than throwing — a broken map must not break
    // task routing for everyone.
    const clean: Record<string, string[]> = {};
    for (const [lane, globs] of Object.entries(lanes)) {
      if (Array.isArray(globs)) {
        const valid = globs.filter((g): g is string => typeof g === 'string' && g.length > 0);
        if (valid.length > 0) clean[lane] = valid;
      }
    }
    return { lanes: clean };
  } catch {
    return { lanes: {} };
  }
}

/** Lanes that claim this path. A path may sit in more than one lane. */
export function ownersFor(path: string, map: OwnershipMap): string[] {
  const owners: string[] = [];
  for (const [lane, globs] of Object.entries(map.lanes)) {
    if (globs.some((g) => matchGlob(g, path))) {
      owners.push(lane);
    }
  }
  return owners;
}

/** Union of lanes across a set of paths. */
export function lanesForPaths(paths: string[], map: OwnershipMap): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    for (const lane of ownersFor(p, map)) set.add(lane);
  }
  return [...set].sort();
}

export interface ConflictVerdict {
  conflicts: boolean;
  /** Files touched by both sides — a guaranteed textual conflict. */
  sharedFiles: string[];
  /** Lanes touched by both sides — a likely semantic conflict. */
  sharedLanes: string[];
}

/**
 * Would two units of work collide? Shared files are certain; shared lanes are
 * the early warning — same module, different files, still one integration.
 */
export function assessConflict(
  aPaths: string[],
  bPaths: string[],
  map: OwnershipMap
): ConflictVerdict {
  const bFiles = new Set(bPaths);
  const sharedFiles = aPaths.filter((p) => bFiles.has(p));

  const aLanes = new Set(lanesForPaths(aPaths, map));
  const sharedLanes = lanesForPaths(bPaths, map).filter((l) => aLanes.has(l));

  return {
    conflicts: sharedFiles.length > 0 || sharedLanes.length > 0,
    sharedFiles,
    sharedLanes,
  };
}

export interface LaneAssignment<T> {
  item: T;
  lanes: string[];
}

/**
 * Greedily select work that does not share a lane with anything already running
 * or already selected. This is the scheduling primitive: given N ready tasks and
 * the lanes currently held by live agents, return the subset that can safely run
 * in parallel right now.
 *
 * Items with NO lane are treated as unconstrained and always selectable — an
 * unmapped repo behaves exactly as it does today.
 */
export function selectDisjoint<T>(
  items: T[],
  pathsOf: (item: T) => string[],
  map: OwnershipMap,
  heldLanes: string[] = []
): LaneAssignment<T>[] {
  const taken = new Set(heldLanes);
  const chosen: LaneAssignment<T>[] = [];

  for (const item of items) {
    const lanes = lanesForPaths(pathsOf(item), map);
    if (lanes.length === 0) {
      chosen.push({ item, lanes });
      continue;
    }
    if (lanes.some((l) => taken.has(l))) {
      continue;
    }
    for (const l of lanes) taken.add(l);
    chosen.push({ item, lanes });
  }

  return chosen;
}
