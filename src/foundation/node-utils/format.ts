import { inspect } from 'node:util';

const INSPECT_OPTS = {
  depth: 2,
  breakLength: Infinity,
  maxStringLength: 500,
  maxArrayLength: 20,
  compact: true,
  colors: false,
} as const;

const CAUSE_DEPTH_LIMIT = 8;

function inspectOneLine(v: unknown): string {
  return inspect(v, INSPECT_OPTS).replace(/\n/g, '\\n');
}

function formatErrWithDepth(err: unknown, depth: number): string {
  if (depth > CAUSE_DEPTH_LIMIT) return '[depth-limit]';
  if (err instanceof Error) {
    const head = err.message || err.name || 'Error';
    if (err.cause !== undefined) {
      return `${head} -> caused by: ${formatErrWithDepth(err.cause, depth + 1)}`;
    }
    return head;
  }
  if (err === null || err === undefined) return String(err);
  const t = typeof err;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') {
    return String(err);
  }
  return inspectOneLine(err);
}

export function formatErr(err: unknown): string {
  return formatErrWithDepth(err, 0);
}
