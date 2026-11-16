/**
 * @module L1.ProcessExec
 *
 * Find processes by command pattern through the host process-list backend.
 */

import { spawn, spawnSync } from 'child_process';
import {
  PROCESS_EXEC_DEFAULT_MAX_BUFFER,
  PROCESS_EXEC_DEFAULT_TIMEOUT_MS,
} from './constants.js';
import {
  ProcessListUnavailable,
  type ProcessListEvidence,
  type ProcessListFailureClassification,
  type ProcessListOperation,
} from './errors.js';
import {
  findByPatternWithBackends,
  findByPatternWithBackendsSyncForCli,
  type BackendProbe,
  type ProcessListBackend,
  type ProcessListOptions,
} from './process-list-backend.js';
import type { ProcessInfo } from './types.js';

export interface FindByPatternOptions extends ProcessListOptions {
  /** Deterministic test seam; production callers use the L1 child_process owner. */
  spawnProcess?: typeof spawn;
}

interface FailureDetails {
  backendId?: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  code?: string;
}

function unavailable(
  pattern: string,
  operation: ProcessListOperation,
  classification: ProcessListFailureClassification,
  cause: unknown,
  details: FailureDetails = {},
): ProcessListUnavailable {
  return new ProcessListUnavailable(pattern, cause, {
    backendId: details.backendId ?? 'posix-ps',
    operation,
    classification,
    status: details.status,
    signal: details.signal,
    stderr: details.stderr,
    code: details.code,
  });
}

function errnoCode(cause: unknown): string | undefined {
  return typeof cause === 'object' && cause !== null && 'code' in cause
    && typeof (cause as NodeJS.ErrnoException).code === 'string'
    ? (cause as NodeJS.ErrnoException).code
    : undefined;
}

function spawnFailureClassification(cause: unknown): ProcessListFailureClassification {
  const code = errnoCode(cause);
  if (code === 'ENOBUFS') return 'max_buffer';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ABORT_ERR') return 'abort';
  return 'spawn_error';
}

function nonzeroExit(
  pattern: string,
  operation: ProcessListOperation,
  status: number | null,
  stderr: string,
  signal: NodeJS.Signals | null = null,
): ProcessListUnavailable {
  const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
  return unavailable(
    pattern,
    operation,
    signal === null ? 'nonzero_exit' : 'signal',
    new Error(`${operation} exit ${String(status)}${suffix}`),
    { status, signal, stderr },
  );
}

function escapeLiteral(pattern: string): string {
  return pattern.replace(/[\\.^$*+?()[\]{}|]/g, '\\$&');
}

function parseFailure(pattern: string, operation: ProcessListOperation, line: string): ProcessListUnavailable {
  return unavailable(
    pattern,
    operation,
    'parse_error',
    new Error(`Malformed ${operation} response line: ${JSON.stringify(line)}`),
  );
}

function parsePids(stdout: string, pattern: string): number[] {
  const lines = stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  if (lines.length === 0) throw parseFailure(pattern, 'pgrep', '<empty>');
  return lines.map(line => {
    if (!/^\d+$/.test(line)) throw parseFailure(pattern, 'pgrep', line);
    return parseInt(line, 10);
  });
}

function parseProcessList(stdout: string, pattern: string): ProcessInfo[] {
  const lines = stdout.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) throw parseFailure(pattern, 'ps', '<empty>');
  return lines.map(line => {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) throw parseFailure(pattern, 'ps', line);
    return { pid: parseInt(m[1]!, 10), command: m[2]!.trim() };
  });
}

/**
 * Find processes matching pattern. Returns pids + command strings.
 * Synchronous CLI diagnostic API; event-loop-sensitive callers use the
 * bounded async variant.
 *
 * @throws ProcessListUnavailable if either process-list operation fails.
 */
export function findByLiteralPatternSyncForCli(pattern: string): ProcessInfo[] {
  return findByPatternSyncForCli(escapeLiteral(pattern));
}

function findPosixByPatternSync(pattern: string): ProcessInfo[] {
  let pids: number[];
  try {
    const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8' });
    if (result.error) {
      throw unavailable(pattern, 'pgrep', spawnFailureClassification(result.error), result.error, {
        status: result.status,
        signal: result.signal,
        stderr: result.stderr,
        code: errnoCode(result.error),
      });
    }
    if (result.status === 1) return [];
    if (result.status !== 0) {
      throw nonzeroExit(pattern, 'pgrep', result.status, result.stderr, result.signal);
    }
    pids = parsePids(result.stdout, pattern);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) throw err;
    throw unavailable(pattern, 'pgrep', spawnFailureClassification(err), err, { code: errnoCode(err) });
  }

  if (pids.length === 0) return [];

  try {
    const psResult = spawnSync('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf-8' });
    if (psResult.error) {
      throw unavailable(pattern, 'ps', spawnFailureClassification(psResult.error), psResult.error, {
        status: psResult.status,
        signal: psResult.signal,
        stderr: psResult.stderr,
        code: errnoCode(psResult.error),
      });
    }
    if (psResult.status !== 0) {
      throw nonzeroExit(pattern, 'ps', psResult.status, psResult.stderr, psResult.signal);
    }
    return parseProcessList(psResult.stdout, pattern);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) throw err;
    throw unavailable(pattern, 'ps', spawnFailureClassification(err), err, { code: errnoCode(err) });
  }
}

interface AsyncProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function abortCause(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('Process list query aborted'), { code: 'ABORT_ERR' });
}

function abortFailure(
  pattern: string,
  operation: ProcessListOperation,
  signal: AbortSignal,
  stderr = '',
): ProcessListUnavailable {
  const cause = abortCause(signal);
  return unavailable(pattern, operation, 'abort', cause, {
    stderr,
    code: errnoCode(cause) ?? 'ABORT_ERR',
  });
}

/** Spawn one bounded listing command. The child_process import is the mock seam. */
async function runListingProcess(
  command: ProcessListOperation,
  args: string[],
  pattern: string,
  options: FindByPatternOptions,
): Promise<AsyncProcessResult> {
  const signal = options.signal;
  if (signal?.aborted) throw abortFailure(pattern, command, signal);

  let proc: ReturnType<typeof spawn>;
  try {
    // L1 owns abort/timeout cleanup rather than delegating it to spawn's
    // premature AbortError path.
    proc = (options.spawnProcess ?? spawn)(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw unavailable(pattern, command, spawnFailureClassification(err), err, { code: errnoCode(err) });
  }

  const requestedTimeout = options.timeoutMs ?? PROCESS_EXEC_DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(Math.max(0, requestedTimeout), 2_147_483_647)
    : PROCESS_EXEC_DEFAULT_TIMEOUT_MS;
  const requestedMaxBuffer = options.maxBuffer ?? PROCESS_EXEC_DEFAULT_MAX_BUFFER;
  const maxBuffer = Number.isFinite(requestedMaxBuffer)
    ? Math.max(1, Math.floor(requestedMaxBuffer))
    : PROCESS_EXEC_DEFAULT_MAX_BUFFER;

  return new Promise<AsyncProcessResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let buffered = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stderrString = (): string => Buffer.concat(stderr).toString('utf-8');
    const cleanupTransient = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      proc.stdout?.off('data', onStdout);
      proc.stderr?.off('data', onStderr);
    };
    const cleanupLifecycle = (): void => {
      proc.off('error', onError);
      proc.off('close', onClose);
    };
    const rejectFailure = (error: ProcessListUnavailable): void => {
      if (settled) return;
      settled = true;
      cleanupTransient();
      cleanupLifecycle();
      reject(error);
    };
    const terminate = (error: ProcessListUnavailable): void => {
      if (settled) return;
      settled = true;
      cleanupTransient();
      // Keep error/close handlers until the OS lifecycle event so late error
      // events are consumed and those handlers then remove themselves.
      try {
        proc.kill('SIGKILL');
      } catch {
        // silent: the typed timeout/abort/overflow evidence remains the primary fact.
      }
      reject(error);
    };
    const push = (target: Buffer[], chunk: Buffer | string): boolean => {
      if (settled) return false;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxBuffer - buffered);
      target.push(buffer.subarray(0, remaining));
      buffered += Math.min(buffer.length, remaining);
      if (buffer.length > remaining) {
        const cause = Object.assign(
          new Error(`${command} output exceeded ${maxBuffer} bytes`),
          { code: 'ENOBUFS' },
        );
        terminate(unavailable(pattern, command, 'max_buffer', cause, {
          stderr: stderrString(),
          code: 'ENOBUFS',
        }));
        return false;
      }
      return true;
    };
    function onStdout(chunk: Buffer | string): void {
      push(stdout, chunk);
    }
    function onStderr(chunk: Buffer | string): void {
      push(stderr, chunk);
    }
    function onAbort(): void {
      terminate(abortFailure(pattern, command, signal!, stderrString()));
    }
    function onError(err: Error): void {
      if (settled) {
        cleanupLifecycle();
        return;
      }
      rejectFailure(unavailable(pattern, command, spawnFailureClassification(err), err, {
        stderr: stderrString(),
        code: errnoCode(err),
      }));
    }
    function onClose(status: number | null, processSignal: NodeJS.Signals | null): void {
      cleanupLifecycle();
      if (settled) return;
      if (processSignal !== null) {
        rejectFailure(unavailable(
          pattern,
          command,
          'signal',
          new Error(`${command} killed by signal ${processSignal}`),
          { status, signal: processSignal, stderr: stderrString() },
        ));
        return;
      }
      settled = true;
      cleanupTransient();
      resolve({ status, stdout: Buffer.concat(stdout).toString('utf-8'), stderr: stderrString() });
    }

    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.on('error', onError);
    proc.on('close', onClose);
    timer = setTimeout(() => {
      const cause = Object.assign(
        new Error(`${command} timed out after ${timeoutMs}ms`),
        { code: 'ETIMEDOUT' },
      );
      terminate(unavailable(pattern, command, 'timeout', cause, {
        stderr: stderrString(),
        code: 'ETIMEDOUT',
      }));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Close the pre-check/listener-registration race without spawning again.
    if (signal?.aborted) onAbort();
  });
}

export async function findByLiteralPatternAsync(
  pattern: string,
  options: FindByPatternOptions = {},
): Promise<ProcessInfo[]> {
  return findByPatternAsync(escapeLiteral(pattern), options);
}

/** Bounded, interruptible process query; ps failures never degrade to blank commands. */
async function findPosixByPatternAsync(
  pattern: string,
  options: FindByPatternOptions = {},
): Promise<ProcessInfo[]> {
  const pgrep = await runListingProcess('pgrep', ['-f', pattern], pattern, options);
  if (pgrep.status === 1) return [];
  if (pgrep.status !== 0) throw nonzeroExit(pattern, 'pgrep', pgrep.status, pgrep.stderr);

  const pids = parsePids(pgrep.stdout, pattern);
  if (pids.length === 0) return [];

  const ps = await runListingProcess(
    'ps',
    ['-o', 'pid=,command=', '-p', pids.join(',')],
    pattern,
    options,
  );
  if (ps.status !== 0) throw nonzeroExit(pattern, 'ps', ps.status, ps.stderr);
  return parseProcessList(ps.stdout, pattern);
}

function availableEvidence(
  operation: ProcessListOperation,
  status: number | null,
  stderr: string,
): ProcessListEvidence {
  return { backendId: 'posix-ps', operation, classification: 'available', status, signal: null, stderr };
}

function probeFailure(
  cause: unknown,
  priorEvidence: readonly ProcessListEvidence[] = [],
): BackendProbe {
  const error = cause instanceof ProcessListUnavailable
    ? cause
    : unavailable('', 'probe', 'spawn_error', cause, { code: errnoCode(cause) });
  return {
    kind: 'unavailable',
    backendId: 'posix-ps',
    evidence: [...priorEvidence, ...error.evidenceChain],
    error,
  };
}

class PosixPsProcessListBackend implements ProcessListBackend {
  readonly id = 'posix-ps';
  private cachedAvailableProbe?: BackendProbe;

  async probe(options: ProcessListOptions = {}): Promise<BackendProbe> {
    // Cache only a successful capability result; failures remain retryable.
    if (this.cachedAvailableProbe) return this.cachedAvailableProbe;
    const probe = await this.probeHost(options);
    if (probe.kind === 'available') this.cachedAvailableProbe = probe;
    return probe;
  }

  private async probeHost(options: ProcessListOptions): Promise<BackendProbe> {
    const evidence: ProcessListEvidence[] = [];
    try {
      const pgrep = await runListingProcess(
        'pgrep',
        ['-f', 'chestnut_process_list_capability_probe'],
        '',
        options,
      );
      if (pgrep.status !== 0 && pgrep.status !== 1) {
        throw nonzeroExit('', 'pgrep', pgrep.status, pgrep.stderr);
      }
      evidence.push(availableEvidence('pgrep', pgrep.status, pgrep.stderr));
      const ps = await runListingProcess(
        'ps',
        ['-o', 'pid=,command=', '-p', String(process.pid)],
        '',
        options,
      );
      if (ps.status !== 0) throw nonzeroExit('', 'ps', ps.status, ps.stderr);
      const processes = parseProcessList(ps.stdout, '');
      if (!processes.some(item => item.pid === process.pid)) {
        throw parseFailure('', 'parse', `self pid ${process.pid} missing`);
      }
      evidence.push(availableEvidence('ps', ps.status, ps.stderr));
      return { kind: 'available', backendId: this.id, evidence };
    } catch (cause) {
      // silent: host failure becomes structured unavailable probe evidence.
      return probeFailure(cause, evidence);
    }
  }

  probeSyncForCli(): BackendProbe {
    let operation: ProcessListOperation = 'pgrep';
    const evidence: ProcessListEvidence[] = [];
    try {
      const pgrep = spawnSync('pgrep', ['-f', 'chestnut_process_list_capability_probe'], { encoding: 'utf-8' });
      if (pgrep.error) {
        throw unavailable('', 'pgrep', spawnFailureClassification(pgrep.error), pgrep.error, {
          status: pgrep.status,
          signal: pgrep.signal,
          stderr: pgrep.stderr,
          code: errnoCode(pgrep.error),
        });
      }
      if (pgrep.status !== 0 && pgrep.status !== 1) {
        throw nonzeroExit('', 'pgrep', pgrep.status, pgrep.stderr, pgrep.signal);
      }
      evidence.push(availableEvidence('pgrep', pgrep.status, pgrep.stderr));
      operation = 'ps';
      const ps = spawnSync(
        'ps',
        ['-o', 'pid=,command=', '-p', String(process.pid)],
        { encoding: 'utf-8' },
      );
      if (ps.error) {
        throw unavailable('', 'ps', spawnFailureClassification(ps.error), ps.error, {
          status: ps.status,
          signal: ps.signal,
          stderr: ps.stderr,
          code: errnoCode(ps.error),
        });
      }
      if (ps.status !== 0) throw nonzeroExit('', 'ps', ps.status, ps.stderr, ps.signal);
      const processes = parseProcessList(ps.stdout, '');
      if (!processes.some(item => item.pid === process.pid)) {
        throw parseFailure('', 'parse', `self pid ${process.pid} missing`);
      }
      evidence.push(availableEvidence('ps', ps.status, ps.stderr));
      return { kind: 'available', backendId: this.id, evidence };
    } catch (cause) {
      // silent: sync CLI host failure uses the same unavailable probe evidence.
      return probeFailure(cause instanceof ProcessListUnavailable
        ? cause
        : unavailable('', operation, spawnFailureClassification(cause), cause, { code: errnoCode(cause) }), evidence);
    }
  }

  findByPattern(pattern: string, options: ProcessListOptions): Promise<ProcessInfo[]> {
    return findPosixByPatternAsync(pattern, options);
  }

  findByPatternSyncForCli(pattern: string): ProcessInfo[] {
    return findPosixByPatternSync(pattern);
  }
}

export function createProcessListBackends(
  platform = process.platform,
): readonly ProcessListBackend[] {
  if (platform === 'darwin' || platform === 'linux' || platform === 'freebsd') {
    return [new PosixPsProcessListBackend()];
  }
  return [];
}

const productionRegistries = new Map<NodeJS.Platform, readonly ProcessListBackend[]>();

function productionProcessListBackends(platform = process.platform): readonly ProcessListBackend[] {
  const cached = productionRegistries.get(platform);
  if (cached) return cached;
  const backends = createProcessListBackends(platform);
  productionRegistries.set(platform, backends);
  return backends;
}

function unsupportedHost(pattern: string, platform: NodeJS.Platform): ProcessListUnavailable {
  return unavailable(
    pattern,
    'backend',
    'unsupported',
    new Error(`Unsupported process-list backend on ${platform}`),
    { backendId: 'unsupported' },
  );
}

export function findByPatternSyncForCli(pattern: string): ProcessInfo[] {
  const backends = productionProcessListBackends();
  if (backends.length === 0) throw unsupportedHost(pattern, process.platform);
  return findByPatternWithBackendsSyncForCli(pattern, backends);
}

/** Bounded, interruptible process query; listing failures never degrade to no-match. */
export async function findByPatternAsync(
  pattern: string,
  options: FindByPatternOptions = {},
): Promise<ProcessInfo[]> {
  if (options.spawnProcess) {
    // Deterministic low-level query seam: tests drive child events synchronously.
    // Production callers never take this branch and always use capability probes.
    const backends = createProcessListBackends();
    if (backends.length === 0) throw unsupportedHost(pattern, process.platform);
    return backends[0]!.findByPattern(pattern, options);
  }
  const backends = productionProcessListBackends();
  if (backends.length === 0) throw unsupportedHost(pattern, process.platform);
  return findByPatternWithBackends(pattern, options, backends);
}
