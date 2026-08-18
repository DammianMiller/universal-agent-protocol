/**
 * The execution gate must be able to tell a broken shader from a working one.
 *
 * It could not. The browser rung runs on cloakbrowser, and when that fails the
 * gate falls back to the vm-dom harness — stubbed browser globals with no
 * graphics behind them. For a DOM app that is fine. For a WebGL app the stub
 * does not report "I cannot judge this", it reports FAILURE: every shader fails
 * to compile and `getShaderInfoLog()` returns undefined.
 *
 * Measured (octopus_invaders_v4, 2026-08-18): one run logged
 * `Shader compile error: undefined` FIFTY times, byte-identical, because the
 * string came from the page's own handler and the log it printed was empty. The
 * model was told its shaders were broken, handed no diagnostic, and asked to
 * fix them again — 50 times. No loop guard or throughput work can converge that,
 * because the acceptance signal itself is false.
 *
 * playwright-core was already a dependency and its Chromium does real WebGL2
 * with no extra flags (verified: `#version 300 es` compiles, renderer present,
 * EXT_color_buffer_float available). These tests pin the two verdicts that
 * matter: a valid shader must produce NO error, and a broken one must produce
 * the REAL compiler message.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';

import { loadPlaywrightDriver } from '../../src/delivery/playwright-driver.js';

const VALID = '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p,0.0,1.0); }';
// Missing the statement terminator — a genuine GLSL syntax error.
const BROKEN = '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p,0.0,1.0)  }';

function pageFor(glsl: string): string {
  return `<html><body><canvas id="c"></canvas><script>
const gl = document.getElementById('c').getContext('webgl2');
const s = gl.createShader(gl.VERTEX_SHADER);
gl.shaderSource(s, ${JSON.stringify(glsl)});
gl.compileShader(s);
if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('Shader compile error:', gl.getShaderInfoLog(s));
</script></body></html>`;
}

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function errorsFor(glsl: string): Promise<string[]> {
  const html = pageFor(glsl);
  server = createServer((_q, r) => {
    r.writeHead(200, { 'Content-Type': 'text/html' });
    r.end(html);
  });
  await new Promise<void>((r) => server!.listen(0, r));
  const port = (server!.address() as { port: number }).port;

  const driver = await loadPlaywrightDriver();
  if (!driver) return ['__NO_DRIVER__'];
  try {
    await driver.launch({ headless: true });
    await driver.goto(`http://127.0.0.1:${port}/`);
    await driver.waitForLoadState('load');
    await new Promise((r) => setTimeout(r, 400));
    return driver.getErrors().map((e) => e.message);
  } finally {
    await driver.close();
  }
}

describe('WebGL2 in the execution gate', () => {
  it('reports NO error for a shader that compiles', async () => {
    const errs = await errorsFor(VALID);
    if (errs[0] === '__NO_DRIVER__') return; // no chromium here — nothing to assert
    // The whole point: the stub failed this case, which is what made the run
    // unconvergeable. A valid shader must not look broken.
    expect(errs).toEqual([]);
  }, 120_000);

  it('reports the REAL compiler message for a broken shader', async () => {
    const errs = await errorsFor(BROKEN);
    if (errs[0] === '__NO_DRIVER__') return;
    expect(errs.length).toBeGreaterThan(0);
    const joined = errs.join(' ');
    expect(joined).toContain('Shader compile error');
    // `undefined` is exactly what the stub produced 50 times, and it is
    // unactionable. The message has to carry the compiler's own diagnostic.
    expect(joined).not.toContain('undefined');
    expect(joined).toMatch(/ERROR:\s*\d+:\d+/);
  }, 120_000);

  it('degrades to null rather than throwing when playwright is absent', async () => {
    // The gate has a stub rung behind this one; an optional dependency going
    // missing must fall through, not take the gate down.
    const driver = await loadPlaywrightDriver();
    expect(driver === null || typeof driver.launch === 'function').toBe(true);
  });
});
