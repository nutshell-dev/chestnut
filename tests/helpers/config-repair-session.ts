import * as fs from 'node:fs';
import * as http from 'node:http';
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
  createTrackedTempDirSync,
} from '../utils/temp.js';
import type { RetentionScope } from '../utils/resource-retention.js';

export const cliPath = path.resolve(__dirname, '../../dist/cli.js');
export const CONFIG_REPAIR_REF = 'PHASE2221_INTEGRATION_KEY';
const CLI_CHILD_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 5_000;
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

export function createConfigRepairWorkspace(baseUrl: string, timeoutMs?: number): ConfigRepairWorkspace {
  const { dir: root, retention } = createScopedTempDirSync('chestnut-config-repair-integration-');
  const home = createTrackedTempDirSync('chestnut-config-repair-home-');
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
  return { root, home, retention };
}

export async function finishConfigRepairCase<T>(
  workspace: ConfigRepairWorkspace,
  runAndConfirm: () => Promise<T>,
): Promise<T> {
  const retainAndThrow = (primary: unknown): never => {
    try {
      workspace.retention.retain({ code: 'test_failed', error: primary });
    } catch (recording) {
      throw new AggregateError([primary, recording], 'Test and retention recording failed', { cause: primary });
    }
    throw primary;
  };
  return withCleanupPreservingError(async () => {
    try {
      const value = await runAndConfirm();
      workspace.retention.complete();
      return value;
    } catch (primary) {
      return retainAndThrow(primary);
    }
  }, async () => {
    try {
      await cleanupTempDir(workspace.root);
      await cleanupTempDir(workspace.home);
    } catch (cleanup) {
      return retainAndThrow(cleanup);
    }
  });
}

export function configRepairEnv(root: string, home: string, withKey: boolean): NodeJS.ProcessEnv {
  const env = {
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

export interface ConfigRepairSessionResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ready?: ReadyFact;
  readonly exitedPath: string;
  readonly execution: {
    readonly kind: 'not_started' | 'gone' | 'unconfirmed';
    readonly capture?: ExecutionTargetCapture;
    readonly observation?: ExecutionTargetObservation;
    readonly termination?: ExecutionTerminationOutcome;
  };
}

export class ConfigRepairSessionError extends Error {
  constructor(message: string, readonly result: ConfigRepairSessionResult, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigRepairSessionError';
  }
}

export interface SessionOptions {
  readonly mode?: 'cli' | 'finite' | 'orphan';
  readonly lifetimeMs?: number;
  readonly timeoutMs?: number;
  readonly onReady?: (ready: ReadyFact) => void;
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

async function waitForReady(
  child: ChildProcessWithoutNullStreams,
  readyPath: string,
  deadline: number,
): Promise<ReadyFact> {
  for (;;) {
    if (fs.existsSync(readyPath)) {
      return JSON.parse(fs.readFileSync(readyPath, 'utf8')) as ReadyFact;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('PTY wrapper exited before publishing its ready identity');
    }
    if (Date.now() >= deadline) throw new Error('PTY fixture ready handshake timed out');
    await new Promise<void>(resolve => setTimeout(resolve, READY_POLL_MS));
  }
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
  const baseResult: ConfigRepairSessionResult = {
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    exitedPath,
    execution: { kind: 'not_started' },
  };
  if (signal.aborted) {
    throw new ConfigRepairSessionError('session cancelled before spawn', baseResult, { cause: signal.reason });
  }

  const mode = options.mode ?? 'cli';
  const readyPath = path.join(workspace.root, `.session-ready-${randomUUID()}.json`);
  const modeArgs = mode === 'cli'
    ? [cliPath, ...args]
    : [String(options.lifetimeMs ?? 5_000)];
  const command = [process.execPath, fixturePath, readyPath, exitedPath, mode, ...modeArgs];
  const child = spawnPty(command, configRepairEnv(workspace.root, workspace.home, withKey), workspace.root);
  const deadline = Date.now() + (options.timeoutMs ?? CLI_CHILD_TIMEOUT_MS);
  let stdout = '';
  let stderr = '';
  let status: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let answerIndex = 0;
  let lastPrompt = '';
  let responseTimer: NodeJS.Timeout | undefined;
  let capture: ExecutionTargetCapture | undefined;
  let termination: ExecutionTerminationOutcome | undefined;
  let terminationPromise: Promise<void> | undefined;
  let requested: { message: string; cause: unknown } | undefined;

  const makeResult = (
    kind: ConfigRepairSessionResult['execution']['kind'],
    ready?: ReadyFact,
    observation?: ExecutionTargetObservation,
  ): ConfigRepairSessionResult => ({
    status,
    signal: exitSignal,
    stdout,
    stderr,
    ...(ready !== undefined && { ready }),
    exitedPath,
    execution: {
      kind,
      ...(capture !== undefined && { capture }),
      ...(observation !== undefined && { observation }),
      ...(termination !== undefined && { termination }),
    },
  });
  const startTermination = (): void => {
    if (!requested || terminationPromise) return;
    if (capture?.kind === 'captured') {
      terminationPromise = terminateExecutionTarget(capture.target, 'caller_requested')
        .then(outcome => { termination = outcome; });
    }
  };
  const request = (message: string, cause: unknown): void => {
    if (requested) return;
    requested = { message, cause };
    startTermination();
  };
  const onAbort = (): void => request('session cancelled by caller', signal.reason);
  const timeout = setTimeout(() => request('interactive session timed out', new Error('session timeout')),
    Math.max(1, deadline - Date.now()));
  signal.addEventListener('abort', onAbort, { once: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    const plainTail = stdout.slice(-1_000).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    if (answerIndex >= answers.length || plainTail === lastPrompt
      || !answers[answerIndex].prompt.test(plainTail)) return;
    lastPrompt = plainTail;
    responseTimer = setTimeout(() => {
      if (answerIndex < answers.length && !requested) {
        child.stdin.write(`${answers[answerIndex++].value}\n`);
      }
    }, PTY_RESPONSE_DELAY_MS);
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, codeSignal) => {
      status = code;
      exitSignal = codeSignal;
      resolve();
    });
  });

  let ready: ReadyFact | undefined;
  try {
    ready = await waitForReady(child, readyPath, Math.min(deadline, Date.now() + READY_TIMEOUT_MS));
    if (fs.realpathSync(ready.cwd) !== fs.realpathSync(workspace.root)) {
      throw new Error(`PTY fixture cwd mismatch: ${ready.cwd}`);
    }
    capture = captureExecutionTarget({
      leaderPid: ready.pid,
      processGroupId: ready.processGroupId,
    });
    options.onReady?.(ready);
    if (signal.aborted) onAbort();
    startTermination();
    await closed;
    await terminationPromise;
  } catch (error) {
    if (capture?.kind === 'captured') {
      if (!terminationPromise) {
        terminationPromise = terminateExecutionTarget(capture.target, 'caller_requested')
          .then(outcome => { termination = outcome; });
      }
      try {
        await closed;
        await terminationPromise;
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'PTY driver and execution cleanup failed', { cause: error });
      }
      const observation = observeExecutionTarget(capture.target);
      if (observation.kind === 'gone') throw error;
      const result = makeResult('unconfirmed', ready, observation);
      const primary = new ConfigRepairSessionError(
        'PTY driver failed and the execution group is not confirmed gone', result, { cause: error },
      );
      try {
        workspace.retention.retain({
          code: 'unconfirmed_process_group',
          error: primary,
          evidence: { capture, observation, termination, ready, wrapper: { status, signal: exitSignal } },
        });
      } catch (recording) {
        throw new AggregateError([primary, recording], 'Session and retention recording failed', { cause: primary });
      }
      throw primary;
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* best effort after driver failure */ }
    }
    await closed.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
    if (responseTimer) clearTimeout(responseTimer);
  }

  const target = capture && 'target' in capture ? capture.target : undefined;
  const observation = target ? observeExecutionTarget(target) : undefined;
  if (observation?.kind !== 'gone') {
    const result = makeResult('unconfirmed', ready, observation);
    const primary = new ConfigRepairSessionError(
      `PTY execution group is not confirmed gone: ${observation?.kind ?? 'identity_invalid'}`, result,
    );
    try {
      workspace.retention.retain({
        code: 'unconfirmed_process_group',
        error: primary,
        evidence: { capture, observation, termination, ready, wrapper: { status, signal: exitSignal } },
      });
    } catch (recording) {
      throw new AggregateError([primary, recording], 'Session and retention recording failed', { cause: primary });
    }
    throw primary;
  }

  const result = makeResult('gone', ready, observation);
  if (requested) {
    throw new ConfigRepairSessionError(
      `${requested.message} at answer ${answerIndex}/${answers.length}: ${stdout}\n${stderr}`,
      result,
      { cause: requested.cause },
    );
  }
  if (answerIndex < answers.length) {
    throw new ConfigRepairSessionError(
      `interactive CLI exited after ${answerIndex}/${answers.length} answers`, result,
    );
  }
  return result;
}

export type ConfigRepairServerBehavior = 'sse' | 'reject' | 'hang';
export interface ConfigRepairRequest {
  readonly model?: string;
  readonly headers: http.IncomingHttpHeaders;
}

export interface ConfigRepairServer {
  readonly baseUrl: string;
  readonly requests: ConfigRepairRequest[];
  setBehavior(behavior: ConfigRepairServerBehavior): void;
  close(): Promise<void>;
}

export async function startConfigRepairServer(): Promise<ConfigRepairServer> {
  const requests: ConfigRepairRequest[] = [];
  let behavior: ConfigRepairServerBehavior = 'sse';
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let model: string | undefined;
      try {
        const parsed = JSON.parse(body) as { model?: unknown };
        if (typeof parsed.model === 'string') model = parsed.model;
      } catch { /* non-JSON probe bodies still count as requests */ }
      requests.push({ ...(model !== undefined && { model }), headers: request.headers });
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
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('integration server has no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setBehavior(next) { behavior = next; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
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
