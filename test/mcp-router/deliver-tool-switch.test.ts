/**
 * Two separate things, one reported symptom: "uap-router_deliver consistently
 * times out".
 *
 * MEASURED FIRST, and the obvious story was wrong. Over 24h the MCP tool never
 * timed out once — p50 3s, max 48s, nothing near its 1800s ceiling. What timed
 * out was the CLI invoked from a BASH tool: thirteen waiting invocations of
 * `uap deliver --await-run`, TEN of them with a 300s tool budget against the
 * CLI's 900s default, so the client killed the call every time and the model
 * read it as the tool failing.
 *
 * The 900s default is right for the caller it was written for — a terminal or
 * CI step with no request timeout — and the note on it correctly records that
 * shortening it globally was the wrong layer. The caller it does not cover is
 * an AGENT shelling out, which has a request timeout exactly like the MCP one.
 * `resolveOwnerPid` already answers "is an agent client my ancestor", so the
 * default now asks it.
 *
 * The switch is the second thing, and independent: an operator-only way to
 * withdraw the tool entirely.
 */
import { describe, it, expect } from 'vitest';
import { deliverToolDisabled, DELIVER_TOOL_OFF_ENV } from '../../src/mcp-router/server.js';
import { defaultAwaitBudgetSec } from '../../src/cli/deliver.js';
import { FOLLOW_CLIENT_POLL_SEC } from '../../src/delivery/await-run.js';

describe('the deliver tool switch', () => {
  it('is off by default — the tool stays available unless asked otherwise', () => {
    expect(deliverToolDisabled({})).toBe(false);
  });

  it('accepts the usual truthy spellings', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', 'On']) {
      expect(deliverToolDisabled({ [DELIVER_TOOL_OFF_ENV]: v }), v).toBe(true);
    }
  });

  it('treats anything else as ON, including the word "off"', () => {
    // A switch whose disable value is ambiguous is worse than none: `=off`
    // must not silently disable the thing it names.
    for (const v of ['0', 'false', 'no', 'off', '', 'maybe']) {
      expect(deliverToolDisabled({ [DELIVER_TOOL_OFF_ENV]: v }), v).toBe(false);
    }
  });

  it('names an env var, so it cannot be granted inline by a model', () => {
    // Operator-only by construction: it is read from the launch environment,
    // the same shape as the other operator switches in this codebase.
    expect(DELIVER_TOOL_OFF_ENV).toBe('UAP_NO_DELIVER_TOOL');
  });
});

describe('the follow budget adapts to whether the caller can wait', () => {
  // The 900s default serves a terminal or CI step, which has no request
  // timeout. An agent shelling out has one — measured at 300s against this
  // 900s default, ten times in 24h, killed mid-wait every time — but it is not
  // the MCP layer, so it got the long default. The question is "does my caller
  // give up on me", which `resolveOwnerPid` already answers.
  const LONG = 900;

  it('keeps the long default when no agent client is an ancestor', () => {
    // A terminal or CI step: nothing is going to cut the call short.
    expect(defaultAwaitBudgetSec(() => undefined)).toBe(LONG);
  });

  it('uses the client-sized budget when an agent client IS an ancestor', () => {
    expect(defaultAwaitBudgetSec(() => 4242)).toBe(FOLLOW_CLIENT_POLL_SEC);
  });

  it('is well under the tool budgets that were killing these calls', () => {
    // Observed bash-tool budgets were 300s; anything at or above that would
    // still be cut short, which is the whole failure being fixed.
    expect(defaultAwaitBudgetSec(() => 4242)).toBeLessThan(300);
  });

  it('falls back to the long default if the ancestry cannot be read', () => {
    // Unknowable must not silently shorten a CI wait.
    expect(defaultAwaitBudgetSec(() => { throw new Error('no /proc'); })).toBe(LONG);
  });
});
