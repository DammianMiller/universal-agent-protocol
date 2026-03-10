/**
 * Intelligent merge of existing CLAUDE.md with newly generated content
 * 
 * Strategy:
 * - Preserves user customizations in standard sections
 * - Extracts valuable content from existing file
 * - Places extracted content in appropriate new sections
 * - Never loses information
 */

interface Section {
  title: string;
  content: string;
  emoji?: string;
  startLine: number;
  endLine: number;
}

interface ExtractedContent {
  customSections: Section[];
  troubleshooting: string[];
  urls: string[];
  commands: string[];
  configFiles: string[];
  workflows: string[];
  clusters: string[];
  gotchas: string[];
  lessons: string[];
}

/**
 * Parse markdown content into sections
 */
function parseSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let currentSection: Section | null = null;
  let currentContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match ## headings, capturing optional emoji
    const heading = line.match(/^##\s+([🔴⚡🤖📋🧠🌳🚀📁🏗️🔧🗄️🔐✅🔄📊⚙️🧪🏭⛔]\s*)?(.+)$/);

    if (heading) {
      if (currentSection) {
        currentSection.content = currentContent.join('\n').trim();
        currentSection.endLine = i - 1;
        sections.push(currentSection);
      }

      currentSection = {
        title: heading[2].trim(),
        emoji: heading[1]?.trim(),
        content: '',
        startLine: i,
        endLine: i,
      };
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    currentSection.content = currentContent.join('\n').trim();
    currentSection.endLine = lines.length - 1;
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Extract preamble (content before first ## heading)
 */
function extractPreamble(content: string): string {
  const lines = content.split('\n');
  const preamble: string[] = [];

  for (const line of lines) {
    if (line.match(/^##\s+/)) {
      break;
    }
    preamble.push(line);
  }

  return preamble.join('\n').trim();
}

/**
 * Standard sections managed by the template (will be replaced)
 */
const STANDARD_SECTIONS = new Set([
  'DIRECTIVE HIERARCHY',
  'SESSION START PROTOCOL',
  'MULTI-AGENT COORDINATION PROTOCOL',
  'MANDATORY DECISION LOOP',
  'MEMORY SYSTEM',
  'FOUR-LAYER MEMORY SYSTEM',
  'WORKTREE WORKFLOW',
  'PARALLEL REVIEW PROTOCOL',
  'AUTOMATIC TRIGGERS',
  'REPOSITORY STRUCTURE',
  'COMPLETION PROTOCOL',
  'COMPLETION CHECKLIST',
]);

/**
 * Sections that contain extractable content (we'll merge content intelligently)
 */
const EXTRACTABLE_SECTIONS = new Set([
  'TROUBLESHOOTING',
  'QUICK REFERENCE',
  'CONFIG FILES',
  'ARCHITECTURE',
  'COMPONENTS',
  'DATABASE',
  'AUTHENTICATION',
  'PROJECT KNOWLEDGE',
  'INFRASTRUCTURE',
]);

function normalizeTitle(title: string): string {
  return title.toUpperCase()
    .replace(/[🔴⚡🤖📋🧠🌳🚀📁🏗️🔧🗄️🔐✅🔄📊⚙️🧪🏭⛔]/g, '')
    .trim();
}

function isStandardSection(title: string): boolean {
  const normalized = normalizeTitle(title);
  for (const std of STANDARD_SECTIONS) {
    if (normalized.includes(std) || std.includes(normalized)) {
      return true;
    }
  }
  return false;
}

function isExtractableSection(title: string): boolean {
  const normalized = normalizeTitle(title);
  for (const ext of EXTRACTABLE_SECTIONS) {
    if (normalized.includes(ext) || ext.includes(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract valuable content from existing sections
 */
function extractContent(sections: Section[]): ExtractedContent {
  const result: ExtractedContent = {
    customSections: [],
    troubleshooting: [],
    urls: [],
    commands: [],
    configFiles: [],
    workflows: [],
    clusters: [],
    gotchas: [],
    lessons: [],
  };

  for (const section of sections) {
    const normalized = normalizeTitle(section.title);
    const content = section.content;

    // Completely custom sections - preserve entirely
    if (!isStandardSection(section.title) && !isExtractableSection(section.title)) {
      result.customSections.push(section);
      continue;
    }

    // Extract troubleshooting entries (table rows)
    if (normalized.includes('TROUBLESHOOTING')) {
      const tableRows = content.match(/^\|[^|]+\|[^|]+\|$/gm) || [];
      for (const row of tableRows) {
        if (!row.includes('---') && !row.toLowerCase().includes('symptom') && !row.toLowerCase().includes('solution')) {
          result.troubleshooting.push(row);
        }
      }
    }

    // Extract URLs
    if (normalized.includes('QUICK REFERENCE') || normalized.includes('URL')) {
      const urls = content.match(/https?:\/\/[^\s)>]+/g) || [];
      result.urls.push(...urls.filter(u => !u.includes('img.shields.io')));
    }

    // Extract kubectl contexts/clusters
    if (content.includes('kubectl config use-context')) {
      const contexts = content.match(/kubectl config use-context\s+\S+.*$/gm) || [];
      result.clusters.push(...contexts);
    }

    // Extract workflow files
    if (content.includes('.yml') || content.includes('.yaml')) {
      const workflows = content.match(/├──\s+[\w-]+\.ya?ml.*$/gm) || [];
      result.workflows.push(...workflows);
    }

    // Extract config file entries
    if (normalized.includes('CONFIG')) {
      const configRows = content.match(/^\|\s*`[^`]+`\s*\|[^|]+\|$/gm) || [];
      result.configFiles.push(...configRows);
    }

    // Extract gotchas
    if (normalized.includes('GOTCHA') || content.includes('⚠️')) {
      const gotchas = content.match(/^-?\s*⚠️.*$/gm) || [];
      result.gotchas.push(...gotchas);
    }

    // Extract lessons
    if (normalized.includes('LESSON') || normalized.includes('KNOWLEDGE')) {
      const lessons = content.match(/^-\s+\*\*[^*]+\*\*:.*$/gm) || [];
      result.lessons.push(...lessons);
    }
  }

  return result;
}

/**
 * Inject extracted content into appropriate sections of new content
 */
function injectExtractedContent(newSections: Section[], extracted: ExtractedContent): Section[] {
  const result = [...newSections];

  for (const section of result) {
    const normalized = normalizeTitle(section.title);

    // Inject troubleshooting entries
    if (normalized.includes('TROUBLESHOOTING') && extracted.troubleshooting.length > 0) {
      const existingRows = section.content.match(/^\|[^|]+\|[^|]+\|$/gm) || [];
      const existingSet = new Set(existingRows.map(r => r.toLowerCase()));
      const newRows = extracted.troubleshooting.filter(r => !existingSet.has(r.toLowerCase()));
      
      if (newRows.length > 0) {
        // Find table end and append
        const tableMatch = section.content.match(/(^\|.*\|$\n?)+/m);
        if (tableMatch) {
          const tableEnd = tableMatch.index! + tableMatch[0].length;
          section.content = 
            section.content.slice(0, tableEnd) + 
            newRows.join('\n') + '\n' +
            section.content.slice(tableEnd);
        }
      }
    }

    // Inject URLs
    if (normalized.includes('QUICK REFERENCE') && extracted.urls.length > 0) {
      const existingUrls = new Set((section.content.match(/https?:\/\/[^\s)>]+/g) || []).map(u => u.toLowerCase()));
      const newUrls = extracted.urls.filter(u => !existingUrls.has(u.toLowerCase()));
      
      if (newUrls.length > 0 && !section.content.includes('### URLs')) {
        section.content += '\n\n### URLs\n' + newUrls.map(u => `- ${u}`).join('\n');
      }
    }

    // Inject clusters
    if (normalized.includes('QUICK REFERENCE') && extracted.clusters.length > 0) {
      if (!section.content.includes('kubectl config use-context')) {
        section.content += '\n\n### Clusters\n```bash\n' + extracted.clusters.join('\n') + '\n```';
      }
    }

    // Inject workflows  
    if (normalized.includes('QUICK REFERENCE') && extracted.workflows.length > 0) {
      const existingWorkflows = new Set((section.content.match(/[\w-]+\.ya?ml/g) || []).map(w => w.toLowerCase()));
      const newWorkflows = extracted.workflows.filter(w => {
        const match = w.match(/[\w-]+\.ya?ml/);
        return match && !existingWorkflows.has(match[0].toLowerCase());
      });
      
      if (newWorkflows.length > 0 && !section.content.includes('### Workflows')) {
        section.content += '\n\n### Workflows\n```\n' + newWorkflows.join('\n') + '\n```';
      }
    }

    // Inject config files
    if (normalized.includes('CONFIG') && extracted.configFiles.length > 0) {
      const existingFiles = new Set((section.content.match(/`[^`]+`/g) || []).map(f => f.toLowerCase()));
      const newFiles = extracted.configFiles.filter(f => {
        const match = f.match(/`([^`]+)`/);
        return match && !existingFiles.has(match[0].toLowerCase());
      });
      
      if (newFiles.length > 0) {
        section.content += '\n' + newFiles.join('\n');
      }
    }

    // Inject gotchas into Project Knowledge
    if (normalized.includes('PROJECT KNOWLEDGE') || normalized.includes('GOTCHA')) {
      if (extracted.gotchas.length > 0 && !section.content.includes('### Gotchas')) {
        section.content += '\n\n### Gotchas\n' + extracted.gotchas.join('\n');
      }
    }

    // Inject lessons into Project Knowledge
    if (normalized.includes('PROJECT KNOWLEDGE') || normalized.includes('LESSON')) {
      if (extracted.lessons.length > 0 && !section.content.includes('### Lessons')) {
        section.content += '\n\n### Lessons\n' + extracted.lessons.join('\n');
      }
    }
  }

  return result;
}

/**
 * Merge existing CLAUDE.md content with newly generated content
 * 
 * Intelligent merge strategy:
 * 1. Use new template structure and preamble
 * 2. Replace standard sections with new versions
 * 3. Extract valuable content from existing file
 * 4. Inject extracted content into appropriate new sections
 * 5. Append completely custom sections at the end
 */
export function mergeClaudeMd(existingContent: string, newContent: string): string {
  const existingSections = parseSections(existingContent);
  const newSections = parseSections(newContent);
  const newPreamble = extractPreamble(newContent);

  // Extract valuable content from existing file
  const extracted = extractContent(existingSections);

  // Inject extracted content into new sections
  const mergedSections = injectExtractedContent(newSections, extracted);

  // Build final content
  const merged: string[] = [];
  merged.push(newPreamble);
  merged.push('');

  // Add all sections from new content (with injected data)
  for (const section of mergedSections) {
    const emoji = section.emoji ? `${section.emoji} ` : '';
    merged.push(`## ${emoji}${section.title}`);
    merged.push('');
    merged.push(section.content);
    merged.push('');
    merged.push('---');
    merged.push('');
  }

  // Append custom sections that weren't in the template
  if (extracted.customSections.length > 0) {
    merged.push('<!-- Custom Sections (preserved from existing file) -->');
    merged.push('');
    
    for (const section of extracted.customSections) {
      const emoji = section.emoji ? `${section.emoji} ` : '';
      merged.push(`## ${emoji}${section.title}`);
      merged.push('');
      merged.push(section.content);
      merged.push('');
      merged.push('---');
      merged.push('');
    }
  }

  // Clean up
  let result = merged.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.replace(/---\n*$/, '');
  result = result.trim();

  return result;
}

/**
 * Validate merge result - ensure no significant content was lost
 */
export function validateMerge(original: string, merged: string): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  
  // Check for URLs that might have been lost
  const originalUrls = new Set((original.match(/https?:\/\/[^\s)>]+/g) || []).filter(u => !u.includes('img.shields.io')));
  const mergedUrls = new Set((merged.match(/https?:\/\/[^\s)>]+/g) || []));
  
  for (const url of originalUrls) {
    if (!mergedUrls.has(url)) {
      warnings.push(`URL may be missing: ${url.slice(0, 50)}...`);
    }
  }

  // Check for kubectl contexts that might have been lost
  const originalContexts = original.match(/kubectl config use-context\s+\S+/g) || [];
  const mergedContexts = merged.match(/kubectl config use-context\s+\S+/g) || [];
  
  if (originalContexts.length > mergedContexts.length) {
    warnings.push(`Some kubectl contexts may be missing (had ${originalContexts.length}, now ${mergedContexts.length})`);
  }

  // Check for custom section headers
  const originalSections = parseSections(original);
  const mergedSections = parseSections(merged);
  const mergedTitles = new Set(mergedSections.map(s => normalizeTitle(s.title)));
  
  for (const section of originalSections) {
    if (!isStandardSection(section.title) && !mergedTitles.has(normalizeTitle(section.title))) {
      warnings.push(`Custom section may be missing: ${section.title}`);
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}
