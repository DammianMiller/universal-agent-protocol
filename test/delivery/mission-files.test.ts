import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMissingFilesNote, missingMissionFiles } from '../../src/delivery/mission-files.js';

describe('appendMissingFilesNote (per-turn layout-divergence feedback)', () => {
  it('appends missing mission-named files to failed-turn feedback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mfn-'));
    try {
      writeFileSync(join(dir, 'player.js'), 'void 0;');
      const mission = 'Build js/enemies.js and js/player.js plus css/styles.css';
      const fb = appendMissingFilesNote('gate FAILED: journeys red', dir, mission);
      expect(fb).toContain('gate FAILED: journeys red');
      expect(fb).toContain('MISSION FILES STILL MISSING');
      expect(fb).toContain('js/enemies.js');
      expect(fb).toContain('css/styles.css');
      expect(fb).not.toContain('player.js,'); // basename exists — not listed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns feedback unchanged when nothing is missing (and survives bad roots)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mfn2-'));
    try {
      writeFileSync(join(dir, 'game.js'), 'void 0;');
      expect(appendMissingFilesNote('all fine', dir, 'polish game.js')).toBe('all fine');
      expect(appendMissingFilesNote('fb', '/nonexistent/root/xyz', 'make a.js')).toContain('fb');
      expect(missingMissionFiles(dir, 'no file tokens here')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
