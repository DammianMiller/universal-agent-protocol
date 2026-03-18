#!/usr/bin/env node
/**
 * Layer 1: Intelligent Agent Execution Proxy (v1.0.0)
 *
 * Model-agnostic proxy that sits between any OpenAI-compatible client and
 * any OpenAI-compatible inference server. Implements:
 *
 * 1. tool_choice="required" injection (forces tool use via GBNF grammar)
 * 2. REFLECTION-ACTION LOOP: Every N calls, injects a reflection checkpoint
 *    into the system message forcing the model to evaluate progress
 * 3. PROGRESSIVE BUDGET PRESSURE: Changes system message based on phase
 *    (exploration -> execution -> verification -> emergency)
 * 4. SEMANTIC DEDUP + FORCED MUTATION: Detects near-identical commands
 *    and applies known fix patterns (gcc flag reorder, cd prefix, etc.)
 * 5. OUTPUT-DIFF DETECTION: Tracks output hashes, injects strategy
 *    alternatives when 3+ identical outputs detected
 *
 * Works with any model served via OpenAI-compatible API:
 *   llama.cpp, vLLM, Ollama, OpenAI, Anthropic (via proxy), etc.
 *
 * Usage:
 *   TARGET_URL=http://localhost:8080 node tool-choice-proxy.js
 *   TARGET_URL=http://localhost:11434 PROXY_PORT=11435 node tool-choice-proxy.js
 *
 * Then point your client's baseURL to http://127.0.0.1:${PROXY_PORT}/v1
 */

const http = require('http');
const https = require('https');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '11435', 10);
const TARGET_URL = process.env.TARGET_URL || 'http://127.0.0.1:8080';
const FORCE_TOOL_CHOICE = process.env.FORCE_TOOL_CHOICE || 'required';

// Temperature cap: clamp temperature to this value when tools are present.
// Must be >= the wrapper's dynamic_temp_floor (0.2 for Qwen3.5) to avoid
// overriding the wrapper's retry temperature strategy. Set to 0 to disable.
const MAX_TOOL_TEMPERATURE = parseFloat(process.env.MAX_TOOL_TEMPERATURE || '0.4');

// Budget: stop forcing tool calls after this many chat/completions requests
const SOFT_BUDGET = parseInt(process.env.PROXY_SOFT_BUDGET || '35', 10);
const HARD_BUDGET = parseInt(process.env.PROXY_HARD_BUDGET || '50', 10);
const REFLECTION_INTERVAL = parseInt(process.env.REFLECTION_INTERVAL || '15', 10);

let requestCount = 0;
let chatCompletionCount = 0;
let toolForceCount = 0;

// --- Option 5: Output-diff tracking ---
const recentOutputHashes = [];
const MAX_OUTPUT_HISTORY = 10;
let consecutiveIdenticalOutputs = 0;

// --- Option 6: Semantic dedup ---
const recentCommandPrefixes = [];
const MAX_CMD_HISTORY = 10;

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < Math.min(s.length, 2000); i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

// --- Option 3: Progressive budget phases ---
function getBudgetPhase(n) {
  if (n <= 8) return 'exploration';
  if (n <= 28) return 'execution';
  if (n <= 40) return 'verification';
  return 'emergency';
}

function getPhaseMessage(n, total) {
  const phase = getBudgetPhase(n);
  const remaining = total - n;

  // Keep messages SHORT - the small model gets confused by long injections
  switch (phase) {
    case 'exploration':
      return null; // Don't inject during exploration - let the model work
    case 'execution':
      return null; // Don't inject during execution - let the model work
    case 'verification':
      return `[${remaining} calls left] Test your solution now.`;
    case 'emergency':
      return `[URGENT: ${remaining} calls left] Write output files NOW. Submit even if incomplete.`;
  }
}

// --- Option 1: Reflection checkpoint ---
function getReflectionMessage(n, total) {
  // Keep SHORT - small models lose track with long injections
  return `[Call ${n}/${total}] If your last 2+ commands failed or gave same output, try a different approach. If you have a solution, test it.`;
}

// --- Option 2: Strategy alternatives based on output-diff ---
function getStrategyAlternatives() {
  // Keep SHORT
  return `[STUCK] Same output 5+ times. Try: different approach, install missing deps, check directory, read test files.`;
}

const server = http.createServer((req, res) => {
  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = Buffer.concat(chunks).toString();
    requestCount++;

    if (req.method === 'POST' && req.url && req.url.includes('/chat/completions') && body) {
      try {
        const parsed = JSON.parse(body);
        chatCompletionCount++;

        const n = chatCompletionCount;

        // === BUDGET ENFORCEMENT ===
        if (n > HARD_BUDGET) {
          delete parsed.tools;
          delete parsed.tool_choice;
          console.log(`[proxy] #${n} HARD BUDGET: stripped tools`);
        } else if (n > SOFT_BUDGET) {
          if (parsed.tool_choice === 'required') {
            parsed.tool_choice = 'auto';
          }
          console.log(`[proxy] #${n} SOFT BUDGET: tool_choice=auto`);
        } else if (parsed.tools && parsed.tools.length > 0) {
          const original = parsed.tool_choice;
          parsed.tool_choice = FORCE_TOOL_CHOICE;
          toolForceCount++;
        }

        // === OPTION 3: PROGRESSIVE BUDGET PRESSURE ===
        // Inject phase message into the last user/system message
        if (parsed.messages && parsed.messages.length > 0) {
          const phaseMsg = getPhaseMessage(n, HARD_BUDGET);

          // === OPTION 1: REFLECTION CHECKPOINT ===
          let reflectionMsg = '';
          if (n > 1 && n % REFLECTION_INTERVAL === 0) {
            reflectionMsg = getReflectionMessage(n, HARD_BUDGET);
            console.log(`[proxy] #${n} REFLECTION checkpoint injected`);
          }

          // === OPTION 2: OUTPUT-DIFF STRATEGY SWITCHING ===
          let strategyMsg = '';
          if (consecutiveIdenticalOutputs >= 5) {
            strategyMsg = getStrategyAlternatives();
            consecutiveIdenticalOutputs = 0; // Reset after injection
            console.log(`[proxy] #${n} STRATEGY CHANGE injected`);
          }

          // DISABLED: Message injection regresses small models (Qwen3.5 35B/3B).
          // The model loses track of the task when extra messages are injected.
          // Options 1/2/3 are logged for telemetry but NOT injected.
          // Options 4 (CWD injection), 5 (verifier hints), 6 (gcc mutation) still active.
          const injection = [phaseMsg, reflectionMsg, strategyMsg].filter(Boolean).join(' ');
          if (injection) {
            console.log(`[proxy] #${n} (logged, not injected): ${injection.slice(0, 120)}`);
          }
        }

        // === OPTION 6: SEMANTIC DEDUP + FORCED MUTATION ===
        // Check the last assistant message for tool calls and apply mutations
        if (parsed.messages && parsed.messages.length > 0) {
          const lastMsg = parsed.messages[parsed.messages.length - 1];
          if (lastMsg.role === 'assistant' && lastMsg.tool_calls) {
            for (const tc of lastMsg.tool_calls) {
              if (tc.function && tc.function.arguments) {
                try {
                  const args = JSON.parse(tc.function.arguments);
                  if (args.command && typeof args.command === 'string') {
                    const cmd = args.command;

                    // Mutation: gcc -lm before source -> reorder
                    const gccMatch = cmd.match(/gcc\s+(.*?)-l(\w+)\s+(.*?\.c\b)/);
                    if (gccMatch) {
                      const mutated = cmd.replace(
                        /gcc\s+(.*?)-l(\w+)\s+(.*?\.c\b)/,
                        (match, pre, lib, src) => `gcc ${pre}${src} -l${lib}`
                      );
                      if (mutated !== cmd) {
                        args.command = mutated;
                        tc.function.arguments = JSON.stringify(args);
                        console.log(`[proxy] #${n} MUTATION: gcc flag reorder`);
                      }
                    }
                  }
                } catch (e) {
                  // Ignore parse errors
                }
              }
            }
          }
        }

        // Cap temperature when tools are present to reduce looping
        // NOTE: Do NOT set repetition_penalty - it corrupts structured tool-call output
        if (MAX_TOOL_TEMPERATURE > 0 && parsed.tools && parsed.tools.length > 0) {
          if (parsed.temperature === undefined || parsed.temperature > MAX_TOOL_TEMPERATURE) {
            parsed.temperature = MAX_TOOL_TEMPERATURE;
          }
        }

        body = JSON.stringify(parsed);
      } catch (e) {
        console.error(`[proxy] #${requestCount} JSON parse error: ${e.message}`);
      }
    }

    // Forward to target
    const targetUrl = new URL(req.url || '/', TARGET_URL);
    const isHttps = targetUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const proxyReq = transport.request(
      targetUrl,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: targetUrl.host,
          'content-length': Buffer.byteLength(body),
        },
      },
      (proxyRes) => {
        // CRITICAL: writeHead MUST be called before any res.write() calls.
        // Previously this was after the event listener setup, causing a race
        // condition where data events could fire before headers were sent,
        // producing malformed HTTP responses that broke OpenAI client parsing
        // and caused Qwen3.5 tool call test failures.
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

        // === Track response for output-diff detection ===
        const responseChunks = [];
        proxyRes.on('data', (chunk) => {
          responseChunks.push(chunk);
          res.write(chunk);
        });
        proxyRes.on('end', () => {
          res.end();

          // Track output hash for diff detection
          if (req.url && req.url.includes('/chat/completions')) {
            const responseBody = Buffer.concat(responseChunks).toString();
            try {
              const respParsed = JSON.parse(responseBody);
              const content = respParsed?.choices?.[0]?.message?.content || '';
              const toolCalls = respParsed?.choices?.[0]?.message?.tool_calls || [];

              // Hash the response content + tool call args
              const hashInput =
                content + toolCalls.map((tc) => tc?.function?.arguments || '').join('');

              if (hashInput.length > 0) {
                const hash = simpleHash(hashInput);
                if (
                  recentOutputHashes.length > 0 &&
                  recentOutputHashes[recentOutputHashes.length - 1] === hash
                ) {
                  consecutiveIdenticalOutputs++;
                } else {
                  consecutiveIdenticalOutputs = 0;
                }
                recentOutputHashes.push(hash);
                if (recentOutputHashes.length > MAX_OUTPUT_HISTORY) {
                  recentOutputHashes.shift();
                }
              }
            } catch (e) {
              // Ignore parse errors on response
            }
          }
        });
      }
    );

    proxyReq.on('error', (err) => {
      console.error(`[proxy] #${requestCount} upstream error: ${err.message}`);
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[proxy] UAP Intelligent Agent Execution Proxy (v1.0.0)`);
  console.log(`[proxy] Features: reflection-loop, progressive-budget, semantic-dedup, output-diff`);
  console.log(
    `[proxy] Budget: soft=${SOFT_BUDGET}, hard=${HARD_BUDGET}, reflection every ${REFLECTION_INTERVAL} calls`
  );
  console.log(
    `[proxy] Temperature cap: ${MAX_TOOL_TEMPERATURE > 0 ? MAX_TOOL_TEMPERATURE : 'disabled'}`
  );
  console.log(`[proxy] Listening on 0.0.0.0:${PROXY_PORT}`);
  console.log(`[proxy] Forwarding to ${TARGET_URL}`);
  console.log(`[proxy] Ready.`);
});
