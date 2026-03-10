import Handlebars from 'handlebars';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ProjectAnalysis } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Template section identifiers for lazy loading.
 */
export type TemplateSection =
  | 'header'
  | 'directives'
  | 'session-start'
  | 'coordination'
  | 'decision-loop'
  | 'memory-system'
  | 'worktree'
  | 'parallel-review'
  | 'triggers'
  | 'repository'
  | 'architecture'
  | 'components'
  | 'auth'
  | 'quick-reference'
  | 'skills-droids'
  | 'infrastructure'
  | 'testing'
  | 'troubleshooting'
  | 'config-files'
  | 'checklist'
  | 'knowledge'
  | 'footer';

/**
 * Section metadata for conditional loading.
 */
export interface SectionMetadata {
  id: TemplateSection;
  file: string;
  required: boolean;
  dependencies?: TemplateSection[];
  condition?: (analysis: ProjectAnalysis) => boolean;
  tokenEstimate: number; // Approximate token count
}

/**
 * Default section definitions.
 */
export const DEFAULT_SECTIONS: SectionMetadata[] = [
  { id: 'header', file: 'header.hbs', required: true, tokenEstimate: 50 },
  { id: 'directives', file: 'directives.hbs', required: true, tokenEstimate: 200 },
  { id: 'session-start', file: 'session-start.hbs', required: true, tokenEstimate: 150 },
  { id: 'coordination', file: 'coordination.hbs', required: true, tokenEstimate: 400 },
  { id: 'decision-loop', file: 'decision-loop.hbs', required: true, tokenEstimate: 300 },
  { id: 'memory-system', file: 'memory-system.hbs', required: true, tokenEstimate: 500 },
  { id: 'worktree', file: 'worktree.hbs', required: true, tokenEstimate: 200 },
  { id: 'parallel-review', file: 'parallel-review.hbs', required: true, tokenEstimate: 250 },
  { id: 'triggers', file: 'triggers.hbs', required: true, tokenEstimate: 150 },
  { 
    id: 'repository', 
    file: 'repository.hbs', 
    required: false, 
    condition: (a) => !!a.components?.length,
    tokenEstimate: 300 
  },
  { 
    id: 'architecture', 
    file: 'architecture.hbs', 
    required: false, 
    condition: (analysis) => !!analysis.infrastructure?.iac || analysis.components?.length > 3,
    tokenEstimate: 400 
  },
  { 
    id: 'components', 
    file: 'components.hbs', 
    required: false, 
    condition: (a) => (a.components?.length || 0) > 0,
    tokenEstimate: 300 
  },
  { 
    id: 'auth', 
    file: 'auth.hbs', 
    required: false, 
    condition: (a) => !!a.authentication,
    tokenEstimate: 200 
  },
  { id: 'quick-reference', file: 'quick-reference.hbs', required: false, tokenEstimate: 250 },
  { 
    id: 'skills-droids', 
    file: 'skills-droids.hbs', 
    required: false, 
    condition: () => existsSync(join(process.cwd(), '.factory/skills')) || existsSync(join(process.cwd(), '.factory/droids')),
    tokenEstimate: 400 
  },
  { 
    id: 'infrastructure', 
    file: 'infrastructure.hbs', 
    required: false, 
    condition: (analysis) => (analysis.directories?.infrastructure?.length || 0) > 0,
    tokenEstimate: 300 
  },
  { id: 'testing', file: 'testing.hbs', required: false, tokenEstimate: 150 },
  { 
    id: 'troubleshooting', 
    file: 'troubleshooting.hbs', 
    required: false, 
    condition: () => false, // Only include if explicitly requested
    tokenEstimate: 300 
  },
  { id: 'config-files', file: 'config-files.hbs', required: false, tokenEstimate: 200 },
  { id: 'checklist', file: 'checklist.hbs', required: true, tokenEstimate: 100 },
  { 
    id: 'knowledge', 
    file: 'knowledge.hbs', 
    required: false, 
    condition: () => false, // Only include if memory has content
    tokenEstimate: 400 
  },
  { id: 'footer', file: 'footer.hbs', required: true, tokenEstimate: 20 },
];

/**
 * Template loading configuration.
 */
export interface TemplateLoaderConfig {
  sectionsDir?: string;
  maxTokens?: number;
  includeSections?: TemplateSection[];
  excludeSections?: TemplateSection[];
  forceInclude?: TemplateSection[];
}

/**
 * Modular template loader with lazy-loading support.
 */
export class TemplateLoader {
  private sectionsDir: string;
  private maxTokens: number;
  private sections: SectionMetadata[];
  private compiledSections: Map<TemplateSection, Handlebars.TemplateDelegate>;
  private analysis: ProjectAnalysis | null = null;

  constructor(config: TemplateLoaderConfig = {}) {
    this.sectionsDir = config.sectionsDir || this.findSectionsDir();
    this.maxTokens = config.maxTokens || 8000; // Conservative default
    this.sections = [...DEFAULT_SECTIONS];
    this.compiledSections = new Map();

    // Apply include/exclude filters
    if (config.includeSections) {
      this.sections = this.sections.filter(s => 
        s.required || config.includeSections!.includes(s.id)
      );
    }
    if (config.excludeSections) {
      this.sections = this.sections.filter(s => 
        s.required || !config.excludeSections!.includes(s.id)
      );
    }
    if (config.forceInclude) {
      for (const id of config.forceInclude) {
        const existing = this.sections.find(s => s.id === id);
        if (existing) {
          existing.required = true;
        }
      }
    }

    this.registerHelpers();
  }

  /**
   * Find the sections directory.
   */
  private findSectionsDir(): string {
    const locations = [
      join(process.cwd(), 'templates/sections'),
      join(__dirname, '../../templates/sections'),
    ];

    for (const loc of locations) {
      if (existsSync(loc)) {
        return loc;
      }
    }

    // Fall back to main template if no sections exist
    return join(__dirname, '../../templates');
  }

  /**
   * Register Handlebars helpers.
   */
  private registerHelpers(): void {
    // Conditional section helper
    Handlebars.registerHelper('section', (sectionId: string, options: Handlebars.HelperOptions) => {
      const section = this.sections.find(s => s.id === sectionId);
      if (!section) return '';
      
      if (!this.shouldIncludeSection(section)) {
        return '';
      }
      
      return options.fn(this);
    });

    // Token budget helper
    Handlebars.registerHelper('withinBudget', (tokens: number, options: Handlebars.HelperOptions) => {
      if (this.getRemainingTokenBudget() >= tokens) {
        return options.fn(this);
      }
      return options.inverse(this);
    });
  }

  /**
   * Set the project analysis for conditional loading.
   */
  setAnalysis(analysis: ProjectAnalysis): void {
    this.analysis = analysis;
  }

  /**
   * Check if a section should be included based on conditions.
   */
  private shouldIncludeSection(section: SectionMetadata): boolean {
    if (section.required) return true;
    
    if (section.condition && this.analysis) {
      return section.condition(this.analysis);
    }
    
    return true; // Include by default if no condition
  }

  /**
   * Get sections that should be included.
   */
  getIncludedSections(): SectionMetadata[] {
    return this.sections.filter(s => this.shouldIncludeSection(s));
  }

  /**
   * Estimate total tokens for included sections.
   */
  estimateTotalTokens(): number {
    return this.getIncludedSections()
      .reduce((sum, s) => sum + s.tokenEstimate, 0);
  }

  /**
   * Get remaining token budget.
   */
  getRemainingTokenBudget(): number {
    return this.maxTokens - this.estimateTotalTokens();
  }

  /**
   * Load and compile a section template.
   */
  loadSection(sectionId: TemplateSection): Handlebars.TemplateDelegate | null {
    if (this.compiledSections.has(sectionId)) {
      return this.compiledSections.get(sectionId)!;
    }

    const section = this.sections.find(s => s.id === sectionId);
    if (!section) return null;

    const filePath = join(this.sectionsDir, section.file);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const compiled = Handlebars.compile(content);
      this.compiledSections.set(sectionId, compiled);
      return compiled;
    } catch {
      return null;
    }
  }

  /**
   * Load all sections and assemble the full template.
   */
  loadFullTemplate(): string {
    // Check if sections directory exists
    if (!existsSync(this.sectionsDir) || !this.hasSectionFiles()) {
      // Fall back to monolithic template
      return this.loadMonolithicTemplate();
    }

    const parts: string[] = [];
    
    for (const section of this.getIncludedSections()) {
      const filePath = join(this.sectionsDir, section.file);
      if (existsSync(filePath)) {
        parts.push(readFileSync(filePath, 'utf-8'));
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Check if section files exist.
   */
  private hasSectionFiles(): boolean {
    try {
      const files = readdirSync(this.sectionsDir);
      return files.some(f => f.endsWith('.hbs'));
    } catch {
      return false;
    }
  }

  /**
   * Load the monolithic template as fallback.
   */
  private loadMonolithicTemplate(): string {
    const locations = [
      join(process.cwd(), 'templates/CLAUDE.template.md'),
      join(__dirname, '../../templates/CLAUDE.template.md'),
    ];

    for (const loc of locations) {
      if (existsSync(loc)) {
        return readFileSync(loc, 'utf-8');
      }
    }

    throw new Error('No template found');
  }

  /**
   * Compile the full template with context.
   */
  compile(context: Record<string, unknown>): string {
    const template = this.loadFullTemplate();
    const compiled = Handlebars.compile(template);
    return compiled(context);
  }

  /**
   * Get a summary of what will be included.
   */
  getSummary(): {
    includedSections: string[];
    excludedSections: string[];
    estimatedTokens: number;
    withinBudget: boolean;
  } {
    const included = this.getIncludedSections().map(s => s.id);
    const excluded = this.sections
      .filter(s => !this.shouldIncludeSection(s))
      .map(s => s.id);
    const estimatedTokens = this.estimateTotalTokens();

    return {
      includedSections: included,
      excludedSections: excluded,
      estimatedTokens,
      withinBudget: estimatedTokens <= this.maxTokens,
    };
  }
}

/**
 * Create section template files from the monolithic template.
 * This is a one-time migration utility.
 */
export async function splitTemplateIntoSections(
  templatePath: string,
  outputDir: string
): Promise<void> {
  // This would be implemented to parse the monolithic template
  // and split it into section files based on markers.
  // For now, we use the monolithic template directly.
  console.log(`Would split ${templatePath} into sections at ${outputDir}`);
}
