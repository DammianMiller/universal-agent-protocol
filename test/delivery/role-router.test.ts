import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRoleModelConfig,
  createRoleExecutor,
  loadRoleRouting,
  resolveRoleRouting,
} from '../../src/delivery/role-router.js';
import { OpenAICompatClient } from '../../src/models/openai-compat-client.js';
import { ModelPresets } from '../../src/models/types.js';

describe('role-router (Option C3) & OpenAICompatClient thinking/multimodal', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uap-role-router-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('enforces exact precedence: env > .uap.json multiModel > escalateModel > local fresh-context C1 fallback', () => {
    // 1. Default local fresh-context fallback (C1) when nothing else is set
    const fallback = resolveRoleRouting({}, {}, 'local-auto', 'http://127.0.0.1:4000/v1');
    expect(fallback.blueprint).toMatchObject({
      role: 'blueprint',
      modelId: 'local-auto',
      endpoint: 'http://127.0.0.1:4000/v1',
      source: 'local-fresh-context',
      thinking: true,
      freshContext: true,
    });
    expect(fallback.critic.source).toBe('local-fresh-context');
    expect(fallback.vision.source).toBe('local-fresh-context');

    // 2. Escalate model fallback when distinct & known preset (applies to blueprint + critic, not vision)
    const fromEscalate = resolveRoleRouting(
      { deliver: { escalateModel: 'sonnet' } },
      {},
      'local-auto',
      'http://127.0.0.1:4000/v1'
    );
    expect(fromEscalate.blueprint.modelId).toBe('sonnet');
    expect(fromEscalate.blueprint.source).toBe('escalate-model');
    expect(fromEscalate.critic.modelId).toBe('sonnet');
    expect(fromEscalate.critic.source).toBe('escalate-model');
    expect(fromEscalate.vision.source).toBe('local-fresh-context');

    // 3. .uap.json multiModel.<role>Model overrides escalate fallback
    const fromConfig = resolveRoleRouting(
      {
        deliver: { escalateModel: 'sonnet' },
        multiModel: {
          blueprintModel: 'opus-4.6',
          criticModel: 'qwen38-27b',
          criticEndpoint: 'http://127.0.0.1:8081/v1',
          visionModel: 'vision-local',
          visionEndpoint: 'http://127.0.0.1:8080/v1',
        },
      },
      {},
      'local-auto'
    );
    expect(fromConfig.blueprint).toMatchObject({ modelId: 'opus-4.6', source: 'config-multi-model' });
    expect(fromConfig.critic).toMatchObject({
      modelId: 'qwen38-27b',
      endpoint: 'http://127.0.0.1:8081/v1',
      source: 'config-multi-model',
    });
    expect(fromConfig.vision).toMatchObject({
      modelId: 'vision-local',
      endpoint: 'http://127.0.0.1:8080/v1',
      source: 'config-multi-model',
    });

    // 4. Env override beats everything
    const fromEnv = resolveRoleRouting(
      {
        multiModel: {
          blueprintModel: 'opus-4.6',
          criticModel: 'qwen38-27b',
        },
      },
      {
        UAP_BLUEPRINT_MODEL: 'sonnet-4.6',
        UAP_CRITIC_MODEL: 'custom-critic',
        UAP_CRITIC_ENDPOINT: 'http://127.0.0.1:9001/v1',
      },
      'local-auto'
    );
    expect(fromEnv.blueprint).toMatchObject({ modelId: 'sonnet-4.6', source: 'env' });
    expect(fromEnv.critic).toMatchObject({
      modelId: 'custom-critic',
      endpoint: 'http://127.0.0.1:9001/v1',
      source: 'env',
    });
  });

  it('loadRoleRouting reads main repo .uap.json when invoked inside a linked worktree', () => {
    writeFileSync(
      join(root, '.uap.json'),
      JSON.stringify({
        multiModel: {
          criticModel: 'qwen38-27b',
          criticEndpoint: 'http://127.0.0.1:8082/v1',
        },
      }),
      'utf-8'
    );
    const wtDir = join(root, '.worktrees', '001-feature');
    mkdirSync(wtDir, { recursive: true });

    const table = loadRoleRouting(wtDir, 'local-auto', 'http://127.0.0.1:4000/v1', {});
    expect(table.critic).toMatchObject({
      modelId: 'qwen38-27b',
      endpoint: 'http://127.0.0.1:8082/v1',
      source: 'config-multi-model',
    });
  });

  it('buildRoleModelConfig preserves preset metadata or synthesizes custom config cleanly', () => {
    const base = ModelPresets['local-auto'];
    const customCfg = buildRoleModelConfig(
      {
        role: 'critic',
        modelId: 'custom-judge-v1',
        endpoint: 'http://127.0.0.1:9999/v1',
        source: 'env',
        thinking: true,
        freshContext: true,
      },
      base
    );
    expect(customCfg.apiModel).toBe('custom-judge-v1');
    expect(customCfg.endpoint).toBe('http://127.0.0.1:9999/v1');
  });

  it('OpenAICompatClient + createRoleExecutor send x-uap-reasoning=1, enable_thinking=true, image_url parts, and fall back to reasoning_content', async () => {
    let sentHeaders: Record<string, string> = {};
    let sentBody: Record<string, unknown> = {};

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'Qwen3.8-Flash-Next' }] }), { status: 200 });
      }
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      sentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '',
                reasoning_content: '{"axes":{"completeness":9}}',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAICompatClient();
    const routing = resolveRoleRouting({}, {}, 'local-auto', 'http://127.0.0.1:4000/v1');
    const exec = createRoleExecutor(client, routing.critic, ModelPresets['local-auto']);

    const out = await exec('Critique this artifact', ['data:image/png;base64,AAAA']);
    expect(out).toBe('{"axes":{"completeness":9}}');
    expect(sentHeaders['x-uap-reasoning']).toBe('1');
    expect(sentHeaders['x-uap-json-response']).toBeUndefined();
    expect(sentBody.max_tokens).toBe(16384);
    expect(sentBody.chat_template_kwargs).toEqual({ enable_thinking: true });

    const msgs = sentBody.messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(Array.isArray(msgs[0].content)).toBe(true);
    expect(msgs[0].content[0].type).toBe('text');
    expect(msgs[0].content[1].type).toBe('image_url');
  });
});
