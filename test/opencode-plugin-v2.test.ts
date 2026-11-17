/**
 * opencode V2 plugin-definition contract
 *
 * Regression guard for the 2026-11-17 incident: opencode v2.3.0 hard-rejects
 * the V1 named-export plugin shape on every boot
 * (PluginModule.LoadError: "Plugin must export a default definition with an
 * id and an effect or setup function"). Every UAP plugin file must
 * default-export the V2 definition object, keep its SDK imports TYPE-ONLY
 * (so the file loads under plain node without @opencode/plugin installed),
 * and carry a unique stable id.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const PLUGIN_DIR = join(process.cwd(), '.opencode', 'plugin');
const KIT_PATH = join(process.cwd(), '.opencode', 'lib', 'uap-plugin-kit.ts');
const ENFORCE_PATH = join(process.cwd(), 'tools', 'agents', 'plugins', 'uap-enforce.ts');

const PLUGIN_FILES = [
  'oh-my-pi.ts',
  'uap-commands.ts',
  'uap-dashboard.ts',
  'uap-droids.ts',
  'uap-pattern-rag.ts',
  'uap-reactor.ts',
  'uap-session-hooks.ts',
  'uap-skills.ts',
  'uap-task-completion.ts',
];

interface PluginDefinition {
  id: unknown;
  setup?: unknown;
  effect?: unknown;
}

const importPlugin = (file: string): Promise<{ default: unknown }> =>
  import(pathToFileURL(join(PLUGIN_DIR, file)).href) as Promise<{ default: unknown }>;

describe('opencode V2 plugin definition contract', () => {
  it('every plugin default-exports a definition with id + setup', async () => {
    for (const file of PLUGIN_FILES) {
      const mod = await importPlugin(file);
      const def = mod.default as PluginDefinition;
      expect(def, `${file}: default export must be the V2 definition object`).toBeTruthy();
      expect(typeof def, `${file}: default must be an object, not a function`).toBe('object');
      expect(typeof def.id, `${file}: definition.id must be a string`).toBe('string');
      expect(def.id, `${file}: id must not be empty`).not.toBe('');
      const hasSetup = typeof def.setup === 'function';
      const hasEffect = typeof def.effect === 'function';
      expect(
        hasSetup || hasEffect,
        `${file}: definition needs a setup or effect function (the V2 loader rejects anything else)`
      ).toBe(true);
    }
  });

  it('plugin ids are unique', async () => {
    const ids: string[] = [];
    for (const file of PLUGIN_FILES) {
      const mod = await importPlugin(file);
      ids.push((mod.default as PluginDefinition).id as string);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every .ts file in the plugin discovery dir is a loadable definition', async () => {
    // opencode auto-loads EVERY .ts under .opencode/plugin/. A helper module
    // parked there (e.g. the shared kit before it moved to .opencode/lib/)
    // fails the loader schema on every boot. Shared code lives outside the
    // discovery dir; everything inside must be a valid definition.
    const { readdirSync } = await import('fs');
    const files = readdirSync(PLUGIN_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.sort()).toEqual([...PLUGIN_FILES].sort());
    for (const file of files) {
      const mod = await importPlugin(file);
      const def = mod.default as PluginDefinition;
      expect(
        typeof def?.id === 'string' &&
          (typeof def.setup === 'function' || typeof def.effect === 'function'),
        `${file}: must be a valid V2 definition (id + setup/effect)`
      ).toBe(true);
    }
  });

  it('uap-enforce.ts (distribution copy) default-exports a valid definition', async () => {
    const mod = (await import(
      pathToFileURL(ENFORCE_PATH).href
    )) as { default: unknown };
    const def = mod.default as PluginDefinition;
    expect(typeof def).toBe('object');
    expect(typeof def.id).toBe('string');
    expect(typeof def.setup).toBe('function');
  });

  it('plugin files keep SDK imports type-only (loadable without the package)', () => {
    // The generated/tracked plugins must not require @opencode/plugin at
    // runtime: opencode injects the SDK, and vitest/node imports these files
    // (generator byte-compare + pure-function tests) without it installed.
    // The shared kit (.opencode/lib/, OUTSIDE the plugin discovery dir so
    // opencode does not load it as a plugin) follows the same rule for
    // its 'effect' import.
    const targets = PLUGIN_FILES.map((f) => join(PLUGIN_DIR, f)).concat([KIT_PATH]);
    for (const path of targets) {
      const source = readFileSync(path, 'utf-8');
      const valueImports = source.match(/^import\s+[^t][^\n]*from\s+['"]@opencode\/plugin['"]/m);
      expect(
        valueImports,
        `${path}: must import @opencode/plugin TYPE-ONLY (found a value import)`
      ).toBeNull();
    }
  });

  it('no plugin imports the retired @opencode-ai/plugin package', () => {
    // The V1-era package pin is exactly how the fleet drifted into
    // LoadError-on-boot; guard against reintroduction.
    for (const file of PLUGIN_FILES) {
      const source = readFileSync(join(PLUGIN_DIR, file), 'utf-8');
      expect(source, `${file} still references @opencode-ai/plugin`).not.toContain(
        '@opencode-ai/plugin'
      );
    }
    const enforceSource = readFileSync(ENFORCE_PATH, 'utf-8');
    expect(enforceSource).not.toContain('@opencode-ai/plugin');
  });

  it('generators pin the current SDK (no stale @opencode-ai/plugin pins)', () => {
    const hooks = readFileSync(join(process.cwd(), 'src', 'cli', 'hooks.ts'), 'utf-8');
    expect(hooks).toContain("'@opencode/plugin': '2.3.0'");
    expect(hooks).not.toContain('@opencode-ai/plugin');
    const init = readFileSync(join(process.cwd(), 'src', 'cli', 'init.ts'), 'utf-8');
    expect(init).toContain("'@opencode/plugin': '2.3.0'");
    expect(init).not.toContain('@opencode-ai/plugin');
  });

  it('.opencode/package.json pins the current SDK (when present: untracked local state)', async () => {
    // .opencode/package.json is DELIBERATELY untracked (.opencode/.gitignore
    // lists it): each machine's `uap hooks install`/`uap init` writes the
    // pin from the tracked generator seams (asserted above). CI checkouts
    // have no such file — the generator tests carry the contract there.
    const { existsSync } = await import('fs');
    const pkgPath = join(PLUGIN_DIR, '..', 'package.json');
    if (!existsSync(pkgPath)) return;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@opencode/plugin']).toBe('2.3.0');
    expect(pkg.dependencies['@opencode-ai/plugin']).toBeUndefined();
  });
});

describe('uap-plugin-kit', () => {
  it('$ quotes interpolations and resolves exitCode/stdout', async () => {
    const { $ } = await import(
      pathToFileURL(KIT_PATH).href
    );
    const res = await $`printf '%s' ${"it's quoted"}`.quiet();
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("it's quoted");
  });

  it('$ rejects on non-zero exit unless nothrow', async () => {
    const { $ } = await import(
      pathToFileURL(KIT_PATH).href
    );
    await expect($`exit 3`.quiet()).rejects.toThrow();
    const ok = await $`exit 3`.quiet().nothrowMode();
    expect(ok.exitCode).toBe(3);
  });

  it('toolInput builders emit the documented JSON Schema shapes', async () => {
    const { toolInput, toolResult } = await import(
      pathToFileURL(KIT_PATH).href
    );
    const schema = toolInput.object(
      {
        q: toolInput.string('query'),
        n: toolInput.number('importance', { minimum: 1, maximum: 10, default: 7 }),
        on: toolInput.boolean('enabled'),
        kind: toolInput.enum('type', ['task', 'bug'], 'task'),
      },
      ['q']
    );
    expect(schema).toMatchObject({
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string', description: 'query' },
        n: { type: 'number', minimum: 1, maximum: 10, default: 7 },
        on: { type: 'boolean' },
        kind: { type: 'string', enum: ['task', 'bug'], default: 'task' },
      },
    });
    expect(toolResult('hello')).toEqual({ content: 'hello' });
  });
});
