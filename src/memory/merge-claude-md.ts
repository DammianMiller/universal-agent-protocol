/**
 * Merge Claude MD Module for UAP
 *
 * Provides utilities for merging multiple Claude.md knowledge files
 * into a single consolidated document.
 */

export interface ClaudeMD {
  title: string;
  content: string;
  sections: Section[];
  metadata: Record<string, any>;
}

export interface Section {
  heading: string;
  level: number;
  content: string;
  children: Section[];
}

export interface MergeConfig {
  deduplicate: boolean;
  dedupThreshold: number;
  prioritySections: string[];
  maxSectionLength: number;
}

const DEFAULT_CONFIG: MergeConfig = {
  deduplicate: true,
  dedupThreshold: 0.85,
  prioritySections: ['Architecture', 'Setup', 'Configuration', 'Known Issues'],
  maxSectionLength: 10000,
};

/**
 * Merge multiple Claude.md files into one
 */
export function mergeClaudeMDs(
  files: Array<{ name: string; content: string }>,
  config: Partial<MergeConfig> = {}
): {
  merged: string;
  sections: Section[];
  stats: MergeStats;
} {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const stats: MergeStats = {
    filesProcessed: files.length,
    totalSections: 0,
    duplicatesRemoved: 0,
    finalLength: 0,
  };

  if (files.length === 0) {
    return {
      merged: '',
      sections: [],
      stats,
    };
  }

  // Parse all files
  const parsedFiles: Array<{ name: string; sections: Section[] }> = files.map((file) => ({
    name: file.name,
    sections: parseMarkdown(file.content),
  }));

  stats.totalSections = parsedFiles.reduce((sum, f) => sum + f.sections.length, 0);

  // Merge sections with deduplication
  const mergedSections: Section[] = [];
  const seenContents = new Set<string>();

  // Sort by priority
  const sortedFiles = [...parsedFiles].sort((a, b) => {
    const aPriority = countPrioritySections(a.sections, cfg.prioritySections);
    const bPriority = countPrioritySections(b.sections, cfg.prioritySections);
    return bPriority - aPriority;
  });

  for (const file of sortedFiles) {
    for (const section of file.sections) {
      if (!cfg.deduplicate || !seenContents.has(section.content)) {
        mergedSections.push(section);
        seenContents.add(section.content);
      } else {
        stats.duplicatesRemoved++;
      }
    }
  }

  // Build final document
  const merged = buildDocument(mergedSections, files[0].name.replace('.md', ''));
  stats.finalLength = merged.length;

  return {
    merged,
    sections: mergedSections,
    stats,
  };
}

/**
 * Merge stats interface
 */
export interface MergeStats {
  filesProcessed: number;
  totalSections: number;
  duplicatesRemoved: number;
  finalLength: number;
}

/**
 * Parse markdown content into sections
 */
function parseMarkdown(content: string): Section[] {
  const sections: Section[] = [];
  const lines = content.split('\n');
  let currentSection: Section | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      // Save previous section
      if (currentSection) {
        sections.push(currentSection);
      }

      // Start new section
      currentSection = {
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        content: '',
        children: [],
      };
    } else if (currentSection) {
      // Accumulate section content
      currentSection.content += line + '\n';
    }
  }

  // Don't forget the last section
  if (currentSection) {
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Count priority sections in a file
 */
function countPrioritySections(sections: Section[], prioritySections: string[]): number {
  return sections.filter((s) => prioritySections.some((p: string) => s.heading.includes(p))).length;
}

/**
 * Build markdown document from sections
 */
function buildDocument(sections: Section[], title: string): string {
  const lines = [`# ${title}\n`];

  for (const section of sections) {
    lines.push(`#${' '.repeat(section.level - 1)} ${section.heading}`);
    lines.push('');
    lines.push(section.content.trim());
    lines.push('');
  }

  return lines.join('\n').trim();
}
