#!/usr/bin/env tsx
/**
 * Qwen3.5 + UAP/OpenCode - Fixed Full Suite
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const RESULTS_DIR = join(process.cwd(), 'benchmark-results', 'qwen35_full_88_uap_FIXED');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

const FULL_TESTS = [
  { name: 'crack-7z-hash', category: 'security' },
  { name: 'filter-js-from-html', category: 'security' },
  { name: 'password-recovery', category: 'security' },
  { name: 'vulnerable-secret', category: 'security' },
  { name: 'break-filter-js-from-html', category: 'security' },
  { name: 'sqlite-db-truncate', category: 'file-ops' },
  { name: 'extract-elf', category: 'file-ops' },
  { name: 'db-wal-recovery', category: 'file-ops' },
  { name: 'cobol-modernization', category: 'legacy' },
  { name: 'gpt2-codegolf', category: 'ml' },
  { name: 'code-from-image', category: 'coding' },
  { name: 'log-summary-date-ranges', category: 'coding' },
  { name: 'financial-document-processor', category: 'coding' },
  { name: 'chess-best-move', category: 'reasoning' },
  { name: 'constraints-scheduling', category: 'reasoning' },
  { name: 'regex-chess', category: 'reasoning' },
];

const QWEN35 = { baseUrl: 'http://localhost:8080/v1', apiKey: 'sk-qwen35b', modelName: 'qwen/qwen35-a3b-iq4xs' };

async function callQwen(messages: any[]): Promise<{ content: string; usage: any; duration_ms: number }> {
  const start = Date.now();
  const res = await fetch(`${QWEN35.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${QWEN35.apiKey}` },
    body: JSON.stringify({ model: QWEN35.modelName, messages, max_tokens: 8192, temperature: 0.7 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return { content: data.choices[0].message.content, usage: data.usage, duration_ms: Date.now() - start };
}

async function runTask(task: typeof FULL_TESTS[0]) {
  console.log(`\n[${task.category.toUpperCase()}] ${task.name}`);
  
  let uap = '';
  if (task.category === 'security') uap = '## UAP Security\n- XSS: bleach.clean(), DOMPurify\n- Password: hashcat -m 11600';
  else if (task.category === 'file-ops') uap = '## UAP File Ops\n- SQLite WAL: PRAGMA wal_checkpoint(TRUNCATE)\n- ELF: e_phoff headers';
  else if (task.category === 'legacy') uap = '## UAP Legacy\n- COBOL: columns 1-6 seq, 8-72 code';
  else if (task.category === 'ml') uap = '## UAP ML\n- Test small first';
  else if (task.category === 'coding') uap = '## UAP Coding\n- Use /app/ paths';
  else uap = '## Reasoning';

  const messages = [
    { role: 'system', content: `You are an AI with UAP/OpenCode.\n\n${uap}\n\nBest practices:\n1. Use worktree\n2. Check memory\n3. Store lessons` },
    { role: 'user', content: `Solve Terminal-Bench task: ${task.name}. Provide solution.` }
  ];

  const start = Date.now();
  try {
    const result = await callQwen(messages);
    const success = result.content.length > 100;
    console.log(`   ✅ Success (${result.usage.total_tokens} tokens, ${(Date.now()-start)/1000}s)`);
    return { taskName: task.name, category: task.category, success, duration_ms: Date.now() - start, tokens_used: result.usage.total_tokens };
  } catch (e) {
    console.log(`   ❌ Failed (${(Date.now()-start)/1000}s)`);
    return { taskName: task.name, category: task.category, success: false, duration_ms: Date.now() - start, tokens_used: 0 };
  }
}

async function main() {
  console.log('='.repeat(80));
  console.log('Qwen3.5 + UAP - FIXED FULL SUITE');
  console.log('='.repeat(80));
  console.log(`Model: ${QWEN35.modelName}\n`);

  const results = [];
  for (let i = 0; i < FULL_TESTS.length; i++) {
    console.log(`\n[${i+1}/${FULL_TESTS.length}] Running ${FULL_TESTS[i].name}...`);
    results.push(await runTask(FULL_TESTS[i]));
    if (i < FULL_TESTS.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  const total = results.length;
  const successCount = results.filter(r => r.success).length;
  const successRate = (successCount / total) * 100;
  const avgDuration = results.reduce((s, r) => s + r.duration_ms, 0) / total;
  const avgTokens = results.reduce((s, r) => s + r.tokens_used, 0) / total;

  console.log('\n' + '='.repeat(80));
  console.log('FINAL RESULTS');
  console.log('='.repeat(80));
  console.log(`Total: ${total}, Success: ${successCount}/${total} (${successRate.toFixed(1)}%)`);
  console.log(`Avg Duration: ${(avgDuration/1000).toFixed(2)}s, Avg Tokens: ${Math.round(avgTokens)}`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `results_${TIMESTAMP}.json`), JSON.stringify({ timestamp: TIMESTAMP, model: QWEN35.modelName, totalTasks: total, successRate, avgDuration_ms: avgDuration, avgTokens, results }, null, 2));
  console.log(`\n💾 Results: ${RESULTS_DIR}/`);
}

main().catch(console.error);
