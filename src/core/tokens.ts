/**
 * Token-economy helpers.
 *
 * The harness optimizes for the minimum amount of context/tokens per task.
 * These utilities strip terminal noise from CLI output and clip verbose
 * logs using a "smart" head+tail strategy instead of naive truncation.
 */

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Remove ANSI escape sequences (colors, cursor control) from text. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '');
}

/** Hard truncate with an ellipsis marker when over the limit. */
export function truncate(input: string, max: number): string {
  if (max <= 0) return '';
  if (input.length <= max) return input;
  const keep = Math.max(0, max - 20);
  return `${input.slice(0, keep)}\n… [truncated ${input.length - keep} chars]`;
}

/**
 * Smart clip of a (typically multi-line error) log.
 *
 * Keeps the FIRST `head` lines (context / initial summary) and the LAST
 * `tail` lines (final error summary + stack trace), dropping the repetitive
 * middle. This preserves the most useful signal per token.
 *
 * @param input  Raw stdout/stderr text.
 * @param head   Number of leading lines to keep (default 50).
 * @param tail   Number of trailing lines to keep (default 100).
 */
export function clipSmart(input: string, head = 50, tail = 100): string {
  const clean = stripAnsi(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n');

  // Drop trailing blank lines so the "tail" is meaningful.
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop();
  }

  if (lines.length <= head + tail) return clean;

  const headLines = lines.slice(0, head);
  const tailLines = lines.slice(-tail);
  const omitted = lines.length - head - tail;

  return [
    ...headLines,
    ``,
    `… [${omitted} lines omitted] …`,
    ``,
    ...tailLines,
  ].join('\n');
}
