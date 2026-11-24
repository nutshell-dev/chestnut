import * as fs from 'node:fs';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  captureExecutionTarget,
  observeExecutionTarget,
  terminateExecutionTarget,
  type ExecutionTargetCapture,
  type ExecutionTargetObservation,
  type ExecutionTerminationOutcome,
} from '../../src/foundation/process-exec/index.js';
import { runChildProcess, withCleanupPreservingError } from '../utils/child-process.js';
import {
  cleanupTempDir,
  createScopedTempDirSync,
} from '../utils/temp.js';
import type { RetentionScope } from '../utils/resource-retention.js';

export const cliPath = path.resolve(__dirname, '../../dist/cli.js');
export const CONFIG_REPAIR_REF = 'PHASE2221_INTEGRATION_KEY';
const CLI_CHILD_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 5_000;
const WRAPPER_CLOSE_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 10;
const PTY_RESPONSE_DELAY_MS = 100;
const fixturePath = path.resolve(__dirname, '../fixtures/config-repair-session-child.mjs');

export interface InteractiveAnswer {
  readonly prompt: RegExp;
  readonly value: string;
}

export interface ConfigRepairWorkspace {
  readonly root: string;
  readonly home: string;
  readonly retention: RetentionScope;
}

export function createConfigRepairWorkspace(
  baseUrl: string,
  timeoutMs?: number,
  options: { readonly afterInitialize?: (root: string, home: string) => void } = {},
): ConfigRepairWorkspace {
  const { dir: root, retention } = createScopedTempDirSync('chestnut-config-repair-integration-');
  const home = path.join(root, '.test-home');
  try {
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(root, '.chestnut', 'llm'), { recursive: true });
    fs.mkdirSync(path.join(root, '.chestnut', 'claws'), { recursive: true });
    fs.writeFileSync(path.join(root, '.chestnut', 'config.yaml'), "version: '1'\n");
    fs.writeFileSync(path.join(root, '.chestnut', 'llm', 'config.yaml'), `schema_version: 1
revision: 1
primary:
  provider_id: custom:openai
  api_format: openai
  auth_profile: api_key
  api_key: \${${CONFIG_REPAIR_REF}}
  model: original-model
  label: main
  base_url: ${baseUrl}
${timeoutMs === undefined ? '' : `  timeout_ms: ${timeoutMs}\n`}`);
    options.afterInitialize?.(root, home);
  } catch (primary) {
    try {
      retention.retain({ code: 'fixture_setup_failed', error: primary });
    } catch (recording) {
      throw new AggregateError(
        [primary, recording],
        'Workspace setup and recording failed',
        { cause: primary },
      );
    }
    throw primary;
  }
  return { root, home, retention };
}

export async function finishConfigRepairCase<T>(
  workspace: ConfigRepairWorkspace,
  runAndConfirm: () => Promise<T>,
  evidence: { readonly requests?: () => readonly ConfigRepairRequest[] } = {},
): Promise<T> {
  const retainAndThrow = (primary: unknown): never => {
    try {
      workspace.retention.retain({ code: 'test_failed', error: primary });
    } catch (recording) {
      throw new AggregateError([primary, recording], 'Test and retention recording failed', { cause: primary });
    }
    throw primary;
  };
  let completionFailed = false;
  return withCleanupPreservingError(async () => {
    try {
      const value = await withCleanupPreservingError(runAndConfirm, async () => {
        if (evidence.requests) {
          fs.writeFileSync(
            path.join(workspace.root, 'http-requests.json'),
            JSON.stringify(evidence.requests()),
          );
        }
      });
      try {
        workspace.retention.complete();
      } catch (error) {
        // A completed record may already be published even when fsync/close
        // reports an error. Its current retention view can therefore say
        // "allow" after a later retained append also fails. The caller must
        // stop deleting locally instead of laundering that uncertainty through
        // inspectRetention's otherwise correct completed-state decision.
        completionFailed = true;
        throw error;
      }
      return value;
    } catch (primary) {
      return retainAndThrow(primary);
    }
  }, async () => {
    if (completionFailed) return;
    try {
      await cleanupTempDir(workspace.root);
    } catch (cleanup) {
      return retainAndThrow(cleanup);
    }
  });
}

export function configRepairEnv(root: string, home: string, withKey: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHESTNUT_ROOT: root,
    CHESTNUT_HOME: home,
    NODE_NO_WARNINGS: '1',
  };
  delete env[CONFIG_REPAIR_REF];
  if (withKey) env[CONFIG_REPAIR_REF] = 'integration-secret';
  return env;
}

export async function runConfigRepairCli(
  workspace: ConfigRepairWorkspace,
  args: string[],
  signal: AbortSignal,
  input = '',
  withKey = false,
) {
  return runChildProcess(process.execPath, [cliPath, ...args], {
    cwd: path.dirname(cliPath),
    env: configRepairEnv(workspace.root, workspace.home, withKey),
    input,
    timeoutMs: CLI_CHILD_TIMEOUT_MS,
    signal,
  });
}

export interface ReadyFact {
  pid: number;
  processGroupId: number;
  cwd: string;
  mode: string;
  groupChildPid?: number;
}

type CloseFact =
  | { readonly kind: 'not_started' }
  | { readonly kind: 'closed'; readonly status: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'unconfirmed'; readonly reason: 'deadline' | 'error'; readonly error?: unknown };

type CleanupAttempt = Readonly<{
  resource: 'wrapper' | 'worker_group' | 'stdin' | 'stdout' | 'stderr';
  operation: string;
  outcome: unknown;
}>;

type StopFact = Readonly<{ reason: string; cause: unknown }>;
type ErrorFact = Readonly<{ operation: string; error: unknown }>;

export interface ConfigRepairSessionResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ready?: ReadyFact;
  readonly readyRaw?: unknown;
  readonly exitedPath: string;
  readonly evidencePath: string;
  readonly execution: {
    readonly kind: 'not_started' | 'gone' | 'unconfirmed';
    readonly capture?: ExecutionTargetCapture;
    readonly observation?: ExecutionTargetObservation;
    readonly termination?: ExecutionTerminationOutcome;
  };
  readonly wrapper: {
    readonly close: CloseFact;
    readonly capture?: ExecutionTargetCapture;
    readonly observation?: ExecutionTargetObservation;
    readonly termination?: ExecutionTerminationOutcome;
  };
  readonly streams: Readonly<Record<'stdin' | 'stdout' | 'stderr', {
    readonly close: CloseFact;
    readonly ended: boolean;
    readonly destroyed: boolean;
  }>>;
  readonly firstStop?: StopFact;
  readonly laterStops: readonly StopFact[];
  readonly attempts: readonly CleanupAttempt[];
  readonly errors: readonly ErrorFact[];
  readonly lateFacts: readonly unknown[];
  readonly retainedListeners: readonly string[];
  readonly observationStoppedAt?: string;
}

export class ConfigRepairSessionError extends Error {
  constructor(message: string, readonly result: ConfigRepairSessionResult, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigRepairSessionError';
  }
}

export interface SessionOptions {
  readonly mode?: 'cli' | 'finite' | 'orphan' | 'final-output' | 'single-prompt'
    | 'split-prompt' | 'ignore-term' | 'hold-wrapper' | 'no-ready'
    | 'bad-ready-json' | 'bad-ready-schema' | 'bad-ready-cwd';
  readonly lifetimeMs?: number;
  readonly timeoutMs?: number;
  readonly onReady?: (ready: ReadyFact) => void;
  /** Test-only FS boundary used to prove pre-capture failure handling. */
  readonly readReady?: (readyPath: string) => unknown;
  /** Test-only startup boundary; all ordinary cases use the real PTY. */
  readonly spawnPty?: (command: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcessWithoutNullStreams;
  /** Test-only finite L1 boundaries for receiver-side union/throw coverage. */
  readonly captureTarget?: typeof captureExecutionTarget;
  readonly observeTarget?: typeof observeExecutionTarget;
  readonly terminateTarget?: typeof terminateExecutionTarget;
  /** Test-only wrapper boundary; worker termination remains independently injectable. */
  readonly terminateWrapper?: typeof terminateExecutionTarget;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function spawnPty(command: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcessWithoutNullStreams {
  const options = { cwd, env, stdio: 'pipe' as const, detached: true };
  return process.platform === 'darwin'
    ? spawn('script', ['-q', '/dev/null', ...command], options)
    : spawn('script', ['-qec', command.map(shellQuote).join(' '), '/dev/null'], options);
}

type CaptureAction = 'continue' | 'observe_only' | 'finish_unconfirmed';

function assertNotCallerProcessGroup(identity: { leaderPid: number; processGroupId: number }): void {
  const callerPgid = (process as NodeJS.Process & { pgid?: number }).pgid;
  if (identity.leaderPid === process.pid || identity.processGroupId === process.pid
    || identity.leaderPid === callerPgid || identity.processGroupId === callerPgid) {
    throw new Error(`Refusing to signal the caller's own process group: ${JSON.stringify(identity)}`);
  }
}

function captureAction(capture: ExecutionTargetCapture): CaptureAction {
  switch (capture.kind) {
    case 'captured': return 'continue';
    case 'gone': return 'observe_only';
    case 'unknown':
    case 'invalid': return 'finish_unconfirmed';
    default: {
      const exhaustive: never = capture;
      return exhaustive;
    }
  }
}

function closedFact(status: number | null, signal: NodeJS.Signals | null = null): CloseFact {
  return { kind: 'closed', status, signal };
}

function unconfirmedFact(error?: unknown): CloseFact {
  return error === undefined
    ? { kind: 'unconfirmed', reason: 'deadline' }
    : { kind: 'unconfirmed', reason: 'error', error };
}

function encodeEvidence(value: unknown, seen = new Map<object, string>(), at = '$'): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'undefined') return { $type: 'undefined' };
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
  if (typeof value !== 'object') return String(value);
  const previous = seen.get(value);
  if (previous !== undefined) return { $ref: previous };
  seen.set(value, at);
  if (value instanceof Error) {
    const encoded: Record<string, unknown> = {
      $type: value instanceof AggregateError ? 'AggregateError' : 'Error',
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause' || key === 'errors') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable) encoded[String(key)] = encodeEvidence(Reflect.get(value, key), seen, `${at}.${String(key)}`);
    }
    if ('cause' in value) encoded.cause = encodeEvidence(value.cause, seen, `${at}.cause`);
    if (value instanceof AggregateError) encoded.errors = encodeEvidence(value.errors, seen, `${at}.errors`);
    return encoded;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => encodeEvidence(item, seen, `${at}.${index}`));
  }
  const encoded: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable && typeof key === 'string') {
      encoded[key] = encodeEvidence(Reflect.get(value, key), seen, `${at}.${key}`);
    }
  }
  return encoded;
}

function validateReady(raw: unknown, mode: string, root: string): ReadyFact {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('PTY ready identity is not an object');
  }
  const candidate = raw as Record<string, unknown>;
  const validPid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 1;
  if (!validPid(candidate.pid) || !validPid(candidate.processGroupId)
    || candidate.pid !== candidate.processGroupId || typeof candidate.cwd !== 'string'
    || candidate.mode !== mode || (candidate.groupChildPid !== undefined && !validPid(candidate.groupChildPid))) {
    throw new Error(`PTY ready identity failed validation: ${JSON.stringify(raw)}`);
  }
  if (fs.realpathSync(candidate.cwd) !== fs.realpathSync(root)) {
    throw new Error(`PTY fixture cwd mismatch: ${candidate.cwd}`);
  }
  return {
    pid: candidate.pid,
    processGroupId: candidate.processGroupId,
    cwd: candidate.cwd,
    mode: candidate.mode,
    ...(candidate.groupChildPid !== undefined ? { groupChildPid: candidate.groupChildPid } : {}),
  };
}

async function waitForReady(
  readyPath: string,
  deadline: number,
  readReady: (file: string) => unknown,
  stopped: Promise<void>,
  isStopped: () => boolean,
): Promise<unknown> {
  for (;;) {
    if (fs.existsSync(readyPath)) return readReady(readyPath);
    if (isStopped()) throw new Error('ready handshake interrupted by session stop');
    if (Date.now() >= deadline) throw new Error('PTY fixture ready handshake timed out');
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>(resolve => { timer = setTimeout(resolve, READY_POLL_MS); }),
        stopped,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function emptySessionResult(exitedPath: string, evidencePath: string): ConfigRepairSessionResult {
  return {
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    exitedPath,
    evidencePath,
    execution: { kind: 'not_started' },
    wrapper: { close: { kind: 'not_started' } },
    streams: {
      stdin: { close: { kind: 'not_started' }, ended: false, destroyed: false },
      stdout: { close: { kind: 'not_started' }, ended: false, destroyed: false },
      stderr: { close: { kind: 'not_started' }, ended: false, destroyed: false },
    },
    laterStops: [],
    attempts: [],
    errors: [],
    lateFacts: [],
    retainedListeners: [],
  };
}

function writeSessionEvidence(result: ConfigRepairSessionResult): void {
  fs.writeFileSync(result.evidencePath, `${JSON.stringify(encodeEvidence({ result }), null, 2)}\n`);
}

function throwBeforeStart(
  result: ConfigRepairSessionResult,
  message: string,
  cause: unknown,
): never {
  const snapshot: ConfigRepairSessionResult = {
    ...result,
    firstStop: { reason: message, cause },
    errors: [{ operation: message, error: cause }],
  };
  const primary = new ConfigRepairSessionError(message, snapshot, { cause });
  try {
    writeSessionEvidence(snapshot);
  } catch (recording) {
    throw Object.assign(
      new AggregateError([primary, recording], 'Session and evidence recording failed', { cause: primary }),
      { result: snapshot, evidence: { result: snapshot } },
    );
  }
  throw primary;
}

export async function runConfigRepairSession(
  workspace: ConfigRepairWorkspace,
  args: string[],
  answers: InteractiveAnswer[],
  signal: AbortSignal,
  withKey = false,
  options: SessionOptions = {},
): Promise<ConfigRepairSessionResult> {
  const exitedPath = path.join(workspace.root, `.session-exited-${randomUUID()}.json`);
  const evidencePath = path.join(workspace.root, 'session-evidence.json');
  const baseResult = emptySessionResult(exitedPath, evidencePath);
  if (signal.aborted) {
    return throwBeforeStart(baseResult, 'session cancelled before spawn', signal.reason);
  }

  const mode = options.mode ?? 'cli';
  const readyPath = path.join(workspace.root, `.session-ready-${randomUUID()}.json`);
  const modeArgs = mode === 'cli'
    ? [cliPath, ...args]
    : [String(options.lifetimeMs ?? 5_000)];
  const command = [process.execPath, fixturePath, readyPath, exitedPath, mode, ...modeArgs];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawnPty ?? spawnPty)(
      command,
      configRepairEnv(workspace.root, workspace.home, withKey),
      workspace.root,
    );
  } catch (error) {
    return throwBeforeStart(baseResult, 'PTY spawn failed', error);
  }
  const deadline = Date.now() + (options.timeoutMs ?? CLI_CHILD_TIMEOUT_MS);
  const captureTarget = options.captureTarget ?? captureExecutionTarget;
  const observeTarget = options.observeTarget ?? observeExecutionTarget;
  const terminateTarget = options.terminateTarget ?? terminateExecutionTarget;
  const terminateWrapper = options.terminateWrapper ?? terminateExecutionTarget;
  let stdout = '';
  let stderr = '';
  let status: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let answerIndex = 0;
  let promptTail = '';
  let responseTimer: NodeJS.Timeout | undefined;
  let pendingAnswer: { index: number } | undefined;
  let writing = false;
  let acceptInput = true;
  let ready: ReadyFact | undefined;
  let readyRaw: unknown;
  let capture: ExecutionTargetCapture | undefined;
  let observation: ExecutionTargetObservation | undefined;
  let termination: ExecutionTerminationOutcome | undefined;
  let wrapperCapture: ExecutionTargetCapture | undefined;
  let wrapperObservation: ExecutionTargetObservation | undefined;
  let wrapperTermination: ExecutionTerminationOutcome | undefined;
  let wrapperClose: CloseFact = { kind: 'not_started' };
  let wrapperError: unknown;
  let firstStop: StopFact | undefined;
  const laterStops: StopFact[] = [];
  const attempts: CleanupAttempt[] = [];
  const errors: ErrorFact[] = [];
  const lateFacts: unknown[] = [];
  const retainedListeners: string[] = [];
  let observationStoppedAt: string | undefined;
  let finalized = false;
  let retentionCode = 'unconfirmed_process_group';
  const streamState = {
    stdin: { close: { kind: 'not_started' } as CloseFact, ended: false, destroyed: false },
    stdout: { close: { kind: 'not_started' } as CloseFact, ended: false, destroyed: false },
    stderr: { close: { kind: 'not_started' } as CloseFact, ended: false, destroyed: false },
  };

  let wakeStop!: () => void;
  const stopped = new Promise<void>(resolve => { wakeStop = resolve; });
  const requestStop = (reason: string, cause: unknown): void => {
    const fact = { reason, cause };
    if (firstStop === undefined) {
      firstStop = fact;
      wakeStop();
    } else {
      laterStops.push(fact);
    }
  };
  const recordError = (operation: string, error: unknown): void => {
    errors.push({ operation, error });
  };
  const recordAttempt = (
    resource: CleanupAttempt['resource'],
    operation: string,
    outcome: unknown,
  ): void => {
    attempts.push({ resource, operation, outcome });
  };

  const makeResult = (): ConfigRepairSessionResult => ({
    status,
    signal: exitSignal,
    stdout,
    stderr,
    ...(ready !== undefined ? { ready } : {}),
    ...(readyRaw !== undefined ? { readyRaw } : {}),
    exitedPath,
    evidencePath,
    execution: {
      kind: observation?.kind === 'gone' ? 'gone' : 'unconfirmed',
      ...(capture !== undefined ? { capture } : {}),
      ...(observation !== undefined ? { observation } : {}),
      ...(termination !== undefined ? { termination } : {}),
    },
    wrapper: {
      close: wrapperClose,
      ...(wrapperCapture !== undefined ? { capture: wrapperCapture } : {}),
      ...(wrapperObservation !== undefined ? { observation: wrapperObservation } : {}),
      ...(wrapperTermination !== undefined ? { termination: wrapperTermination } : {}),
    },
    streams: {
      stdin: { ...streamState.stdin },
      stdout: { ...streamState.stdout },
      stderr: { ...streamState.stderr },
    },
    ...(firstStop !== undefined ? { firstStop } : {}),
    laterStops: [...laterStops],
    attempts: [...attempts],
    errors: [...errors],
    lateFacts: [...lateFacts],
    retainedListeners: [...retainedListeners],
    ...(observationStoppedAt !== undefined ? { observationStoppedAt } : {}),
  });

  const persistLateFact = (fact: unknown): void => {
    lateFacts.push(fact);
    let writeError: unknown;
    try {
      writeSessionEvidence(makeResult());
    } catch (error) {
      writeError = error;
    }
    try {
      workspace.retention.retain({
        code: retentionCode,
        error: writeError,
        evidence: { lateFact: fact, writeError, result: makeResult() },
      });
    } catch (recording) {
      // Late EventEmitter callbacks have no owner to throw into. Preserve the
      // complete fact and both write failures on stderr instead.
      console.error('Failed to persist late PTY session fact', encodeEvidence({
        fact, writeError, recording, result: makeResult(),
      }));
    }
  };
  const recordLate = (resource: string, event: string, value?: unknown): void => {
    const fact = { at: new Date().toISOString(), resource, event, value };
    if (finalized) persistLateFact(fact);
    else lateFacts.push(fact);
  };
  const releaseRetainedListeners = (...labels: string[]): void => {
    for (const label of labels) {
      const index = retainedListeners.indexOf(label);
      if (index >= 0) retainedListeners.splice(index, 1);
    }
  };

  let wakeClosed!: () => void;
  const closed = new Promise<void>(resolve => { wakeClosed = resolve; });
  const onChildError = (error: unknown): void => {
    wrapperError = error;
    recordError('wrapper.error', error);
    requestStop('PTY wrapper emitted error', error);
    if (finalized) recordLate('wrapper', 'error', error);
  };
  const onChildClose = (code: number | null, codeSignal: NodeJS.Signals | null): void => {
    status = code;
    exitSignal = codeSignal;
    wrapperClose = closedFact(code, codeSignal);
    wakeClosed();
    if (ready === undefined && firstStop === undefined && !fs.existsSync(readyPath)) {
      requestStop(
        'PTY wrapper closed before publishing a valid ready identity',
        new Error('PTY wrapper exited before publishing its ready identity'),
      );
    }
    if (finalized) {
      child.off('error', onChildError);
      child.off('close', onChildClose);
      releaseRetainedListeners('wrapper:error', 'wrapper:close');
      recordLate('wrapper', 'close', { status: code, signal: codeSignal });
    }
  };
  child.on('error', onChildError);
  child.on('close', onChildClose);

  const streamHandlers: Array<{
    resource: 'stdin' | 'stdout' | 'stderr';
    stream: NodeJS.EventEmitter;
    event: 'error' | 'close' | 'end' | 'finish';
    handler: (...args: any[]) => void;
  }> = [];
  const streamClosures = {} as Record<'stdin' | 'stdout' | 'stderr', Promise<void>>;
  const onStream = (
    resource: 'stdin' | 'stdout' | 'stderr',
    stream: NodeJS.EventEmitter,
  ): void => {
    let wakeStreamClosed!: () => void;
    streamClosures[resource] = new Promise<void>(resolve => { wakeStreamClosed = resolve; });
    const onError = (error: unknown): void => {
      streamState[resource].close = unconfirmedFact(error);
      recordError(`${resource}.error`, error);
      requestStop(`PTY ${resource} emitted error`, error);
      if (finalized) recordLate(resource, 'error', error);
    };
    const onClose = (): void => {
      streamState[resource].close = closedFact(null);
      wakeStreamClosed();
      if (finalized) {
        stream.off('error', onError);
        stream.off('close', onClose);
        releaseRetainedListeners(`${resource}:error`, `${resource}:close`);
        recordLate(resource, 'close');
      }
    };
    const onEnd = (): void => {
      streamState[resource].ended = true;
      if (finalized) recordLate(resource, resource === 'stdin' ? 'finish' : 'end');
    };
    stream.on('error', onError);
    stream.on('close', onClose);
    stream.on(resource === 'stdin' ? 'finish' : 'end', onEnd);
    streamHandlers.push(
      { resource, stream, event: 'error', handler: onError },
      { resource, stream, event: 'close', handler: onClose },
      { resource, stream, event: resource === 'stdin' ? 'finish' : 'end', handler: onEnd },
    );
  };
  onStream('stdin', child.stdin);
  onStream('stdout', child.stdout);
  onStream('stderr', child.stderr);

  const onStdout = (chunk: string): void => {
    stdout += chunk;
    if (!acceptInput || pendingAnswer !== undefined || writing || answerIndex >= answers.length) return;
    promptTail += chunk.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    const answer = answers[answerIndex];
    answer.prompt.lastIndex = 0;
    const match = answer.prompt.exec(promptTail);
    if (!match) return;
    // Consume this prompt occurrence, not merely the current tail string.
    // Later noise may change the tail, but it must not make an already
    // consumed prompt eligible for the next answer.
    promptTail = promptTail.slice(match.index + match[0].length);
    pendingAnswer = { index: answerIndex };
    responseTimer = setTimeout(() => {
      responseTimer = undefined;
      const pending = pendingAnswer;
      if (!acceptInput || firstStop !== undefined || pending === undefined) return;
      writing = true;
      try {
        child.stdin.write(`${answers[pending.index].value}\n`, error => {
          writing = false;
          if (error) {
            recordError('stdin.write_callback', error);
            requestStop('PTY stdin write callback failed', error);
            return;
          }
          if (pendingAnswer === pending) {
            answerIndex = pending.index + 1;
            pendingAnswer = undefined;
          }
        });
      } catch (error) {
        writing = false;
        recordError('stdin.write', error);
        requestStop('PTY stdin write failed', error);
      }
    }, PTY_RESPONSE_DELAY_MS);
  };
  const onStderr = (chunk: string): void => { stderr += chunk; };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);

  const onAbort = (): void => requestStop('session cancelled by caller', signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(
    () => requestStop('interactive session timed out', new Error('session timeout')),
    Math.max(1, deadline - Date.now()),
  );

  if (child.pid !== undefined) {
    try {
      const identity = { leaderPid: child.pid, processGroupId: child.pid };
      assertNotCallerProcessGroup(identity);
      wrapperCapture = captureExecutionTarget(identity);
      recordAttempt('wrapper', 'capture', wrapperCapture);
    } catch (error) {
      recordError('wrapper.capture', error);
      requestStop('PTY wrapper identity capture failed', error);
    }
  } else {
    requestStop('PTY wrapper has no process identity', new Error('spawn returned no child PID'));
  }
  if (signal.aborted) onAbort();

  try {
    readyRaw = await waitForReady(
      readyPath,
      Math.min(deadline, Date.now() + READY_TIMEOUT_MS),
      options.readReady ?? (file => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown),
      stopped,
      () => firstStop !== undefined,
    );
    ready = validateReady(readyRaw, mode, workspace.root);
    try {
      const identity = { leaderPid: ready.pid, processGroupId: ready.processGroupId };
      assertNotCallerProcessGroup(identity);
      capture = captureTarget(identity);
      recordAttempt('worker_group', 'capture', capture);
    } catch (error) {
      recordError('worker_group.capture', error);
      requestStop('PTY worker identity capture failed', error);
    }

    if (capture !== undefined && firstStop === undefined) {
      const action = captureAction(capture);
      if (action === 'finish_unconfirmed') {
        requestStop(
          `PTY worker capture is ${capture.kind}`,
          new Error(`Cannot confirm ownership of PTY worker: ${capture.kind}`, { cause: capture }),
        );
      } else {
        options.onReady?.(ready);
        if (signal.aborted) onAbort();
      }
    }
    if (firstStop === undefined) {
      await Promise.race([closed, stopped]);
    }
  } catch (error) {
    requestStop('PTY session driver failed', error);
  }

  // The single cleanup entry begins here. Work cancellation never cancels it.
  acceptInput = false;
  clearTimeout(timeout);
  signal.removeEventListener('abort', onAbort);
  if (responseTimer) clearTimeout(responseTimer);
  responseTimer = undefined;
  pendingAnswer = undefined;

  const observeWorker = (): void => {
    if (capture === undefined || !('target' in capture)) return;
    try {
      observation = observeTarget(capture.target);
      recordAttempt('worker_group', 'observe', observation);
    } catch (error) {
      recordError('worker_group.observe', error);
    }
  };
  const disposeWorker = async (): Promise<void> => {
    if (capture === undefined) return;
    const action = captureAction(capture);
    observeWorker();
    if (wrapperClose.kind === 'closed' && observation?.kind !== 'gone') {
      requestStop(
        'PTY wrapper closed before the worker group was confirmed gone',
        new Error('PTY wrapper close is not worker group termination evidence'),
      );
    }
    if (action !== 'continue' || observation?.kind === 'gone' || !('target' in capture)) return;
    try {
      termination = await terminateTarget(capture.target, 'caller_requested');
      recordAttempt('worker_group', 'terminate', termination);
    } catch (error) {
      recordError('worker_group.terminate', error);
    }
    observeWorker();
  };

  const observeWrapper = (): void => {
    if (wrapperCapture === undefined || !('target' in wrapperCapture)) return;
    try {
      wrapperObservation = observeExecutionTarget(wrapperCapture.target);
      recordAttempt('wrapper', 'observe', wrapperObservation);
    } catch (error) {
      recordError('wrapper.observe', error);
    }
  };
  const disposeWrapper = async (): Promise<void> => {
    if (wrapperClose.kind === 'closed') {
      observeWrapper();
      return;
    }
    if (wrapperCapture?.kind === 'captured') {
      observeWrapper();
      if (wrapperObservation?.kind !== 'gone') {
        try {
          wrapperTermination = await terminateWrapper(wrapperCapture.target, 'caller_requested');
          recordAttempt('wrapper', 'terminate', wrapperTermination);
        } catch (error) {
          recordError('wrapper.terminate', error);
        }
      }
      observeWrapper();
      return;
    }
    observeWrapper();
    if (wrapperCapture?.kind !== 'gone' && wrapperObservation?.kind !== 'gone'
      && child.exitCode === null && child.signalCode === null) {
      try {
        const sent = child.kill('SIGKILL');
        recordAttempt('wrapper', 'direct_child_kill_SIGKILL', sent);
      } catch (error) {
        recordError('wrapper.direct_child_kill_SIGKILL', error);
      }
    }
  };

  const cleanupDeadline = Date.now() + WRAPPER_CLOSE_TIMEOUT_MS;
  let closeTimer: NodeJS.Timeout | undefined;
  const wrapperWait = Promise.race([
    closed.then(() => 'closed' as const),
    new Promise<'deadline'>(resolve => {
      closeTimer = setTimeout(() => resolve('deadline'), Math.max(0, cleanupDeadline - Date.now()));
    }),
  ]).then(outcome => {
    if (outcome === 'deadline' && wrapperClose.kind !== 'closed') {
      wrapperClose = unconfirmedFact(wrapperError);
    }
    recordAttempt('wrapper', 'close_wait', outcome);
  }).catch(error => {
    wrapperClose = unconfirmedFact(error);
    recordError('wrapper.close_wait', error);
  });
  const settlements = await Promise.allSettled([disposeWorker(), disposeWrapper(), wrapperWait]);
  if (closeTimer) clearTimeout(closeTimer);
  for (const [index, settlement] of settlements.entries()) {
    if (settlement.status === 'rejected') {
      recordError(['worker_group.dispose', 'wrapper.dispose', 'wrapper.close_wait'][index], settlement.reason);
    }
  }

  for (const resource of ['stdin', 'stdout', 'stderr'] as const) {
    if (streamState[resource].close.kind === 'closed') continue;
    const stream = child[resource];
    try {
      stream.destroy();
      streamState[resource].destroyed = true;
      recordAttempt(resource, 'destroy', 'called');
    } catch (error) {
      recordError(`${resource}.destroy`, error);
    }
  }
  let streamCloseTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(Object.values(streamClosures)),
    new Promise<void>(resolve => {
      streamCloseTimer = setTimeout(resolve, Math.max(0, cleanupDeadline - Date.now()));
    }),
  ]);
  if (streamCloseTimer) clearTimeout(streamCloseTimer);
  for (const resource of ['stdin', 'stdout', 'stderr'] as const) {
    if (streamState[resource].close.kind !== 'closed') {
      streamState[resource].close = unconfirmedFact(
        streamState[resource].close.kind === 'unconfirmed' && streamState[resource].close.reason === 'error'
          ? streamState[resource].close.error
          : undefined,
      );
    }
  }
  const isClosed = (fact: CloseFact): boolean => fact.kind === 'closed';
  if (!isClosed(wrapperClose)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.unref();
        recordAttempt('wrapper', 'unref', 'called');
      } catch (error) {
        recordError('wrapper.unref', error);
      }
    }
  }

  const workerGone = observation?.kind === 'gone';
  const streamsClosed = Object.values(streamState).every(stream => stream.close.kind === 'closed');
  const allConfirmed = workerGone && isClosed(wrapperClose) && streamsClosed;
  if (!allConfirmed) {
    observationStoppedAt = new Date().toISOString();
    retentionCode = !workerGone
      ? 'unconfirmed_process_group'
      : !isClosed(wrapperClose) ? 'unconfirmed_wrapper' : 'unconfirmed_streams';
    if (!isClosed(wrapperClose)) retainedListeners.push('wrapper:error', 'wrapper:close');
    else {
      child.off('error', onChildError);
      child.off('close', onChildClose);
    }
    for (const registration of streamHandlers) {
      if (registration.event === 'error' || registration.event === 'close') {
        if (streamState[registration.resource].close.kind !== 'closed') {
          retainedListeners.push(`${registration.resource}:${registration.event}`);
        } else {
          registration.stream.off(registration.event, registration.handler);
        }
      } else {
        registration.stream.off(registration.event, registration.handler);
      }
    }
  } else {
    child.off('error', onChildError);
    child.off('close', onChildClose);
    for (const registration of streamHandlers) {
      registration.stream.off(registration.event, registration.handler);
    }
  }

  // Keep collecting output throughout worker/wrapper termination and stream
  // close. Detach only at the confirmed end or the explicit observation
  // deadline; output already received before this point is part of the result.
  child.stdout.off('data', onStdout);
  child.stderr.off('data', onStderr);
  const result = makeResult();
  finalized = true;
  let evidenceError: unknown;
  try {
    writeSessionEvidence(result);
  } catch (error) {
    evidenceError = error;
    recordError('evidence.write', error);
  }
  const evidenceSnapshot = { result: makeResult(), evidenceError };
  const primaryCause = firstStop?.cause;
  const primary = new ConfigRepairSessionError(
    allConfirmed
      ? `${firstStop?.reason ?? 'interactive CLI exited'} at answer ${answerIndex}/${answers.length}`
      : workerGone
        ? 'PTY wrapper or streams are not confirmed closed'
        : 'PTY execution group is not confirmed gone',
    result,
    { cause: primaryCause },
  );

  if (!allConfirmed) {
    try {
      workspace.retention.retain({ code: retentionCode, error: primary, evidence: evidenceSnapshot });
    } catch (recording) {
      throw Object.assign(
        new AggregateError(
          [primary, ...(evidenceError === undefined ? [] : [evidenceError]), recording],
          'Session, evidence, and retention recording failed',
          { cause: primary },
        ),
        { result, evidence: evidenceSnapshot },
      );
    }
    if (evidenceError !== undefined) {
      throw Object.assign(
        new AggregateError([primary, evidenceError], 'Session and evidence recording failed', { cause: primary }),
        { result, evidence: evidenceSnapshot },
      );
    }
    throw primary;
  }

  if (evidenceError !== undefined) {
    throw Object.assign(
      new AggregateError([primary, evidenceError], 'Session and evidence recording failed', { cause: primary }),
      { result, evidence: evidenceSnapshot },
    );
  }
  if (firstStop !== undefined || answerIndex < answers.length) throw primary;
  return result;
}

export type ConfigRepairServerBehavior = 'sse' | 'reject' | 'hang';
export interface ConfigRepairRequest {
  readonly model?: string;
  readonly headers: http.IncomingHttpHeaders;
}

export interface ConfigRepairServer {
  readonly baseUrl: string;
  readonly requests: readonly ConfigRepairRequest[];
  resetRequests(): void;
  setBehavior(behavior: ConfigRepairServerBehavior): void;
  close(): Promise<void>;
}

interface ConfigRepairServerOptions {
  /** Test-only real-listen boundary, used to occupy a selected port for EADDRINUSE. */
  readonly listen?: (server: http.Server, onListening: () => void) => void;
  /** Test-only observation of the real server for deterministic event/close faults. */
  readonly onListening?: (server: http.Server) => void;
  /** Test-only delivery boundary; the listener and its sockets are always real. */
  readonly readAddress?: (server: http.Server) => ReturnType<http.Server['address']>;
  /** Test-only request persistence boundary. */
  readonly appendRequest?: (recordPath: string, request: ConfigRepairRequest) => void;
}

type ConfigRepairServerState = 'created' | 'listening' | 'closing' | 'closed' | 'unconfirmed';
const SERVER_CLOSE_TIMEOUT_MS = 5_000;

export async function startConfigRepairServer(
  options: ConfigRepairServerOptions = {},
): Promise<ConfigRepairServer> {
  const { dir, retention } = createScopedTempDirSync('config-repair-http-');
  const requestLogPath = path.join(dir, 'requests.jsonl');
  const appendRequest = options.appendRequest ?? ((recordPath: string, request: ConfigRepairRequest) => {
    fs.appendFileSync(recordPath, `${JSON.stringify(request)}\n`, 'utf8');
  });
  const requests: ConfigRepairRequest[] = [];
  const ownerErrors: Array<{ operation: string; error: unknown }> = [];
  const lateFacts: unknown[] = [];
  const sockets = new Set<Socket>();
  const socketClosures = new Map<Socket, Promise<void>>();
  const closeFacts: {
    state: ConfigRepairServerState;
    callback: 'not_started' | 'not_listening' | 'pending' | 'closed' | 'error' | 'deadline';
    callbackError?: unknown;
    closeRequested: boolean;
    closeAllConnections: boolean;
    socketDisposals: Array<{ operation: string; outcome: unknown }>;
    retentionCompleted: boolean;
  } = {
    state: 'created',
    callback: 'not_started',
    closeRequested: false,
    closeAllConnections: false,
    socketDisposals: [],
    retentionCompleted: false,
  };
  let behavior: ConfigRepairServerBehavior = 'sse';
  let closing: Promise<void> | undefined;
  let finalized = false;

  const evidence = () => ({
    state: closeFacts.state,
    requests: [...requests],
    closeFacts: { ...closeFacts, socketDisposals: [...closeFacts.socketDisposals] },
    errors: [...ownerErrors],
    lateFacts: [...lateFacts],
  });
  const persistLateFact = (fact: unknown): void => {
    let recording: unknown;
    try {
      retention.retain({
        code: 'http_fixture_failed',
        error: fact,
        evidence: { ...evidence(), lateFact: fact },
      });
    } catch (error) {
      recording = error;
    }
    if (recording !== undefined) {
      // EventEmitter callbacks have no caller to throw into. Keep both facts visible.
      console.error('Failed to persist late HTTP fixture fact', encodeEvidence({ fact, recording }));
    }
  };
  const recordLate = (resource: string, event: string, value?: unknown): void => {
    const fact = { at: new Date().toISOString(), resource, event, value };
    lateFacts.push(fact);
    if (finalized) persistLateFact(fact);
  };
  const recordError = (operation: string, error: unknown): void => {
    if (!ownerErrors.some(entry => entry.operation === operation && entry.error === error)) {
      ownerErrors.push({ operation, error });
    }
  };
  const fail = (operation: string, error: unknown): void => {
    recordError(operation, error);
    recordLate('owner', 'error', { operation, error });
    if (!finalized) void closeOnce();
  };

  function closeOnce(): Promise<void> {
    if (closing === undefined) {
      closing = closeOwnedServer();
      // Attach rejection handling immediately, while returning the original promise
      // to every caller so afterAll observes the exact same settlement.
      void closing.catch(error => { recordLate('close', 'rejected', error); });
    }
    return closing;
  }

  const server = http.createServer((request, response) => {
    request.on('error', error => { fail('request.error', error); });
    response.on('error', error => { fail('response.error', error); });
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        let model: string | undefined;
        try {
          const parsed = JSON.parse(body) as { model?: unknown };
          if (typeof parsed.model === 'string') model = parsed.model;
        } catch { /* non-JSON probe bodies still count as requests */ }
        const observed = { ...(model !== undefined && { model }), headers: request.headers };
        appendRequest(requestLogPath, observed);
        requests.push(observed);
        if (behavior === 'hang') return;
        if (behavior === 'reject') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'controlled provider rejection' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const frames = [
          { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
          { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
        response.end('data: [DONE]\n\n');
      } catch (error) {
        fail('request.record_or_response', error);
        response.destroy();
      }
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    let confirmClosed!: () => void;
    socketClosures.set(socket, new Promise<void>(resolve => { confirmClosed = resolve; }));
    socket.on('error', error => { fail('socket.error', error); });
    socket.once('close', () => {
      sockets.delete(socket);
      confirmClosed();
      recordLate('socket', 'close');
    });
  });
  server.on('error', error => { fail('server.error', error); });
  server.on('close', () => { recordLate('server', 'close'); });

  const failure = (): AggregateError => {
    const first = ownerErrors[0]?.error ?? new Error('HTTP fixture close was not confirmed');
    return Object.assign(
      new AggregateError(
        ownerErrors.map(entry => entry.error),
        'Config repair HTTP fixture failed',
        { cause: first },
      ),
      { evidence: evidence() },
    );
  };
  const retainFailure = (): never => {
    const primary = failure();
    try {
      retention.retain({ code: 'http_fixture_failed', error: primary, evidence: evidence() });
    } catch (recording) {
      throw Object.assign(
        new AggregateError(
          [primary, recording],
          'HTTP fixture and retention recording failed',
          { cause: primary.cause },
        ),
        { evidence: evidence() },
      );
    }
    throw primary;
  };

  async function closeOwnedServer(): Promise<void> {
    if (finalized) return;
    closeFacts.state = 'closing';
    let resolveCallback!: () => void;
    const callback = new Promise<void>(resolve => { resolveCallback = resolve; });
    if (server.listening) {
      closeFacts.callback = 'pending';
      try {
        server.close(error => {
          if (error) {
            closeFacts.callback = 'error';
            closeFacts.callbackError = error;
            recordError('server.close', error);
          } else {
            closeFacts.callback = 'closed';
          }
          recordLate('server', 'close_callback', error);
          resolveCallback();
        });
        closeFacts.closeRequested = true;
      } catch (error) {
        closeFacts.callback = 'error';
        closeFacts.callbackError = error;
        recordError('server.close', error);
        resolveCallback();
      }
    } else {
      closeFacts.callback = 'not_listening';
      resolveCallback();
    }
    try {
      server.closeAllConnections();
      closeFacts.closeAllConnections = true;
    } catch (error) {
      recordError('server.closeAllConnections', error);
    }

    let timer: NodeJS.Timeout | undefined;
    const confirmation = await Promise.race([
      Promise.all([callback, ...socketClosures.values()]).then(() => 'confirmed' as const),
      new Promise<'deadline'>(resolve => {
        timer = setTimeout(() => resolve('deadline'), SERVER_CLOSE_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (confirmation === 'deadline') {
      const callbackClosed = (): boolean => closeFacts.callback === 'closed';
      closeFacts.callback = callbackClosed() ? 'closed' : 'deadline';
      closeFacts.state = 'unconfirmed';
      recordError(
        'server.close_deadline',
        new Error(`HTTP fixture close was not confirmed within ${SERVER_CLOSE_TIMEOUT_MS}ms`),
      );
      for (const socket of sockets) {
        try {
          socket.destroy();
          closeFacts.socketDisposals.push({ operation: 'socket.destroy', outcome: 'called' });
        } catch (error) {
          closeFacts.socketDisposals.push({ operation: 'socket.destroy', outcome: error });
          recordError('socket.destroy', error);
        }
      }
    } else {
      closeFacts.state = closeFacts.callback === 'error' ? 'unconfirmed' : 'closed';
    }

    if (ownerErrors.length === 0 && closeFacts.state === 'closed') {
      try {
        retention.complete();
        closeFacts.retentionCompleted = true;
      } catch (error) {
        recordError('retention.complete', error);
      }
    }
    if (ownerErrors.length === 0 && closeFacts.retentionCompleted) {
      try {
        await cleanupTempDir(dir);
      } catch (error) {
        recordError('retention.cleanup', error);
      }
    }
    finalized = true;
    if (ownerErrors.length > 0 || closeFacts.state !== 'closed') retainFailure();
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onStartupError = (error: Error): void => { reject(error); };
      server.once('error', onStartupError);
      const onListening = (): void => {
        server.off('error', onStartupError);
        closeFacts.state = 'listening';
        resolve();
      };
      if (options.listen) options.listen(server, onListening);
      else server.listen(0, '127.0.0.1', onListening);
    });
    options.onListening?.(server);
    const address = (options.readAddress ?? (owned => owned.address()))(server);
    if (address === null || typeof address === 'string') throw new Error('integration server has no port');
    return {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requests,
      resetRequests() { requests.length = 0; },
      setBehavior(next) { behavior = next; },
      close: closeOnce,
    };
  } catch (error) {
    recordError('server.start', error);
    await closeOnce();
    throw error;
  }
}

export function readConfigRepairRaw(root: string): {
  text: string;
  document: {
    revision: number;
    primary: Record<string, unknown>;
    fallbacks?: Array<Record<string, unknown>>;
  };
} {
  const configPath = path.join(root, '.chestnut', 'llm', 'config.yaml');
  const text = fs.readFileSync(configPath, 'utf8');
  return { text, document: yaml.load(text) as ReturnType<typeof readConfigRepairRaw>['document'] };
}
