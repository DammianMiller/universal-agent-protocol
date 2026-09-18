/**
 * DETERMINISTIC REVIEW PRE-PASS (uplift 0.2)
 *
 * A ruleset scanner that runs BEFORE the LLM reviewers in the parallel
 * review protocol (open-code-review precedent: deterministic pipelines first,
 * LLM second). Reviewers receive pre-filtered, line-anchored findings so
 * their tokens go to judgment, not pattern-matching.
 *
 * Design stance: precision over recall. Every rule here fires on a pattern
 * that is almost always worth a human/reviewer glance; ambiguous heuristics
 * belong to the LLM reviewers, not to this pass. Findings are advisory input
 * to review — the blocking behavior stays in the expert-review enforcer,
 * which is unchanged.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

/** git invocation without a shell — this module must pass its own scanner. */
function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

export type PrePassCategory = 'secrets' | 'injection' | 'error-handling' | 'concurrency' | 'sql';
export type PrePassSeverity = 'high' | 'medium';

export interface PrePassFinding {
  rule: string;
  category: PrePassCategory;
  severity: PrePassSeverity;
  file: string;
  line: number;
  snippet: string;
  message: string;
}

interface LineRule {
  name: string;
  category: PrePassCategory;
  severity: PrePassSeverity;
  pattern: RegExp;
  message: string;
  /** When set, only files with one of these extensions are scanned. */
  codeOnly?: boolean;
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx', '.py']);

/**
 * Line-anchored rules. Keep each one boringly precise — a finding that cries
 * wolf trains reviewers to ignore the whole pass.
 */
export const LINE_RULES: LineRule[] = [
  {
    name: 'aws-access-key',
    category: 'secrets',
    severity: 'high',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    message: 'hardcoded AWS access key id',
  },
  {
    name: 'github-token',
    category: 'secrets',
    severity: 'high',
    pattern: /\b(?:gh[posur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    message: 'hardcoded GitHub token',
  },
  {
    name: 'slack-token',
    category: 'secrets',
    severity: 'high',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    message: 'hardcoded Slack token',
  },
  {
    name: 'llm-api-key',
    category: 'secrets',
    severity: 'high',
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/,
    message: 'hardcoded LLM provider API key',
  },
  {
    name: 'npm-token',
    category: 'secrets',
    severity: 'high',
    pattern: /\bnpm_[A-Za-z0-9]{20,}\b/,
    message: 'hardcoded npm token',
  },
  {
    name: 'jwt-token',
    category: 'secrets',
    severity: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/,
    message: 'hardcoded JWT',
  },
  {
    name: 'private-key-block',
    category: 'secrets',
    severity: 'high',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
    message: 'private key material committed to source',
  },
  {
    name: 'hardcoded-secret',
    category: 'secrets',
    severity: 'high',
    // assignment of a quoted literal (>=8 chars) to a secret-named variable
    pattern: /\b(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\b\s*[:=]\s*['"][^'"\n]{8,}['"]/i,
    message: 'secret-looking value assigned as a string literal',
  },
  {
    name: 'eval-call',
    category: 'injection',
    severity: 'high',
    pattern: /(?<![\w.])eval\s*\(/,
    // Message deliberately avoids the literal trigger text so this scanner's
    // own source survives its own dogfood scan.
    message: 'dynamic string execution (eval-family) — injection surface',
    codeOnly: true,
  },
  {
    name: 'new-function',
    category: 'injection',
    severity: 'high',
    pattern: /new\s+Function\s*\(/,
    message: 'dynamic code construction via the Function constructor',
    codeOnly: true,
  },
  {
    name: 'exec-interpolated',
    category: 'injection',
    severity: 'high',
    pattern: /\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{/,
    message: 'child_process exec with an interpolated template string (shell injection)',
    codeOnly: true,
  },
  {
    name: 'exec-concat',
    category: 'injection',
    severity: 'high',
    pattern: /\bexec(?:Sync)?\s*\(\s*['"][^'"]*['"]\s*\+/,
    message: 'child_process exec with string concatenation (shell injection)',
    codeOnly: true,
  },
  {
    name: 'shell-true',
    category: 'injection',
    severity: 'medium',
    pattern: /\bshell\s*[:=]\s*(?:True|true)\b/,
    message: 'command routed through a shell (shell flag) — injection surface',
    codeOnly: true,
  },
  {
    name: 'sql-template-interpolation',
    category: 'sql',
    severity: 'high',
    pattern: /`\s*(?:SELECT|INSERT\s+INTO|UPDATE\s|DELETE\s+FROM)\b[^`]*\$\{/i,
    message: 'SQL built by template interpolation — use parameterized queries',
    codeOnly: true,
  },
  {
    name: 'sql-string-concat',
    category: 'sql',
    severity: 'medium',
    pattern: /['"]\s*(?:SELECT|INSERT\s+INTO|UPDATE\s|DELETE\s+FROM)\b[^'"\n]*['"]\s*\+/i,
    message: 'SQL built by string concatenation — use parameterized queries',
    codeOnly: true,
  },
  {
    name: 'innerhtml-assign',
    category: 'injection',
    severity: 'medium',
    pattern: /\.innerHTML\s*=(?!=)/,
    message: 'innerHTML assignment — XSS surface unless the value is sanitized',
    codeOnly: true,
  },
  {
    // \w* so this rule's own definition line does not match itself
    name: 'dangerously-set-innerhtml',
    category: 'injection',
    severity: 'medium',
    pattern: /dangerously\w*InnerHTML/,
    message: 'React raw-HTML injection prop — XSS surface unless sanitized',
    codeOnly: true,
  },
  {
    name: 'document-write',
    category: 'injection',
    severity: 'medium',
    pattern: /\bdocument\.write\s*\(/,
    message: 'document.write — XSS and parser-blocking surface',
    codeOnly: true,
  },
  {
    name: 'insert-adjacent-html',
    category: 'injection',
    severity: 'medium',
    pattern: /\.insertAdjacentHTML\s*\(/,
    message: 'insertAdjacentHTML — XSS surface unless the value is sanitized',
    codeOnly: true,
  },
  {
    name: 'cors-wildcard',
    category: 'injection',
    severity: 'medium',
    pattern: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]?\*/,
    message: 'CORS wildcard origin — verify this endpoint serves no private data',
  },
  {
    name: 'cors-origin-wildcard',
    category: 'injection',
    severity: 'medium',
    pattern: /\borigin\s*:\s*['"]\*['"]/,
    // Message avoids the literal trigger text (dogfood-clean, like the others)
    message: 'CORS wildcard via middleware options — verify no private data is served',
    codeOnly: true,
  },
];

const MAX_SNIPPET_LEN = 120;

/**
 * Redact secret material from a finding snippet. The artifact's purpose is to
 * be pasted into LLM reviewer prompts — a secrets scanner must not multiply
 * copies of what it detects. The file:line anchor is enough for a reviewer
 * to inspect the secret in place.
 */
export function redactSecrets(snippet: string): string {
  return snippet
    .replace(/(['"])[^'"\n]{4,}\1/g, '$1***redacted***$1')
    .replace(
      /\b(?:AKIA[0-9A-Z]{4}[0-9A-Z]{12}|gh[posur]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{4,}|sk-(?:ant-)?[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{3,})\b/g,
      '***redacted***',
    );
}

function fileExtension(file: string): string {
  const base = file.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot) : '';
}

/** Scan one file's content. `file` is the repo-relative path used in findings. */
export function scanFileContent(file: string, content: string): PrePassFinding[] {
  const ext = fileExtension(file);
  const isCode = CODE_EXTENSIONS.has(ext);
  const findings: PrePassFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    for (const rule of LINE_RULES) {
      if (rule.codeOnly && !isCode) continue;
      if (rule.pattern.test(text)) {
        const snippet = text.trim().slice(0, MAX_SNIPPET_LEN);
        findings.push({
          rule: rule.name,
          category: rule.category,
          severity: rule.severity,
          file,
          line: i + 1,
          snippet: rule.category === 'secrets' ? redactSecrets(snippet) : snippet,
          message: rule.message,
        });
      }
    }
  }

  findings.push(...scanEmptyCatches(file, content, isCode));
  findings.push(...scanPythonErrorSwallowing(file, lines, isCode));
  findings.push(...scanConcurrencySmells(file, content, isCode));
  return findings;
}

/**
 * Whole-content pass for empty catch blocks — a per-line rule can never see
 * the idiomatic multi-line form (`} catch (e) {` newline `}`), which is also
 * the easiest way to deliberately evade the gate.
 */
function scanEmptyCatches(file: string, content: string, isCode: boolean): PrePassFinding[] {
  if (!isCode || file.endsWith('.py')) return [];
  const findings: PrePassFinding[] = [];
  const pattern = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
  for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
    const line = content.slice(0, match.index).split('\n').length;
    findings.push({
      rule: 'empty-catch',
      category: 'error-handling',
      severity: 'medium',
      file,
      line,
      snippet: match[0].replace(/\s+/g, ' ').slice(0, MAX_SNIPPET_LEN),
      message: 'empty catch swallows the error with no trace',
    });
  }
  return findings;
}

/** Python `except: ... pass` pairs — a two-line pattern the line rules can't see. */
function scanPythonErrorSwallowing(
  file: string,
  lines: string[],
  isCode: boolean,
): PrePassFinding[] {
  if (!isCode || !file.endsWith('.py')) return [];
  const findings: PrePassFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    // single-line form: except ...: pass
    if (/^\s*except\b[^:\n]*:\s*(?:pass|\.\.\.)\s*(?:#.*)?$/.test(lines[i])) {
      findings.push({
        rule: 'except-pass',
        category: 'error-handling',
        severity: 'medium',
        file,
        line: i + 1,
        snippet: lines[i].trim().slice(0, MAX_SNIPPET_LEN),
        message: 'except block whose entire body is pass — error swallowed silently',
      });
      continue;
    }
    if (i >= lines.length - 1) break;
    if (!/^\s*except\b[^:]*:\s*(?:#.*)?$/.test(lines[i])) continue;
    const next = lines[i + 1].trim();
    if (next === 'pass' || next === '...') {
      findings.push({
        rule: 'except-pass',
        category: 'error-handling',
        severity: 'medium',
        file,
        line: i + 1,
        snippet: lines[i].trim().slice(0, MAX_SNIPPET_LEN),
        message: 'except block whose entire body is pass — error swallowed silently',
      });
    }
  }
  return findings;
}

/** File-level: Python threads without any lock in the same file. */
function scanConcurrencySmells(
  file: string,
  content: string,
  isCode: boolean,
): PrePassFinding[] {
  if (!isCode || !file.endsWith('.py')) return [];
  if (!/\bthreading\.Thread\s*\(/.test(content)) return [];
  if (/\b(?:threading\.)?Lock\s*\(/.test(content)) return [];
  return [
    {
      rule: 'threading-no-lock',
      category: 'concurrency',
      severity: 'medium',
      file,
      line: 1,
      snippet: 'threading.Thread without any Lock in file',
      message: 'threads spawned but no Lock in this file — check shared-state access',
    },
  ];
}

export interface PrePassOptions {
  /** Explicit repo-relative file list (default: changed files vs upstream). */
  files?: string[];
  projectDir?: string;
}

/** Resolve the target file list for a pre-pass run. */
export function collectPrePassTargets(options: PrePassOptions): string[] {
  const dir = options.projectDir ?? process.cwd();
  if (options.files && options.files.length > 0) return options.files;
  // Default: everything the branch touched, plus uncommitted/untracked work —
  // the same surface the reviewers are about to read.
  const found = new Set<string>();
  const collect = (args: string[]): void => {
    const out = git(dir, args);
    if (out === null) return;
    for (const line of out.split('\n')) {
      const f = line.trim();
      if (f && !f.includes('node_modules/')) found.add(f);
    }
  };
  let baseResolved = false;
  for (const base of ['origin/master', 'origin/main', 'master', 'main']) {
    if (git(dir, ['rev-parse', '--verify', base]) !== null) {
      collect(['diff', '--name-only', `${base}...HEAD`]);
      baseResolved = true;
      break;
    }
  }
  if (!baseResolved) collect(['diff', '--name-only', 'HEAD~1..HEAD']);
  collect(['diff', '--name-only', '--cached']);
  collect(['diff', '--name-only']);
  collect(['ls-files', '--others', '--exclude-standard']);
  return [...found].filter((f) => existsSync(join(dir, f)));
}

/** Scan a resolved target list. */
export function runPrePass(options: PrePassOptions): {
  findings: PrePassFinding[];
  filesScanned: string[];
} {
  const dir = options.projectDir ?? process.cwd();
  const targets = collectPrePassTargets(options);
  const findings: PrePassFinding[] = [];
  const filesScanned: string[] = [];
  for (const file of targets) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), 'utf-8');
    } catch {
      continue; // binary or unreadable — not this pass's job
    }
    filesScanned.push(file);
    findings.push(...scanFileContent(file, content));
  }
  return { findings, filesScanned };
}

/** Percent-encode branch to a filename slug — mirrors slug_for() in the
 * expert_review_required enforcer exactly (the artifact must land where the
 * enforcer looks). */
export function branchSlug(branch: string): string {
  return branch.replace(/%/g, '%25').replace(/\//g, '%2F');
}

export interface PrePassArtifact {
  ran_at: string;
  head: string | null;
  files_scanned: number;
  finding_count: number;
  findings: PrePassFinding[];
}

/**
 * Write the pre-pass artifact to .uap/reviews/<branch-slug>.pre-pass.json.
 *
 * Deliberately a SIBLING of the review artifact (<slug>.json), not a block
 * inside it: the expert-review enforcer treats the existence of <slug>.json
 * as "a review happened", and every substantive check in it is conditional on
 * keys the pre-pass never writes. A pre-pass-only <slug>.json would satisfy
 * the blocking gate with zero reviewers — so this advisory pass must never
 * create that file. Consolidation reads this sibling and merges its findings
 * into the real artifact along with the verdict.
 */
export function writePrePassArtifact(
  projectDir: string,
  findings: PrePassFinding[],
  filesScanned: number,
): { path: string; artifact: PrePassArtifact } | null {
  const branch = git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') return null; // detached/non-git: nowhere to write
  const head = git(projectDir, ['rev-parse', 'HEAD']);

  const dir = join(projectDir, '.uap', 'reviews');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${branchSlug(branch)}.pre-pass.json`);

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = {}; // corrupt artifact: overwrite, don't crash the review
    }
  }

  const artifact: PrePassArtifact = {
    ran_at: new Date().toISOString(),
    head,
    files_scanned: filesScanned,
    finding_count: findings.length,
    findings,
  };
  const merged = { ...existing, pre_pass: artifact };
  // Atomic write: a crash mid-write must not destroy reviewer-written keys —
  // a torn artifact would be reset to {} on next read, erasing a review.
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n');
  renameSync(tmpPath, path);
  return { path, artifact };
}
