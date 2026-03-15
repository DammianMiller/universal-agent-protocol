#!/usr/bin/env node
/**
 * Layer 1: tool_choice="required" HTTP Proxy (v9.9.0)
 *
 * Sits between opencode and llama-server, injecting tool_choice="required"
 * into every /v1/chat/completions request that includes tools.
 *
 * This forces the model to produce tool calls via GBNF grammar constraint,
 * mechanically preventing text-only responses.
 *
 * NEW in v9.9.0:
 * - Request budget: after SOFT_BUDGET requests, stops forcing tool_choice
 *   so the model can produce a text-only "done" response and end the session
 * - After HARD_BUDGET, strips tools entirely to force text-only completion
 * - Lower temperature (0.3) and repetition_penalty (1.15) to reduce looping
 *
 * Usage:
 *   PROXY_PORT=11435 TARGET_URL=http://192.168.1.165:8080 node tool-choice-proxy.js
 *
 * Then point opencode.json baseURL to http://127.0.0.1:11435/v1
 */

const http = require('http');
const https = require('https');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '11435', 10);
const TARGET_URL = process.env.TARGET_URL || 'http://192.168.1.165:8080';
const FORCE_TOOL_CHOICE = process.env.FORCE_TOOL_CHOICE || 'required';

// Budget: stop forcing tool calls after this many chat/completions requests
const SOFT_BUDGET = parseInt(process.env.PROXY_SOFT_BUDGET || '35', 10);
const HARD_BUDGET = parseInt(process.env.PROXY_HARD_BUDGET || '50', 10);

let requestCount = 0;
let chatCompletionCount = 0;
let toolForceCount = 0;

const server = http.createServer((req, res) => {
  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = Buffer.concat(chunks).toString();
    requestCount++;

    // Inject tool_choice + sampling params into chat completions requests
    if (req.method === 'POST' && req.url && req.url.includes('/chat/completions') && body) {
      try {
        const parsed = JSON.parse(body);
        chatCompletionCount++;

        if (chatCompletionCount > HARD_BUDGET) {
          // HARD BUDGET: strip tools entirely, force text-only completion
          // This makes the model produce a text response, ending the opencode session
          delete parsed.tools;
          delete parsed.tool_choice;
          console.log(
            `[proxy] #${chatCompletionCount} HARD BUDGET (${HARD_BUDGET}): stripped tools, forcing text-only completion`
          );
        } else if (chatCompletionCount > SOFT_BUDGET) {
          // SOFT BUDGET: stop forcing tool_choice, let model choose
          // Model can still use tools if it wants, but can also produce text to finish
          if (parsed.tool_choice === 'required') {
            parsed.tool_choice = 'auto';
          }
          console.log(
            `[proxy] #${chatCompletionCount} SOFT BUDGET (${SOFT_BUDGET}): tool_choice=auto (model can finish)`
          );
        } else if (parsed.tools && parsed.tools.length > 0) {
          // Normal operation: force tool_choice
          const original = parsed.tool_choice;
          parsed.tool_choice = FORCE_TOOL_CHOICE;
          toolForceCount++;
          console.log(
            `[proxy] #${chatCompletionCount} tool_choice: ${JSON.stringify(original)} -> "${FORCE_TOOL_CHOICE}" (${parsed.tools.length} tools)`
          );
        }

        // Enforce lower temperature to reduce looping
        // NOTE: Do NOT set repetition_penalty - it corrupts structured tool-call output
        if (parsed.temperature === undefined || parsed.temperature > 0.4) {
          parsed.temperature = 0.3;
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
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
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
  console.log(`[proxy] Layer 1: tool_choice="${FORCE_TOOL_CHOICE}" proxy (v9.9.0)`);
  console.log(`[proxy] Budget: soft=${SOFT_BUDGET}, hard=${HARD_BUDGET}`);
  console.log(`[proxy] Listening on 0.0.0.0:${PROXY_PORT}`);
  console.log(`[proxy] Forwarding to ${TARGET_URL}`);
  console.log(`[proxy] Ready.`);
});
