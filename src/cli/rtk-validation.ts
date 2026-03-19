/**
 * RTK (Required Template Keys) Validation
 *
 * Validates that CLAUDE.md contains all mandatory sections required by
 * the UAP protocol. Replaces the v3.0.0 stub that always returned valid.
 *
 * Required sections are defined by the ENFORCEMENT_CHECKS comment in CLAUDE.md:
 * SESSION_START, DECISION_LOOP, MANDATORY_WORKTREE, PARALLEL_REVIEW,
 * SCHEMA_DIFF, GATES, RTK_INCLUDES, PATTERN_ROUTER, VALIDATE_PLAN
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface RTKValidationResult {
  valid: boolean;
  missing: string[];
  found: string[];
  warnings: string[];
}

/**
 * Mandatory sections that must appear in CLAUDE.md.
 * Each entry maps a check name to the heading/content pattern that satisfies it.
 */
const REQUIRED_SECTIONS: Record<string, { pattern: RegExp; description: string }> = {
  SESSION_START: {
    pattern: /## .*SESSION\s+START/i,
    description: 'Session initialization instructions',
  },
  DECISION_LOOP: {
    pattern: /## .*DECISION\s+LOOP/i,
    description: 'Six-step decision loop (READ/QUERY/THINK/ACT/RECORD)',
  },
  MANDATORY_WORKTREE: {
    pattern: /## .*WORKTREE\s+WORKFLOW|## .*Pre-Edit Worktree Gate/i,
    description: 'Worktree workflow enforcement',
  },
  PARALLEL_REVIEW: {
    pattern: /## .*PARALLEL\s+REVIEW/i,
    description: 'Parallel review protocol',
  },
  SCHEMA_DIFF: {
    pattern: /Schema\s+Diff\s+Gate|schema.diff/i,
    description: 'Schema diff gate for breaking changes',
  },
  GATES: {
    pattern: /## .*COMPLETION\s+GATES|## .*BLOCKING\s+PREREQUISITES/i,
    description: 'Completion gates (test, build, lint, deploy)',
  },
  PATTERN_ROUTER: {
    pattern: /## .*Pattern\s+Router/i,
    description: 'Pattern router configuration',
  },
  VERIFIER_FIRST: {
    pattern: /## .*VERIFIER.FIRST/i,
    description: 'Verifier-first protocol (baseline before changes)',
  },
  PRE_EDIT_BUILD: {
    pattern: /## .*Pre-Edit\s+Build\s+Gate/i,
    description: 'Pre-edit build gate enforcement',
  },
};

/**
 * Optional but recommended sections.
 */
const RECOMMENDED_SECTIONS: Record<string, { pattern: RegExp; description: string }> = {
  MEMORY_SYSTEM: {
    pattern: /## .*Memory|memory.*system/i,
    description: 'Memory system configuration',
  },
  BROWSER_USAGE: {
    pattern: /## .*Browser|browser.*usage/i,
    description: 'Browser automation guidelines',
  },
  TROUBLESHOOTING: {
    pattern: /## .*Troubleshoot/i,
    description: 'Troubleshooting section',
  },
};

/**
 * Validate that CLAUDE.md contains all required RTK sections.
 *
 * @param projectDir - Project root directory (defaults to cwd)
 * @returns Validation result with missing/found sections
 */
export function validateRTKIncludes(projectDir?: string): RTKValidationResult {
  const dir = projectDir || process.cwd();
  const claudeMdPath = join(dir, 'CLAUDE.md');

  if (!existsSync(claudeMdPath)) {
    return {
      valid: false,
      missing: Object.keys(REQUIRED_SECTIONS),
      found: [],
      warnings: ['CLAUDE.md not found in project root'],
    };
  }

  const content = readFileSync(claudeMdPath, 'utf-8');
  const missing: string[] = [];
  const found: string[] = [];
  const warnings: string[] = [];

  // Check required sections
  for (const [name, { pattern }] of Object.entries(REQUIRED_SECTIONS)) {
    if (pattern.test(content)) {
      found.push(name);
    } else {
      missing.push(name);
    }
  }

  // Check recommended sections (warnings only)
  for (const [name, { pattern, description: desc }] of Object.entries(RECOMMENDED_SECTIONS)) {
    if (!pattern.test(content)) {
      warnings.push(`Recommended section missing: ${name} (${desc})`);
    }
  }

  // Check for ENFORCEMENT_CHECKS comment
  const enforcementMatch = content.match(/ENFORCEMENT_CHECKS:\s*([A-Z_,\s]+)/);
  if (enforcementMatch) {
    const declaredChecks = enforcementMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    // Verify all declared checks have corresponding sections
    for (const check of declaredChecks) {
      if (!REQUIRED_SECTIONS[check] && !found.includes(check)) {
        warnings.push(`Declared enforcement check "${check}" has no matching section`);
      }
    }
  } else {
    warnings.push('No ENFORCEMENT_CHECKS comment found in CLAUDE.md');
  }

  // Check template version
  const versionMatch = content.match(/TEMPLATE_VERSION:\s*([\d.]+)/);
  if (!versionMatch) {
    warnings.push('No TEMPLATE_VERSION found in CLAUDE.md');
  }

  return {
    valid: missing.length === 0,
    missing,
    found,
    warnings,
  };
}

/**
 * Print RTK validation results to console.
 */
export function printRTKValidation(result: RTKValidationResult): void {
  if (result.valid) {
    console.log(`RTK Validation: PASSED (${result.found.length} sections verified)`);
  } else {
    console.log(`RTK Validation: FAILED (${result.missing.length} missing sections)`);
    console.log('\nMissing required sections:');
    for (const name of result.missing) {
      const section = REQUIRED_SECTIONS[name];
      console.log(`  - ${name}: ${section?.description || 'Unknown'}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}
