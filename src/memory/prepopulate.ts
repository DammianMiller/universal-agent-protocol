import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import type { MemoryEntry } from './backends/base.js';

export interface PrepopulateOptions {
  docs?: boolean;
  git?: boolean;
  skills?: boolean;
  limit?: number;
  since?: string;
  verbose?: boolean;
}

export interface PrepopulateResult {
  docsProcessed: number;
  gitCommitsProcessed: number;
  skillsDiscovered: number;
  artifactsDiscovered: number;
  memoriesCreated: number;
  errors: string[];
}

export interface DiscoveredSkill {
  name: string;
  path: string;
  type: 'droid' | 'skill' | 'command' | 'artifact';
  description?: string;
  platform: 'factory' | 'claude' | 'opencode' | 'generic';
}

interface ParsedDocument {
  path: string;
  title: string;
  sections: Array<{
    heading: string;
    content: string;
    type: 'setup' | 'architecture' | 'api' | 'troubleshooting' | 'general';
  }>;
}

interface GitCommit {
  hash: string;
  date: string;
  author: string;
  message: string;
  body: string;
  files: string[];
  type: 'fix' | 'feat' | 'refactor' | 'docs' | 'test' | 'chore' | 'revert' | 'other';
}

/**
 * Prepopulate memory from project documentation, git history, and skills/artifacts
 */
export async function prepopulateMemory(
  cwd: string,
  options: PrepopulateOptions = {}
): Promise<{ shortTerm: MemoryEntry[]; longTerm: MemoryEntry[]; skills: DiscoveredSkill[] }> {
  const shortTermMemories: MemoryEntry[] = [];
  const longTermMemories: MemoryEntry[] = [];
  const discoveredSkills: DiscoveredSkill[] = [];
  
  const doAll = !options.docs && !options.git && !options.skills;

  // Parse documentation
  if (doAll || options.docs) {
    const docs = await parseDocumentation(cwd, options.verbose);
    const docMemories = extractDocumentationMemories(docs);
    
    // Short-term: recent/important observations
    shortTermMemories.push(...docMemories.filter(m => m.importance && m.importance >= 7).slice(0, 20));
    
    // Long-term: all documentation memories
    longTermMemories.push(...docMemories);
  }

  // Extract git learnings
  if (doAll || options.git) {
    const commits = await extractGitHistory(cwd, options.limit || 500, options.since);
    const gitMemories = extractGitLearnings(commits);
    
    // Short-term: recent significant commits
    shortTermMemories.push(...gitMemories.filter(m => m.importance && m.importance >= 6).slice(0, 30));
    
    // Long-term: all git learnings
    longTermMemories.push(...gitMemories);
  }

  // Discover skills, droids, commands, and artifacts
  if (doAll || options.skills) {
    const skills = await discoverSkillsAndArtifacts(cwd, options.verbose);
    discoveredSkills.push(...skills);
    
    // Create memories for discovered skills
    const skillMemories = extractSkillMemories(skills);
    longTermMemories.push(...skillMemories);
    
    // Add important skills to short-term
    shortTermMemories.push(...skillMemories.filter(m => m.importance && m.importance >= 7).slice(0, 10));
  }

  return { shortTerm: shortTermMemories, longTerm: longTermMemories, skills: discoveredSkills };
}

/**
 * Parse all documentation files in the project
 */
export async function parseDocumentation(cwd: string, verbose = false): Promise<ParsedDocument[]> {
  const docs: ParsedDocument[] = [];
  
  // Documentation file patterns to search for
  const docPatterns = [
    'README.md',
    'README.txt',
    'README',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'ARCHITECTURE.md',
    'DEVELOPMENT.md',
    'SECURITY.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/ISSUE_TEMPLATE.md',
  ];

  // Parse root-level docs
  for (const pattern of docPatterns) {
    const docPath = join(cwd, pattern);
    if (existsSync(docPath)) {
      const doc = parseMarkdownFile(docPath, cwd);
      if (doc) {
        docs.push(doc);
        if (verbose) console.log(`  Parsed: ${pattern}`);
      }
    }
  }

  // Parse docs/ directory
  const docsDir = join(cwd, 'docs');
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
    const docFiles = findMarkdownFiles(docsDir);
    for (const docFile of docFiles) {
      const doc = parseMarkdownFile(docFile, cwd);
      if (doc) {
        docs.push(doc);
        if (verbose) console.log(`  Parsed: ${relative(cwd, docFile)}`);
      }
    }
  }

  // Parse ADRs (Architecture Decision Records)
  const adrDirs = ['docs/adr', 'docs/decisions', 'adr', 'decisions'];
  for (const adrDir of adrDirs) {
    const adrPath = join(cwd, adrDir);
    if (existsSync(adrPath) && statSync(adrPath).isDirectory()) {
      const adrFiles = findMarkdownFiles(adrPath);
      for (const adrFile of adrFiles) {
        const doc = parseMarkdownFile(adrFile, cwd, 'adr');
        if (doc) {
          docs.push(doc);
          if (verbose) console.log(`  Parsed ADR: ${relative(cwd, adrFile)}`);
        }
      }
    }
  }

  return docs;
}

/**
 * Extract git commit history with details
 */
export async function extractGitHistory(
  cwd: string,
  limit = 500,
  since?: string
): Promise<GitCommit[]> {
  const commits: GitCommit[] = [];

  try {
    // Check if it's a git repo
    execSync('git rev-parse --git-dir', { cwd, encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    return commits; // Not a git repo
  }

  // Build git log command
  let gitCmd = `git log --pretty=format:"%H|%aI|%an|%s|%b<<<END>>>" -n ${limit}`;
  if (since) {
    gitCmd += ` --since="${since}"`;
  }

  try {
    const output = execSync(gitCmd, { cwd, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    const commitStrings = output.split('<<<END>>>').filter(s => s.trim());

    for (const commitStr of commitStrings) {
      const parts = commitStr.trim().split('|');
      if (parts.length < 4) continue;

      const [hash, date, author, ...rest] = parts;
      const messageAndBody = rest.join('|');
      const [message, ...bodyParts] = messageAndBody.split('\n');
      const body = bodyParts.join('\n').trim();

      // Get files changed in this commit
      let files: string[] = [];
      try {
        const filesOutput = execSync(`git diff-tree --no-commit-id --name-only -r ${hash}`, {
          cwd,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        files = filesOutput.trim().split('\n').filter(f => f);
      } catch {
        // Ignore errors getting file list
      }

      // Determine commit type from conventional commit format
      const type = categorizeCommit(message);

      commits.push({
        hash: hash.trim(),
        date: date.trim(),
        author: author.trim(),
        message: message.trim(),
        body,
        files,
        type,
      });
    }
  } catch (error) {
    // Git command failed, return empty
    console.warn('Failed to extract git history:', error);
  }

  return commits;
}

/**
 * Convert documentation into memory entries
 */
export function extractDocumentationMemories(docs: ParsedDocument[]): MemoryEntry[] {
  const memories: MemoryEntry[] = [];
  const now = new Date().toISOString();

  for (const doc of docs) {
    for (const section of doc.sections) {
      // Skip empty or very short sections
      if (!section.content || section.content.length < 50) continue;

      // Chunk large sections
      const chunks = chunkContent(section.content, 500);
      
      for (let i = 0; i < chunks.length; i++) {
        const memoryType = mapSectionToMemoryType(section.type);
        const importance = calculateDocImportance(section, doc.path);

        memories.push({
          id: `doc-${basename(doc.path, extname(doc.path))}-${section.heading.toLowerCase().replace(/\s+/g, '-')}-${i}`,
          timestamp: now,
          type: memoryType,
          content: chunks[i],
          tags: extractTags(section, doc.path),
          importance,
          metadata: {
            source: 'documentation',
            file: doc.path,
            section: section.heading,
            docTitle: doc.title,
          },
        });
      }
    }
  }

  return memories;
}

/**
 * Convert git history into memory entries with learnings
 */
export function extractGitLearnings(commits: GitCommit[]): MemoryEntry[] {
  const memories: MemoryEntry[] = [];

  // Group commits by type for analysis
  const bugFixes = commits.filter(c => c.type === 'fix');
  const features = commits.filter(c => c.type === 'feat');
  const refactors = commits.filter(c => c.type === 'refactor');
  const reverts = commits.filter(c => c.type === 'revert');

  // Extract learnings from bug fixes
  for (const commit of bugFixes.slice(0, 50)) {
    const learning = extractBugFixLearning(commit);
    if (learning) {
      memories.push({
        id: `git-fix-${commit.hash.substring(0, 8)}`,
        timestamp: commit.date,
        type: 'observation',
        content: learning,
        tags: ['bug-fix', ...extractFileTags(commit.files)],
        importance: calculateCommitImportance(commit),
        metadata: {
          source: 'git',
          commit: commit.hash,
          author: commit.author,
          files: commit.files.slice(0, 10),
        },
      });
    }
  }

  // Extract learnings from features
  for (const commit of features.slice(0, 30)) {
    memories.push({
      id: `git-feat-${commit.hash.substring(0, 8)}`,
      timestamp: commit.date,
      type: 'observation',
      content: `Feature added: ${commit.message}${commit.body ? `. ${summarizeBody(commit.body)}` : ''}`,
      tags: ['feature', ...extractFileTags(commit.files)],
      importance: calculateCommitImportance(commit),
      metadata: {
        source: 'git',
        commit: commit.hash,
        author: commit.author,
        files: commit.files.slice(0, 10),
      },
    });
  }

  // Extract learnings from refactors (architectural decisions)
  for (const commit of refactors.slice(0, 20)) {
    memories.push({
      id: `git-refactor-${commit.hash.substring(0, 8)}`,
      timestamp: commit.date,
      type: 'thought',
      content: `Architectural change: ${commit.message}${commit.body ? `. Reasoning: ${summarizeBody(commit.body)}` : ''}`,
      tags: ['refactor', 'architecture', ...extractFileTags(commit.files)],
      importance: calculateCommitImportance(commit) + 1, // Refactors are usually important decisions
      metadata: {
        source: 'git',
        commit: commit.hash,
        author: commit.author,
        files: commit.files.slice(0, 10),
      },
    });
  }

  // Extract learnings from reverts (failed approaches)
  for (const commit of reverts) {
    memories.push({
      id: `git-revert-${commit.hash.substring(0, 8)}`,
      timestamp: commit.date,
      type: 'thought',
      content: `Failed approach reverted: ${commit.message}. This approach did not work - avoid similar changes.`,
      tags: ['revert', 'failed-approach', ...extractFileTags(commit.files)],
      importance: 8, // Reverts are always important learnings
      metadata: {
        source: 'git',
        commit: commit.hash,
        author: commit.author,
        files: commit.files.slice(0, 10),
      },
    });
  }

  // Identify hot spots (frequently modified files)
  const fileChangeCounts = new Map<string, number>();
  for (const commit of commits) {
    for (const file of commit.files) {
      fileChangeCounts.set(file, (fileChangeCounts.get(file) || 0) + 1);
    }
  }
  const hotSpots = [...fileChangeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .filter(([_, count]) => count >= 5);

  if (hotSpots.length > 0) {
    memories.push({
      id: 'git-hotspots',
      timestamp: new Date().toISOString(),
      type: 'observation',
      content: `Frequently modified files (hot spots): ${hotSpots.map(([f, c]) => `${f} (${c} changes)`).join(', ')}. These files may need extra attention during changes.`,
      tags: ['hot-spots', 'code-quality'],
      importance: 7,
      metadata: {
        source: 'git-analysis',
        hotSpots: Object.fromEntries(hotSpots),
      },
    });
  }

  return memories;
}

// Helper functions

function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      files.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))) {
      files.push(fullPath);
    }
  }
  
  return files;
}

function parseMarkdownFile(filePath: string, cwd: string, docType?: string): ParsedDocument | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const relativePath = relative(cwd, filePath);
    
    // Extract title from first heading or filename
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : basename(filePath, extname(filePath));

    // Split content by headings
    const sections: ParsedDocument['sections'] = [];
    const headingRegex = /^(#{1,3})\s+(.+)$/gm;
    let lastIndex = 0;
    let lastHeading = 'Introduction';
    let match;

    while ((match = headingRegex.exec(content)) !== null) {
      // Save previous section
      if (lastIndex > 0 || match.index > 0) {
        const sectionContent = content.slice(lastIndex, match.index).trim();
        if (sectionContent) {
          sections.push({
            heading: lastHeading,
            content: cleanMarkdown(sectionContent),
            type: categorizeSectionType(lastHeading, sectionContent, docType),
          });
        }
      }
      lastHeading = match[2];
      lastIndex = match.index + match[0].length;
    }

    // Add final section
    const finalContent = content.slice(lastIndex).trim();
    if (finalContent) {
      sections.push({
        heading: lastHeading,
        content: cleanMarkdown(finalContent),
        type: categorizeSectionType(lastHeading, finalContent, docType),
      });
    }

    return {
      path: relativePath,
      title,
      sections,
    };
  } catch {
    return null;
  }
}

function cleanMarkdown(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '[code block]') // Replace code blocks
    .replace(/`[^`]+`/g, (m) => m) // Keep inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Convert links to text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[image: $1]') // Simplify images
    .replace(/\n{3,}/g, '\n\n') // Normalize newlines
    .trim();
}

function categorizeSectionType(
  heading: string,
  content: string,
  docType?: string
): ParsedDocument['sections'][0]['type'] {
  const headingLower = heading.toLowerCase();
  const contentLower = content.toLowerCase();

  if (docType === 'adr') return 'architecture';
  
  if (
    headingLower.includes('install') ||
    headingLower.includes('setup') ||
    headingLower.includes('getting started') ||
    headingLower.includes('quickstart') ||
    headingLower.includes('prerequisites')
  ) {
    return 'setup';
  }

  if (
    headingLower.includes('architecture') ||
    headingLower.includes('design') ||
    headingLower.includes('structure') ||
    headingLower.includes('overview')
  ) {
    return 'architecture';
  }

  if (
    headingLower.includes('api') ||
    headingLower.includes('endpoint') ||
    headingLower.includes('reference')
  ) {
    return 'api';
  }

  if (
    headingLower.includes('troubleshoot') ||
    headingLower.includes('faq') ||
    headingLower.includes('common issues') ||
    headingLower.includes('known issues') ||
    contentLower.includes('if you encounter')
  ) {
    return 'troubleshooting';
  }

  return 'general';
}

function mapSectionToMemoryType(sectionType: string): MemoryEntry['type'] {
  switch (sectionType) {
    case 'architecture':
      return 'thought';
    case 'troubleshooting':
      return 'observation';
    default:
      return 'observation';
  }
}

function calculateDocImportance(
  section: ParsedDocument['sections'][0],
  filePath: string
): number {
  let importance = 5;

  // Boost README
  if (filePath.toLowerCase().includes('readme')) importance += 2;
  
  // Boost architecture docs
  if (section.type === 'architecture') importance += 1;
  
  // Boost setup/troubleshooting
  if (section.type === 'setup' || section.type === 'troubleshooting') importance += 1;
  
  // ADRs are important
  if (filePath.includes('adr') || filePath.includes('decision')) importance += 2;

  return Math.min(importance, 10);
}

function categorizeCommit(message: string): GitCommit['type'] {
  const msgLower = message.toLowerCase();
  
  if (msgLower.startsWith('revert')) return 'revert';
  if (msgLower.startsWith('fix:') || msgLower.startsWith('fix(') || msgLower.includes('bugfix')) return 'fix';
  if (msgLower.startsWith('feat:') || msgLower.startsWith('feat(') || msgLower.startsWith('feature')) return 'feat';
  if (msgLower.startsWith('refactor:') || msgLower.startsWith('refactor(')) return 'refactor';
  if (msgLower.startsWith('docs:') || msgLower.startsWith('docs(')) return 'docs';
  if (msgLower.startsWith('test:') || msgLower.startsWith('test(')) return 'test';
  if (msgLower.startsWith('chore:') || msgLower.startsWith('chore(')) return 'chore';
  
  return 'other';
}

function extractBugFixLearning(commit: GitCommit): string | null {
  const message = commit.message;
  const body = commit.body;
  
  // Try to extract what was fixed
  let learning = `Bug fixed: ${message}`;
  
  if (body) {
    // Look for "Fixes #123" or similar
    const issueMatch = body.match(/(?:fixes|closes|resolves)\s+#(\d+)/i);
    if (issueMatch) {
      learning += ` (Issue #${issueMatch[1]})`;
    }
    
    // Add summary of body if present
    const summary = summarizeBody(body);
    if (summary) {
      learning += `. ${summary}`;
    }
  }
  
  // Add affected files context
  if (commit.files.length > 0 && commit.files.length <= 5) {
    learning += ` Affected files: ${commit.files.join(', ')}.`;
  }
  
  return learning;
}

function summarizeBody(body: string): string {
  // Take first meaningful line of body
  const lines = body.split('\n').filter(l => l.trim() && !l.startsWith('Co-authored') && !l.startsWith('Signed-off'));
  if (lines.length === 0) return '';
  
  const firstLine = lines[0].trim();
  if (firstLine.length > 200) {
    return firstLine.substring(0, 200) + '...';
  }
  return firstLine;
}

function calculateCommitImportance(commit: GitCommit): number {
  let importance = 5;
  
  // Reverts are always important
  if (commit.type === 'revert') importance = 8;
  
  // Large changes are more significant
  if (commit.files.length > 10) importance += 1;
  
  // Changes to core files
  const coreFiles = commit.files.filter(f => 
    f.includes('config') || 
    f.includes('package.json') ||
    f.includes('index') ||
    f.includes('main') ||
    f.includes('app')
  );
  if (coreFiles.length > 0) importance += 1;
  
  // Has detailed body
  if (commit.body && commit.body.length > 50) importance += 1;
  
  return Math.min(importance, 10);
}

function extractFileTags(files: string[]): string[] {
  const tags = new Set<string>();
  
  for (const file of files.slice(0, 10)) {
    // Extract directory as tag
    const parts = file.split('/');
    if (parts.length > 1) {
      tags.add(parts[0]);
    }
    
    // Extract file type
    const ext = extname(file).toLowerCase();
    if (ext === '.ts' || ext === '.tsx') tags.add('typescript');
    if (ext === '.js' || ext === '.jsx') tags.add('javascript');
    if (ext === '.py') tags.add('python');
    if (ext === '.go') tags.add('go');
    if (ext === '.rs') tags.add('rust');
    if (ext === '.yml' || ext === '.yaml') tags.add('config');
    if (ext === '.json') tags.add('config');
    if (ext === '.md') tags.add('docs');
    
    // Special files
    if (file.includes('test') || file.includes('spec')) tags.add('tests');
    if (file.includes('docker') || file.includes('Dockerfile')) tags.add('docker');
    if (file.includes('terraform') || file.endsWith('.tf')) tags.add('terraform');
  }
  
  return [...tags].slice(0, 5);
}

function extractTags(section: ParsedDocument['sections'][0], filePath: string): string[] {
  const tags: string[] = [section.type];
  
  // Add source file as tag
  const fileName = basename(filePath, extname(filePath)).toLowerCase();
  if (fileName !== 'readme') {
    tags.push(fileName);
  }
  
  // Extract keywords from heading
  const keywords = section.heading.toLowerCase()
    .split(/[\s-_]+/)
    .filter(w => w.length > 3 && !['the', 'and', 'for', 'with'].includes(w));
  tags.push(...keywords.slice(0, 3));
  
  return [...new Set(tags)].slice(0, 5);
}

function chunkContent(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content];
  
  const chunks: string[] = [];
  const sentences = content.split(/(?<=[.!?])\s+/);
  let currentChunk = '';
  
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxLength) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }
  
  if (currentChunk) chunks.push(currentChunk.trim());
  
  return chunks;
}

/**
 * Discover skills, droids, commands, and artifacts from various platforms
 */
export async function discoverSkillsAndArtifacts(
  cwd: string,
  verbose = false
): Promise<DiscoveredSkill[]> {
  const skills: DiscoveredSkill[] = [];

  // Factory.ai droids, skills, and commands
  const factoryPaths = [
    { dir: '.factory/droids', type: 'droid' as const },
    { dir: '.factory/skills', type: 'skill' as const },
    { dir: '.factory/commands', type: 'command' as const },
  ];

  for (const { dir, type } of factoryPaths) {
    const fullPath = join(cwd, dir);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      const files = readdirSync(fullPath);
      for (const file of files) {
        if (file.endsWith('.md') || file.endsWith('.yaml') || file.endsWith('.yml')) {
          const filePath = join(fullPath, file);
          const skill = parseSkillFile(filePath, cwd, type, 'factory');
          if (skill) {
            skills.push(skill);
            if (verbose) console.log(`  Found Factory ${type}: ${skill.name}`);
          }
        }
      }
    }
  }

  // Claude Code agents and commands
  const claudePaths = [
    { dir: '.claude/agents', type: 'droid' as const },
    { dir: '.claude/commands', type: 'command' as const },
  ];

  for (const { dir, type } of claudePaths) {
    const fullPath = join(cwd, dir);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      const files = readdirSync(fullPath);
      for (const file of files) {
        if (file.endsWith('.md') || file.endsWith('.yaml') || file.endsWith('.yml')) {
          const filePath = join(fullPath, file);
          const skill = parseSkillFile(filePath, cwd, type, 'claude');
          if (skill) {
            skills.push(skill);
            if (verbose) console.log(`  Found Claude ${type}: ${skill.name}`);
          }
        }
      }
    }
  }

  // OpenCode agents and commands
  const opencodePaths = [
    { dir: '.opencode/agent', type: 'droid' as const },
    { dir: '.opencode/command', type: 'command' as const },
  ];

  for (const { dir, type } of opencodePaths) {
    const fullPath = join(cwd, dir);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      const files = readdirSync(fullPath);
      for (const file of files) {
        if (file.endsWith('.md') || file.endsWith('.yaml') || file.endsWith('.yml') || file.endsWith('.json')) {
          const filePath = join(fullPath, file);
          const skill = parseSkillFile(filePath, cwd, type, 'opencode');
          if (skill) {
            skills.push(skill);
            if (verbose) console.log(`  Found OpenCode ${type}: ${skill.name}`);
          }
        }
      }
    }
  }

  // Discover artifacts (reusable code patterns, templates)
  const artifactDirs = [
    'templates',
    'snippets',
    '.github/workflows',
    'scripts',
    'tools',
  ];

  for (const dir of artifactDirs) {
    const fullPath = join(cwd, dir);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      const files = readdirSync(fullPath).slice(0, 20); // Limit to avoid too many
      for (const file of files) {
        const filePath = join(fullPath, file);
        if (statSync(filePath).isFile()) {
          skills.push({
            name: basename(file, extname(file)),
            path: relative(cwd, filePath),
            type: 'artifact',
            description: `Reusable ${dir} artifact`,
            platform: 'generic',
          });
          if (verbose) console.log(`  Found artifact: ${file}`);
        }
      }
    }
  }

  return skills;
}

/**
 * Parse a skill/droid/command file to extract metadata
 */
function parseSkillFile(
  filePath: string,
  cwd: string,
  type: DiscoveredSkill['type'],
  platform: DiscoveredSkill['platform']
): DiscoveredSkill | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const fileName = basename(filePath, extname(filePath));
    let description = '';

    // Try to extract description from different formats
    if (filePath.endsWith('.md')) {
      // Extract first paragraph or heading
      const match = content.match(/^#\s+.+\n+(.+)/m);
      if (match) description = match[1].trim();
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      // Look for description field
      const match = content.match(/description:\s*['"]?([^'"\n]+)/i);
      if (match) description = match[1].trim();
    } else if (filePath.endsWith('.json')) {
      try {
        const json = JSON.parse(content);
        description = json.description || '';
      } catch {
        // Ignore JSON parse errors
      }
    }

    return {
      name: fileName,
      path: relative(cwd, filePath),
      type,
      description: description || `${platform} ${type}`,
      platform,
    };
  } catch {
    return null;
  }
}

/**
 * Convert discovered skills into memory entries
 */
export function extractSkillMemories(skills: DiscoveredSkill[]): MemoryEntry[] {
  const memories: MemoryEntry[] = [];
  const now = new Date().toISOString();

  // Group by type
  const droids = skills.filter(s => s.type === 'droid');
  const skillItems = skills.filter(s => s.type === 'skill');
  const commands = skills.filter(s => s.type === 'command');
  const artifacts = skills.filter(s => s.type === 'artifact');

  // Create memory for available droids/agents
  if (droids.length > 0) {
    memories.push({
      id: 'skills-droids-available',
      timestamp: now,
      type: 'observation',
      content: `Available AI agents/droids: ${droids.map(d => `${d.name} (${d.platform})`).join(', ')}. These can be invoked for specialized tasks.`,
      tags: ['droids', 'agents', 'capabilities'],
      importance: 8,
      metadata: {
        source: 'skills-discovery',
        droids: droids.map(d => ({ name: d.name, platform: d.platform, path: d.path })),
      },
    });
  }

  // Create memory for available skills
  if (skillItems.length > 0) {
    memories.push({
      id: 'skills-skills-available',
      timestamp: now,
      type: 'observation',
      content: `Available skills: ${skillItems.map(s => s.name).join(', ')}. These provide specialized capabilities.`,
      tags: ['skills', 'capabilities'],
      importance: 7,
      metadata: {
        source: 'skills-discovery',
        skills: skillItems.map(s => ({ name: s.name, platform: s.platform, path: s.path })),
      },
    });
  }

  // Create memory for available commands
  if (commands.length > 0) {
    memories.push({
      id: 'skills-commands-available',
      timestamp: now,
      type: 'observation',
      content: `Available slash commands: ${commands.map(c => `/${c.name}`).join(', ')}. Use these for quick actions.`,
      tags: ['commands', 'shortcuts'],
      importance: 7,
      metadata: {
        source: 'skills-discovery',
        commands: commands.map(c => ({ name: c.name, platform: c.platform, path: c.path })),
      },
    });
  }

  // Create memories for individual droids with descriptions
  for (const droid of droids) {
    if (droid.description && droid.description.length > 20) {
      memories.push({
        id: `skill-droid-${droid.name}`,
        timestamp: now,
        type: 'thought',
        content: `Droid "${droid.name}" (${droid.platform}): ${droid.description}. Located at ${droid.path}.`,
        tags: ['droid', droid.platform, droid.name],
        importance: 6,
        metadata: {
          source: 'skills-discovery',
          ...droid,
        },
      });
    }
  }

  // Create memory for useful artifacts/templates
  const usefulArtifacts = artifacts.filter(a =>
    a.path.includes('workflow') ||
    a.path.includes('template') ||
    a.path.includes('script')
  );
  if (usefulArtifacts.length > 0) {
    memories.push({
      id: 'skills-artifacts-available',
      timestamp: now,
      type: 'observation',
      content: `Useful project artifacts: ${usefulArtifacts.slice(0, 10).map(a => a.path).join(', ')}. These can be referenced or reused.`,
      tags: ['artifacts', 'templates', 'reusable'],
      importance: 5,
      metadata: {
        source: 'skills-discovery',
        artifacts: usefulArtifacts.map(a => a.path),
      },
    });
  }

  return memories;
}
