/**
 * Minimal, dependency-free logger with consistent prefixes.
 * Kept intentionally terse to avoid polluting agent context / terminal.
 */

type Level = 'info' | 'ok' | 'warn' | 'err' | 'debug';

const COLORS: Record<Level, string> = {
  info: '\u001b[36m', // cyan
  ok: '\u001b[32m', // green
  warn: '\u001b[33m', // yellow
  err: '\u001b[31m', // red
  debug: '\u001b[90m', // gray
};
const RESET = '\u001b[0m';

const PREFIX: Record<Level, string> = {
  info: '›',
  ok: '✓',
  warn: '⚠',
  err: '✗',
  debug: '·',
};

const isTty = process.stdout.isTTY === true;
let debugEnabled = process.env.HARNESS_DEBUG === '1' || process.env.HARNESS_DEBUG === 'true';

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

function write(level: Level, message: string): void {
  const stream = level === 'err' ? process.stderr : process.stdout;
  const prefix = PREFIX[level];
  if (isTty) {
    stream.write(`${COLORS[level]}${prefix}${RESET} ${message}\n`);
  } else {
    stream.write(`${prefix} ${message}\n`);
  }
}

export const log = {
  info: (m: string) => write('info', m),
  ok: (m: string) => write('ok', m),
  warn: (m: string) => write('warn', m),
  err: (m: string) => write('err', m),
  debug: (m: string) => {
    if (debugEnabled) write('debug', m);
  },
};
