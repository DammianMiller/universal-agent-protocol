#!/usr/bin/env node
/**
 * llama-server-optimize.ts v2.0.0
 *
 * CLI tool for generating optimal llama.cpp startup parameters
 * for Qwen3.5 35B A3B on 16GB or 24GB VRAM systems.
 *
 * v2.0.0 improvements:
 * - GBNF grammar support for structured tool call output
 * - Speculative decoding with draft model support
 * - KV cache quantization (q8_0/q4_0 split K/V)
 * - Flash attention integration
 * - Prompt caching via slot-save
 * - LoRA adapter loading
 * - Quant upgrade profiles with accuracy/speed tradeoffs
 */

import { program } from 'commander';
import * as fs from 'fs';
import * as readline from 'readline';
import * as os from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  recommendAdaptiveFromLive,
  runSimulationBenchmark,
  summarizeLiveBenchmark,
  tuneSpeculativeParams,
  type LiveBenchmarkSample,
  type RuntimeMetrics,
  type SpeculativeParams,
  type TuningProfile,
} from '../benchmarks/speculative-autotune.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

// Quantization profiles based on Qwen3.5 35B A3B architecture
const QUANTIZATION_PROFILES: Record<
  string,
  {
    name: string;
    description: string;
    modelSizeGB: number;
    kvCacheOverheadGB: number;
    accuracy: number;
    contextMultiplier: number;
    recommendedFor: string;
    toolCallReliability: string;
  }
> = {
  q8_0: {
    name: 'Q8_0',
    description: '8-bit quantization - maximum accuracy',
    modelSizeGB: 38,
    kvCacheOverheadGB: 0.5,
    accuracy: 100,
    contextMultiplier: 0.5,
    recommendedFor: '48GB+ VRAM only',
    toolCallReliability: '99%',
  },
  q6_k: {
    name: 'Q6_K',
    description: '6-bit quantization - near-lossless',
    modelSizeGB: 28,
    kvCacheOverheadGB: 0.5,
    accuracy: 98,
    contextMultiplier: 0.7,
    recommendedFor: '24GB VRAM - high accuracy',
    toolCallReliability: '98%',
  },
  q5_k_m: {
    name: 'Q5_K_M',
    description: '5-bit quantization - best balance for 24GB',
    modelSizeGB: 24,
    kvCacheOverheadGB: 0.5,
    accuracy: 97,
    contextMultiplier: 0.8,
    recommendedFor: '24GB VRAM - RECOMMENDED',
    toolCallReliability: '97%',
  },
  q4_k_m: {
    name: 'Q4_K_M',
    description: '4-bit quantization - best balance for 16GB',
    modelSizeGB: 20,
    kvCacheOverheadGB: 0.5,
    accuracy: 95,
    contextMultiplier: 1.0,
    recommendedFor: '16-24GB VRAM',
    toolCallReliability: '95%',
  },
  iq4_xs: {
    name: 'IQ4_XS',
    description: '4-bit importance quantization - max context on 16GB',
    modelSizeGB: 17,
    kvCacheOverheadGB: 0.5,
    accuracy: 96,
    contextMultiplier: 2.0,
    recommendedFor: '16GB VRAM - CURRENT DEFAULT',
    toolCallReliability: '94%',
  },
  q3_k_m: {
    name: 'Q3_K_M',
    description: '3-bit quantization - maximum context',
    modelSizeGB: 16,
    kvCacheOverheadGB: 0.5,
    accuracy: 92,
    contextMultiplier: 1.5,
    recommendedFor: '16GB VRAM - max context trade-off',
    toolCallReliability: '88%',
  },
  q2_k: {
    name: 'Q2_K',
    description: '2-bit quantization - NOT RECOMMENDED',
    modelSizeGB: 14,
    kvCacheOverheadGB: 0.5,
    accuracy: 85,
    contextMultiplier: 2.0,
    recommendedFor: 'AVOID - quality cliff below 3-bit',
    toolCallReliability: '60%',
  },
};

// Context length options
const CONTEXT_LENGTHS = [
  { value: 4096, label: '4K', description: 'Fastest, minimal context' },
  { value: 8192, label: '8K', description: 'Short documents' },
  { value: 16384, label: '16K', description: 'Standard context' },
  { value: 32768, label: '32K', description: 'Long documents' },
  { value: 65536, label: '64K', description: 'Very long documents' },
  { value: 131072, label: '128K', description: 'Maximum practical for IQ4_XS on 24GB' },
  { value: 262144, label: '256K', description: 'Full context (requires 48GB+ or KV quant)' },
];

// KV cache quantization options (split K/V for optimal quality/VRAM)
const KV_CACHE_OPTIONS = [
  {
    value: { k: 'f16', v: 'f16' },
    label: 'f16/f16',
    description: 'Default - highest accuracy, most VRAM',
  },
  {
    value: { k: 'q8_0', v: 'q8_0' },
    label: 'q8_0/q8_0',
    description: 'Good balance - ~50% KV VRAM savings',
  },
  {
    value: { k: 'q8_0', v: 'q4_0' },
    label: 'q8_0/q4_0',
    description: 'RECOMMENDED - keys need more precision than values',
  },
  {
    value: { k: 'q4_0', v: 'q4_0' },
    label: 'q4_0/q4_0',
    description: 'Maximum savings - ~75% KV VRAM reduction',
  },
];

// Preset configurations
const PRESETS: Record<
  string,
  {
    name: string;
    description: string;
    vram: number;
    quantization: string;
    context: number;
    kvCacheK: string;
    kvCacheV: string;
    gpuLayers: number;
    flashAttn: boolean;
    speculative: boolean;
    promptCache: boolean;
    grammar: boolean;
  }
> = {
  balanced: {
    name: 'balanced',
    description: 'IQ4_XS, 32K context, KV q8/q4 (16-24GB)',
    vram: 16,
    quantization: 'iq4_xs',
    context: 32768,
    kvCacheK: 'q8_0',
    kvCacheV: 'q4_0',
    gpuLayers: 99,
    flashAttn: true,
    speculative: false,
    promptCache: true,
    grammar: true,
  },
  accuracy: {
    name: 'accuracy',
    description: 'Q5_K_M, 16K context, f16 KV, flash attn (24GB)',
    vram: 24,
    quantization: 'q5_k_m',
    context: 16384,
    kvCacheK: 'f16',
    kvCacheV: 'f16',
    gpuLayers: 99,
    flashAttn: true,
    speculative: false,
    promptCache: true,
    grammar: true,
  },
  context: {
    name: 'context',
    description: 'IQ4_XS, 128K context, KV q4/q4, flash attn (24GB)',
    vram: 24,
    quantization: 'iq4_xs',
    context: 131072,
    kvCacheK: 'q4_0',
    kvCacheV: 'q4_0',
    gpuLayers: 99,
    flashAttn: true,
    speculative: false,
    promptCache: true,
    grammar: true,
  },
  speed: {
    name: 'speed',
    description: 'IQ4_XS, 8K context, speculative decoding, flash attn',
    vram: 16,
    quantization: 'iq4_xs',
    context: 8192,
    kvCacheK: 'q8_0',
    kvCacheV: 'q4_0',
    gpuLayers: 99,
    flashAttn: true,
    speculative: true,
    promptCache: true,
    grammar: true,
  },
  'tool-call': {
    name: 'tool-call',
    description: 'Optimized for tool calling: grammar + prompt cache + flash attn',
    vram: 16,
    quantization: 'iq4_xs',
    context: 32768,
    kvCacheK: 'q8_0',
    kvCacheV: 'q4_0',
    gpuLayers: 99,
    flashAttn: true,
    speculative: false,
    promptCache: true,
    grammar: true,
  },
  'max-context': {
    name: 'max-context',
    description: 'Q3_K_M, 256K context, KV q4/q4 (24GB+)',
    vram: 24,
    quantization: 'q3_k_m',
    context: 262144,
    kvCacheK: 'q4_0',
    kvCacheV: 'q4_0',
    gpuLayers: 99,
    flashAttn: true,
    speculative: false,
    promptCache: false,
    grammar: false,
  },
};

interface Config {
  vram: number;
  quantization: string;
  context: number;
  kvCacheK: string;
  kvCacheV: string;
  gpuLayers: number;
  threads: number;
  modelPath: string;
  host: string;
  port: number;
  logFile: string;
  hfModel: string;
  // v2.0 features
  flashAttn: boolean;
  speculative: boolean;
  draftModelPath: string;
  draftModelLayers: number;
  promptCache: boolean;
  slotSavePath: string;
  grammar: boolean;
  grammarPath: string;
  loraPath: string;
  loraScale: number;
  chatTemplatePath: string;
}

interface SpecAutotuneOptions {
  acceptance: string;
  rollback: string;
  profile: TuningProfile;
  draftMax: string;
  draftMin: string;
  draftPMin: string;
  json?: boolean;
}

interface SpecBenchmarkOptions {
  profile: TuningProfile;
  trace: 'stable' | 'volatile' | 'mixed';
  steps: string;
  seed: string;
  json?: boolean;
}

interface SpecBenchmarkLiveOptions {
  endpoint: string;
  model: string;
  runs: string;
  prompt: string;
  maxTokens: string;
  temperature: string;
  profile: TuningProfile;
  draftMax: string;
  draftMin: string;
  draftPMin: string;
  json?: boolean;
}

function readCompletionTokens(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const response = payload as {
    usage?: { completion_tokens?: number; completionTokens?: number };
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (typeof response.usage?.completion_tokens === 'number') return response.usage.completion_tokens;
  if (typeof response.usage?.completionTokens === 'number') return response.usage.completionTokens;

  const text = response.choices?.[0]?.message?.content;
  if (typeof text === 'string' && text.length > 0) {
    return Math.max(1, Math.ceil(text.length / 4));
  }

  return 0;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (query: string): Promise<string> => {
  return new Promise((resolve) => rl.question(query, resolve));
};

async function detectVRAM(): Promise<number> {
  try {
    const { execSync } = await import('child_process');

    // Try nvidia-smi for NVIDIA GPUs
    try {
      const output = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const totalMB = parseInt(output.trim().split('\n')[0]);
      return Math.round(totalMB / 1024);
    } catch {
      // nvidia-smi not available
    }

    // Try sysctl for macOS (unified memory)
    try {
      const output = execSync('sysctl -n hw.memsize', { encoding: 'utf-8' });
      const totalBytes = parseInt(output.trim());
      const totalGB = Math.round(totalBytes / (1024 * 1024 * 1024));
      return Math.min(totalGB, 48);
    } catch {
      // sysctl not available
    }

    return 16;
  } catch {
    return 16;
  }
}

async function selectOption<T extends { value: any; label: string; description?: string }>(
  message: string,
  options: T[],
  defaultIndex: number = 0
): Promise<T> {
  console.log(`\n${message}`);
  console.log('--'.repeat(30));

  options.forEach((opt, index) => {
    const marker = index === defaultIndex ? '>' : ' ';
    console.log(`${marker} ${index + 1}. ${opt.label}`);
    if (opt.description) {
      console.log(`   ${opt.description}`);
    }
  });

  const answer = await question('\nSelect option (1-99): ');
  const index = parseInt(answer) - 1;

  if (index >= 0 && index < options.length) {
    return options[index];
  }

  return options[defaultIndex];
}

function calculateVRAMUsage(config: Config): {
  model: number;
  kvCache: number;
  draftModel: number;
  total: number;
  sufficient: boolean;
} {
  const profile = QUANTIZATION_PROFILES[config.quantization];
  if (!profile) {
    return { model: 20, kvCache: 10, draftModel: 0, total: 30, sufficient: false };
  }

  const modelGB = profile.modelSizeGB;

  // KV cache VRAM depends on context length and quantization
  const contextMultiplier = config.context / 32768;
  let kvMultiplier = 1.0;
  if (config.kvCacheK === 'q8_0') kvMultiplier *= 0.5;
  if (config.kvCacheK === 'q4_0') kvMultiplier *= 0.25;
  if (config.kvCacheV === 'q4_0') kvMultiplier *= 0.5;
  if (config.kvCacheV === 'q8_0') kvMultiplier *= 0.75;
  const kvCacheGB = 2.0 * contextMultiplier * kvMultiplier;

  // Draft model for speculative decoding (~0.5GB for 0.6B model)
  const draftModelGB = config.speculative ? 0.5 : 0;

  const totalGB = modelGB + kvCacheGB + draftModelGB + 1.5; // +1.5GB buffer

  return {
    model: modelGB,
    kvCache: kvCacheGB,
    draftModel: draftModelGB,
    total: totalGB,
    sufficient: totalGB <= config.vram,
  };
}

function generateStartupCommand(config: Config): string {
  const lines: string[] = ['llama-server \\'];

  // Model
  lines.push(`  --model ${config.modelPath} \\`);

  // Context
  lines.push(`  --ctx-size ${config.context} \\`);

  // KV cache quantization (split K/V)
  lines.push(`  --cache-type-k ${config.kvCacheK} \\`);
  lines.push(`  --cache-type-v ${config.kvCacheV} \\`);

  // GPU layers
  lines.push(`  --n-gpu-layers ${config.gpuLayers} \\`);

  // Threads
  lines.push(`  --threads ${config.threads} \\`);

  // Flash attention
  if (config.flashAttn) {
    lines.push('  --flash-attn \\');
  }

  // Speculative decoding
  if (config.speculative && config.draftModelPath) {
    lines.push(`  --model-draft ${config.draftModelPath} \\`);
    lines.push(`  --draft-max 16 \\`);
    lines.push(`  --draft-min 3 \\`);
    lines.push(`  --draft-p-min 0.8 \\`);
    if (config.draftModelLayers > 0) {
      lines.push(`  --n-gpu-layers-draft ${config.draftModelLayers} \\`);
    }
  }

  // Prompt caching
  if (config.promptCache && config.slotSavePath) {
    lines.push(`  --slot-save-path ${config.slotSavePath} \\`);
  }

  // Chat template
  if (config.chatTemplatePath) {
    lines.push(`  --chat-template-file ${config.chatTemplatePath} \\`);
  }

  // LoRA adapter
  if (config.loraPath) {
    lines.push(`  --lora ${config.loraPath} \\`);
    if (config.loraScale !== 1.0) {
      lines.push(`  --lora-scaled ${config.loraScale} \\`);
    }
  }

  // Server config
  lines.push(`  --host ${config.host} \\`);
  lines.push(`  --port ${config.port} \\`);

  // Memory management
  lines.push('  --mlock \\');

  // Logging
  if (config.logFile) {
    lines.push(`  --log-file ${config.logFile} \\`);
  }

  // Parallel slots for concurrent requests
  lines.push('  --parallel 2 \\');

  // Metrics endpoint
  lines.push('  --metrics');

  return lines.join('\n');
}

function generateConfigFile(config: Config): string {
  const vramUsage = calculateVRAMUsage(config);
  const profile = QUANTIZATION_PROFILES[config.quantization];

  return `# llama.cpp server configuration
# Generated by llama-server-optimize v2.0.0
# Optimized for Qwen3.5 35B A3B tool calling
#
# VRAM estimate: ${vramUsage.total.toFixed(1)}GB (model: ${vramUsage.model}GB, KV: ${vramUsage.kvCache.toFixed(1)}GB${config.speculative ? `, draft: ${vramUsage.draftModel}GB` : ''})
# Quantization: ${profile?.name || config.quantization} (${profile?.accuracy || '?'}% accuracy)
# Tool call reliability: ${profile?.toolCallReliability || '?'}

[model]
path=${config.modelPath}
type=gguf
quantization=${config.quantization}

[server]
host=${config.host}
port=${config.port}
threads=${config.threads}
parallel=2
log-file=${config.logFile || 'llama-server.log'}
metrics=true

[inference]
ctx-size=${config.context}
cache-type-k=${config.kvCacheK}
cache-type-v=${config.kvCacheV}
n-gpu-layers=${config.gpuLayers}
flash-attn=${config.flashAttn}

[chat]
chat-template-file=${config.chatTemplatePath || 'tools/agents/config/chat_template.jinja'}

[optimization]
mlock=true
${config.speculative ? `\n[speculative]\nmodel-draft=${config.draftModelPath}\ndraft-max=16\ndraft-min=3\ndraft-p-min=0.8` : '# speculative decoding disabled'}
${config.promptCache ? `\n[cache]\nslot-save-path=${config.slotSavePath}` : '# prompt caching disabled'}
${config.loraPath ? `\n[lora]\npath=${config.loraPath}\nscale=${config.loraScale}` : '# no LoRA adapter'}
${config.grammar ? `\n[grammar]\n# Use with --grammar-file flag for structured tool call output\ngrammar-file=${config.grammarPath || 'tools/agents/config/tool-call.gbnf'}` : '# grammar constrained output disabled'}
`;
}

async function interactiveMode(): Promise<Config> {
  console.log('\n=== Qwen3.5 35B A3B Server Optimizer v2.0 ===\n');

  const detectedVRAM = await detectVRAM();
  console.log(`Detected VRAM: ${detectedVRAM}GB`);

  const vramOption = await selectOption(
    'Select VRAM:',
    [
      { value: 16, label: '16GB', description: 'Standard GPU (RTX 4060 Ti 16GB, etc.)' },
      { value: 24, label: '24GB', description: 'High-end GPU (RTX 3090/4090)' },
      { value: 48, label: '48GB', description: 'Professional GPU (A6000, dual GPU)' },
    ],
    detectedVRAM <= 16 ? 0 : detectedVRAM <= 24 ? 1 : 2
  );

  // Use case
  const useCase = await selectOption(
    'Primary use case:',
    [
      {
        value: 'tool-call',
        label: 'Tool Calling (RECOMMENDED)',
        description: 'Optimized for reliable tool calls with grammar + prompt cache',
      },
      { value: 'balanced', label: 'Balanced', description: 'Good for most tasks' },
      { value: 'accuracy', label: 'Maximum Accuracy', description: 'Best quality, less context' },
      { value: 'context', label: 'Maximum Context', description: 'Long documents, codebases' },
      {
        value: 'speed',
        label: 'Fastest Speed',
        description: 'Speculative decoding + small context',
      },
    ],
    0
  );

  const preset = PRESETS[useCase.value as string] || PRESETS['tool-call'];

  // Context length
  const contextOption = await selectOption(
    'Context length:',
    CONTEXT_LENGTHS,
    CONTEXT_LENGTHS.findIndex((c) => c.value === preset.context)
  );

  // Quantization
  const quantOption = await selectOption(
    'Quantization:',
    Object.entries(QUANTIZATION_PROFILES).map(([key, profile]) => ({
      value: key,
      label: `${profile.name} - ${profile.description}`,
      description: `${profile.accuracy}% accuracy | Tool calls: ${profile.toolCallReliability} | ${profile.recommendedFor}`,
    })),
    Object.keys(QUANTIZATION_PROFILES).indexOf(preset.quantization)
  );

  // KV cache
  const kvOption = await selectOption(
    'KV cache quantization:',
    KV_CACHE_OPTIONS,
    2 // q8_0/q4_0 recommended
  );

  // Flash attention
  const flashAnswer = await question('\nEnable flash attention? (Y/n): ');
  const flashAttn = flashAnswer.toLowerCase() !== 'n';

  // Speculative decoding
  const specAnswer = await question('Enable speculative decoding with draft model? (y/N): ');
  const speculative = specAnswer.toLowerCase() === 'y';

  let draftModelPath = '';
  if (speculative) {
    draftModelPath =
      (await question('Draft model path (default: ./models/Qwen3.5-0.6B.gguf): ')).trim() ||
      './models/Qwen3.5-0.6B.gguf';
  }

  // Prompt caching
  const cacheAnswer = await question('Enable prompt caching (slot-save)? (Y/n): ');
  const promptCache = cacheAnswer.toLowerCase() !== 'n';

  // LoRA
  const loraAnswer = await question('Load LoRA adapter? (y/N): ');
  let loraPath = '';
  let loraScale = 1.0;
  if (loraAnswer.toLowerCase() === 'y') {
    loraPath = (await question('LoRA adapter path: ')).trim();
    const scaleStr = await question('LoRA scale (default: 1.0): ');
    loraScale = parseFloat(scaleStr) || 1.0;
  }

  const config: Config = {
    vram: vramOption.value as number,
    quantization: quantOption.value as string,
    context: contextOption.value as number,
    kvCacheK: (kvOption.value as { k: string; v: string }).k,
    kvCacheV: (kvOption.value as { k: string; v: string }).v,
    gpuLayers: 99,
    threads: Math.max(1, os.cpus().length - 2),
    modelPath: './models/Qwen3.5-35B-A3B.gguf',
    host: '0.0.0.0',
    port: 8080,
    logFile: 'llama-server.log',
    hfModel: '',
    flashAttn,
    speculative,
    draftModelPath,
    draftModelLayers: 99,
    promptCache,
    slotSavePath: promptCache ? './cache/slots' : '',
    grammar: true,
    grammarPath: join(PROJECT_ROOT, 'tools/agents/config/tool-call.gbnf'),
    loraPath,
    loraScale,
    chatTemplatePath: join(PROJECT_ROOT, 'tools/agents/config/chat_template.jinja'),
  };

  const vramUsage = calculateVRAMUsage(config);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('=== Configuration Summary ===');
  console.log('='.repeat(60));
  console.log(`VRAM:           ${config.vram}GB`);
  console.log(
    `Quantization:   ${QUANTIZATION_PROFILES[config.quantization]?.name || config.quantization}`
  );
  console.log(
    `Context:        ${CONTEXT_LENGTHS.find((c) => c.value === config.context)?.label || config.context}`
  );
  console.log(`KV Cache:       K=${config.kvCacheK} V=${config.kvCacheV}`);
  console.log(`Flash Attn:     ${config.flashAttn ? 'YES' : 'no'}`);
  console.log(
    `Speculative:    ${config.speculative ? 'YES (' + config.draftModelPath + ')' : 'no'}`
  );
  console.log(`Prompt Cache:   ${config.promptCache ? 'YES' : 'no'}`);
  console.log(`Grammar:        ${config.grammar ? 'YES (GBNF)' : 'no'}`);
  console.log(`LoRA:           ${config.loraPath || 'none'}`);
  console.log(`Threads:        ${config.threads}`);
  console.log('='.repeat(60));

  console.log('\nVRAM Usage:');
  console.log(`  Model weights:  ${vramUsage.model.toFixed(1)} GB`);
  console.log(`  KV cache:       ${vramUsage.kvCache.toFixed(1)} GB`);
  if (config.speculative) {
    console.log(`  Draft model:    ${vramUsage.draftModel.toFixed(1)} GB`);
  }
  console.log(`  Total:          ${vramUsage.total.toFixed(1)} GB`);
  console.log(`  Available:      ${config.vram} GB`);
  console.log(
    `  Status:         ${vramUsage.sufficient ? 'OK - fits in VRAM' : 'WARNING - may not fit!'}`
  );

  if (!vramUsage.sufficient) {
    console.log(`\n  Suggestions to reduce VRAM:`);
    console.log(`    - Lower quantization (current: ${config.quantization})`);
    console.log(`    - Reduce context length (current: ${config.context})`);
    console.log(`    - Use KV cache q4_0/q4_0`);
    console.log(`    - Disable speculative decoding`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('=== Startup Command ===');
  console.log('='.repeat(60));
  console.log(generateStartupCommand(config));

  const saveConfig = await question('\nSave configuration to llama-server.conf? (y/N): ');
  if (saveConfig.toLowerCase() === 'y') {
    const configContent = generateConfigFile(config);
    fs.writeFileSync('llama-server.conf', configContent);
    console.log('Configuration saved to llama-server.conf');
  }

  console.log('\nOptimization complete!');

  return config;
}

async function presetMode(presetName: string): Promise<Config> {
  const preset = PRESETS[presetName];

  if (!preset) {
    console.error(`Unknown preset: ${presetName}`);
    console.log('Available presets:', Object.keys(PRESETS).join(', '));
    process.exit(1);
  }

  const config: Config = {
    vram: preset.vram,
    quantization: preset.quantization,
    context: preset.context,
    kvCacheK: preset.kvCacheK,
    kvCacheV: preset.kvCacheV,
    gpuLayers: preset.gpuLayers,
    threads: Math.max(1, os.cpus().length - 2),
    modelPath: './models/Qwen3.5-35B-A3B.gguf',
    host: '0.0.0.0',
    port: 8080,
    logFile: 'llama-server.log',
    hfModel: '',
    flashAttn: preset.flashAttn,
    speculative: preset.speculative,
    draftModelPath: preset.speculative ? './models/Qwen3.5-0.6B.gguf' : '',
    draftModelLayers: 99,
    promptCache: preset.promptCache,
    slotSavePath: preset.promptCache ? './cache/slots' : '',
    grammar: preset.grammar,
    grammarPath: join(PROJECT_ROOT, 'tools/agents/config/tool-call.gbnf'),
    loraPath: '',
    loraScale: 1.0,
    chatTemplatePath: join(PROJECT_ROOT, 'tools/agents/config/chat_template.jinja'),
  };

  const vramUsage = calculateVRAMUsage(config);
  const profile = QUANTIZATION_PROFILES[config.quantization];

  console.log(`\n=== Qwen3.5 35B A3B - ${preset.name.toUpperCase()} Preset ===`);
  console.log(`${preset.description}`);
  console.log('='.repeat(60));
  console.log(
    `Quantization:   ${profile?.name || config.quantization} (${profile?.accuracy ?? '?'}% accuracy)`
  );
  console.log(
    `Context:        ${CONTEXT_LENGTHS.find((c) => c.value === config.context)?.label || config.context}`
  );
  console.log(`KV Cache:       K=${config.kvCacheK} V=${config.kvCacheV}`);
  console.log(`Flash Attn:     ${config.flashAttn ? 'YES' : 'no'}`);
  console.log(`Speculative:    ${config.speculative ? 'YES' : 'no'}`);
  console.log(`Prompt Cache:   ${config.promptCache ? 'YES' : 'no'}`);
  console.log(`Grammar:        ${config.grammar ? 'YES (GBNF)' : 'no'}`);
  console.log(`Tool Calls:     ${profile?.toolCallReliability || '?'} reliability`);
  console.log('='.repeat(60));

  console.log('\nVRAM Usage:');
  console.log(`  Model:    ${vramUsage.model.toFixed(1)} GB`);
  console.log(`  KV cache: ${vramUsage.kvCache.toFixed(1)} GB`);
  if (config.speculative) console.log(`  Draft:    ${vramUsage.draftModel.toFixed(1)} GB`);
  console.log(`  Total:    ${vramUsage.total.toFixed(1)} GB / ${config.vram} GB`);
  console.log(`  Status:   ${vramUsage.sufficient ? 'OK' : 'WARNING - may not fit!'}`);

  console.log('\n' + '='.repeat(60));
  console.log('=== Startup Command ===');
  console.log('='.repeat(60));
  console.log(generateStartupCommand(config));

  return config;
}

// CLI commands
program
  .name('llama-optimize')
  .description('Optimize llama.cpp startup parameters for Qwen3.5 35B A3B')
  .version('2.0.0');

program
  .command('interactive')
  .description('Run interactive setup wizard')
  .action(async () => {
    try {
      await interactiveMode();
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    } finally {
      rl.close();
    }
  });

program
  .command('preset <name>')
  .description(`Use a preset: ${Object.keys(PRESETS).join(', ')}`)
  .action(async (presetName: string) => {
    try {
      await presetMode(presetName);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

program
  .command('quick')
  .description('Quick mode with tool-call preset (recommended)')
  .action(async () => {
    try {
      await presetMode('tool-call');
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

program
  .command('json')
  .description('Output configuration as JSON')
  .option('--preset <name>', 'Use preset')
  .action(async (options: { preset?: string }) => {
    try {
      let config: Config;
      if (options.preset) {
        config = await presetMode(options.preset);
      } else {
        config = await interactiveMode();
      }

      const output = {
        ...config,
        vramUsage: calculateVRAMUsage(config),
        quantProfile: QUANTIZATION_PROFILES[config.quantization],
      };

      console.log(JSON.stringify(output, null, 2));
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    } finally {
      rl.close();
    }
  });

program
  .command('hf <repo>')
  .description('Download model from HuggingFace')
  .option('--quant <name>', 'Quantization to download', 'iq4_xs')
  .option('--output <dir>', 'Output directory', './models')
  .option('--draft', 'Also download draft model for speculative decoding')
  .action(async (repo: string, options: { quant: string; output: string; draft?: boolean }) => {
    console.log(`\nDownload ${options.quant} model from ${repo}:`);
    console.log(
      `  huggingface-cli download ${repo} --include "*${options.quant}*" --local-dir ${options.output}`
    );

    if (options.draft) {
      console.log(`\nDownload draft model for speculative decoding:`);
      console.log(
        `  huggingface-cli download Qwen/Qwen3.5-0.6B-GGUF --include "*q8_0*" --local-dir ${options.output}`
      );
    }

    console.log(`\nAfter download, run:`);
    console.log(`  llama-optimize preset tool-call`);
  });

program
  .command('profiles')
  .description('Show all quantization profiles with tool call reliability')
  .action(() => {
    console.log('\n=== Quantization Profiles for Qwen3.5 35B A3B ===\n');
    console.log('Profile    | Size  | Accuracy | Tool Calls | Recommended For');
    console.log('-----------|-------|----------|------------|----------------');
    for (const [, p] of Object.entries(QUANTIZATION_PROFILES)) {
      console.log(
        `${p.name.padEnd(10)} | ${(p.modelSizeGB + 'GB').padEnd(5)} | ${(p.accuracy + '%').padEnd(8)} | ${p.toolCallReliability.padEnd(10)} | ${p.recommendedFor}`
      );
    }
    console.log('\nUpgrade path for better tool call reliability:');
    console.log('  IQ4_XS (94%) -> Q4_K_M (95%) -> Q5_K_M (97%) -> Q6_K (98%)');
    console.log('  Each step up requires ~4-7GB more VRAM');
  });

program
  .command('spec-autotune')
  .description('Option 1: tune draft settings from acceptance + rollback metrics')
  .option('--acceptance <rate>', 'Acceptance rate from 0.0 to 1.0', '0.7')
  .option('--rollback <rate>', 'Rollback rate from 0.0 to 1.0', '0.15')
  .option('--profile <name>', 'throughput|latency|stable', 'throughput')
  .option('--draft-max <value>', 'Base draft-max', '16')
  .option('--draft-min <value>', 'Base draft-min', '3')
  .option('--draft-p-min <value>', 'Base draft-p-min', '0.8')
  .option('--json', 'Output as JSON')
  .action((options: SpecAutotuneOptions) => {
    const base: SpeculativeParams = {
      draftMax: parseInt(options.draftMax, 10),
      draftMin: parseInt(options.draftMin, 10),
      draftPMin: parseFloat(options.draftPMin),
    };

    const metrics: RuntimeMetrics = {
      acceptanceRate: parseFloat(options.acceptance),
      rollbackRate: parseFloat(options.rollback),
    };

    const profile = (options.profile || 'throughput') as TuningProfile;
    const tuned = tuneSpeculativeParams(base, metrics, profile);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            profile,
            metrics,
            base,
            tuned,
            startupFlags: `--draft-max ${tuned.draftMax} --draft-min ${tuned.draftMin} --draft-p-min ${tuned.draftPMin}`,
          },
          null,
          2
        )
      );
      return;
    }

    console.log('\n=== Speculative Option 1 Autotune ===');
    console.log(`Profile:      ${profile}`);
    console.log(`Acceptance:   ${(metrics.acceptanceRate * 100).toFixed(1)}%`);
    console.log(`Rollback:     ${(metrics.rollbackRate * 100).toFixed(1)}%`);
    console.log(`Base:         --draft-max ${base.draftMax} --draft-min ${base.draftMin} --draft-p-min ${base.draftPMin}`);
    console.log(
      `Recommended:  --draft-max ${tuned.draftMax} --draft-min ${tuned.draftMin} --draft-p-min ${tuned.draftPMin}`
    );
  });

program
  .command('spec-benchmark')
  .description('Benchmark static vs Option 1 adaptive speculative tuning (simulation)')
  .option('--profile <name>', 'throughput|latency|stable', 'throughput')
  .option('--trace <name>', 'stable|volatile|mixed acceptance trace', 'mixed')
  .option('--steps <count>', 'Number of simulation steps', '120')
  .option('--seed <value>', 'Deterministic random seed', '42')
  .option('--json', 'Output as JSON')
  .action((options: SpecBenchmarkOptions) => {
    const result = runSimulationBenchmark({
      profile: (options.profile || 'throughput') as TuningProfile,
      trace: (options.trace || 'mixed') as 'stable' | 'volatile' | 'mixed',
      steps: parseInt(options.steps, 10),
      seed: parseInt(options.seed, 10),
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('\n=== Speculative Option 1 Benchmark (Simulation) ===');
    console.log(`Profile:           ${result.profile}`);
    console.log(`Trace:             ${result.trace}`);
    console.log(`Steps:             ${result.steps}`);
    console.log(`Static avg TPS:    ${result.staticAvgTps}`);
    console.log(`Adaptive avg TPS:  ${result.adaptiveAvgTps}`);
    console.log(`Improvement:       ${result.improvementPct}%`);
    console.log(
      `Final adaptive:    --draft-max ${result.finalAdaptiveParams.draftMax} --draft-min ${result.finalAdaptiveParams.draftMin} --draft-p-min ${result.finalAdaptiveParams.draftPMin}`
    );
    console.log('\nNote: This command is a deterministic simulation benchmark for rapid tuning iteration.');
  });

program
  .command('spec-benchmark-live')
  .description('Benchmark active llama-server and produce Option 1 adaptive recommendation')
  .option('--endpoint <url>', 'OpenAI-compatible endpoint', 'http://127.0.0.1:8080/v1')
  .option('--model <id>', 'Model id for /chat/completions', 'qwen3.5-a3b-iq4xs')
  .option('--runs <count>', 'Number of benchmark requests', '5')
  .option(
    '--prompt <text>',
    'Benchmark prompt text',
    'Write a concise explanation of speculative decoding performance tuning in 6 bullet points.'
  )
  .option('--max-tokens <count>', 'Completion tokens per run', '256')
  .option('--temperature <value>', 'Sampling temperature', '0.2')
  .option('--profile <name>', 'throughput|latency|stable', 'throughput')
  .option('--draft-max <value>', 'Current draft-max', '16')
  .option('--draft-min <value>', 'Current draft-min', '3')
  .option('--draft-p-min <value>', 'Current draft-p-min', '0.8')
  .option('--json', 'Output as JSON')
  .action(async (options: SpecBenchmarkLiveOptions) => {
    const runs = Math.max(1, parseInt(options.runs, 10));
    const endpoint = options.endpoint.replace(/\/$/, '');
    const model = options.model;
    const profile = (options.profile || 'throughput') as TuningProfile;
    const baseParams: SpeculativeParams = {
      draftMax: parseInt(options.draftMax, 10),
      draftMin: parseInt(options.draftMin, 10),
      draftPMin: parseFloat(options.draftPMin),
    };

    const samples: LiveBenchmarkSample[] = [];
    const failures: string[] = [];

    for (let i = 0; i < runs; i += 1) {
      const start = Date.now();
      try {
        const response = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: options.prompt }],
            max_tokens: parseInt(options.maxTokens, 10),
            temperature: parseFloat(options.temperature),
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          failures.push(`run ${i + 1}: HTTP ${response.status} ${errorBody.slice(0, 120)}`);
          continue;
        }

        const payload = (await response.json()) as unknown;
        const completionTokens = readCompletionTokens(payload);
        const latencyMs = Date.now() - start;

        samples.push({ latencyMs, completionTokens });
      } catch (error) {
        failures.push(`run ${i + 1}: ${String(error)}`);
      }
    }

    const summary = summarizeLiveBenchmark(samples);
    const recommendation = recommendAdaptiveFromLive(summary, profile, baseParams);

    const output = {
      endpoint,
      model,
      profile,
      requestedRuns: runs,
      successfulRuns: summary.runs,
      failedRuns: failures.length,
      baseParams,
      liveSummary: summary,
      inferredMetrics: {
        acceptanceRate: Number((recommendation.inferredMetrics.acceptanceRate * 100).toFixed(2)),
        rollbackRate: Number((recommendation.inferredMetrics.rollbackRate * 100).toFixed(2)),
      },
      tunedParams: recommendation.tunedParams,
      recommendationFlags: `--draft-max ${recommendation.tunedParams.draftMax} --draft-min ${recommendation.tunedParams.draftMin} --draft-p-min ${recommendation.tunedParams.draftPMin}`,
      failures,
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log('\n=== Speculative Option 1 Live Benchmark ===');
    console.log(`Endpoint:           ${endpoint}`);
    console.log(`Model:              ${model}`);
    console.log(`Profile:            ${profile}`);
    console.log(`Runs:               ${summary.runs}/${runs}`);
    console.log(`Avg latency:        ${summary.avgLatencyMs} ms`);
    console.log(`Completion tokens:  ${summary.totalCompletionTokens}`);
    console.log(`Throughput:         ${summary.tokensPerSecond} tok/s`);
    console.log(`Inferred acceptance:${(recommendation.inferredMetrics.acceptanceRate * 100).toFixed(2)}%`);
    console.log(`Inferred rollback:  ${(recommendation.inferredMetrics.rollbackRate * 100).toFixed(2)}%`);
    console.log(`Base params:        --draft-max ${baseParams.draftMax} --draft-min ${baseParams.draftMin} --draft-p-min ${baseParams.draftPMin}`);
    console.log(
      `Suggested params:   --draft-max ${recommendation.tunedParams.draftMax} --draft-min ${recommendation.tunedParams.draftMin} --draft-p-min ${recommendation.tunedParams.draftPMin}`
    );
    if (failures.length > 0) {
      console.log(`Failures:           ${failures.length} (use --json for details)`);
    }
    console.log('\nRun this benchmark before and after restarting llama-server with suggested flags to measure actual gain.');
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
