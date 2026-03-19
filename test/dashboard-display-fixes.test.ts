/**
 * Tests for dashboard display fixes:
 *
 * 1. Duplicate uap_dashboard tool removed from uap-commands.ts
 * 2. session-telemetry.ts boxLine() handles ANSI + wide chars
 * 3. session-telemetry.ts dashboard hash is state-based (not time-based)
 * 4. web/dashboard.html Operations panel uses class="panel"
 * 5. visualize.ts getVisualWidth() handles wide Unicode chars
 * 6. visualize.ts box() uses visual width for padding
 * 7. cli/dashboard.ts compactSessionSummary() width calculation fixed
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Dashboard Display Fixes', () => {
  describe('Duplicate tool registration removed', () => {
    it('uap-commands.ts does NOT register uap_dashboard tool', () => {
      const source = readFileSync('.opencode/plugin/uap-commands.ts', 'utf-8');
      // Should have the comment explaining why it's not here
      expect(source).toContain('uap_dashboard is registered in uap-dashboard.ts');
      // Should NOT have the old tool definition with the incompatible enum
      expect(source).not.toContain("'overview', 'tasks', 'agents', 'memory', 'progress', 'stats'");
    });

    it('uap-dashboard.ts still registers uap_dashboard tool', () => {
      const source = readFileSync('.opencode/plugin/uap-dashboard.ts', 'utf-8');
      expect(source).toContain('uap_dashboard: tool(');
      expect(source).toContain("'show', 'start', 'stop', 'snapshot', 'summary'");
    });
  });

  describe('session-telemetry.ts boxLine() ANSI stripping', () => {
    it('uses stripAnsiCodes function for proper ANSI removal', () => {
      const source = readFileSync('src/telemetry/session-telemetry.ts', 'utf-8');
      expect(source).toContain('function stripAnsiCodes');
      expect(source).toContain('function getVisualWidth');
    });

    it('boxLine uses getVisualWidth for padding calculation', () => {
      const source = readFileSync('src/telemetry/session-telemetry.ts', 'utf-8');
      expect(source).toContain('const visualWidth = getVisualWidth(stripped)');
      expect(source).toContain('const pad = Math.max(0, width - visualWidth - 2)');
    });
  });

  describe('Dashboard hash is state-based', () => {
    it('generateDashboardHash does NOT use Date.now()', () => {
      const source = readFileSync('src/telemetry/session-telemetry.ts', 'utf-8');
      // Find the generateDashboardHash function
      const hashFnMatch = source.match(
        /function generateDashboardHash[\s\S]*?return [`'][\s\S]*?[`'];/
      );
      expect(hashFnMatch).not.toBeNull();
      const hashFn = hashFnMatch![0];
      expect(hashFn).not.toContain('Date.now()');
      // Should use actual state values
      expect(hashFn).toContain('tokensUsed');
      expect(hashFn).toContain('errors');
    });
  });

  describe('Web dashboard panels use correct classes', () => {
    it('Policies panel uses class="panel"', () => {
      const source = readFileSync('web/dashboard.html', 'utf-8');
      const section = source.indexOf('Policies');
      expect(section).toBeGreaterThan(-1);
      const before = source.slice(Math.max(0, section - 80), section);
      expect(before).toContain('class="panel');
    });
  });

  describe('visualize.ts getVisualWidth()', () => {
    it('exports getVisualWidth function', async () => {
      const { getVisualWidth } = await import('../src/cli/visualize.js');
      expect(typeof getVisualWidth).toBe('function');
    });

    it('returns 1 for ASCII characters', async () => {
      const { getVisualWidth } = await import('../src/cli/visualize.js');
      expect(getVisualWidth('hello')).toBe(5);
      expect(getVisualWidth('abc123')).toBe(6);
    });

    it('returns 2 for wide Unicode characters (emoji)', async () => {
      const { getVisualWidth } = await import('../src/cli/visualize.js');
      // Emoji are 2 columns wide
      expect(getVisualWidth('🧠')).toBe(2);
      expect(getVisualWidth('hello🧠')).toBe(7); // 5 + 2
    });

    it('returns 2 for CJK characters', async () => {
      const { getVisualWidth } = await import('../src/cli/visualize.js');
      expect(getVisualWidth('中')).toBe(2);
      expect(getVisualWidth('中文')).toBe(4);
    });

    it('strips ANSI codes before measuring', async () => {
      const { getVisualWidth } = await import('../src/cli/visualize.js');
      expect(getVisualWidth('\x1b[32mhello\x1b[0m')).toBe(5);
      expect(getVisualWidth('\x1b[1m\x1b[36mtest\x1b[0m')).toBe(4);
    });

    it('handles box drawing characters as single-width', async () => {
      const { getVisualWidth } = await import('../src/cli/visualize.js');
      expect(getVisualWidth('╭──╮')).toBe(4);
      expect(getVisualWidth('│')).toBe(1);
      expect(getVisualWidth('█░')).toBe(2);
    });
  });

  describe('Session ID truncation in headers', () => {
    it('renderDashboard truncates long session IDs', () => {
      const source = readFileSync('src/telemetry/session-telemetry.ts', 'utf-8');
      // renderDashboard should truncate session ID
      expect(source).toContain("s.sessionId.length > 12 ? s.sessionId.slice(0, 12) + '…'");
    });

    it('showDashboardSnapshot truncates long session IDs', () => {
      const source = readFileSync('src/telemetry/session-telemetry.ts', 'utf-8');
      expect(source).toContain("s.sessionId.length > 16 ? s.sessionId.slice(0, 16) + '…'");
    });

    it('sessionSummary truncates long session IDs', () => {
      const source = readFileSync('src/telemetry/session-telemetry.ts', 'utf-8');
      expect(source).toContain("s.sessionId.length > 20 ? s.sessionId.slice(0, 20) + '…'");
    });
  });

  describe('compactSessionSummary width calculation', () => {
    it('uses plain text length for header padding', () => {
      const source = readFileSync('src/cli/dashboard.ts', 'utf-8');
      // Should calculate header text width from plain string, not ANSI-colored string
      expect(source).toContain('const headerText =');
      expect(source).toContain('const headerPad = Math.max(0, W - headerText.length)');
    });
  });
});
