/**
 * Token Throughput Benchmark for Qwen3.5
 *
 * Measures token generation throughput at different context sizes.
 * Uses actual model inference via the local API endpoint.
 */

import { writeFileSync } from 'fs';
import { z } from 'zod';

// ============================================================================
// Benchmark Configuration
// ============================================================================

export const TokenThroughputConfigSchema = z.object({
  endpoint: z.string().default('http://localhost:8080/v1'),
  model: z.string().default('qwen/qwen35-a3b-iq4xs'),
  contextSizes: z.array(z.number()).default([100, 500, 1000, 2000, 4000, 8000, 16000, 32000]),
  warmupRuns: z.number().default(2),
  measurementRuns: z.number().default(5),
  maxTokens: z.number().default(100),
  temperature: z.number().default(0.7),
});

export type TokenThroughputConfig = z.infer<typeof TokenThroughputConfigSchema>;

// ============================================================================
// Benchmark Result Types
// ============================================================================

export const TokenThroughputResultSchema = z.object({
  contextSize: z.number(),
  tokensPerSecond: z.number(),
  totalTimeMs: z.number(),
  avgLatencyMs: z.number(),
  runs: z.array(
    z.object({
      runIndex: z.number(),
      tokensGenerated: z.number(),
      latencyMs: z.number(),
    })
  ),
});

export type TokenThroughputResult = z.infer<typeof TokenThroughputResultSchema>;

export const TokenThroughputBenchmarkSchema = z.object({
  model: z.string(),
  endpoint: z.string(),
  timestamp: z.string(),
  config: TokenThroughputConfigSchema,
  results: z.array(TokenThroughputResultSchema),
  summary: z.object({
    avgTokensPerSecond: z.number(),
    minTokensPerSecond: z.number(),
    maxTokensPerSecond: z.number(),
    avgLatencyMs: z.number(),
    totalRuns: z.number(),
    totalTokensProcessed: z.number(),
  }),
});

export type TokenThroughputBenchmark = z.infer<typeof TokenThroughputBenchmarkSchema>;

// ============================================================================
// API Client
// ============================================================================

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  max_tokens?: number;
  temperature?: number;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  created: number;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export async function chatCompletion(
  config: TokenThroughputConfig,
  messages: ChatCompletionRequest['messages'],
  options: Partial<ChatCompletionRequest> = {}
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${config.endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: options.max_tokens ?? config.maxTokens,
      temperature: options.temperature ?? config.temperature,
      ...options,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed: ${response.status} ${errorText}`);
  }

  return response.json() as Promise<ChatCompletionResponse>;
}

// ============================================================================
// Benchmark Runner
// ============================================================================

export async function runTokenThroughputBenchmark(
  config: Partial<TokenThroughputConfig> = {}
): Promise<TokenThroughputBenchmark> {
  const cfg = TokenThroughputConfigSchema.parse(config);

  const results: TokenThroughputResult[] = [];

  for (const contextSize of cfg.contextSizes) {
    console.log(`\n📊 Testing context size: ${contextSize.toLocaleString()} tokens`);

    // Generate context-appropriate prompt
    const prompt = 'The '.repeat(contextSize);
    const messages: ChatCompletionRequest['messages'] = [
      {
        role: 'user',
        content: prompt,
      },
    ];

    const runResults: Array<{
      runIndex: number;
      tokensGenerated: number;
      latencyMs: number;
    }> = [];

    // Warmup runs
    for (let i = 0; i < cfg.warmupRuns; i++) {
      const start = Date.now();
      try {
        await chatCompletion(cfg, messages);
        const latencyMs = Date.now() - start;
        runResults.push({ runIndex: i, tokensGenerated: 0, latencyMs });
      } catch (error) {
        console.warn(`Warmup run ${i} failed: ${error}`);
        runResults.push({ runIndex: i, tokensGenerated: 0, latencyMs: Date.now() - start });
      }
    }

    // Measurement runs
    for (let i = 0; i < cfg.measurementRuns; i++) {
      const start = Date.now();
      try {
        const response = await chatCompletion(cfg, messages);
        const latencyMs = Date.now() - start;
        const tokensGenerated = response.usage.completion_tokens;

        runResults.push({ runIndex: i, tokensGenerated, latencyMs });
      } catch (error) {
        console.warn(`Measurement run ${i} failed: ${error}`);
        runResults.push({ runIndex: i, tokensGenerated: 0, latencyMs: Date.now() - start });
      }
    }

    // Calculate statistics
    const successfulRuns = runResults.filter((r) => r.tokensGenerated > 0);
    const avgLatencyMs =
      runResults.reduce((sum, r) => sum + r.latencyMs, 0) / runResults.length;
    const totalTimeMs = runResults.reduce((sum, r) => sum + r.latencyMs, 0);

    // Estimate tokens/s based on context size (since completion tokens may be small)
    const avgTokensPerSecond = successfulRuns.length > 0 ?
      (successfulRuns.reduce((sum, r) => sum + r.tokensGenerated, 0) / successfulRuns.length) /
      (avgLatencyMs / 1000) :
      0;

    results.push({
      contextSize,
      tokensPerSecond: avgTokensPerSecond,
      totalTimeMs,
      avgLatencyMs,
      runs: runResults,
    });

    console.log(
      `   ✓ Avg: ${avgTokensPerSecond.toFixed(2)} tokens/s | Latency: ${avgLatencyMs.toFixed(0)}ms`
    );
  }

  // Calculate summary
  const allTokensPerSecond = results.map((r) => r.tokensPerSecond).filter((t) => t > 0);
  const allLatencies = results.map((r) => r.avgLatencyMs);

  return {
    model: cfg.model,
    endpoint: cfg.endpoint,
    timestamp: new Date().toISOString(),
    config: cfg,
    results,
    summary: {
      avgTokensPerSecond:
        allTokensPerSecond.length > 0
          ? allTokensPerSecond.reduce((a, b) => a + b, 0) / allTokensPerSecond.length
          : 0,
      minTokensPerSecond: allTokensPerSecond.length > 0 ? Math.min(...allTokensPerSecond) : 0,
      maxTokensPerSecond: allTokensPerSecond.length > 0 ? Math.max(...allTokensPerSecond) : 0,
      avgLatencyMs: allLatencies.length > 0 ? allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length : 0,
      totalRuns: cfg.measurementRuns * cfg.contextSizes.length,
      totalTokensProcessed: results.reduce((sum, r) => sum + r.runs.reduce((s, run) => s + run.tokensGenerated, 0), 0),
    },
  };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.url.endsWith(process.argv[1] ?? '')) {
  const config: Partial<TokenThroughputConfig> = {
    endpoint: process.env.ENDPOINT || 'http://localhost:8080/v1',
    model: process.env.MODEL || 'qwen/qwen35-a3b-iq4xs',
    contextSizes: process.env.CONTEXT_SIZES
      ? JSON.parse(process.env.CONTEXT_SIZES)
      : [100, 500, 1000, 2000, 4000, 8000, 16000, 32000],
    measurementRuns: parseInt(process.env.MEASUREMENT_RUNS || '5', 10),
  };

  console.log('🔬 Qwen3.5 Token Throughput Benchmark');
  console.log('='.repeat(60));
  console.log(`Model: ${config.model}`);
  console.log(`Endpoint: ${config.endpoint}`);
  console.log(`Context sizes: ${(config.contextSizes || []).join(', ')}`);
  console.log('='.repeat(60));

  try {
    const benchmark = await runTokenThroughputBenchmark(config);

    console.log('\n' + '='.repeat(60));
    console.log('📈 SUMMARY');
    console.log('='.repeat(60));
    console.log(
      '%-15s %-15s %-15s %-15s',
      'Context Size',
      'Tokens/s',
      'Total Time',
      'Avg Latency'
    );
    console.log('-'.repeat(60));

    for (const r of benchmark.results) {
      console.log(
        `${r.contextSize.toLocaleString().padEnd(15)} ${r.tokensPerSecond.toFixed(2).padEnd(15)} ${r.totalTimeMs}ms`.padEnd(15) +
        `${r.avgLatencyMs.toFixed(0)}ms`
      );
    }

    console.log('\n📊 Overall Statistics:');
    console.log(`  Avg Tokens/s: ${benchmark.summary.avgTokensPerSecond.toFixed(2)}`);
    console.log(`  Min Tokens/s: ${benchmark.summary.minTokensPerSecond.toFixed(2)}`);
    console.log(`  Max Tokens/s: ${benchmark.summary.maxTokensPerSecond.toFixed(2)}`);
    console.log(`  Avg Latency: ${benchmark.summary.avgLatencyMs.toFixed(0)}ms`);
    console.log(`  Total Runs: ${benchmark.summary.totalRuns}`);
    console.log(`  Total Tokens: ${benchmark.summary.totalTokensProcessed}`);

    // Save results
    const outputPath = process.env.OUTPUT_FILE || './token_throughput_results.json';
    writeFileSync(outputPath, JSON.stringify(benchmark, null, 2));
    console.log(`\n💾 Results saved to: ${outputPath}`);
  } catch (error) {
    console.error('Benchmark failed:', error);
    process.exit(1);
  }
}
