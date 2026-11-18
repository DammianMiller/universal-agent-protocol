// Shared helpers for UAP's opencode V2 plugins (.opencode/plugin/*.ts).
//
// THIS FILE LIVES IN .opencode/lib/ ON PURPOSE: opencode auto-loads every
// .ts under .opencode/plugin/ as a plugin candidate, and a helper module
// without a V2 default-export definition fails the loader on every boot.
// Keep shared code out of the discovery directory.
//
// Portability contract: opencode loads these files under Bun, but the repo's
// vitest suite imports them under node (shape tests, pure-function tests).
// So this kit uses only node:child_process — never a `bun` import — and
// plugin files must keep their `@opencode/plugin` imports TYPE-ONLY so the
// generated/tracked files resolve in any runtime without the package on
// disk.
import { exec } from 'node:child_process';
import type { JsonSchema } from 'effect';

/** Result of a kit `$` shell call (Bun.$-shaped: Buffers + exitCode). */
export interface ShellResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/** A plain JSON-Schema fragment for a V2 tool input property. */
export type JsonSchemaFragment = JsonSchema.JsonSchema;

const shellQuote = (value: unknown): string => "'" + String(value).replace(/'/g, "'\\''") + "'";

/**
 * A running shell command. `quiet()` resolves with stdout/stderr/exitCode
 * (no echo); `nothrow()` stops non-zero exits from rejecting. The nothrow
 * flag is read at settle time, so both `.quiet().nothrow()` and a bare
 * `.quiet()` behave exactly like Bun's `$`.
 */
class ShellRun implements PromiseLike<ShellResult> {
  private nothrow = false;
  private readonly promise: Promise<ShellResult>;

  constructor(command: string) {
    this.promise = new Promise<ShellResult>((resolve, reject) => {
      exec(command, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const rawCode = (err as { code?: unknown } | null)?.code;
        const exitCode = typeof rawCode === 'number' ? rawCode : err ? 127 : 0;
        const result: ShellResult = {
          stdout: Buffer.from(stdout ?? ''),
          stderr: Buffer.from(stderr ?? ''),
          exitCode,
        };
        if (exitCode !== 0 && !this.nothrow) {
          reject(new Error(`uap-plugin-kit: command exited ${exitCode}: ${command.slice(0, 200)}`));
        } else {
          resolve(result);
        }
      });
    });
  }

  /** Bun.$-style: keep non-zero exits as resolved results instead of throws. */
  nothrowMode(): this {
    this.nothrow = true;
    return this;
  }

  /** Bun.$-style quiet: the kit never echoes; resolve with the buffers. */
  quiet(): this {
    return this;
  }

  then<TResult1 = ShellResult, TResult2 = never>(
    onfulfilled?:
      | ((value: ShellResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }
}

/**
 * Bun.$-compatible shell tagged template. Interpolated values are
 * single-quoted (embedded quotes escaped), matching Bun's `$` semantics the
 * existing call sites were written against.
 *
 *   const res = await $`uap memory query ${query}`.quiet()
 *   const res = await $`uap verify --runtime-only`.quiet().nothrow()
 */
export function $(strings: TemplateStringsArray, ...values: unknown[]): ShellRun {
  let command = '';
  for (let i = 0; i < strings.length; i++) {
    command += strings[i];
    if (i < values.length) command += shellQuote(values[i]);
  }
  return new ShellRun(command);
}

/**
 * JSON-Schema builders for V2 tool inputs. V1 plugins used the zod-style
 * `tool.schema.*()` helpers; V2 takes plain JSON Schema. Each builder keeps
 * the V1 description strings; formerly-defaulted parameters are documented
 * with `default` and should ALSO be defaulted in the execute body with `??`
 * (the runtime does not guarantee schema-default application).
 */
export const toolInput = {
  string: (description: string): JsonSchemaFragment => ({ type: 'string', description }),

  number: (
    description: string,
    opts: { minimum?: number; maximum?: number; default?: number } = {}
  ): JsonSchemaFragment => ({ type: 'number', description, ...opts }),

  boolean: (
    description: string,
    opts: { default?: boolean } = {}
  ): JsonSchemaFragment => ({ type: 'boolean', description, ...opts }),

  enum: (
    description: string,
    values: readonly string[],
    def?: string
  ): JsonSchemaFragment => ({
    type: 'string',
    description,
    enum: [...values],
    ...(def !== undefined ? { default: def } : {}),
  }),

  object: (
    properties: Record<string, JsonSchemaFragment>,
    required: readonly string[] = []
  ): JsonSchemaFragment => ({
    type: 'object',
    properties,
    required: [...required],
  }),
} as const;

/** Wrap a tool's return text in the V2 Tool.Result content shape. */
export const toolResult = (text: string): { content: string } => ({ content: text });

/**
 * Extract the session id from a V2 opencode event payload (events carry
 * `data.sessionID`), tolerating older/odd shapes. Empty string = unknown.
 */
export const eventSessionID = (event: unknown): string => {
  const data = (event as { data?: unknown }).data;
  const sid = (data as { sessionID?: unknown } | undefined)?.sessionID;
  return typeof sid === 'string' ? sid : '';
};
