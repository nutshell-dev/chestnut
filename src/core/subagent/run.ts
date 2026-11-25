// src/core/subagent/run.ts
/**
 * runSubagent — compatibility projection over the self-owned execution runner.
 * Resource assembly lives in the fixed driver; this module has no second run loop.
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { createAuditWriter } from '../../foundation/audit/index.js';
import { makeTraceId, type TraceId } from '../../foundation/audit/index.js';
import { formatErr, randomHex } from '../../foundation/node-utils/index.js';
import { STREAM_FILE, createPerResourceStreamWriter, type StreamEvent } from '../../foundation/stream/index.js';
import { LLMAllProvidersFailedError, type LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import { ToolExecutor, type ToolExecutionContext, type ToolRegistry } from '../../foundation/tools/index.js';
import type { llmProviderProtocol } from '../../foundation/llm-provider/index.js';
type ToolDefinition = llmProviderProtocol.ToolDefinition;
import type { Message } from '../../foundation/dialog-store/index.js';
import { createDialogStore } from '../../foundation/dialog-store/index.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import type { PermissionChecker, ToolProfile } from '../../foundation/tool-protocol/index.js';
import { SubAgent, type DegradedArtifact } from './agent.js';
import { createSubAgentRecoveryStore } from './recovery-state.js';
import { DONE_TOOL_NAME, createResultCaptureChannel, parseCapturedResult } from './tools/done.js';
import { createSubAgentLifecycleSink } from './lifecycle-sink.js';
import { bindRunCapture } from './registry-helper.js';
import { createSubagentExecutionRunner, type SubagentAttemptResult } from './execution-runner.js';
import type {
  SubagentExecutionDegraded,
  SubagentFinalOutcome,
  SubagentJsonValue,
} from './execution-types.js';
import { SUBAGENT_TIMEOUT_MS } from './constants.js';
import {
  decodeSubagentInput,
  PREPARED_SUBAGENT_INPUT_KIND,
  resolveSubagentSystemPrompt,
  type PreparedSubagentInput,
} from './execution-input.js';

export interface RunSubagentOptions {
  agentId: string;
  toolProfile?: ToolProfile;
  execution?: ToolExecutionContext;
  clawDir: string;
  fs: FileSystem;
  fsFactory?: (baseDir: string) => FileSystem;
  llm: LLMOrchestrator;
  registry: ToolRegistry;
  /** Legacy transition fields; omit both when executionInput is supplied. */
  prompt?: string;
  systemPrompt?: string;
  /** New versioned declaration; runtime dependencies still come from this options object. */
  executionInput?: PreparedSubagentInput;
  resultDir: string;
  syncDir: string;
  maxSteps?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  toolsForLLM?: ToolDefinition[];
  onIdleTimeout?: () => void;
  resultTool?: string;
  messages?: Message[];
  toolTimeoutMs?: number;
  permissionChecker?: PermissionChecker;
  traceId?: TraceId;
  currentContractId?: string;
}

export interface RunSubagentResult {
  text: string;
  capturedResult?: unknown;
  degraded?: DegradedArtifact[];
}

interface ResolvedRunSubagentInput {
  readonly agentId: string;
  readonly clawDir: string;
  readonly syncDir: string;
  readonly resultDir: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly traceId?: TraceId;
  readonly toolProfile?: ToolProfile;
  readonly execution?: ToolExecutionContext;
  readonly maxSteps?: number;
  readonly idleTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly toolsForLLM?: ToolDefinition[];
  readonly resultTool?: string;
  readonly messages?: Message[];
  readonly toolTimeoutMs?: number;
  readonly currentContractId?: string;
}

interface PersistedRunSubagentInput extends ResolvedRunSubagentInput {
  readonly schema_version: 1;
  readonly kind: 'run_subagent_options';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  return isRecord(value) && typeof value.name === 'string' && typeof value.description === 'string'
    && isRecord(value.input_schema);
}

function isMessage(value: unknown): value is Message {
  return isRecord(value)
    && (value.role === 'user' || value.role === 'assistant' || value.role === 'system')
    && (typeof value.content === 'string' || Array.isArray(value.content));
}

function isExecutionContext(value: unknown): value is ToolExecutionContext {
  return isRecord(value) && typeof value.callerKind === 'string';
}

function isDegradedArtifact(value: unknown): value is DegradedArtifact {
  return isRecord(value)
    && (value.artifact === 'steps_log' || value.artifact === 'dialog' || value.artifact === 'log' || value.artifact === 'completeness')
    && typeof value.stage === 'string' && typeof value.error === 'string';
}

function serializeInput(opts: RunSubagentOptions): PersistedRunSubagentInput {
  if (typeof opts.prompt !== 'string' || typeof opts.systemPrompt !== 'string') {
    throw new TypeError('legacy runSubagent input requires prompt and systemPrompt');
  }
  return {
    schema_version: 1,
    kind: 'run_subagent_options',
    agentId: opts.agentId,
    clawDir: opts.clawDir,
    syncDir: opts.syncDir,
    resultDir: opts.resultDir,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    ...(opts.traceId !== undefined ? { traceId: opts.traceId } : {}),
    ...(opts.toolProfile !== undefined ? { toolProfile: opts.toolProfile } : {}),
    ...(opts.execution !== undefined ? { execution: opts.execution } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.toolsForLLM !== undefined ? { toolsForLLM: opts.toolsForLLM } : {}),
    ...(opts.resultTool !== undefined ? { resultTool: opts.resultTool } : {}),
    ...(opts.messages !== undefined ? { messages: opts.messages } : {}),
    ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
    ...(opts.currentContractId !== undefined ? { currentContractId: opts.currentContractId } : {}),
  };
}

function parseInput(value: SubagentJsonValue): PersistedRunSubagentInput | PreparedSubagentInput {
  if (isRecord(value) && value.kind === PREPARED_SUBAGENT_INPUT_KIND) {
    return decodeSubagentInput(value);
  }
  return parseLegacyInput(value);
}

function parseLegacyInput(value: SubagentJsonValue): PersistedRunSubagentInput {
  if (!isRecord(value) || value.schema_version !== 1 || value.kind !== 'run_subagent_options') {
    throw new TypeError('invalid persisted RunSubagentOptions input header');
  }
  for (const field of ['agentId', 'clawDir', 'syncDir', 'resultDir', 'prompt', 'systemPrompt'] as const) {
    if (typeof value[field] !== 'string') throw new TypeError(`invalid persisted RunSubagentOptions field: ${field}`);
  }
  const optionalString = (field: 'toolProfile' | 'resultTool' | 'currentContractId' | 'traceId'): string | undefined => {
    const item = value[field];
    if (item !== undefined && typeof item !== 'string') throw new TypeError(`invalid persisted field: ${field}`);
    return item;
  };
  const optionalNumber = (field: 'maxSteps' | 'idleTimeoutMs' | 'timeoutMs' | 'toolTimeoutMs'): number | undefined => {
    const item = value[field];
    if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
      throw new TypeError(`invalid persisted field: ${field}`);
    }
    return item;
  };
  const tools = value.toolsForLLM;
  if (tools !== undefined && (!Array.isArray(tools) || !tools.every(isToolDefinition))) {
    throw new TypeError('invalid persisted field: toolsForLLM');
  }
  const messages = value.messages;
  if (messages !== undefined && (!Array.isArray(messages) || !messages.every(isMessage))) {
    throw new TypeError('invalid persisted field: messages');
  }
  const execution = value.execution;
  if (execution !== undefined && !isExecutionContext(execution)) {
    throw new TypeError('invalid persisted field: execution');
  }
  return {
    schema_version: 1,
    kind: 'run_subagent_options',
    agentId: value.agentId as string,
    clawDir: value.clawDir as string,
    syncDir: value.syncDir as string,
    resultDir: value.resultDir as string,
    prompt: value.prompt as string,
    systemPrompt: value.systemPrompt as string,
    ...(optionalString('traceId') !== undefined ? { traceId: makeTraceId(optionalString('traceId')!) } : {}),
    ...(optionalString('toolProfile') !== undefined ? { toolProfile: optionalString('toolProfile') } : {}),
    ...(optionalString('resultTool') !== undefined ? { resultTool: optionalString('resultTool') } : {}),
    ...(optionalString('currentContractId') !== undefined ? { currentContractId: optionalString('currentContractId') } : {}),
    ...(optionalNumber('maxSteps') !== undefined ? { maxSteps: optionalNumber('maxSteps') } : {}),
    ...(optionalNumber('idleTimeoutMs') !== undefined ? { idleTimeoutMs: optionalNumber('idleTimeoutMs') } : {}),
    ...(optionalNumber('timeoutMs') !== undefined ? { timeoutMs: optionalNumber('timeoutMs') } : {}),
    ...(optionalNumber('toolTimeoutMs') !== undefined ? { toolTimeoutMs: optionalNumber('toolTimeoutMs') } : {}),
    ...(tools !== undefined ? { toolsForLLM: tools } : {}),
    ...(messages !== undefined ? { messages } : {}),
    ...(execution !== undefined ? { execution } : {}),
  };
}

function resolveInput(
  persisted: PersistedRunSubagentInput | PreparedSubagentInput,
  opts: RunSubagentOptions,
): ResolvedRunSubagentInput {
  if (persisted.kind === 'run_subagent_options') return persisted;
  return {
    agentId: opts.agentId,
    clawDir: opts.clawDir,
    syncDir: opts.syncDir,
    resultDir: opts.resultDir,
    prompt: persisted.prompt,
    systemPrompt: resolveSubagentSystemPrompt(persisted.systemPrompt, { taskId: opts.agentId }),
    ...(opts.traceId !== undefined ? { traceId: opts.traceId } : {}),
    toolProfile: persisted.toolProfile,
    execution: persisted.execution,
    maxSteps: persisted.budget.maxSteps,
    idleTimeoutMs: persisted.budget.idleTimeoutMs,
    timeoutMs: persisted.budget.timeoutMs,
    toolsForLLM: structuredClone([...persisted.tools.manifest.llmTools]),
    resultTool: persisted.resultCapture.toolName,
    ...(persisted.messages !== undefined ? { messages: structuredClone([...persisted.messages]) } : {}),
    toolTimeoutMs: persisted.budget.toolTimeoutMs,
    ...(opts.currentContractId !== undefined ? { currentContractId: opts.currentContractId } : {}),
  };
}

function executionResultDir(opts: RunSubagentOptions): string {
  if (!path.isAbsolute(opts.resultDir)) return opts.resultDir;
  const bases = [opts.clawDir];
  if (typeof opts.fs.resolve === 'function') bases.unshift(opts.fs.resolve('.'));
  for (const base of bases) {
    if (!path.isAbsolute(base)) continue;
    const relative = path.relative(base, opts.resultDir);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join(path.posix.sep);
    }
  }
  throw new Error(`runSubagent resultDir must be inside clawDir: ${opts.resultDir}`);
}

function lateResult(error: unknown, resultDir: string, streamPath: string): SubagentAttemptResult | undefined {
  if (!isRecord(error) || !isRecord(error.subagentLateResult)) return undefined;
  const late = error.subagentLateResult;
  if (typeof late.text !== 'string' || typeof late.stopReason !== 'string') return undefined;
  return {
    content: late.text,
    rawResult: { text: late.text, stopReason: late.stopReason },
    artifacts: [
      { kind: 'dialog', path: `${resultDir}/messages.json` },
      { kind: 'stream', path: streamPath },
    ],
  };
}

function executionDegraded(agent: SubAgent): SubagentExecutionDegraded[] {
  return agent.getDegradedArtifacts().map(item => ({
    stage: 'artifact',
    artifact: `${item.artifact}:${item.stage}`,
    error: item.error,
  }));
}

function jsonValue(value: unknown, label = 'capturedResult'): SubagentJsonValue | undefined {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${label} must be JSON serializable`);
  return JSON.parse(serialized) as SubagentJsonValue;
}

function createRunDriver(opts: RunSubagentOptions, auditWriter: ReturnType<typeof createAuditWriter>) {
  return {
    recoveryFor(error: unknown) {
      return error instanceof LLMAllProvidersFailedError
        ? 'shared_dependency' as const
        : 'none' as const;
    },
    createAttempt(request: {
      input: SubagentJsonValue;
      signal: AbortSignal;
      deadlineAtMs?: number;
    }) {
      const input = resolveInput(parseInput(request.input), opts);
      const resultDir = input.resultDir;
      const traceId = input.traceId ?? makeTraceId(randomHex(8));
      const streamPath = `${resultDir}/${STREAM_FILE}`;
      const baseStreamWriter = createPerResourceStreamWriter(opts.fs, streamPath, auditWriter);
      const taskStreamWriter = {
        write: (event: Record<string, unknown>): void => {
          baseStreamWriter.write({ ts: Date.now(), ...event } as StreamEvent);
        },
      };
      const messageStore = createDialogStore(opts.fs, resultDir, auditWriter, 'messages.json');
      const recoveryStore = createSubAgentRecoveryStore({ fs: opts.fs, resultDir });
      const capture = createResultCaptureChannel<{ result: string }>();
      const runRegistry = bindRunCapture(opts.registry, capture);
      const toolsForLLM = input.toolsForLLM ?? runRegistry.formatForLLM(runRegistry.getAll());
      const sink = createSubAgentLifecycleSink({
        auditWriter,
        agentId: input.agentId,
        traceId,
        currentContractId: input.currentContractId,
      });
      const toolExecutor = new ToolExecutor({
        registry: runRegistry,
        defaultTimeoutMs: input.toolTimeoutMs,
        clawDir: input.clawDir,
        syncDir: input.syncDir,
        workspaceDir: path.join(input.clawDir, CLAWSPACE_DIR),
        fs: opts.fs,
        fsFactory: opts.fsFactory,
        llm: opts.llm,
        auditWriter,
        execution: input.execution ?? {
          callerKind: 'task',
          allowDone: true,
          allowShadow: false,
          allowSummon: false,
          allowNotifyClaw: false,
        },
      });
      const agent = new SubAgent({
        agentId: input.agentId,
        resultDir,
        messageStore,
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        toolExecutor,
        llm: opts.llm,
        registry: runRegistry,
        fs: opts.fs,
        maxSteps: input.maxSteps,
        idleTimeoutMs: input.idleTimeoutMs,
        signal: request.signal,
        timeoutMs: input.timeoutMs,
        deadlineAtMs: request.deadlineAtMs,
        toolsForLLM,
        toolProfile: input.toolProfile,
        onIdleTimeout: opts.onIdleTimeout,
        taskStreamWriter,
        sink,
        traceId,
        messages: input.messages,
        permissionChecker: opts.permissionChecker,
        recoveryStore,
      });

      let convergedLateResult: SubagentAttemptResult | undefined;
      const completion = (async () => {
        let text: string;
        try {
          text = await agent.run();
        } catch (error) {
          convergedLateResult = lateResult(error, resultDir, streamPath);
          const degraded = agent.getDegradedArtifacts();
          if (degraded.length > 0) {
            const carrier = typeof error === 'object' && error !== null ? error : new Error(formatErr(error));
            Object.assign(carrier, { degraded: [...degraded] });
            throw carrier;
          }
          throw error;
        }
        const toolName = input.resultTool ?? DONE_TOOL_NAME;
        const capturedResult = toolName === DONE_TOOL_NAME
          ? capture.get()
          : (opts.registry.get(toolName) as { capturedResult?: unknown } | undefined)?.capturedResult;
        const parsedCapture = capturedResult === undefined ? undefined : parseCapturedResult(capturedResult);
        if (parsedCapture?.kind === 'malformed') {
          sink.captureProtocolMalformed({ tool: toolName, reason: parsedCapture.reason });
        }
        const degraded = agent.getDegradedArtifacts();
        const rawResult: Record<string, SubagentJsonValue> = { text };
        const jsonCapture = jsonValue(capturedResult);
        if (jsonCapture !== undefined) rawResult.capturedResult = jsonCapture;
        if (degraded.length > 0) rawResult.degraded = degraded.map(item => ({ ...item }));
        return {
          content: text,
          rawResult,
          artifacts: [
            { kind: 'dialog', path: `${resultDir}/messages.json` },
            { kind: 'stream', path: streamPath },
          ],
        };
      })();
      return {
        completion,
        close: () => { agent.close(); },
        lateResult: () => convergedLateResult,
        degraded: () => executionDegraded(agent),
      };
    },
  };
}

function projectResult(outcome: SubagentFinalOutcome): RunSubagentResult {
  const raw = outcome.rawResult;
  if (!isRecord(raw) || typeof raw.text !== 'string') {
    throw new Error(`completed subagent outcome has no valid RunSubagentResult: ${outcome.identity.attemptId}`);
  }
  const degraded = Array.isArray(raw.degraded) ? raw.degraded.filter(isDegradedArtifact) : [];
  return {
    text: raw.text,
    ...(raw.capturedResult !== undefined ? { capturedResult: raw.capturedResult } : {}),
    ...(degraded.length > 0 ? { degraded } : {}),
  };
}

/** Compatibility convenience: start + completion, with no independent execution logic. */
export async function runSubagent(opts: RunSubagentOptions): Promise<RunSubagentResult> {
  const prepared = opts.executionInput === undefined ? undefined : decodeSubagentInput(opts.executionInput);
  if (prepared) {
    const legacyFields = [
      'prompt', 'systemPrompt', 'toolProfile', 'execution', 'maxSteps', 'idleTimeoutMs',
      'timeoutMs', 'toolsForLLM', 'resultTool', 'messages', 'toolTimeoutMs',
    ] as const;
    const conflicting = legacyFields.filter(field => opts[field] !== undefined);
    if (conflicting.length > 0) {
      throw new TypeError(`executionInput cannot be combined with legacy fields: ${conflicting.join(', ')}`);
    }
  }
  const input = jsonValue(prepared ?? serializeInput(opts), 'runSubagent input');
  if (input === undefined) throw new TypeError('runSubagent input must be JSON serializable');
  const timeoutMs = prepared?.budget.timeoutMs ?? opts.timeoutMs ?? SUBAGENT_TIMEOUT_MS;
  const auditWriter = createAuditWriter(opts.fs, `${opts.resultDir}/audit.tsv`);
  const runner = createSubagentExecutionRunner({
    fs: opts.fs,
    auditWriter,
    driver: createRunDriver(opts, auditWriter),
  });
  const execution = await runner.start({
    runId: opts.agentId,
    resultDir: executionResultDir(opts),
    input,
    signal: opts.signal,
    deadlineAtMs: Date.now() + timeoutMs,
  });
  const outcome = await execution.completion;
  if (outcome.kind !== 'completed') {
    throw outcome.cause ?? new Error(outcome.content);
  }
  return projectResult(outcome);
}

/** Uniform display projection for the result-capture protocol. */
export function getDisplayResult(text: string, capturedResult?: unknown): string {
  if (capturedResult === undefined) return text;
  const parsed = parseCapturedResult(capturedResult);
  return parsed.kind === 'ok' ? parsed.value.result : text;
}
