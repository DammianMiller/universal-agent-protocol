/**
 * Structured Logger for UAP
 *
 * Replaces bare console.log/warn/error calls in runtime modules with
 * a configurable logger that respects verbosity levels.
 *
 * Levels: silent < error < warn < info < debug
 *
 * Set via:
 * - UAP_LOG_LEVEL env var (e.g., UAP_LOG_LEVEL=debug)
 * - Programmatic: setLogLevel('debug')
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let currentLevel: LogLevel = (process.env.UAP_LOG_LEVEL as LogLevel) || 'warn';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

function formatPrefix(_level: LogLevel, module?: string): string {
  const tag = module ? `[${module}]` : '[uap]';
  return `${tag}`;
}

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Create a module-scoped logger.
 *
 * @param module - Module name for log prefix (e.g., 'mcp-router', 'memory')
 */
export function createLogger(module: string): Logger {
  return {
    error(message: string, ...args: unknown[]) {
      if (shouldLog('error')) {
        console.error(formatPrefix('error', module), message, ...args);
      }
    },
    warn(message: string, ...args: unknown[]) {
      if (shouldLog('warn')) {
        console.warn(formatPrefix('warn', module), message, ...args);
      }
    },
    info(message: string, ...args: unknown[]) {
      if (shouldLog('info')) {
        console.log(formatPrefix('info', module), message, ...args);
      }
    },
    debug(message: string, ...args: unknown[]) {
      if (shouldLog('debug')) {
        console.log(formatPrefix('debug', module), message, ...args);
      }
    },
  };
}

/**
 * Global logger instance for modules that don't need a specific prefix.
 */
export const logger = createLogger('uap');
