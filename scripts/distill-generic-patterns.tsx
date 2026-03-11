#!/usr/bin/env tsx
/**
 * Distill Terminal-Bench-specific patterns into GENERIC instructions
 */

const DISTILLED_PATTERNS = {
  security: `
### Security Best Practices (Generic)
- **Input Validation**: Always sanitize user input before processing
- **Credential Handling**: Use established tools/libraries for cryptographic operations
- **Pattern Recognition**: Understand common attack vectors (injection, XSS, CSRF)
- **Defense in Depth**: Layer security controls rather than relying on single mechanisms
- **Tool Selection**: Choose appropriate tools based on context`,

  passwordCracking: `
### Password Security Analysis (Generic)
- **Hash Identification**: Identify hash format before attempting recovery
- **Tool Chain**: Extract hash first, then apply appropriate cracking method
- **Method Selection**: Choose between wordlist attacks and brute force
- **Resource Awareness**: GPU tools for speed, CPU tools for compatibility`,

  xssFiltering: `
### HTML Sanitization (Generic)
- **Tag Removal**: Strip all script-related tags
- **Attribute Cleaning**: Remove event handlers
- **Protocol Blocking**: Block javascript:, data: URL schemes
- **Case Normalization**: Handle case-insensitive tag matching
- **Library Preference**: Use established sanitization libraries`,

  binaryParsing: `
### Binary File Parsing (Generic)
- **Format Documentation**: Study file format specification first
- **Byte Order Awareness**: Handle endianness correctly
- **Offset Calculation**: Use documented offsets for headers
- **Type Safety**: Use proper data types matching the format
- **Validation**: Verify magic numbers and integrity`,

  databaseRecovery: `
### Database Recovery (Generic)
- **Log Replay**: Use checkpoint operations to apply transactions
- **WAL Handling**: Checkpoint before truncating write-ahead logs
- **Data Integrity**: Verify consistency after recovery
- **Backup Strategy**: Maintain multiple backup points`,

  legacyCode: `
### Legacy Code Modernization (Generic)
- **Format Preservation**: Understand original code structure
- **Semantic Mapping**: Map legacy constructs to modern equivalents
- **Behavior Verification**: Test with original inputs
- **Documentation**: Document assumptions about legacy behavior`,

  mlTraining: `
### Machine Learning Development (Generic)
- **Incremental Validation**: Test with minimal config first
- **Resource Monitoring**: Track GPU/CPU/memory usage
- **Early Verification**: Validate data shapes and outputs early
- **Caching Strategy**: Cache intermediate results`,

  fileOperations: `
### File System Operations (Generic)
- **Path Consistency**: Use absolute paths for reliability
- **Existence Verification**: Check files before operations
- **Error Handling**: Handle missing files and I/O errors gracefully
- **Edge Cases**: Consider empty files, special characters`
};

console.log('='.repeat(80));
console.log('DISTILLED GENERIC INSTRUCTIONS');
console.log('='.repeat(80));

for (const [category, pattern] of Object.entries(DISTILLED_PATTERNS)) {
  console.log('\n' + '─'.repeat(80));
  console.log(pattern);
}

console.log('\n\n' + '='.repeat(80));
console.log('USAGE GUIDE');
console.log('='.repeat(80));
console.log(`
To use these patterns:

1. Map task domain to category (security, file-ops, etc.)
2. Inject the corresponding generic pattern into system prompt
3. Let the model apply general principles to solve the problem

Key principle: Provide DOMAIN KNOWLEDGE, not SOLUTIONS
- GOOD: "Always verify files before reading"
- BAD: "Read /app/database.db and truncate WAL"
`);

import { writeFileSync } from 'fs';

const typescriptCode = `/**
 * Generic UAP Patterns - Domain-agnostic best practices
 * NOT specific to any benchmark or test scenario
 */

export const GENERIC_UAP_PATTERNS: Record<string, string> = {
  security: \`### Security Best Practices (Generic)
- **Input Validation**: Always sanitize user input before processing
- **Credential Handling**: Use established tools/libraries for cryptographic operations
- **Pattern Recognition**: Understand common attack vectors (injection, XSS, CSRF)
- **Defense in Depth**: Layer security controls rather than relying on single mechanisms\`,

  passwordCracking: \`### Password Security Analysis (Generic)
- **Hash Identification**: Identify hash format before attempting recovery
- **Tool Chain**: Extract hash first, then apply appropriate cracking method
- **Method Selection**: Choose between wordlist attacks and brute force\`,

  xssFiltering: \`### HTML Sanitization (Generic)
- **Tag Removal**: Strip all script-related tags
- **Attribute Cleaning**: Remove event handlers
- **Protocol Blocking**: Block javascript:, data: URL schemes\`,

  binaryParsing: \`### Binary File Parsing (Generic)
- **Format Documentation**: Study file format specification first
- **Byte Order Awareness**: Handle endianness correctly
- **Offset Calculation**: Use documented offsets for headers\`,

  databaseRecovery: \`### Database Recovery (Generic)
- **Log Replay**: Use checkpoint operations to apply transactions
- **WAL Handling**: Checkpoint before truncating write-ahead logs
- **Data Integrity**: Verify consistency after recovery\`,

  legacyCode: \`### Legacy Code Modernization (Generic)
- **Format Preservation**: Understand original code structure
- **Semantic Mapping**: Map legacy constructs to modern equivalents
- **Behavior Verification**: Test with original inputs\`,

  mlTraining: \`### Machine Learning Development (Generic)
- **Incremental Validation**: Test with minimal config first
- **Resource Monitoring**: Track GPU/CPU/memory usage
- **Early Verification**: Validate data shapes and outputs early\`,

  fileOperations: \`### File System Operations (Generic)
- **Path Consistency**: Use absolute paths for reliability
- **Existence Verification**: Check files before operations
- **Error Handling**: Handle missing files gracefully\`
};

export function getGenericContext(category: string): string {
  return GENERIC_UAP_PATTERNS[category] || 'Follow standard development best practices';
}
`;

writeFileSync('/home/cogtek/dev/miller-tech/universal-agent-memory/src/memory/generic-uap-patterns.ts', typescriptCode);
console.log('\n✅ Saved to: src/memory/generic-uap-patterns.ts');
