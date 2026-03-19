import chalk from 'chalk';

// BRAILLE_DOTS removed — was only used by dead sparkline function

export interface BarSegment {
  value: number;
  color: (text: string) => string;
  label?: string;
}

export interface TableColumn {
  key: string;
  header: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  color?: (text: string) => string;
}

export interface TreeNode {
  label: string;
  children?: TreeNode[];
  status?: string;
  meta?: string;
}

export function progressBar(
  current: number,
  total: number,
  width: number = 30,
  options: {
    filled?: (text: string) => string;
    empty?: (text: string) => string;
    showPercent?: boolean;
    showCount?: boolean;
    label?: string;
  } = {}
): string {
  const {
    filled = chalk.green,
    empty = chalk.dim,
    showPercent = true,
    showCount = true,
    label,
  } = options;

  const ratio = total > 0 ? Math.min(current / total, 1) : 0;
  const filledWidth = Math.round(ratio * width);
  const emptyWidth = width - filledWidth;

  const filledPart = filled('█'.repeat(filledWidth));
  const emptyPart = empty('░'.repeat(emptyWidth));

  const parts: string[] = [];
  if (label) parts.push(chalk.bold(label));
  parts.push(`${filledPart}${emptyPart}`);
  if (showPercent) parts.push(chalk.bold(`${Math.round(ratio * 100)}%`));
  if (showCount) parts.push(chalk.dim(`(${current}/${total})`));

  return parts.join(' ');
}

export function stackedBar(segments: BarSegment[], total: number, width: number = 40): string {
  if (total === 0) return chalk.dim('░'.repeat(width));

  let result = '';
  let usedWidth = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segWidth =
      i === segments.length - 1 ? width - usedWidth : Math.round((seg.value / total) * width);
    if (segWidth > 0) {
      result += seg.color('█'.repeat(Math.min(segWidth, width - usedWidth)));
      usedWidth += segWidth;
    }
  }

  if (usedWidth < width) {
    result += chalk.dim('░'.repeat(width - usedWidth));
  }

  return result;
}

export function stackedBarLegend(segments: BarSegment[]): string {
  return segments
    .filter((s) => s.value > 0)
    .map((s) => `${s.color('██')} ${s.label || ''} ${chalk.bold(String(s.value ?? 0))}`)
    .join('  ');
}

export function horizontalBarChart(
  data: Array<{ label: string; value: number; color?: (text: string) => string }>,
  options: { maxWidth?: number; maxLabelWidth?: number } = {}
): string[] {
  const { maxWidth = 40, maxLabelWidth = 15 } = options;
  const maxValue = Math.max(...data.map((d) => d.value), 1);
  const lines: string[] = [];

  for (const item of data) {
    const barWidth = Math.round((item.value / maxValue) * maxWidth);
    const color = item.color || chalk.blue;
    const label = item.label.padEnd(maxLabelWidth).slice(0, maxLabelWidth);
    const bar = color('█'.repeat(Math.max(barWidth, 0)));
    const value = chalk.bold(String(item.value));
    lines.push(`  ${chalk.dim(label)} ${bar} ${value}`);
  }

  return lines;
}

/** Safely coerce any value to a display string without producing "[object Object]" */
function safeDisplayString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  }
  return String(v);
}

export function table(rows: Record<string, unknown>[], columns: TableColumn[]): string[] {
  const colWidths = columns.map((col) => {
    if (col.width) return col.width;
    const headerLen = col.header.length;
    const maxDataLen = Math.max(...rows.map((r) => safeDisplayString(r[col.key]).length), 0);
    return Math.max(headerLen, maxDataLen) + 2;
  });

  const lines: string[] = [];

  const headerLine = columns
    .map((col, i) => padCell(col.header, colWidths[i], col.align || 'left'))
    .join(chalk.dim(' │ '));
  lines.push(`  ${chalk.bold(headerLine)}`);

  const separator = colWidths.map((w) => '─'.repeat(w)).join(chalk.dim('─┼─'));
  lines.push(`  ${chalk.dim(separator)}`);

  for (const row of rows) {
    const rowLine = columns
      .map((col, i) => {
        const val = safeDisplayString(row[col.key]);
        const padded = padCell(val, colWidths[i], col.align || 'left');
        return col.color ? col.color(padded) : padded;
      })
      .join(chalk.dim(' │ '));
    lines.push(`  ${rowLine}`);
  }

  return lines;
}

function padCell(text: string, width: number, align: 'left' | 'right' | 'center'): string {
  const stripped = stripAnsi(text);
  const pad = Math.max(0, width - stripped.length);

  switch (align) {
    case 'right':
      return ' '.repeat(pad) + text;
    case 'center': {
      const left = Math.floor(pad / 2);
      const right = pad - left;
      return ' '.repeat(left) + text + ' '.repeat(right);
    }
    default:
      return text + ' '.repeat(pad);
  }
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Calculate the visual width of a string in terminal columns.
 * Wide characters (emoji, CJK) occupy 2 columns; most others occupy 1.
 * Exported for use in tests.
 */
export function getVisualWidth(str: string): number {
  const stripped = stripAnsi(str);
  let width = 0;
  for (const char of stripped) {
    const code = char.codePointAt(0) || 0;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3040 && code <= 0x33bf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x2ffff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function tree(node: TreeNode, prefix: string = '', isLast: boolean = true): string[] {
  const lines: string[] = [];
  const connector = isLast ? '└── ' : '├── ';
  const statusIcon = node.status ? `${node.status} ` : '';
  const meta = node.meta ? chalk.dim(` (${node.meta})`) : '';

  lines.push(`${prefix}${connector}${statusIcon}${node.label}${meta}`);

  if (node.children) {
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
      const childLines = tree(node.children[i], childPrefix, i === node.children.length - 1);
      lines.push(...childLines);
    }
  }

  return lines;
}

export function box(
  title: string,
  content: string[],
  options: { width?: number; borderColor?: (text: string) => string } = {}
): string[] {
  const { borderColor = chalk.dim } = options;
  const maxContentWidth = Math.max(
    getVisualWidth(title) + 2,
    ...content.map((l) => getVisualWidth(l))
  );
  const width = options.width || maxContentWidth + 4;
  const innerWidth = width - 2;

  const lines: string[] = [];
  lines.push(borderColor(`╭${'─'.repeat(innerWidth)}╮`));
  lines.push(
    borderColor('│') +
      ` ${chalk.bold(title)}${' '.repeat(Math.max(0, innerWidth - getVisualWidth(title) - 1))}` +
      borderColor('│')
  );
  lines.push(borderColor(`├${'─'.repeat(innerWidth)}┤`));

  for (const line of content) {
    const vw = getVisualWidth(line);
    const pad = Math.max(0, innerWidth - vw - 1);
    lines.push(borderColor('│') + ` ${line}${' '.repeat(pad)}` + borderColor('│'));
  }

  lines.push(borderColor(`╰${'─'.repeat(innerWidth)}╯`));
  return lines;
}

export function sectionHeader(title: string, width: number = 60): string {
  const padLen = Math.max(0, width - title.length - 4);
  return chalk.bold.cyan(`── ${title} ${'─'.repeat(padLen)}`);
}

export function keyValue(
  pairs: Array<[string, string | number]>,
  options: { keyWidth?: number; indent?: number } = {}
): string[] {
  const { keyWidth = 18, indent = 2 } = options;
  const pad = ' '.repeat(indent);
  return pairs.map(([key, value]) => {
    const paddedKey = key.padEnd(keyWidth);
    return `${pad}${chalk.dim(paddedKey)} ${chalk.bold(String(value))}`;
  });
}

export function miniGauge(value: number, max: number, width: number = 10): string {
  const ratio = Math.min(value / Math.max(max, 1), 1);
  const filled = Math.round(ratio * width);
  const color =
    ratio >= 0.8
      ? chalk.green
      : ratio >= 0.5
        ? chalk.yellow
        : ratio >= 0.25
          ? chalk.hex('#FF8800')
          : chalk.red;
  return color('▓'.repeat(filled)) + chalk.dim('░'.repeat(width - filled));
}

export function statusBadge(status: string): string {
  const badges: Record<string, string> = {
    active: chalk.bgGreen.black(' ACTIVE '),
    idle: chalk.bgYellow.black(' IDLE '),
    done: chalk.bgBlue.white(' DONE '),
    failed: chalk.bgRed.white(' FAILED '),
    blocked: chalk.bgRed.white(' BLOCKED '),
    open: chalk.bgWhite.black(' OPEN '),
    in_progress: chalk.bgCyan.black(' IN PROGRESS '),
    wont_do: chalk.bgGray.white(' WONT DO '),
    running: chalk.bgGreen.black(' RUNNING '),
    stopped: chalk.bgRed.white(' STOPPED '),
    not_available: chalk.bgGray.white(' N/A '),
  };
  return badges[status] || chalk.dim(`[${status}]`);
}

export function divider(width: number = 60, char: string = '─'): string {
  return chalk.dim(char.repeat(width));
}

export function bulletList(
  items: Array<{ text: string; status?: 'ok' | 'warn' | 'error' | 'info' }>,
  indent: number = 2
): string[] {
  const pad = ' '.repeat(indent);
  const icons: Record<string, string> = {
    ok: chalk.green('●'),
    warn: chalk.yellow('●'),
    error: chalk.red('●'),
    info: chalk.blue('●'),
  };
  return items.map((item) => {
    const icon = icons[item.status || 'info'];
    return `${pad}${icon} ${item.text}`;
  });
}

export function columns(
  left: string[],
  right: string[],
  options: { gap?: number; leftWidth?: number } = {}
): string[] {
  const { gap = 4, leftWidth = 35 } = options;
  const maxLen = Math.max(left.length, right.length);
  const lines: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    const l = left[i] || '';
    const r = right[i] || '';
    const strippedL = stripAnsi(l);
    const pad = Math.max(0, leftWidth - strippedL.length) + gap;
    lines.push(`${l}${' '.repeat(pad)}${r}`);
  }

  return lines;
}

export function inlineProgressSummary(stats: {
  total: number;
  byStatus: Record<string, number>;
  blocked: number;
  ready: number;
}): string[] {
  const done = (stats.byStatus['done'] || 0) + (stats.byStatus['wont_do'] || 0);
  const inProg = stats.byStatus['in_progress'] || 0;
  const open = stats.byStatus['open'] || 0;
  const blocked = stats.byStatus['blocked'] || 0;
  const total = stats.total;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const pctColor = pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red;

  const barWidth = 30;
  const doneW = total > 0 ? Math.round((done / total) * barWidth) : 0;
  const progW = total > 0 ? Math.round((inProg / total) * barWidth) : 0;
  const blockW = total > 0 ? Math.round((blocked / total) * barWidth) : 0;
  const openW = Math.max(0, barWidth - doneW - progW - blockW);
  const bar =
    chalk.green('█'.repeat(doneW)) +
    chalk.cyan('█'.repeat(progW)) +
    chalk.red('█'.repeat(blockW)) +
    chalk.white('█'.repeat(openW));

  const lines: string[] = [];
  lines.push(chalk.dim('─'.repeat(50)));
  lines.push(
    `${bar} ${pctColor(chalk.bold(pct + '%'))} ` +
      chalk.dim(`${done}`) +
      chalk.green('✓') +
      chalk.dim(' ') +
      chalk.dim(`${inProg}`) +
      chalk.cyan('◐') +
      chalk.dim(' ') +
      (blocked > 0 ? chalk.dim(`${blocked}`) + chalk.red('❄') + chalk.dim(' ') : '') +
      chalk.dim(`${open}○`) +
      chalk.dim(` / ${total}`)
  );

  return lines;
}

// heatmapRow removed — was exported but never imported by any consumer
