import fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const RETENTION_RECORD_FILENAME = 'test-resource-failures.jsonl';
const RETENTION_VERSION = 1;

export type RetentionReason = Readonly<{
  code: string;
  error?: unknown;
  evidence?: unknown;
}>;

export interface RetentionScope {
  readonly id: string;
  readonly runRoot: string;
  readonly protectedPaths: readonly string[];
  retain(reason: RetentionReason): void;
  complete(): void;
}

export type RetentionDecision =
  | { kind: 'allow' }
  | { kind: 'preserve'; scopeIds: readonly string[]; reasons: readonly string[] }
  | { kind: 'indeterminate'; error: unknown };

export type RetentionPublication = 'not_published' | 'published' | 'indeterminate';

export class RetentionWriteError extends Error {
  constructor(
    readonly path: string,
    readonly publication: RetentionPublication,
    cause: unknown,
  ) {
    super(
      `Failed to publish retention record at ${path} (publication=${publication})`,
      { cause },
    );
    this.name = 'RetentionWriteError';
  }
}

type ScopeEvent = {
  version: number;
  type: 'scope_begin' | 'scope_retained' | 'scope_completed';
  id: string;
  recordedAt: string;
  label?: string;
  protectedPaths?: string[];
  code?: string;
  error?: unknown;
  evidence?: unknown;
};

type ScopeState = {
  protectedPaths: readonly string[];
  retained: boolean;
  completed: boolean;
  reasons: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encoded(value: unknown, seen = new Map<object, string>(), at = '$'): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { $type: 'number', value: String(value) };
  }
  if (typeof value === 'undefined') return { $type: 'undefined' };
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
  if (typeof value === 'symbol') return { $type: 'symbol', value: value.description };
  if (typeof value === 'function') return { $type: 'function', value: value.name };
  if (typeof value !== 'object') return { $type: typeof value, value: String(value) };
  const previous = seen.get(value);
  if (previous !== undefined) return { $ref: previous };
  seen.set(value, at);

  if (value instanceof Error) {
    const result: Record<string, unknown> = {
      $type: value instanceof AggregateError ? 'AggregateError' : 'Error',
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause' || key === 'errors') continue;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property?.enumerable) continue;
      const encodedKey = typeof key === 'string' ? key : `[${String(key)}]`;
      result[encodedKey] = encoded(Reflect.get(value, key), seen, `${at}.${encodedKey}`);
    }
    if ('cause' in value) result.cause = encoded(value.cause, seen, `${at}.cause`);
    if (value instanceof AggregateError) {
      result.errors = encoded(value.errors, seen, `${at}.errors`);
    }
    return result;
  }
  if (value instanceof Date) return { $type: 'Date', value: value.toISOString() };
  if (value instanceof RegExp) return { $type: 'RegExp', value: String(value) };
  if (value instanceof Map) {
    return {
      $type: 'Map',
      entries: [...value.entries()].map(([key, item], index) => [
        encoded(key, seen, `${at}.entries.${index}.0`),
        encoded(item, seen, `${at}.entries.${index}.1`),
      ]),
    };
  }
  if (value instanceof Set) {
    return { $type: 'Set', values: [...value].map((item, index) => encoded(item, seen, `${at}.${index}`)) };
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => encoded(item, seen, `${at}.${index}`));
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable) continue;
    const encodedKey = typeof key === 'string' ? key : `[${String(key)}]`;
    result[encodedKey] = encoded(Reflect.get(value, key), seen, `${at}.${encodedKey}`);
  }
  return result;
}

function canonicalPath(candidate: string): string {
  const absolute = path.resolve(candidate);
  let ancestor = absolute;
  const missing: string[] = [];
  while (true) {
    try {
      const real = fs.realpathSync(ancestor);
      return path.resolve(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function relativeInside(root: string, candidate: string): string | null {
  const relative = path.relative(root, candidate);
  if (relative === '') return '';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative;
}

function pathsIntersect(left: string, right: string): boolean {
  return relativeInside(left, right) !== null || relativeInside(right, left) !== null;
}

function normalizeScopePaths(runRoot: string, protectedPaths: readonly string[]): string[] {
  const root = canonicalPath(runRoot);
  return protectedPaths.map(protectedPath => {
    const normalized = canonicalPath(path.resolve(runRoot, protectedPath));
    if (relativeInside(root, normalized) === null) {
      throw new Error(`Retention protected path escapes run root: ${protectedPath}`);
    }
    return normalized;
  });
}

function closeNoThrow(fd: number): unknown {
  try {
    fs.closeSync(fd);
    return undefined;
  } catch (error) {
    return error;
  }
}

function appendEvent(runRoot: string, event: ScopeEvent): void {
  const recordPath = path.join(runRoot, RETENTION_RECORD_FILENAME);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(`${JSON.stringify(encoded(event))}\n`, 'utf8');
  } catch (error) {
    throw new RetentionWriteError(recordPath, 'not_published', error);
  }

  let existed = true;
  try {
    const stat = fs.lstatSync(recordPath);
    if (!stat.isFile()) throw new Error(`Retention record is not a regular file: ${recordPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') existed = false;
    else throw new RetentionWriteError(recordPath, 'not_published', error);
  }

  let fd: number | undefined;
  let publication: RetentionPublication = 'not_published';
  const errors: unknown[] = [];
  try {
    fd = fs.openSync(recordPath, 'a');
    const written = fs.writeSync(fd, bytes, 0, bytes.length, null);
    if (written !== bytes.length) {
      publication = 'indeterminate';
      throw new Error(`Short retention append: expected ${bytes.length} bytes, wrote ${written}`);
    }
    publication = 'published';
    fs.fsyncSync(fd);
  } catch (error) {
    errors.push(error);
    if (publication === 'not_published' && fd !== undefined) publication = 'indeterminate';
  }
  if (fd !== undefined) {
    const closeError = closeNoThrow(fd);
    if (closeError !== undefined) errors.push(closeError);
  }

  if (errors.length === 0 && !existed) {
    let parentFd: number | undefined;
    try {
      parentFd = fs.openSync(runRoot, 'r');
      fs.fsyncSync(parentFd);
    } catch (error) {
      errors.push(error);
    }
    if (parentFd !== undefined) {
      const closeError = closeNoThrow(parentFd);
      if (closeError !== undefined) errors.push(closeError);
    }
  }
  if (errors.length > 0) {
    throw new RetentionWriteError(
      recordPath,
      publication,
      errors.length === 1 ? errors[0] : new AggregateError(errors, 'Retention append and close failed'),
    );
  }
}

export function beginRetentionScope(input: {
  runRoot: string;
  protectedPaths: readonly string[];
  label: string;
}): RetentionScope {
  if (!input.runRoot) throw new Error('A run root is required to begin a retention scope');
  const runRoot = path.resolve(input.runRoot);
  const id = randomUUID();
  const protectedPaths = normalizeScopePaths(runRoot, input.protectedPaths);
  const scope: RetentionScope = {
    id,
    runRoot,
    protectedPaths,
    retain(reason) {
      if (!reason.code) throw new Error('A retention reason code is required');
      appendEvent(runRoot, {
        version: RETENTION_VERSION,
        type: 'scope_retained',
        id,
        recordedAt: new Date().toISOString(),
        code: reason.code,
        error: reason.error,
        evidence: reason.evidence,
      });
    },
    complete() {
      appendEvent(runRoot, {
        version: RETENTION_VERSION,
        type: 'scope_completed',
        id,
        recordedAt: new Date().toISOString(),
      });
    },
  };
  appendEvent(runRoot, {
    version: RETENTION_VERSION,
    type: 'scope_begin',
    id,
    recordedAt: new Date().toISOString(),
    label: input.label,
    protectedPaths,
  });
  return scope;
}

function invalidStream(message: string, cause?: unknown): RetentionDecision {
  return { kind: 'indeterminate', error: new Error(message, cause === undefined ? undefined : { cause }) };
}

function legacyDecision(value: unknown): RetentionDecision | undefined {
  if (isRecord(value) && value.type === 'unconfirmed-direct-child') {
    return { kind: 'preserve', scopeIds: [], reasons: ['unconfirmed-direct-child'] };
  }
  return undefined;
}

function validEvent(value: unknown): value is ScopeEvent {
  if (!isRecord(value) || value.version !== RETENTION_VERSION || typeof value.id !== 'string' || !value.id) {
    return false;
  }
  if (typeof value.recordedAt !== 'string') return false;
  if (value.type === 'scope_begin') {
    return typeof value.label === 'string' && Array.isArray(value.protectedPaths)
      && value.protectedPaths.every(item => typeof item === 'string');
  }
  if (value.type === 'scope_retained') return typeof value.code === 'string' && value.code.length > 0;
  return value.type === 'scope_completed';
}

export function inspectRetention(runRoot: string, targetPath?: string): RetentionDecision {
  const recordPath = path.join(runRoot, RETENTION_RECORD_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(recordPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const marker = fs.lstatSync(recordPath);
        return {
          kind: 'indeterminate',
          error: new Error(
            `Retention marker exists but cannot be read (${marker.isSymbolicLink() ? 'dangling symlink' : 'unknown target'}): ${recordPath}`,
            { cause: error },
          ),
        };
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'allow' };
        return {
          kind: 'indeterminate',
          error: new AggregateError([error, statError], `Cannot inspect retention marker: ${recordPath}`),
        };
      }
    }
    return { kind: 'indeterminate', error };
  }
  if (raw.length === 0) return invalidStream(`Empty retention record: ${recordPath}`);

  const scopes = new Map<string, ScopeState>();
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  else {
    try {
      const legacy = legacyDecision(JSON.parse(raw));
      if (legacy) return legacy;
    } catch { /* reported below as an incomplete stream */ }
    return invalidStream(`Incomplete retention record (missing newline): ${recordPath}`);
  }
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return invalidStream(`Malformed retention record: ${recordPath}`, error);
    }
    const legacy = legacyDecision(parsed);
    if (legacy) return legacy;
    if (!validEvent(parsed)) {
      return invalidStream(`Unknown or invalid retention event in ${recordPath}`);
    }
    const event = parsed;
    const state = scopes.get(event.id);
    if (event.type === 'scope_begin') {
      if (state) return invalidStream(`Duplicate retention scope begin: ${event.id}`);
      let protectedPaths: string[];
      try {
        protectedPaths = normalizeScopePaths(runRoot, event.protectedPaths as string[]);
      } catch (error) {
        return invalidStream(`Invalid protected path in retention scope: ${event.id}`, error);
      }
      scopes.set(event.id, { protectedPaths, retained: false, completed: false, reasons: [] });
      continue;
    }
    if (!state) return invalidStream(`Retention event precedes scope begin: ${event.id}`);
    if (event.type === 'scope_completed') {
      if (state.completed) return invalidStream(`Duplicate retention scope completion: ${event.id}`);
      state.completed = true;
    } else {
      state.retained = true;
      if (!state.reasons.includes(event.code as string)) state.reasons.push(event.code as string);
    }
  }

  let canonicalRoot: string;
  let canonicalTarget: string | undefined;
  try {
    canonicalRoot = canonicalPath(runRoot);
    canonicalTarget = targetPath === undefined
      ? undefined
      : canonicalPath(path.resolve(runRoot, targetPath));
  } catch (error) {
    return { kind: 'indeterminate', error };
  }
  const scopeIds: string[] = [];
  const reasons: string[] = [];
  for (const [id, state] of scopes) {
    if (state.completed && !state.retained) continue;
    const rootInspection = canonicalTarget === undefined || relativeInside(canonicalTarget, canonicalRoot) !== null;
    const pathMatch = canonicalTarget !== undefined
      && ((state.protectedPaths.length === 0 && state.retained)
        || state.protectedPaths.some(protectedPath => pathsIntersect(protectedPath, canonicalTarget)));
    if (!rootInspection && !pathMatch) continue;
    scopeIds.push(id);
    for (const reason of state.reasons.length > 0 ? state.reasons : ['scope_pending']) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return scopeIds.length > 0 ? { kind: 'preserve', scopeIds, reasons } : { kind: 'allow' };
}
