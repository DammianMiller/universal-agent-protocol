/**
 * Terminal-safe rendering  — strip the C0/C1 control
 * characters that could steer an operator's terminal from data we did not
 * author: JSON report fields, analytics-store model ids, commit subjects.
 *
 * Kept characters: `\t`, `\n`, `\r` (layout, not control); everything else in
 * C0 (U+0000–U+001F), DEL (U+007F), and C1 (U+0080–U+009F) is removed. This
 * is defense-in-depth at ONE choke point, not a trust boundary: the strings
 * it cleans come from repo/store files an operator could equally `cat` — but
 * a UAP surface must not be a better terminal-injection mule than `cat`.
 */
// eslint-disable-next-line no-control-regex -- matching control bytes IS this module's job; the regex strips what it matches
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Strip terminal-control bytes (keeps tab/newline/CR). */
export function termSafe(s: string): string {
  return s.replace(CONTROL_CHARS, '');
}

/**
 * Same strip, then flatten to ONE line and bound the length — for strings
 * that become prompt text or single-line display fields (model ids, labels).
 * Line breaks are structure a hostile string must not smuggle in: collapsing
 * them to a space keeps the text honest and the shape fixed.
 */
export function termSafeBounded(s: string, max: number): string {
  return termSafe(s)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
