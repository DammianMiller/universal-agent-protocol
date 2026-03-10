import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { QdrantClient } from '@qdrant/js-client-rest';
import { AgentContextConfigSchema } from '../types/index.js';
import type { AgentContextConfig } from '../types/index.js';

type PatternAction = 'index' | 'query' | 'status' | 'generate';

interface PatternOptions {
  search?: string;
  top?: string;
  minScore?: string;
  format?: string;
  force?: boolean;
  verbose?: boolean;
}

/**
 * Load .uap.json config from the current working directory.
 */
function loadConfig(cwd: string): AgentContextConfig | null {
  const configPath = join(cwd, '.uap.json');
  if (!existsSync(configPath)) {
    console.log(chalk.red('  No .uap.json found. Run `uap init` first.'));
    return null;
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return AgentContextConfigSchema.parse(raw);
}

/**
 * Get pattern RAG settings from config, with defaults.
 */
function getPatternRagConfig(config: AgentContextConfig) {
  return {
    enabled: config.memory?.patternRag?.enabled ?? false,
    collection: config.memory?.patternRag?.collection ?? 'agent_patterns',
    embeddingModel: config.memory?.patternRag?.embeddingModel ?? 'all-MiniLM-L6-v2',
    vectorSize: config.memory?.patternRag?.vectorSize ?? 384,
    scoreThreshold: config.memory?.patternRag?.scoreThreshold ?? 0.35,
    topK: config.memory?.patternRag?.topK ?? 2,
    indexScript: config.memory?.patternRag?.indexScript ?? './agents/scripts/index_patterns_to_qdrant.py',
    queryScript: config.memory?.patternRag?.queryScript ?? './agents/scripts/query_patterns.py',
    sourceFile: config.memory?.patternRag?.sourceFile ?? 'CLAUDE.md',
    sourceFiles: config.memory?.patternRag?.sourceFiles ?? [],
    skillsDir: config.memory?.patternRag?.skillsDir,
    maxBodyChars: config.memory?.patternRag?.maxBodyChars ?? 400,
  };
}

/**
 * Resolve the Qdrant endpoint from config.
 */
function getQdrantEndpoint(config: AgentContextConfig): string {
  const endpoint = config.memory?.longTerm?.endpoint || 'localhost:6333';
  return endpoint.startsWith('http://') || endpoint.startsWith('https://') ? endpoint : `http://${endpoint}`;
}

/**
 * Find a working Python with sentence-transformers available.
 */
export function findPython(cwd: string): string | null {
  const candidates = [
    join(cwd, 'agents', '.venv', 'bin', 'python'),
    join(cwd, '.venv', 'bin', 'python'),
    'python3',
    'python',
  ];

  for (const py of candidates) {
    try {
      execSync(`${py} -c "import sentence_transformers" 2>/dev/null`, { cwd, stdio: 'pipe' });
      return py;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

/**
 * Bootstrap a Python venv at agents/.venv with sentence-transformers + qdrant-client.
 * Returns the python binary path on success, null on failure.
 * Best-effort: doesn't throw.
 */
export function ensurePythonVenv(cwd: string): string | null {
  const venvDir = join(cwd, 'agents', '.venv');
  const venvPython = join(venvDir, 'bin', 'python');

  // If venv already has the deps, return immediately
  try {
    execSync(`${venvPython} -c "import sentence_transformers; import qdrant_client"`, { cwd, stdio: 'pipe' });
    return venvPython;
  } catch {
    // Need to create or install deps
  }

  // Find a system python3 to create the venv
  let systemPython: string | null = null;
  for (const candidate of ['python3', 'python']) {
    try {
      execSync(`${candidate} --version`, { stdio: 'pipe' });
      systemPython = candidate;
      break;
    } catch {
      // try next
    }
  }
  if (!systemPython) return null;

  try {
    // Create venv if it doesn't exist
    if (!existsSync(venvPython)) {
      execSync(`${systemPython} -m venv ${venvDir}`, { cwd, stdio: 'pipe', timeout: 30000 });
    }
    // Install deps (uses hardcoded package names, no user input)
    execSync(`${venvPython} -m pip install --quiet sentence-transformers qdrant-client`, {
      cwd,
      stdio: 'pipe',
      timeout: 300000, // 5 min for large deps
    });
    return venvPython;
  } catch {
    return null;
  }
}

export async function patternsCommand(action: PatternAction, options: PatternOptions = {}): Promise<void> {
  const cwd = process.cwd();

  switch (action) {
    case 'status':
      await showPatternStatus(cwd);
      break;
    case 'index':
      await indexPatterns(cwd, options);
      break;
    case 'query':
      await queryPatterns(cwd, options);
      break;
    case 'generate':
      await generateScripts(cwd, options);
      break;
  }
}

/**
 * Show pattern RAG status: collection info, pattern count, last indexed.
 */
async function showPatternStatus(cwd: string): Promise<void> {
  console.log(chalk.bold('\n=== Pattern RAG Status ===\n'));

  const config = loadConfig(cwd);
  if (!config) return;

  const rag = getPatternRagConfig(config);

  console.log(`  ${chalk.dim('Enabled:')}       ${rag.enabled ? chalk.green('yes') : chalk.yellow('no')}`);
  console.log(`  ${chalk.dim('Collection:')}    ${rag.collection}`);
  console.log(`  ${chalk.dim('Embedding:')}     ${rag.embeddingModel}`);
  console.log(`  ${chalk.dim('Score Threshold:')} ${rag.scoreThreshold}`);
  console.log(`  ${chalk.dim('Top-K:')}         ${rag.topK}`);
  console.log(`  ${chalk.dim('Source:')}        ${rag.sourceFile}`);
  console.log('');

  // Check Qdrant collection
  const url = getQdrantEndpoint(config);
  try {
    const client = new QdrantClient({ url });
    const collections = await client.getCollections();
    const found = collections.collections.find(c => c.name === rag.collection);

    if (found) {
      const info = await client.getCollection(rag.collection);
      console.log(chalk.green(`  Qdrant collection '${rag.collection}':`));
      console.log(`    Points:  ${info.points_count ?? 'unknown'}`);
      console.log(`    Indexed: ${info.indexed_vectors_count ?? 'unknown'}`);
      console.log(`    Status:  ${info.status}`);
    } else {
      console.log(chalk.yellow(`  Collection '${rag.collection}' not found.`));
      console.log(chalk.dim('  Run `uap patterns index` to create it.'));
    }
  } catch {
    console.log(chalk.dim('  Qdrant not available. Run `uap memory start` first.'));
  }

  // Check Python + scripts
  const python = findPython(cwd);
  console.log('');
  console.log(`  ${chalk.dim('Python:')}       ${python ? chalk.green(python) : chalk.red('not found')}`);
  console.log(`  ${chalk.dim('Index script:')} ${existsSync(join(cwd, rag.indexScript)) ? chalk.green('found') : chalk.yellow('missing')}`);
  console.log(`  ${chalk.dim('Query script:')} ${existsSync(join(cwd, rag.queryScript)) ? chalk.green('found') : chalk.yellow('missing')}`);
  console.log('');
}

/**
 * Index patterns from CLAUDE.md into the Qdrant collection.
 * Uses the Python index script if available.
 */
async function indexPatterns(cwd: string, options: PatternOptions): Promise<void> {
  const config = loadConfig(cwd);
  if (!config) return;

  const rag = getPatternRagConfig(config);
  const spinner = ora('Indexing patterns...').start();

  // Prefer the Python script if it exists
  const scriptPath = join(cwd, rag.indexScript);
  if (existsSync(scriptPath)) {
    const python = findPython(cwd);
    if (!python) {
      spinner.fail('Python with sentence-transformers not found.');
      console.log(chalk.dim('  Install: pip install sentence-transformers qdrant-client'));
      console.log(chalk.dim('  Or create venv: python3 -m venv agents/.venv && agents/.venv/bin/pip install sentence-transformers qdrant-client'));
      return;
    }

    try {
      const output = execSync(`${python} ${scriptPath}`, { cwd, encoding: 'utf-8', timeout: 120000 });
      spinner.succeed('Patterns indexed successfully.');
      if (options.verbose) {
        console.log(chalk.dim(output));
      } else {
        // Extract summary line
        const summaryMatch = output.match(/Total: (\d+) documents/);
        if (summaryMatch) {
          console.log(chalk.green(`  ${summaryMatch[0]}`));
        }
      }
    } catch (err) {
      spinner.fail('Pattern indexing failed.');
      if (err instanceof Error) {
        console.log(chalk.red(`  ${err.message.split('\n').slice(0, 3).join('\n  ')}`));
      }
    }
    return;
  }

  // No script found - offer to generate
  spinner.warn('Index script not found.');
  console.log(chalk.dim(`  Expected: ${rag.indexScript}`));
  console.log(chalk.dim('  Run `uap patterns generate` to create the scripts.'));
}

/**
 * Query patterns from the Qdrant collection.
 * Uses the Python query script for real semantic embeddings.
 */
async function queryPatterns(cwd: string, options: PatternOptions): Promise<void> {
  const search = options.search;
  if (!search) {
    console.log(chalk.red('  Search term required. Usage: uap patterns query <search>'));
    return;
  }

  const config = loadConfig(cwd);
  if (!config) return;

  const rag = getPatternRagConfig(config);
  const topK = parseInt(options.top || String(rag.topK));
  const minScore = parseFloat(options.minScore || String(rag.scoreThreshold));
  const format = options.format || 'text';

  // Prefer Python script for real embeddings
  const scriptPath = join(cwd, rag.queryScript);
  if (existsSync(scriptPath)) {
    const python = findPython(cwd);
    if (!python) {
      console.log(chalk.red('  Python with sentence-transformers not found.'));
      return;
    }

    try {
      const output = execSync(
        `${python} ${scriptPath} ${JSON.stringify(search)} --top ${topK} --min-score ${minScore} --format ${format}`,
        { cwd, encoding: 'utf-8', timeout: 30000 }
      );
      if (format === 'json') {
        // Parse and pretty-print
        const patterns = JSON.parse(output);
        if (patterns.length === 0) {
          console.log(chalk.yellow('  No matching patterns found.'));
          return;
        }
        for (const p of patterns) {
          const abbr = p.abbreviation ? ` (${p.abbreviation})` : '';
          console.log(`\n  ${chalk.green(`[${p.score.toFixed(3)}]`)} ${chalk.bold(`P${p.id}: ${p.title}${abbr}`)}`);
          console.log(`  ${chalk.dim(p.body.slice(0, rag.maxBodyChars))}${p.body.length > rag.maxBodyChars ? '...' : ''}`);
        }
      } else {
        console.log(output);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Connection refused')) {
        console.log(chalk.dim('  Qdrant not available. Run `uap memory start` first.'));
      } else {
        console.log(chalk.red('  Pattern query failed.'));
        if (err instanceof Error) {
          console.log(chalk.dim(`  ${err.message.split('\n').slice(0, 2).join('\n  ')}`));
        }
      }
    }
    return;
  }

  // Fallback: direct Qdrant query with keyword matching
  console.log(chalk.yellow('  Query script not found. Using fallback keyword search (less accurate).'));
  console.log(chalk.dim(`  For semantic search, run \`uap patterns generate\` to create the Python scripts.\n`));

  try {
    const url = getQdrantEndpoint(config);
    const client = new QdrantClient({ url });
    const collections = await client.getCollections();
    const found = collections.collections.some(c => c.name === rag.collection);

    if (!found) {
      console.log(chalk.yellow(`  Collection '${rag.collection}' not found.`));
      console.log(chalk.dim('  Run `uap patterns index` first.'));
      return;
    }

    // Scroll through all points and do keyword matching as fallback
    const result = await client.scroll(rag.collection, { limit: 100, with_payload: true });
    const keywords = search.toLowerCase().split(/\s+/);
    const matches = result.points
      .map(p => {
        const payload = p.payload as Record<string, unknown>;
        const title = String(payload.title || '').toLowerCase();
        const body = String(payload.body || '').toLowerCase();
        const kws = (payload.keywords as string[]) || [];
        let score = 0;
        for (const kw of keywords) {
          if (title.includes(kw)) score += 2;
          if (body.includes(kw)) score += 1;
          if (kws.some(k => k.includes(kw))) score += 1.5;
        }
        return { id: p.id, title: payload.title, body: payload.body, abbreviation: payload.abbreviation, score };
      })
      .filter(m => m.score > 0)
      .sort((a, b) => (b.score as number) - (a.score as number))
      .slice(0, topK);

    if (matches.length === 0) {
      console.log(chalk.yellow('  No matching patterns found.'));
      return;
    }

    for (const m of matches) {
      const abbr = m.abbreviation ? ` (${m.abbreviation})` : '';
      console.log(`\n  ${chalk.green(`[${(m.score as number).toFixed(1)}]`)} ${chalk.bold(`P${m.id}: ${m.title}${abbr}`)}`);
      const body = String(m.body || '');
      console.log(`  ${chalk.dim(body.slice(0, rag.maxBodyChars))}${body.length > rag.maxBodyChars ? '...' : ''}`);
    }
    console.log('');
  } catch {
    console.log(chalk.dim('  Qdrant not available. Run `uap memory start` first.'));
  }
}

/**
 * Generate the Python index/query scripts for pattern RAG.
 */
export async function generateScripts(cwd: string, options: PatternOptions = {}): Promise<void> {
  const config = loadConfig(cwd);
  if (!config) return;

  const rag = getPatternRagConfig(config);
  const endpoint = config.memory?.longTerm?.endpoint || 'localhost:6333';
  const endpointUrl = endpoint.startsWith('http') ? new URL(endpoint) : new URL(`http://${endpoint}`);
  const host = endpointUrl.hostname;
  const port = parseInt(endpointUrl.port) || 6333;

  // Generate index script
  const indexPath = join(cwd, rag.indexScript);
  const indexDir = dirname(indexPath);
  if (!existsSync(indexDir)) {
    mkdirSync(indexDir, { recursive: true });
  }

  if (existsSync(indexPath) && !options.force) {
    console.log(chalk.yellow(`  Index script already exists: ${rag.indexScript}`));
    console.log(chalk.dim('  Use --force to overwrite.'));
  } else {
    writeFileSync(indexPath, generateIndexScript(rag, host, port));
    execSync(`chmod +x ${indexPath}`);
    console.log(chalk.green(`  Created: ${rag.indexScript}`));
  }

  // Generate query script
  const queryPath = join(cwd, rag.queryScript);
  const queryDir = dirname(queryPath);
  if (!existsSync(queryDir)) {
    mkdirSync(queryDir, { recursive: true });
  }

  if (existsSync(queryPath) && !options.force) {
    console.log(chalk.yellow(`  Query script already exists: ${rag.queryScript}`));
    console.log(chalk.dim('  Use --force to overwrite.'));
  } else {
    writeFileSync(queryPath, generateQueryScript(rag, host, port));
    execSync(`chmod +x ${queryPath}`);
    console.log(chalk.green(`  Created: ${rag.queryScript}`));
  }

  console.log(chalk.dim('\n  Install Python deps: pip install sentence-transformers qdrant-client'));
}

function generateIndexScript(
  rag: ReturnType<typeof getPatternRagConfig>,
  host: string,
  port: number,
): string {
  // Build the list of additional source files for the Python script
  const sourceFilesJson = JSON.stringify(rag.sourceFiles || []);
  const skillsDirValue = rag.skillsDir ? `"${rag.skillsDir}"` : 'None';

  return `#!/usr/bin/env python3
"""
Extract knowledge from project documentation and index into Qdrant.

Scans multiple sources:
  1. CLAUDE.md (with @include resolution)
  2. AGENTS.md and other configured source files
  3. .claude/skills/*/SKILL.md (skill files)

Creates/updates the '${rag.collection}' collection with embeddings from
${rag.embeddingModel} for on-demand retrieval by the Pattern RAG system.

Generated by: uap patterns generate (v0.8.1+)
"""

import re
import sys
import hashlib
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

from sentence_transformers import SentenceTransformer
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PRIMARY_SOURCE = PROJECT_ROOT / "${rag.sourceFile}"
ADDITIONAL_SOURCES = ${sourceFilesJson}
SKILLS_DIR: Optional[str] = ${skillsDirValue}
QDRANT_HOST = "${host}"
QDRANT_PORT = ${port}
COLLECTION_NAME = "${rag.collection}"
EMBEDDING_MODEL = "${rag.embeddingModel}"
VECTOR_SIZE = ${rag.vectorSize}
MAX_BODY_CHARS = 2000


def resolve_includes(text: str, base_dir: Path) -> str:
    """Resolve @include directives (e.g. @hooks-session-start.md)."""
    def replace_include(match):
        filename = match.group(1).strip()
        # Search common locations
        candidates = [
            base_dir / filename,
            base_dir / ".claude" / "hooks" / filename,
            base_dir / ".claude" / filename,
            base_dir / "docs" / filename,
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate.read_text()
        return match.group(0)  # Keep original if not found

    return re.sub(r"^@(\\S+\\.md)$", replace_include, text, flags=re.MULTILINE)


def extract_numbered_patterns(text: str) -> list[dict]:
    """Extract '### Pattern N: Title' blocks (legacy format)."""
    patterns = []
    pattern_regex = re.compile(
        r"### Pattern (\\d+): (.+?)(?:\\s*\\((\\w+)\\))?\\n(.*?)(?=\\n### Pattern \\d+:|\\n## |\\n---|\\Z)",
        re.DOTALL,
    )
    for match in pattern_regex.finditer(text):
        number = int(match.group(1))
        title = match.group(2).strip()
        abbreviation = match.group(3) or ""
        body = match.group(4).strip()
        if len(body) > MAX_BODY_CHARS:
            body = body[:MAX_BODY_CHARS] + "\\n... (truncated)"
        patterns.append({
            "title": title, "abbreviation": abbreviation,
            "category": "pattern", "source": "CLAUDE.md",
            "keywords": list(set(title.lower().split())),
            "body": body,
            "content_hash": hashlib.md5(body.encode()).hexdigest(),
        })
    return patterns


def extract_sections(text: str, source_name: str) -> list[dict]:
    """Extract ## and ### heading sections from any markdown file."""
    sections = []
    # Split on ## headings (level 2 and 3)
    heading_regex = re.compile(r"^(#{2,3})\\s+(.+)$", re.MULTILINE)
    matches = list(heading_regex.finditer(text))

    for i, match in enumerate(matches):
        level = len(match.group(1))
        title = match.group(2).strip()

        # Skip HTML comments, empty titles, very short titles
        if title.startswith("<!--") or len(title) < 3:
            continue

        # Get body until next heading of same or higher level
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()

        # Skip empty or trivial sections
        if len(body) < 20:
            continue

        if len(body) > MAX_BODY_CHARS:
            body = body[:MAX_BODY_CHARS] + "\\n... (truncated)"

        # Classify category from source name and content
        category = classify_section(title, body, source_name)

        # Build keywords from title
        keywords = [w.lower() for w in re.findall(r"[a-zA-Z]{3,}", title)]

        sections.append({
            "title": title,
            "abbreviation": "",
            "category": category,
            "source": source_name,
            "keywords": keywords,
            "body": body,
            "content_hash": hashlib.md5(body.encode()).hexdigest(),
        })

    return sections


def classify_section(title: str, body: str, source: str) -> str:
    """Classify a section into a category based on content signals."""
    t = title.lower()
    b = body.lower()[:500]

    if "skill" in source.lower():
        return "skill"
    if any(w in t for w in ["deploy", "kubernetes", "k8s", "cluster", "infra"]):
        return "infrastructure"
    if any(w in t for w in ["security", "auth", "secret", "owasp", "xss"]):
        return "security"
    if any(w in t for w in ["test", "coverage", "vitest", "jest"]):
        return "testing"
    if any(w in t for w in ["performance", "optimize", "cache", "latency"]):
        return "performance"
    if any(w in t for w in ["workflow", "protocol", "checklist", "process"]):
        return "workflow"
    if any(w in t for w in ["database", "postgres", "sql", "pgdog", "cnpg"]):
        return "database"
    if any(w in t for w in ["observ", "monitor", "metric", "log", "trace"]):
        return "observability"
    if any(w in t for w in ["design", "ui", "ux", "css", "style", "theme"]):
        return "design"
    if any(w in t for w in ["review", "quality", "lint", "code"]):
        return "code-quality"
    if "terraform" in b or "iac" in t:
        return "infrastructure"
    return "general"


def extract_skill_frontmatter(text: str) -> tuple[str, str]:
    """Extract name and description from YAML frontmatter."""
    fm_match = re.match(r"^---\\n(.*?)\\n---", text, re.DOTALL)
    if not fm_match:
        return "", ""
    fm = fm_match.group(1)
    name_match = re.search(r"^name:\\s*(.+)$", fm, re.MULTILINE)
    desc_match = re.search(r'^description:\\s*["\\'"]?(.+?)["\\'"]?\\s*$', fm, re.MULTILINE)
    name = name_match.group(1).strip().strip('"').strip("'") if name_match else ""
    desc = desc_match.group(1).strip().strip('"').strip("'") if desc_match else ""
    return name, desc


def scan_skills(project_root: Path, skills_dir: Optional[str]) -> list[dict]:
    """Scan .claude/skills/*/SKILL.md files."""
    docs = []
    # Auto-detect skills directory
    candidates = []
    if skills_dir:
        candidates.append(project_root / skills_dir)
    candidates.extend([
        project_root / ".claude" / "skills",
        project_root / ".factory" / "skills",
    ])

    for skills_path in candidates:
        if not skills_path.is_dir():
            continue
        skill_files = sorted(skills_path.glob("*/SKILL.md"))
        for sf in skill_files:
            text = sf.read_text()
            skill_name, skill_desc = extract_skill_frontmatter(text)
            if not skill_name:
                skill_name = sf.parent.name

            # Extract sections from the skill file
            sections = extract_sections(text, f"skill:{skill_name}")

            # If no sections extracted, index the whole skill as one doc
            if not sections and len(text.strip()) > 50:
                body = text.strip()
                if len(body) > MAX_BODY_CHARS:
                    body = body[:MAX_BODY_CHARS] + "\\n... (truncated)"
                sections = [{
                    "title": skill_name,
                    "abbreviation": "",
                    "category": "skill",
                    "source": f"skill:{skill_name}",
                    "keywords": [w.lower() for w in re.findall(r"[a-zA-Z]{3,}", skill_name + " " + skill_desc)],
                    "body": body,
                    "content_hash": hashlib.md5(body.encode()).hexdigest(),
                }]

            # Add skill description as keywords to all sections
            if skill_desc:
                desc_keywords = [w.lower() for w in re.findall(r"[a-zA-Z]{3,}", skill_desc)]
                for s in sections:
                    s["keywords"] = list(set(s["keywords"] + desc_keywords))

            docs.extend(sections)
        if docs:
            break  # Use first found skills directory

    return docs


def deduplicate(docs: list[dict]) -> list[dict]:
    """Remove duplicate documents by content hash."""
    seen = set()
    unique = []
    for d in docs:
        h = d["content_hash"]
        if h not in seen:
            seen.add(h)
            unique.append(d)
    return unique


def index_to_qdrant(docs: list[dict]) -> None:
    """Create collection and upsert document embeddings."""
    if not docs:
        print("  No documents to index — skipping")
        return

    client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)
    model = SentenceTransformer(EMBEDDING_MODEL)

    # Recreate collection
    collections = [c.name for c in client.get_collections().collections]
    if COLLECTION_NAME in collections:
        client.delete_collection(COLLECTION_NAME)
        print(f"  Deleted existing '{COLLECTION_NAME}' collection")

    client.create_collection(
        collection_name=COLLECTION_NAME,
        vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
    )
    print(f"  Created '{COLLECTION_NAME}' collection ({VECTOR_SIZE}-dim cosine)")

    # Assign sequential IDs and build embeddings
    points = []
    for idx, doc in enumerate(docs, start=1):
        embed_text = f"{doc['title']}. {' '.join(doc['keywords'][:10])}. {doc['body'][:500]}"
        vector = model.encode(embed_text).tolist()
        points.append(PointStruct(
            id=idx, vector=vector,
            payload={
                "title": doc["title"],
                "abbreviation": doc.get("abbreviation", ""),
                "category": doc["category"],
                "source": doc.get("source", ""),
                "detection": doc.get("detection", ""),
                "keywords": doc["keywords"],
                "body": doc["body"],
                "content_hash": doc["content_hash"],
                "indexed_at": datetime.now(tz=timezone.utc).isoformat(),
            },
        ))

    # Batch upsert (Qdrant handles large batches fine)
    BATCH_SIZE = 100
    for i in range(0, len(points), BATCH_SIZE):
        batch = points[i:i + BATCH_SIZE]
        client.upsert(collection_name=COLLECTION_NAME, points=batch)
    print(f"  Indexed {len(points)} documents")


def main():
    print("=== UAP Pattern Indexer (v2 — multi-source) ===")
    all_docs: list[dict] = []

    # 1. Primary source (CLAUDE.md) with @include resolution
    if PRIMARY_SOURCE.exists():
        text = PRIMARY_SOURCE.read_text()
        text = resolve_includes(text, PROJECT_ROOT)
        print(f"  Read {PRIMARY_SOURCE.name} ({len(text)} bytes, includes resolved)")

        # Try legacy numbered patterns first
        patterns = extract_numbered_patterns(text)
        if patterns:
            print(f"  Extracted {len(patterns)} numbered patterns")
            all_docs.extend(patterns)

        # Also extract heading-based sections
        sections = extract_sections(text, PRIMARY_SOURCE.name)
        if sections:
            print(f"  Extracted {len(sections)} sections from {PRIMARY_SOURCE.name}")
            all_docs.extend(sections)
    else:
        print(f"  {PRIMARY_SOURCE.name} not found — skipping")

    # 2. Additional source files (AGENTS.md, etc.)
    for src_name in ADDITIONAL_SOURCES:
        src_path = PROJECT_ROOT / src_name
        if src_path.exists():
            text = src_path.read_text()
            sections = extract_sections(text, src_name)
            print(f"  Extracted {len(sections)} sections from {src_name}")
            all_docs.extend(sections)
        else:
            print(f"  {src_name} not found — skipping")

    # 3. Auto-detect common files if no additional sources configured
    if not ADDITIONAL_SOURCES:
        for auto_file in ["AGENTS.md", "CONTRIBUTING.md"]:
            auto_path = PROJECT_ROOT / auto_file
            if auto_path.exists():
                text = auto_path.read_text()
                sections = extract_sections(text, auto_file)
                if sections:
                    print(f"  Auto-detected {auto_file}: {len(sections)} sections")
                    all_docs.extend(sections)

    # 4. Scan skill files
    skills = scan_skills(PROJECT_ROOT, SKILLS_DIR)
    if skills:
        print(f"  Scanned skills: {len(skills)} documents")
        all_docs.extend(skills)

    # Deduplicate
    all_docs = deduplicate(all_docs)
    print(f"  Total unique documents: {len(all_docs)}")

    # Index
    index_to_qdrant(all_docs)

    # Summary by category
    categories: dict[str, int] = {}
    for d in all_docs:
        categories[d["category"]] = categories.get(d["category"], 0) + 1
    print("\\n=== Summary by Category ===")
    for cat, count in sorted(categories.items(), key=lambda x: -x[1]):
        print(f"  {cat:>20}: {count}")

    print(f"\\nTotal: {len(all_docs)} documents in '{COLLECTION_NAME}' collection")


if __name__ == "__main__":
    main()
`;
}

function generateQueryScript(
  rag: ReturnType<typeof getPatternRagConfig>,
  host: string,
  port: number,
): string {
  return `#!/usr/bin/env python3
"""
Query the ${rag.collection} Qdrant collection for task-relevant patterns.

Generated by: uap patterns generate
"""

import argparse
import json
import sys

from sentence_transformers import SentenceTransformer
from qdrant_client import QdrantClient

QDRANT_HOST = "${host}"
QDRANT_PORT = ${port}
COLLECTION_NAME = "${rag.collection}"
EMBEDDING_MODEL = "${rag.embeddingModel}"

_model = None


def get_model():
    global _model
    if _model is None:
        _model = SentenceTransformer(EMBEDDING_MODEL)
    return _model


def query_patterns(query: str, top_k: int = ${rag.topK}, min_score: float = ${rag.scoreThreshold}) -> list[dict]:
    client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)
    model = get_model()
    vector = model.encode(query).tolist()
    results = client.query_points(
        collection_name=COLLECTION_NAME,
        query=vector,
        limit=top_k,
        score_threshold=min_score,
    )
    patterns = []
    for hit in results.points:
        patterns.append({
            "id": hit.id,
            "score": round(hit.score, 4),
            "title": hit.payload.get("title", ""),
            "abbreviation": hit.payload.get("abbreviation", ""),
            "category": hit.payload.get("category", ""),
            "body": hit.payload.get("body", ""),
        })
    return patterns


def format_for_context(patterns: list[dict]) -> str:
    if not patterns:
        return ""
    lines = ["<uap-patterns>"]
    for p in patterns:
        abbr = f" ({p['abbreviation']})" if p["abbreviation"] else ""
        lines.append(f"### Pattern {p['id']}: {p['title']}{abbr}")
        lines.append(f"Relevance: {p['score']}")
        lines.append(p["body"])
        lines.append("")
    lines.append("</uap-patterns>")
    return "\\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Query UAP pattern collection")
    parser.add_argument("query", help="Task description to match patterns against")
    parser.add_argument("--top", type=int, default=${rag.topK})
    parser.add_argument("--min-score", type=float, default=${rag.scoreThreshold})
    parser.add_argument("--format", choices=["text", "json", "context"], default="text")
    args = parser.parse_args()
    try:
        patterns = query_patterns(args.query, top_k=args.top, min_score=args.min_score)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    if args.format == "json":
        print(json.dumps(patterns, indent=2))
    elif args.format == "context":
        print(format_for_context(patterns))
    else:
        if not patterns:
            print("No matching patterns found.")
            return
        for p in patterns:
            abbr = f" ({p['abbreviation']})" if p["abbreviation"] else ""
            print(f"[{p['score']:.3f}] P{p['id']}: {p['title']}{abbr} [{p['category']}]")
            print(f"  {p['body'][:200]}...")
            print()


if __name__ == "__main__":
    main()
`;
}
