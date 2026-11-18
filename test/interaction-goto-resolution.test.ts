/**
 * Relative `goto` resolution in the web interaction driver.
 *
 * A probe's goto step expresses a PATH relative to the served artifact
 * (manifests cannot know the harness's ephemeral port). The driver must
 * resolve it against the server origin before handing it to the browser —
 * CDP rejects a relative URL with "Cannot navigate to invalid URL" — and the
 * same-origin guard must still refuse off-origin targets.
 *
 * Found live in the voxel-pagoda 0.4 reference run: the model-authored
 * `fallback-without-webgl` probe navigated to `index.html?fb=1` (the page's
 * own force-fallback switch) and the gate reported the probe as broken with
 * exactly that CDP error.
 */
import { describe, expect, it } from 'vitest';
import { WebInteractionDriver } from '../src/delivery/interaction/web-driver.js';
import type { PointerBrowser } from '../src/delivery/interaction/web-driver.js';

const ORIGIN = 'http://127.0.0.1:5599/';

/** Records every URL the browser is told to navigate to. */
function recordingBrowser(gotos: string[]): () => Promise<PointerBrowser> {
  const browser = {
    launch: async () => undefined,
    goto: async (url: string) => {
      gotos.push(url);
      return '200';
    },
    waitForLoadState: async () => undefined,
    addInitScript: async () => undefined,
    evaluate: async <T,>() => null as unknown as T,
    screenshot: async () => undefined,
    getErrors: () => [] as Array<{ kind: string; message: string }>,
    mouseMove: async () => undefined,
    mouseDown: async () => undefined,
    mouseUp: async () => undefined,
    press: async () => undefined,
    close: async () => undefined,
    viewportSize: () => ({ width: 1280, height: 720 }),
  };
  return async () => browser as unknown as PointerBrowser;
}

function fakeServer(): (
  dir: string,
  entry: string
) => Promise<{ url: string; close: () => void }> {
  return async () => ({ url: ORIGIN, close: () => undefined });
}

async function startedDriver(gotos: string[]): Promise<WebInteractionDriver> {
  const d = new WebInteractionDriver({
    projectRoot: '/tmp/voxel-probe',
    entry: 'index.html',
    browserFactory: recordingBrowser(gotos),
    serverFactory: fakeServer(),
  });
  await d.start();
  return d;
}

describe('web interaction driver goto resolution', () => {
  it('resolves a relative probe path against the served origin', async () => {
    const gotos: string[] = [];
    const d = await startedDriver(gotos);
    await d.runStep({ do: 'goto', url: 'index.html?fb=1' });
    expect(gotos).toEqual([ORIGIN, `${ORIGIN}index.html?fb=1`]);
  });

  it('passes an already-absolute same-origin URL through unchanged', async () => {
    const gotos: string[] = [];
    const d = await startedDriver(gotos);
    await d.runStep({ do: 'goto', url: `${ORIGIN}other.html` });
    expect(gotos).toEqual([ORIGIN, `${ORIGIN}other.html`]);
  });

  it('still refuses an off-origin probe target', async () => {
    const gotos: string[] = [];
    const d = await startedDriver(gotos);
    await expect(
      d.runStep({ do: 'goto', url: 'https://evil.example/' })
    ).rejects.toThrow(/off-origin/);
    // Only the initial page load navigated — the probe went nowhere.
    expect(gotos).toEqual([ORIGIN]);
  });
});
