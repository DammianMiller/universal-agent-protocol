/**
 * Language detection + lexical facts for the built-in scanner.
 *
 * The scanner is a *fallback*: when lizard / rust-code-analysis are installed
 * their (authoritative) numbers win. Without them the gate still needs teeth,
 * so we approximate with a generic brace/indent model driven by the facts
 * below. Heuristic by design — documented as such in the policy.
 */

export type CommentStyle = 'c' | 'hash';

export interface LanguageFacts {
  name: string;
  commentStyle: CommentStyle;
  /** True for indent-delimited languages (python): no braces delimit blocks. */
  indentBased: boolean;
  /**
   * Decision keywords counted for cyclomatic complexity. Word-boundary matched
   * against code with strings/comments stripped.
   */
  decisionWords: string[];
  /** Operator decision tokens (counted like keywords): `&&`, `||`, `?` etc. */
  decisionOps: string[];
}

const C_FAMILY: Omit<LanguageFacts, 'name'> = {
  commentStyle: 'c',
  indentBased: false,
  decisionWords: ['if', 'for', 'while', 'case', 'catch', 'elif'],
  decisionOps: ['&&', '||', '?'],
};

const FACTS: Record<string, LanguageFacts> = {
  typescript: { name: 'typescript', ...C_FAMILY },
  javascript: { name: 'javascript', ...C_FAMILY },
  java: { name: 'java', ...C_FAMILY },
  csharp: { name: 'csharp', ...C_FAMILY },
  cpp: { name: 'cpp', ...C_FAMILY },
  c: { name: 'c', ...C_FAMILY },
  go: {
    name: 'go',
    commentStyle: 'c',
    indentBased: false,
    decisionWords: ['if', 'for', 'case', 'select'],
    decisionOps: ['&&', '||'],
  },
  rust: {
    name: 'rust',
    commentStyle: 'c',
    indentBased: false,
    decisionWords: ['if', 'for', 'while', 'loop', 'match', 'catch'],
    decisionOps: ['&&', '||', '?'],
  },
  python: {
    name: 'python',
    commentStyle: 'hash',
    indentBased: true,
    decisionWords: ['if', 'elif', 'for', 'while', 'except', 'with', 'assert'],
    decisionOps: ['and', 'or'],
  },
  ruby: {
    name: 'ruby',
    commentStyle: 'hash',
    indentBased: false,
    decisionWords: ['if', 'elsif', 'unless', 'while', 'until', 'when', 'rescue'],
    decisionOps: ['&&', '||'],
  },
  php: { name: 'php', ...C_FAMILY },
  swift: { name: 'swift', ...C_FAMILY },
  kotlin: { name: 'kotlin', ...C_FAMILY },
  scala: { name: 'scala', ...C_FAMILY },
};

const EXT_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.cs': 'csharp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
  '.c': 'c', '.h': 'c',
  '.rs': 'rust',
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.scala': 'scala',
};

export function languageForFile(path: string): LanguageFacts | null {
  const m = /\.[^./\\]+$/.exec(path);
  if (!m) return null;
  const key = EXT_MAP[m[0].toLowerCase()];
  return key ? FACTS[key] : null;
}

/**
 * Strip strings and comments so decision-keyword counting does not see prose.
 * A small state machine, one handler per state so no single function carries
 * the whole transition table (the quality gate applies to this repo too).
 * Template literals treated as strings (interpolation expressions are
 * miscounted — acceptable for a fallback heuristic).
 */

type StripState = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';

interface Step {
  next: number;
  state: StripState;
}

const QUOTE_OF: Record<'sq' | 'dq' | 'tpl', string> = { sq: "'", dq: '"', tpl: '`' };

function codeStep(ch: string, next: string, style: CommentStyle, out: string[], i: number): Step {
  if (ch === '/' && next === '/') return { next: i + 2, state: 'line' };
  if (ch === '/' && next === '*') return { next: i + 2, state: 'block' };
  if (style === 'hash' && ch === '#') return { next: i + 1, state: 'line' };
  if (ch === "'") { out.push(' '); return { next: i + 1, state: 'sq' }; }
  if (ch === '"') { out.push(' '); return { next: i + 1, state: 'dq' }; }
  if (ch === '`') { out.push(' '); return { next: i + 1, state: 'tpl' }; }
  out.push(ch);
  return { next: i + 1, state: 'code' };
}

function lineStep(ch: string, out: string[], i: number): Step {
  if (ch === '\n') { out.push('\n'); return { next: i + 1, state: 'code' }; }
  return { next: i + 1, state: 'line' };
}

function blockStep(ch: string, next: string, out: string[], i: number): Step {
  if (ch === '*' && next === '/') return { next: i + 2, state: 'code' };
  if (ch === '\n') out.push('\n'); // keep line numbers stable
  return { next: i + 1, state: 'block' };
}

function stringStep(ch: string, state: 'sq' | 'dq' | 'tpl', out: string[], i: number): Step {
  if (ch === '\\') return { next: i + 2, state };
  if (ch === QUOTE_OF[state]) return { next: i + 1, state: 'code' };
  if (ch === '\n') {
    out.push('\n');
    // Unterminated single/double-quoted string ends at the newline; template
    // literals span lines.
    return { next: i + 1, state: state === 'tpl' ? 'tpl' : 'code' };
  }
  return { next: i + 1, state };
}

export function stripNoise(content: string, style: CommentStyle): string {
  const out: string[] = [];
  let state: StripState = 'code';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    const next = i + 1 < n ? content[i + 1] : '';
    let step: Step;
    if (state === 'code') step = codeStep(ch, next, style, out, i);
    else if (state === 'line') step = lineStep(ch, out, i);
    else if (state === 'block') step = blockStep(ch, next, out, i);
    else step = stringStep(ch, state, out, i);
    i = step.next;
    state = step.state;
  }
  return out.join('');
}
