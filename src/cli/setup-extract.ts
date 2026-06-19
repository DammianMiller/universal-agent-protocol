/**
 * Extraction engine — turn a project's UNIQUE custom agent instructions into
 * reusable UAP policies and skills during setup.
 *
 * Existing instruction files (CLAUDE.md, AGENTS.md, …) usually contain a few
 * bespoke rules/workflows alongside the UAP-standard scaffolding. This module
 * detects those non-standard sections, heuristically classifies each as a
 * policy (imperative rule/gate) or a skill (workflow/how-to), and — after the
 * user confirms — emits valid policy `.md` + skill `SKILL.md` files.
 *
 * Deterministic (no LLM). Backup runs before this (see setup-backup.ts); v1
 * copies content into policy/skill files and leaves the originals in place, so
 * nothing is lost. Idempotent via a sidecar manifest of extracted slugs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseSections, isStandardSection, type Section } from '../utils/merge-claude-md.js';
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import type { PromptUI } from './prompt-ui.js';

/** Agent instruction files scanned for custom content (config excluded). */
export const AGENT_INSTRUCTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'AGENT.md',
  'GEMINI.md',
  '.cursorrules',
  '.clinerules',
  '.windsurfrules',
] as const;

export type Classification = 'policy' | 'skill' | 'keep-inline';

export interface CustomSection {
  title: string;
  content: string;
  sourceFile: string;
  classification: Classification;
  confidence: number;
  slug: string;
  /** Stable identity for idempotency (source file + title), independent of slug
   *  so two distinct sections that slugify the same aren't conflated. */
  key: string;
}

export interface ExtractionResult {
  detected: CustomSection[];
  extractedPolicies: string[];
  extractedSkills: string[];
  skipped: string[];
}

const MANIFEST_PATH = join('.uap', 'extracted.json');

function loadManifest(cwd: string): Set<string> {
  try {
    const raw = readFileSync(join(cwd, MANIFEST_PATH), 'utf-8');
    const data = JSON.parse(raw) as { slugs?: string[] };
    return new Set(data.slugs ?? []);
  } catch {
    return new Set();
  }
}

function saveManifest(cwd: string, slugs: Set<string>): void {
  try {
    mkdirSync(join(cwd, '.uap'), { recursive: true });
    writeFileSync(join(cwd, MANIFEST_PATH), JSON.stringify({ slugs: [...slugs] }, null, 2));
  } catch {
    /* sidecar is best-effort */
  }
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'custom';
}

/** Resolve a slug that doesn't collide with an existing file at dir/<slug><ext>. */
function uniqueSlug(base: string, exists: (slug: string) => boolean): string {
  if (!exists(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

const POLICY_RE = /\b(MUST|DO NOT|DON'T|NEVER|ALWAYS|REQUIRED|SHALL|PROHIBITED|FORBIDDEN|MANDATORY|GATE|ENFORCE)\b/gi;
const SKILL_RE = /\b(how to|workflow|procedure|step\s*\d|usage|run the|guide)\b/gi;

/**
 * Heuristically classify a section. Policy signals are imperative rules/gates;
 * skill signals are workflow/how-to. Biased toward keep-inline when ambiguous
 * so content the user expects in CLAUDE.md isn't moved unnecessarily.
 */
export function classifySection(
  title: string,
  content: string
): { classification: Classification; confidence: number } {
  const text = `${title}\n${content}`;
  let policyScore = (text.match(POLICY_RE) ?? []).length * 2;
  let skillScore = (text.match(SKILL_RE) ?? []).length * 1.5;

  // Structural signals
  if (/^\s*[-*]\s*\[[ x]\]/m.test(content)) policyScore += 2; // checklist
  if (/[⛔🔴]/.test(text)) policyScore += 2;
  if (/^\s*\d+\.\s+/m.test(content)) skillScore += 1.5; // ordered steps
  if (/```/.test(content)) skillScore += 1.5; // code block
  if (/\b(gate|policy|prohibited)\b/i.test(title)) policyScore += 2;
  if (/\b(workflow|guide|how|setup|deploy)\b/i.test(title)) skillScore += 1.5;

  const total = policyScore + skillScore;
  const confidence = total === 0 ? 0 : Math.abs(policyScore - skillScore) / total;

  if (policyScore > skillScore && policyScore >= 4) return { classification: 'policy', confidence };
  if (skillScore > policyScore && skillScore >= 3) return { classification: 'skill', confidence };
  return { classification: 'keep-inline', confidence };
}

/** Existing agent instruction files present in the project. */
export function findInstructionFiles(cwd: string): string[] {
  return AGENT_INSTRUCTION_FILES.filter((f) => existsSync(join(cwd, f)));
}

/**
 * Detect non-standard (custom) sections across the project's instruction files,
 * pre-classified. Already-extracted sections (per the manifest) are skipped.
 */
export function detectCustomSections(cwd: string): CustomSection[] {
  const alreadyExtracted = loadManifest(cwd);
  const out: CustomSection[] = [];

  for (const file of findInstructionFiles(cwd)) {
    let sections: Section[];
    try {
      sections = parseSections(readFileSync(join(cwd, file), 'utf-8'));
    } catch {
      continue;
    }
    for (const s of sections) {
      if (!s.title || !s.content.trim()) continue;
      if (isStandardSection(s.title)) continue;
      const key = `${file}::${s.title.toLowerCase().trim()}`;
      if (alreadyExtracted.has(key)) continue;
      const { classification, confidence } = classifySection(s.title, s.content);
      out.push({
        title: s.title,
        content: s.content.trim(),
        sourceFile: file,
        classification,
        confidence,
        slug: slugify(s.title),
        key,
      });
    }
  }
  return out;
}

function policyMarkdown(section: CustomSection, slug: string): string {
  const stem = section.sourceFile.replace(/\.[^.]+$/, '').replace(/^\./, '');
  return `# ${slug}

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: extracted, ${stem}

## Rule

${section.content}

## Why

Extracted from ${section.sourceFile} during \`uap setup\` — a project-specific rule promoted to a reviewable UAP policy.
`;
}

function skillDescription(section: CustomSection): string {
  // First meaningful prose line: skip blanks, headings, and list/step markers
  // (so a "1. Run build" workflow doesn't become a description of "1.").
  const line = section.content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^#{1,6}\s/.test(l) && !/^([-*+]|\d+\.)\s/.test(l) && !/^```/.test(l));
  const base = (line ?? section.title).replace(/\s+/g, ' ').trim();
  return base.length > 120 ? `${base.slice(0, 117)}…` : base;
}

function skillMarkdown(section: CustomSection): string {
  // JSON.stringify yields a valid YAML flow scalar — safe even when the source
  // line contains colons, quotes, or markdown control characters.
  return `---
name: ${section.slug}
description: ${JSON.stringify(skillDescription(section))}
---

# ${section.title}

${section.content}
`;
}

async function emitPolicy(cwd: string, section: CustomSection): Promise<string> {
  const dir = join(cwd, 'policies');
  mkdirSync(dir, { recursive: true });
  const slug = uniqueSlug(section.slug, (s) => existsSync(join(dir, `${s}.md`)));
  const md = policyMarkdown(section, slug);
  writeFileSync(join(dir, `${slug}.md`), md);
  // Register into the policy store (fail-soft — the .md on disk is the source of truth).
  try {
    await getPolicyMemoryManager().storeRawPolicy(md, { category: 'custom', tags: ['extracted'] });
  } catch {
    /* registration is best-effort */
  }
  return slug;
}

function emitSkill(cwd: string, section: CustomSection): string {
  const root = join(cwd, 'skills');
  const name = uniqueSlug(section.slug, (s) => existsSync(join(root, s)));
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMarkdown({ ...section, slug: name }));
  return name;
}

/** Detect + print what would be extracted, writing nothing (non-interactive default). */
export function reportOnly(sections: CustomSection[], log: (m: string) => void = console.log): void {
  if (sections.length === 0) {
    log('  No custom (non-standard) instruction sections detected.');
    return;
  }
  log(`  Detected ${sections.length} custom section(s) (run setup interactively, or --extract-auto, to extract):`);
  for (const s of sections) {
    log(`    - [${s.classification}] ${s.title}  (${s.sourceFile})`);
  }
}

/** Non-interactive auto-extract per heuristic (skips keep-inline). */
export async function extractAuto(cwd: string): Promise<ExtractionResult> {
  const detected = detectCustomSections(cwd);
  const result: ExtractionResult = { detected, extractedPolicies: [], extractedSkills: [], skipped: [] };
  const manifest = loadManifest(cwd);
  for (const s of detected) {
    if (s.classification === 'policy') result.extractedPolicies.push(await emitPolicy(cwd, s));
    else if (s.classification === 'skill') result.extractedSkills.push(emitSkill(cwd, s));
    else {
      result.skipped.push(s.title);
      continue;
    }
    manifest.add(s.key);
  }
  saveManifest(cwd, manifest);
  return result;
}

/**
 * Interactive review: choose which custom sections to extract and confirm the
 * target (policy/skill/skip) for each, then emit and report.
 */
export async function extractInteractive(cwd: string, ui: PromptUI): Promise<ExtractionResult> {
  const detected = detectCustomSections(cwd);
  const result: ExtractionResult = { detected, extractedPolicies: [], extractedSkills: [], skipped: [] };
  if (detected.length === 0) return result;

  ui.note(
    'Found custom instructions in your agent files. You can promote them to reusable UAP policies (rules/gates) or skills (workflows).',
    'Extract custom content'
  );

  const chosen = await ui.multiselect<string>({
    message: 'Which custom sections to extract? (space to toggle, enter to confirm)',
    options: detected.map((s) => ({
      label: `${s.title}  ·  ${s.sourceFile}`,
      value: s.slug,
      hint: `suggested: ${s.classification}`,
    })),
    initialValues: detected.filter((s) => s.classification !== 'keep-inline').map((s) => s.slug),
    required: false,
  });

  const manifest = loadManifest(cwd);
  for (const s of detected) {
    if (!chosen.includes(s.slug)) {
      result.skipped.push(s.title);
      continue;
    }
    const target = await ui.select<Classification>({
      message: `Extract "${s.title}" as:`,
      options: [
        { label: 'Policy (a rule/gate UAP enforces)', value: 'policy' },
        { label: 'Skill (a workflow/how-to UAP can load)', value: 'skill' },
        { label: 'Skip (leave inline)', value: 'keep-inline' },
      ],
      initialValue: s.classification === 'keep-inline' ? 'skill' : s.classification,
    });
    if (target === 'policy') result.extractedPolicies.push(await emitPolicy(cwd, s));
    else if (target === 'skill') result.extractedSkills.push(emitSkill(cwd, s));
    else {
      result.skipped.push(s.title);
      continue;
    }
    manifest.add(s.key);
  }
  saveManifest(cwd, manifest);

  ui.note(
    `Policies: ${result.extractedPolicies.length} → policies/\nSkills: ${result.extractedSkills.length} → skills/\nSkipped: ${result.skipped.length}`,
    'Extraction complete'
  );
  return result;
}

/** True when there is at least one extractable custom section. */
export function hasExtractableContent(cwd: string): boolean {
  return detectCustomSections(cwd).length > 0;
}
