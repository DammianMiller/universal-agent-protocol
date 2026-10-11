/**
 * `uap self` — the self-knowledge card surface (S2).
 *
 *   uap self card [--refresh] [--json]    ensure/build the version-pinned card
 *   uap self query "<question>" [--json] offline ranked search over the card
 *
 * The default output is a compact block suitable for session-start injection:
 * version, catalog counts, where the card lives, and the query command. The
 * full manual lives in `.uap/self-card.md`; `query` is how the agent answers
 * "how do I make UAP do X" without searching online.
 */
import { relative, resolve } from 'path';
import {
  ensureSelfCard,
  searchSelfCard,
  selfCardPath,
  type SelfCardEnsureResult,
} from '../generators/self-card.js';

export interface SelfCommandOptions {
  json?: boolean;
  refresh?: boolean;
  limit?: number;
}

/** Injectable seams so tests exercise the flow without touching the installed package. */
export interface SelfDeps {
  /** Override for ensureSelfCard (tests). */
  ensure?: typeof ensureSelfCard;
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(resolve(cwd), resolve(path));
  return rel && !rel.startsWith('..') ? rel : path;
}

function coreCommands(card: SelfCardEnsureResult): string {
  if (!card.ok) return '';
  return card.card.commands
    .slice(0, 12)
    .map((c) => c.command)
    .join(' · ');
}

export async function selfCommand(
  action: string | undefined,
  question: string | undefined,
  options: SelfCommandOptions = {},
  cwd: string = process.cwd(),
  deps: SelfDeps = {}
): Promise<void> {
  const ensure = deps.ensure ?? ensureSelfCard;

  if (action === 'query') {
    if (!question || !question.trim()) {
      console.error('uap self query: a question is required, e.g. uap self query "how do I run a benchmark"');
      process.exitCode = 1;
      return;
    }
    const card = ensure(cwd, { refresh: options.refresh });
    if (!card.ok) {
      console.error(`uap self query: no card (${card.reason})`);
      process.exitCode = 1;
      return;
    }
    const limit = options.limit && options.limit > 0 ? options.limit : 5;
    const results = searchSelfCard(card.card.markdown, question, limit);
    if (options.json) {
      console.log(
        JSON.stringify({
          ok: true,
          query: question,
          version: card.card.version,
          results: results.map((r) => ({ heading: r.heading, text: r.text, score: r.score })),
        })
      );
      return;
    }
    if (results.length === 0) {
      console.log(`No self-card match for "${question}". Read .uap/self-card.md or rephrase.`);
      return;
    }
    console.log(`UAP self-card query: "${question}" — top ${results.length} match(es):`);
    for (const r of results) {
      console.log(`  [${r.heading}] (score ${r.score})`);
      console.log(`    ${r.text}`);
    }
    return;
  }

  // default: card
  const card = ensure(cwd, { refresh: options.refresh });
  if (!card.ok) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, reason: card.reason }));
    } else {
      console.error(`uap self card: ${card.reason}`);
    }
    process.exitCode = 1;
    return;
  }
  const { version, commands, features, markdown } = card.card;
  const bytes = Buffer.byteLength(markdown, 'utf-8');
  const path = selfCardPath(cwd);
  if (options.json) {
    console.log(
      JSON.stringify({
        ok: true,
        version,
        path: displayPath(cwd, path),
        fresh: card.fresh,
        commands: commands.length,
        features: features.length,
        bytes,
      })
    );
    return;
  }
  console.log(`## UAP self-card v${version} (${commands.length} commands, ${features.length} features)`);
  console.log(`  ${card.fresh ? 'Generated' : 'Pinned'} at ${displayPath(cwd, path)} (${(bytes / 1024).toFixed(1)} KB)`);
  console.log(`  Ask: uap self query "<question>" — offline search over your own manual`);
  console.log(`  Core: ${coreCommands(card)}`);
}
