/**
 * Deterministic merge gate — the Choir-uplift PR 2 of 2.
 *
 * The mission orchestrator (PR 1 / ADR-0003) keeps a mission moving until a
 * deliver run reports DONE against its frozen acceptance. But a *report* is a
 * claim. The merge gate is the last deterministic check between that claim and
 * master: before work tied to a mission lands, the gate re-derives the verdict
 * from recorded evidence — never from the run's self-report, and never by
 * parsing acceptance text out of an instruction string (ADR-0003's documented
 * seam: `verifyAcceptanceHash`, the marker hash, and the attempt ledger).
 *
 * Four checks, all deterministic (no model calls — the acceptance judge ran
 * inside deliver; the gate verifies its RECORDED outcome, it does not re-judge):
 *
 *   1. provenance        — the marker hash on the PR matches the mission's
 *                           CURRENT frozen acceptance (a replan after the PR
 *                           was cut supersedes the criteria it was built to).
 *   2. green-recompute   — fresh run-state says delivered, the final recorded
 *                           iteration passed its gates (acceptanceMet == 1
 *                           when the judge ran), and no salvage proposal
 *                           awaits a ruling.
 *   3. sorry-delta       — stub markers in ADDED lines of non-test files and
 *                           apology/escape phrasing in the run's declared
 *                           summaries. A completion riddled with "TODO" and
 *                           "sorry, I couldn't" is not a completion.
 *   4. axiom-honesty     — the diff does not touch gate infrastructure
 *                           (enforcers, hooks, baselines, CI, or this gate
 *                           itself) without explicit acknowledgment. A PR may
 *                           not weaken the gates that judge it.
 *
 * The gate has NO environment escape hatch by design: `UAP_*_GATE_OFF` and
 * friends are deliberately not consulted here. The only acknowledgment is the
 * operator-visible `allowGateInfra` flag (CLI `--allow-gate-infra`, or a
 * `gate-infra` PR label when wired into the merge queue).
 */
import type { DeliverRunState } from './run-state.js';

export type MergeGateCheck = 'provenance' | 'green-recompute' | 'sorry-delta' | 'axiom-honesty';

/** One changed file: its path and ONLY the lines the diff ADDS (never the
 *  removed lines — deleting a TODO is progress, not a violation). Files that
 *  are deleted, renamed, or binary carry a path with empty `addedText` — the
 *  path itself is evidence for axiom-honesty. */
export interface ChangedFile {
  path: string;
  addedText: string;
}

/** The slice of run-state evidence the gate needs (seam-injected so tests and
 *  the merge queue can supply it without touching disk). */
export type GateRunState = Pick<DeliverRunState, 'status'> & {
  history?: Array<{ passed: boolean; acceptanceMet?: number }>;
  phaseSummaries?: string[];
};

/**
 * Tier-1 evidence: the gate-evidence artifact deliver records on success
 * (`.uap/evidence/<candidateSha>.json`, uplift 1.4), binding every gate's
 * exit code to the exact HEAD it proved. Production delivered runs persist
 * WITHOUT a checkpoint (deliver clears it on success), so the artifact — not
 * run-state history — is the seam that survives a real delivery.
 */
export interface GateEvidenceCheck {
  /** Artifact exists for the sha being landed. */
  present: boolean;
  /** Every recorded gate exited 0. */
  gatesAllZero: boolean;
  /** No gate-affecting environment hatches were set when gates ran. */
  hatchesEmpty: boolean;
  /** The artifact's candidateSha equals the sha being landed. */
  shaMatches: boolean;
  /** The sha the artifact was requested for (for detail messages). */
  expectedSha: string;
}

export interface MergeGateInputs {
  missionId: number;
  /** Current frozen acceptance hash slice (8 hex chars) from the ledger. */
  acceptanceHash8: string;
  /** Marker slice carried by the work's provenance (`[mission:#N:hash8]`).
   *  The merge queue extracts it from the PR body; the standalone CLI passes
   *  the ledger's own slice (the ledger tamper check is the runner's job). */
  markerHash8?: string;
  /** Ledger integrity: the stored acceptance text still hashes to the stored
   *  hash (verifyAcceptanceHash). False means the ledger was hand-edited. */
  ledgerIntact: boolean;
  runState: GateRunState | null;
  /** Tier-1 evidence artifact state (null when the caller cannot check). */
  evidence: GateEvidenceCheck | null;
  /** pid corroboration (PR-1 provenance discipline): the run-state pid
   *  matches the pid the orchestrator spawned. Undefined when either side is
   *  unknown. */
  pidCorroborated?: boolean;
  /** Salvage proposals for this mission still awaiting a ruling. */
  openSalvageCount: number;
  changedFiles: ChangedFile[];
  /** Explicit operator acknowledgment for deliberate gate-infra changes. */
  allowGateInfra?: boolean;
}

export interface MergeGateFinding {
  check: MergeGateCheck;
  ok: boolean;
  detail: string;
}

export interface MergeGateResult {
  missionId: number;
  pass: boolean;
  findings: MergeGateFinding[];
}

/**
 * Stub markers in ADDED code. Applied to non-test, non-docs files: test
 * suites legitimately stub seams (the house style injects stubs everywhere),
 * and docs/ADRs legitimately quote the markers they describe. A `todo!()`
 * left in production code is exactly the half-delivery this check exists to
 * catch.
 */
export const STUB_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'todo macro', re: /todo!\s*\(/ },
  { label: 'NotImplementedError', re: /\bNotImplementedError\b/ },
  { label: 'unimplemented', re: /\bunimplemented\b|\bnot implemented\b/i },
  // Bounded gap (was `.*`): an adversarial multi-megabyte single line made
  // this pattern quadratic; 120 chars is far more than any real
  // placeholder sentence needs (security review P2).
  { label: 'placeholder implementation', re: /\bplaceholder\b.{0,120}\b(implementation|for now)\b|\bstub(?:bed)? (?:body|implementation|for now)\b/i },
  { label: 'TODO marker', re: /\bTODO\b/ },
  { label: 'FIXME marker', re: /\bFIXME\b/ },
];

/** Apology / escape phrasing — the "sorry delta". Scanned in added lines of
 *  every changed file and in the run's declared summaries. */
export const SORRY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'apology', re: /\bsorry\b|\bi apolog(i|y)/i },
  { label: 'gave up', re: /\bi couldn'?t\b|\bi was unable\b|\bdidn'?t manage to\b|\bnot able to (?:complete|finish|fulfill)\b/i },
  { label: 'refusal', re: /\bcannot (?:complete|fulfill)\b|\bunable to (?:complete|fulfill|finish)\b/i },
];

/**
 * Paths that ARE the gate system. A diff touching any of these without
 * `allowGateInfra` fails axiom-honesty — including the merge gate, its
 * evidence gatherer, and the ledger functions the provenance and
 * green-recompute checks consume: a PR may not weaken (or rewrite) the checks
 * that judge it.
 *
 * Deliberately hard-coded in source, not a config file: an externalized list
 * could be edited by the very PR it judges, and any edit to THIS list trips
 * axiom-honesty against the gate itself (the list protects itself by being
 * the gate — architect review F6).
 */
export const GATE_INFRA_PREFIXES = [
  '.codex/hooks/',
  '.github/workflows/',
  'src/policies/enforcers/',
  'src/delivery/merge-gate.ts',
  'src/delivery/gate-evidence.ts',
  'src/cli/merge-gate.ts',
  'src/cli/merge-queue.ts',
  'src/mission/ledger.ts',
  'src/mission/database.ts',
  'scripts/version-bump.sh',
  '.uap/quality-baseline.json',
  'config/capacity-policy.json',
];

/** Test paths are exempt from stub-marker scanning (seams are stubbed by
 *  design in this codebase); docs paths are exempt because they quote the
 *  markers they describe. */
function isTestPath(path: string): boolean {
  return /(^|\/)test\//.test(path) || /\.(test|spec)\.[cm]?[jt]s$/.test(path);
}

function isDocsPath(path: string): boolean {
  return /\.(md|html|txt)$/.test(path);
}

/** Adversarial long lines (minified blobs, lockfiles) make multi-token
 *  patterns expensive; cap per-line scanning (security review P2). */
const SCAN_LINE_MAX = 8192;

/** First matching pattern label, or null. Long lines are skipped — a real
 *  stub marker sits on a human-scale line. */
function firstMatch(text: string, patterns: Array<{ label: string; re: RegExp }>): string | null {
  for (const line of text.split('\n')) {
    if (line.length > SCAN_LINE_MAX) continue;
    for (const p of patterns) {
      if (p.re.test(line)) return p.label;
    }
  }
  return null;
}

/**
 * PURE decision core. Every check runs and reports (a full finding list, not
 * first-fail) so an operator sees every reason at once; `pass` is the AND of
 * all findings.
 */
export function evaluateMergeGate(inputs: MergeGateInputs): MergeGateResult {
  const findings: MergeGateFinding[] = [];

  // ── 1. provenance / statement immutability ──
  const markerOk =
    inputs.ledgerIntact && inputs.markerHash8 !== undefined && inputs.markerHash8 === inputs.acceptanceHash8;
  findings.push({
    check: 'provenance',
    ok: markerOk,
    detail: !inputs.ledgerIntact
      ? 'ledger tampered: stored acceptance text no longer hashes to the stored hash'
      : inputs.markerHash8 === undefined
        ? `no [mission:#${inputs.missionId}:hash8] marker ties this work to frozen acceptance`
        : inputs.markerHash8 === inputs.acceptanceHash8
          ? `marker hash ${inputs.markerHash8} matches frozen acceptance`
          : `marker hash ${inputs.markerHash8} is superseded (current: ${inputs.acceptanceHash8}) — the work was built under replanned-away criteria`,
  });

  // ── 2. green recompute ──
  let greenOk = true;
  const greenDetails: string[] = [];
  // Tier 1 — the evidence artifact deliver records on success. Production
  // delivered runs persist WITHOUT a checkpoint (deliver clears it), so the
  // artifact is the seam that survives a real delivery; a present-but-invalid
  // artifact (red gate, hatch, sha drift) is a hard failure.
  if (inputs.evidence !== null) {
    if (!inputs.evidence.present) {
      greenDetails.push(
        `no gate-evidence artifact for ${inputs.evidence.expectedSha.slice(0, 12)}… (.uap/evidence/)`
      );
    } else if (!inputs.evidence.shaMatches) {
      greenOk = false;
      greenDetails.push('evidence artifact is bound to a different candidate sha');
    } else if (!inputs.evidence.hatchesEmpty) {
      greenOk = false;
      greenDetails.push('evidence artifact records gate-affecting environment hatches');
    } else if (!inputs.evidence.gatesAllZero) {
      greenOk = false;
      greenDetails.push('evidence artifact records a non-zero gate exit');
    }
  }
  // Tier 2 — run-state history (present on interrupted/resumed shapes and
  // hand-crafted fixtures; absent on the production delivered shape).
  if (inputs.runState === null) {
    greenOk = false;
    greenDetails.push('no linked run (or run-state unreadable)');
  } else {
    if (inputs.runState.status !== 'delivered') {
      greenOk = false;
      greenDetails.push(`run state is '${sanitize(inputs.runState.status)}', not 'delivered'`);
    }
    if (inputs.pidCorroborated === false) {
      greenOk = false;
      greenDetails.push('run pid does not match the pid the orchestrator spawned');
    }
    const history = inputs.runState.history ?? [];
    if (history.length > 0) {
      const last = history[history.length - 1];
      if (!last.passed) {
        greenOk = false;
        greenDetails.push(`last recorded iteration failed its gates`);
      } else if (last.acceptanceMet !== undefined && last.acceptanceMet < 1) {
        greenOk = false;
        greenDetails.push(
          `final acceptance judge met only ${Math.round(last.acceptanceMet * 100)}% of criteria`
        );
      }
    } else if (inputs.evidence !== null && inputs.evidence.present) {
      // artifact-backed: status + artifact is sufficient.
    } else if (inputs.evidence === null) {
      // caller did not check the artifact; history is the only evidence.
    } else {
      // No artifact AND no history: the "delivered" status string alone is
      // testimony, not evidence — refuse it (code review P1).
      greenOk = false;
      greenDetails.push(
        'no recorded evidence beyond the delivered status string (deliver clears checkpoints on success; expected .uap/evidence/<sha>.json)'
      );
    }
  }
  if (inputs.openSalvageCount > 0) {
    greenOk = false;
    greenDetails.push(
      `${inputs.openSalvageCount} salvage proposal(s) await a ruling (approval-gated — landing would bypass the ruling)`
    );
  }
  const artifactNote =
    inputs.evidence !== null && inputs.evidence.present && inputs.evidence.gatesAllZero && inputs.evidence.hatchesEmpty && inputs.evidence.shaMatches
      ? ' + evidence artifact green'
      : '';
  findings.push({
    check: 'green-recompute',
    ok: greenOk,
    detail: greenOk
      ? `fresh run-state: delivered${artifactNote}, no open salvage`
      : greenDetails.join('; '),
  });

  // ── 3. sorry-delta ──
  const stubHits: string[] = [];
  const sorryHits: string[] = [];
  for (const f of inputs.changedFiles) {
    if (f.addedText.length === 0) continue;
    if (!isTestPath(f.path) && !isDocsPath(f.path)) {
      const stub = firstMatch(f.addedText, STUB_PATTERNS);
      if (stub) stubHits.push(`${f.path} (${stub})`);
    }
    const sorry = firstMatch(f.addedText, SORRY_PATTERNS);
    if (sorry) sorryHits.push(`${f.path} (${sorry})`);
  }
  const summaries = (inputs.runState?.phaseSummaries ?? []).join('\n');
  if (summaries.length > 0) {
    const sorry = firstMatch(summaries, SORRY_PATTERNS);
    if (sorry) sorryHits.push(`run summaries (${sorry})`);
  }
  const sorryOk = stubHits.length === 0 && sorryHits.length === 0;
  findings.push({
    check: 'sorry-delta',
    ok: sorryOk,
    detail: sorryOk
      ? `no stub or apology markers in ${inputs.changedFiles.length} changed file(s)`
      : `stub markers: ${stubHits.length ? stubHits.join(', ') : 'none'}; apology markers: ${
          sorryHits.length ? sorryHits.join(', ') : 'none'
        }`,
  });

  // ── 4. axiom-honesty (gate-infra tampering) ──
  const infraHits = inputs.changedFiles
    .map((f) => f.path)
    .filter((p) => GATE_INFRA_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix)));
  const infraOk = infraHits.length === 0 || inputs.allowGateInfra === true;
  findings.push({
    check: 'axiom-honesty',
    ok: infraOk,
    detail:
      infraHits.length === 0
        ? 'diff does not touch gate infrastructure'
        : infraOk
          ? `gate-infra changes explicitly acknowledged: ${infraHits.join(', ')}`
          : `diff touches gate infrastructure without acknowledgment (${infraHits.join(
              ', '
            )}) — pass --allow-gate-infra (or label the PR gate-infra) only if this is deliberate`,
  });

  return { missionId: inputs.missionId, pass: findings.every((f) => f.ok), findings };
}

/**
 * Strip terminal escapes before echoing untrusted strings (run-state status
 * comes from an agent-writable state.json — CWE-117, security review P3).
 */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\u001b\u009b]/g, '');
}

/**
 * Extract the mission provenance marker from free text (a PR title or body).
 * Prefix-pinned like the poll-executor's parser: the bracketed form must match
 * exactly, so argv injection and partial collisions cannot forge linkage.
 */
export function missionMarkerOf(text: string): { missionId: number; hash8: string } | null {
  const m = /\[mission:#(\d+):([0-9a-f]{8})\]/.exec(text ?? '');
  return m ? { missionId: Number(m[1]), hash8: m[2] } : null;
}

/**
 * Parse a unified diff into changed files with their ADDED lines. Accepts the
 * output of `git diff --unified=0 <base>...HEAD` and `gh pr diff`. Pure — the
 * command execution lives in the callers, tests exercise only this parser.
 *
 * Path coverage is the security property: DELETED files (`+++ /dev/null`),
 * RENAMED files (no `+++` line at all), and BINARY files (no headers) must all
 * reach the axiom-honesty prefix match — `git rm .codex/hooks/x.sh` is the
 * purest form of weakening a gate, so the deleted path is captured from the
 * `diff --git` / `--- a/` lines (security review P1, architect F1).
 *
 * An ADDED content line that itself starts with `+++` is not misread as a
 * header: `+++` only opens a file when the previous line was its `---` pair.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  const fileFor = (path: string): ChangedFile => {
    let f = byPath.get(path);
    if (!f) {
      f = { path, addedText: '' };
      byPath.set(path, f);
    }
    return f;
  };
  let current: ChangedFile | null = null;
  let inHunk = false; // true after a file's first @@ line
  let prevWasHeaderPair = false; // previous line was a `--- ` file header
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // `diff --git a/<path> b/<path>` — authoritative for renames (no +++
      // line follows) and binaries. Register both sides; the b-side becomes
      // the add target if a +++ header never appears.
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m) {
        fileFor(m[1]); // old path (deletions, rename source)
        current = fileFor(m[2]);
      }
      inHunk = false;
      prevWasHeaderPair = false;
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) {
      const old = line.slice(4);
      // `--- a/<path>`: register the path (deletion evidence) but do not
      // retarget added lines — only the `+++` header does that.
      if (old.startsWith('a/') && old !== 'a/') fileFor(old.slice(2));
      prevWasHeaderPair = true;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ') && prevWasHeaderPair) {
      const target = line.slice(4);
      current =
        target === '/dev/null'
          ? null // pure deletion: added lines cannot follow
          : fileFor(target.startsWith('b/') ? target.slice(2) : target);
      prevWasHeaderPair = false;
      continue;
    }
    prevWasHeaderPair = false;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (line.startsWith('+') && current) {
      // Inside a hunk every `+`-leading line is content — including one that
      // merely LOOKS like a header (`++ b/x` renders as `+++ b/x`).
      current.addedText += line.slice(1) + '\n';
    }
  }
  return [...byPath.values()];
}
