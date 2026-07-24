import { describe, it, expect } from 'vitest';

import { renderAcceptanceContract, type UserPathsManifest } from '../../src/delivery/user-paths.js';
import { defaultPromptBuilder } from '../../src/delivery/convergence-loop.js';

const CANVAS_GAME: UserPathsManifest = {
  version: 1,
  paths: [
    {
      id: 'load_and_start',
      rule: 'Game loads, shows the start screen, and starts on click.',
      client: 'browser',
      entry: 'http://localhost:3001',
      steps: [
        { goto: '/' },
        { expect_visible: 'canvas' },
        { expect_visible: '#title' },
        { expect_text: { selector: '#title', contains: 'OCTOPUS INVADERS' } },
        { click: '#start-btn' },
        { wait_ms: 500 },
        { expect_visible: '#hud-score' },
        { expect_no_console_errors: true },
      ],
    },
  ],
};

describe('renderAcceptanceContract', () => {
  it('lists every referenced DOM selector as a build requirement and adds the canvas→DOM bridge', () => {
    const contract = renderAcceptanceContract(CANVAS_GAME);
    expect(contract).toContain('ACCEPTANCE CONTRACT');
    // journey + its steps are surfaced
    expect(contract).toContain('load_and_start');
    expect(contract).toContain('click #start-btn');
    expect(contract).toContain('#title must contain "OCTOPUS INVADERS"');
    // required selectors are collected from click/expect_visible/expect_text
    expect(contract).toMatch(/REQUIRED DOM SELECTORS[^\n]*#title/);
    expect(contract).toContain('#start-btn');
    expect(contract).toContain('#hud-score');
    expect(contract).toContain('canvas');
    // the canvas-only escape hatch that closes the gap for a small model
    expect(contract).toMatch(/canvas-only build cannot be validated/i);
    expect(contract).toMatch(/background:transparent/i);
  });

  it('never lists shell selectors (body/html) as a requirement', () => {
    const m: UserPathsManifest = {
      version: 1,
      paths: [
        {
          id: 'smoke',
          rule: 'loads',
          client: 'browser',
          steps: [{ goto: '/' }, { expect_visible: 'body' }, { expect_no_console_errors: true }],
        },
      ],
    };
    const contract = renderAcceptanceContract(m);
    // body is not an actionable build requirement, so no REQUIRED SELECTORS block
    expect(contract).not.toContain('REQUIRED DOM SELECTORS');
    expect(contract).toContain('no console errors');
  });

  it('omits the DOM-selector rail for non-browser (http/cli) manifests', () => {
    const api: UserPathsManifest = {
      version: 1,
      paths: [
        {
          id: 'create',
          rule: 'POST creates a record',
          client: 'http',
          steps: [{ request: { method: 'POST', path: '/v1/things' } }, { expect_status: 201 }],
        },
      ],
    };
    const contract = renderAcceptanceContract(api);
    expect(contract).toContain('POST /v1/things');
    expect(contract).toContain('response status 201');
    expect(contract).not.toContain('REQUIRED DOM SELECTORS');
  });

  it('returns empty string for missing or empty manifests', () => {
    expect(renderAcceptanceContract(null)).toBe('');
    expect(renderAcceptanceContract(undefined)).toBe('');
    expect(renderAcceptanceContract({ version: 1, paths: [] })).toBe('');
  });

  it('handles object-form clicks (canvas coordinate clicks {selector,x,y}) without throwing', () => {
    // Real manifests use both a bare selector string AND {selector,x,y} for
    // canvas coordinate clicks — the declared type says string only, so the
    // renderer must extract the selector defensively (regression: it threw
    // "(s ?? '').trim is not a function" and silently injected nothing).
    const m = {
      version: 1,
      paths: [
        {
          id: 'play',
          rule: 'ship follows mouse',
          client: 'browser',
          steps: [
            { goto: '/' },
            { click: '#start-btn' },
            { click: { selector: 'canvas', x: 100, y: 100 } },
            { expect_visible: 'canvas' },
            { expect_no_console_errors: true },
          ],
        },
      ],
    } as unknown as UserPathsManifest;
    const contract = renderAcceptanceContract(m);
    expect(contract).toContain('click #start-btn');
    expect(contract).toContain('click canvas at (100,100)');
    // #start-btn is a required DOM handle; the canvas coordinate target is not a new id
    expect(contract).toMatch(/REQUIRED DOM SELECTORS[^\n]*#start-btn/);
  });
});

describe('acceptance contract injection into the executor prompt', () => {
  it('renders the contract next to the TASK on turn 1', () => {
    const contract = renderAcceptanceContract(CANVAS_GAME);
    const prompt = defaultPromptBuilder({ instruction: 'build a game', turn: 1, acceptanceContract: contract });
    expect(prompt).toContain('TASK: build a game');
    expect(prompt).toContain('ACCEPTANCE CONTRACT');
    expect(prompt).toContain('#start-btn');
  });

  it('carries the contract into retry turns as well', () => {
    const contract = renderAcceptanceContract(CANVAS_GAME);
    const prompt = defaultPromptBuilder({ instruction: 'build a game', turn: 3, acceptanceContract: contract });
    expect(prompt).toContain('ACCEPTANCE CONTRACT');
  });

  it('omits the section entirely when no contract is present', () => {
    expect(defaultPromptBuilder({ instruction: 'x', turn: 1 })).not.toContain('ACCEPTANCE CONTRACT');
  });
});
