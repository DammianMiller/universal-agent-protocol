/**
 * Generic UAP Patterns - Domain-agnostic best practices
 * NOT specific to any benchmark or test scenario
 */

export const GENERIC_UAP_PATTERNS: Record<string, string> = {
  security: `### Security Best Practices (Generic)
- **Input Validation**: Always sanitize user input before processing
- **Credential Handling**: Use established tools/libraries for cryptographic operations
- **Pattern Recognition**: Understand common attack vectors (injection, XSS, CSRF)
- **Defense in Depth**: Layer security controls rather than relying on single mechanisms`,

  passwordCracking: `### Password Security Analysis (Generic)
- **Hash Identification**: Identify hash format before attempting recovery
- **Tool Chain**: Extract hash first, then apply appropriate cracking method
- **Method Selection**: Choose between wordlist attacks and brute force`,

  xssFiltering: `### HTML Sanitization (Generic)
- **Tag Removal**: Strip all script-related tags
- **Attribute Cleaning**: Remove event handlers
- **Protocol Blocking**: Block javascript:, data: URL schemes`,

  binaryParsing: `### Binary File Parsing (Generic)
- **Format Documentation**: Study file format specification first
- **Byte Order Awareness**: Handle endianness correctly
- **Offset Calculation**: Use documented offsets for headers`,

  databaseRecovery: `### Database Recovery (Generic)
- **Log Replay**: Use checkpoint operations to apply transactions
- **WAL Handling**: Checkpoint before truncating write-ahead logs
- **Data Integrity**: Verify consistency after recovery`,

  legacyCode: `### Legacy Code Modernization (Generic)
- **Format Preservation**: Understand original code structure
- **Semantic Mapping**: Map legacy constructs to modern equivalents
- **Behavior Verification**: Test with original inputs`,

  mlTraining: `### Machine Learning Development (Generic)
- **Incremental Validation**: Test with minimal config first
- **Resource Monitoring**: Track GPU/CPU/memory usage
- **Early Verification**: Validate data shapes and outputs early`,

  fileOperations: `### File System Operations (Generic)
- **Path Consistency**: Use absolute paths for reliability
- **Existence Verification**: Check files before operations
- **Error Handling**: Handle missing files gracefully`
};

export function getGenericContext(category: string): string {
  return GENERIC_UAP_PATTERNS[category] || 'Follow standard development best practices';
}
