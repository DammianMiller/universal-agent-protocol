/**
 * PromptUI — a thin prompt abstraction over @clack/prompts.
 *
 * Decouples the setup wizard's flow from the concrete TUI library and gives a
 * single seam for headless / non-interactive runs (CI, tests). Cancel (Ctrl-C)
 * handling is centralized in the clack implementation so the wizard body never
 * sprinkles `isCancel` checks.
 */

import { ensureClack } from '../utils/lazy-imports.js';

export interface SelectOption<T> {
  label: string;
  value: T;
  hint?: string;
}

export interface PromptUI {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  select<T>(opts: { message: string; options: SelectOption<T>[]; initialValue?: T }): Promise<T>;
  multiselect<T>(opts: {
    message: string;
    options: SelectOption<T>[];
    initialValues?: T[];
    required?: boolean;
  }): Promise<T[]>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
  text(opts: { message: string; placeholder?: string; initialValue?: string }): Promise<string>;
  spinner(): { start(msg: string): void; stop(msg?: string): void };
}

/**
 * Clack-backed interactive UI. On cancel it prints a cancel notice and exits
 * cleanly (no partial work — the wizard only writes after the final confirm).
 */
export async function createClackUI(): Promise<PromptUI> {
  const clack = await ensureClack();

  const guard = <T>(value: T | symbol): T => {
    if (clack.isCancel(value)) {
      clack.cancel('Setup cancelled — no changes were made.');
      process.exit(0);
    }
    return value as T;
  };

  // clack's prompt generics can't be inferred through this adapter; options are
  // cast at the boundary while the public PromptUI signatures keep call sites
  // fully type-safe.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return {
    intro: (m) => clack.intro(m),
    outro: (m) => clack.outro(m),
    note: (m, t) => clack.note(m, t),
    select: async <T>(opts: { message: string; options: SelectOption<T>[]; initialValue?: T }) =>
      guard<T>(
        await clack.select({
          message: opts.message,
          options: opts.options as any,
          initialValue: opts.initialValue,
        })
      ),
    multiselect: async <T>(opts: {
      message: string;
      options: SelectOption<T>[];
      initialValues?: T[];
      required?: boolean;
    }) =>
      guard<T[]>(
        (await clack.multiselect({
          message: opts.message,
          options: opts.options as any,
          initialValues: opts.initialValues as any,
          required: opts.required ?? false,
        })) as any
      ),
    confirm: async (opts) =>
      guard<boolean>(
        await clack.confirm({ message: opts.message, initialValue: opts.initialValue ?? true })
      ),
    text: async (opts) =>
      guard<string>(
        await clack.text({
          message: opts.message,
          placeholder: opts.placeholder,
          initialValue: opts.initialValue,
        })
      ),
    spinner: () => {
      const s = clack.spinner();
      return { start: (m: string) => s.start(m), stop: (m?: string) => s.stop(m) };
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Non-interactive UI: returns the initial/default value for every prompt and
 * never reads stdin. The headless path for CI and the unit-test seam — the same
 * wizard body runs against it deterministically.
 */
export function createNonInteractiveUI(): PromptUI {
  return {
    intro: () => undefined,
    outro: () => undefined,
    note: () => undefined,
    select: async (opts) => opts.initialValue ?? opts.options[0]?.value,
    multiselect: async (opts) => opts.initialValues ?? [],
    confirm: async (opts) => opts.initialValue ?? true,
    text: async (opts) => opts.initialValue ?? '',
    spinner: () => ({ start: () => undefined, stop: () => undefined }),
  };
}
