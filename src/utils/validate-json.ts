import { z } from 'zod';

/**
 * Custom error class for application-level errors with detailed context.
 * Extends the built-in Error class to provide additional metadata.
 */
export class AppError extends Error {
  /** Error code for programmatic handling */
  readonly code: string;
  /** Additional context about the error */
  readonly context?: Record<string, unknown>;

  /**
   * Creates a new AppError instance.
   *
   * @param message - Human-readable error message
   * @param code - Error code for programmatic handling
   * @param context - Optional additional context
   */
  constructor(
    message: string,
    code: string,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.context = context;

    // Maintains proper stack trace for where error was thrown (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }
}

/**
 * Zod schema for validating that a value is valid JSON.
 * Accepts any valid JSON value (object, array, string, number, boolean, null).
 */
const jsonSchema = z.unknown();

/** Maximum number of characters of the original input to include in error context. */
const MAX_ERROR_CONTEXT_CHARS = 100;

/**
 * Validates that a string is valid JSON and parses it.
 *
 * Uses zod for runtime validation to ensure the input is a valid string
 * before attempting to parse. The parsed result is then validated
 * against a permissive schema that accepts any valid JSON value.
 *
 * @param input - The string to validate and parse as JSON
 * @returns The parsed JSON value (object, array, string, number, boolean, or null)
 * @throws AppError with code 'INVALID_JSON' if the string is not valid JSON
 *
 * @example
 * ```typescript
 * // Parse a valid JSON object
 * const obj = validateAndParseJSON('{"name": "test", "value": 42}');
 * // Returns: { name: "test", value: 42 }
 *
 * // Parse a valid JSON array
 * const arr = validateAndParseJSON('[1, 2, 3]');
 * // Returns: [1, 2, 3]
 *
 * // Invalid JSON throws AppError
 * try {
 *   validateAndParseJSON('{invalid}');
 * } catch (error) {
 *   if (error instanceof AppError) {
 *     console.log(error.code); // 'INVALID_JSON'
 *   }
 * }
 * ```
 */
export function validateAndParseJSON(input: string): unknown {
  const jsonStringSchema = z
    .string({
      required_error: 'Input is required',
      invalid_type_error: 'Input must be a string',
    })
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            error instanceof Error
              ? `Invalid JSON: ${error.message}`
              : 'Invalid JSON',
        });
        return z.NEVER;
      }
    })
    .pipe(jsonSchema);

  const result = jsonStringSchema.safeParse(input);

  if (!result.success) {
    throw new AppError('Input must be valid JSON', 'INVALID_JSON', {
      errors: result.error.errors,
      input:
        input.length > MAX_ERROR_CONTEXT_CHARS
          ? `${input.substring(0, MAX_ERROR_CONTEXT_CHARS)}...`
          : input,
    });
  }

  return result.data;
}
