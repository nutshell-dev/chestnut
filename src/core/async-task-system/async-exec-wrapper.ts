/**
 * @module L4.AsyncTaskSystem.AsyncExecWrapper
 *
 * Phase 770: wraps a low-level exec handle factory into a Tool that auto-migrates
 * long-running commands to background async execution after a soft timeout.
 */

import * as path from 'path';
import type { ExecContext, Tool } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { ExecHandle, ExecutionGroupTarget, ExecutionIdentity, ExecutionTerminationFact, ExecutionTerminationOutcome } from '../../foundation/process-exec/index.js';
import { captureExecutionTarget, ProcessExecError, resolveHostCommand } from '../../foundation/process-exec/index.js';
import type { ExecWithHandleArgs, AsyncMigrationPolicy } from '../../foundation/command-tool/index.js';
import { formatErr, newUuid } from '../../foundation/node-utils/index.js';
import { EXEC_MAX_OUTPUT, EXEC_TOOL_NAME } from '../../foundation/command-tool/index.js';
import { processExecErrorToToolResult } from '../../foundation/command-tool/index.js';
import { formatExecOutputToolResult } from '../../foundation/command-tool/index.js';
import { rejectLongBlockingExec } from '../../foundation/command-tool/index.js';
import { executeToolTask } from './tool-executor.js';
import { sendToolResult as defaultSendToolResult, sendFallbackResult as defaultSendFallbackResult } from './result-delivery.js';
import type { SendToolResult, SendFallbackResult, WriteInboxAsync } from './result-delivery-types.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_QUEUES_RUNNING_DIR } from './dirs.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { STREAM_TASK_EVENTS } from './stream-events.js';
import { emitHandlerFailed, emitMigratedExecTermination } from './audit-emit.js';
import type { ToolTask, TaskId, FullTaskId, ShortTaskId, ShortIdIndex } from './types.js';
import { makeFullTaskId, taskShortId } from './types.js';
import {
  encodeMigratedExecResult,
  type MigratedExecResultClassification,
  type MigratedExecResultRecord,
  type MigratedExecTerminationRecord,
  type MigratedExecTerminalIntentStage,
} from './migrated-exec-result.js';

export interface AsyncExecWrapperParams {
  execWithHandle: (args: ExecWithHandleArgs, ctx: ExecContext) => Promise<ExecHandle>;
  softTimeoutMs?: number;
  /** Optional override for the migrated hard timeout (ms). Primarily for tests. */
  migratedHardTimeoutMs?: number;
  /**
   * phase 1863 (AT-D9/H1)：命令侧执行形态声明（owner: command-tool；Assembly 接线）。
   * 缺省（undefined）= 可迁移（现状行为零漂移）；migratable:false 时 soft 超时走终止路径
   * （复用显式 timeout 语义——不建迁移任务、不写 TASK_MIGRATED_* 事件族）。
   */
  migrationPolicy?: AsyncMigrationPolicy;
}

interface AsyncExecWrapperDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  retryBaseDelayMs: number;
  moveTaskToDone: (taskId: TaskId) => Promise<void>;
  moveTaskToFailed: (taskId: TaskId) => Promise<void>;
  parentStreamLog?: { write(entry: Record<string, unknown>): void };
  shortIdIndex: ShortIdIndex;
  sendToolResult?: SendToolResult<ToolTask>;
  sendFallbackResult?: SendFallbackResult<ToolTask>;
  writeInboxAsync?: WriteInboxAsync;
}

const ASYNC_EXEC_SOFT_TIMEOUT_MS = 10_000;

function toTerminationRecord(
  fact: ExecutionTerminationFact | ExecutionTerminationOutcome,
): MigratedExecTerminationRecord {
  return {
    status: fact.status,
    trigger: fact.trigger,
    termSent: fact.termSent,
    killSent: fact.killSent,
    identity: fact.identity,
    reason: fact.status === 'indeterminate' ? fact.reason : undefined,
    completedAt: 'completedAt' in fact ? fact.completedAt : undefined,
    checkedAt: 'checkedAt' in fact ? fact.checkedAt : undefined,
  };
}

/** Migrated process hard timeout (ms). Process will be killed after this time. */
export const ASYNC_EXEC_MIGRATED_HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Build a synthetic ToolTask for a migrated exec command.
 */
function buildMigratedToolTask(
  fullId: FullTaskId,
  shortId: ShortTaskId,
  command: string,
  ctx: ExecContext,
  target: ExecutionGroupTarget,
  deadlineAtMs: number,
): ToolTask {
  return {
    kind: 'tool',
    id: fullId,
    shortId: shortId,
    toolName: EXEC_TOOL_NAME,
    args: { command },
    parentClawDir: ctx.clawDir,
    parentClawId: ctx.clawId,
    createdAt: new Date().toISOString(),
    isIdempotent: false,
    maxRetries: 0,
    retryCount: 0,
    toolUseId: ctx.currentToolUseId,
    mode: 'migrated',
    migratedExecution: target,
    // Phase 1272 Step C: the deadline is the SINGLE absolute fact generated
    // before spawn and already armed in L1 — persist it verbatim. Never
    // recompute `Date.now() + duration` here: runtime monitor and restart
    // recovery must consume the exact same value.
    migratedDeadlineMs: deadlineAtMs,
  };
}

/**
 * Race a process handle against a soft timeout and an optional abort signal.
 */
async function raceHandle(
  handle: ExecHandle,
  softTimeoutMs: number,
  signal?: AbortSignal,
): Promise<{ type: 'result'; value: Awaited<ExecHandle['promise']> } | { type: 'migrate' } | { type: 'abort' }> {
  const softTimeout = new Promise<'migrate'>((resolve) => {
    const timer = setTimeout(() => resolve('migrate'), softTimeoutMs);
    timer.unref?.();
  });

  const abort = signal
    ? new Promise<'abort'>((resolve) => {
        const handler = (): void => resolve('abort');
        signal.addEventListener('abort', handler, { once: true });
      })
    : new Promise<'abort'>(() => { /* never */ });

  const resultPromise = handle.promise.then(
    (value) => ({ type: 'result' as const, value }),
    (err: unknown) => {
      // If the signal aborted the process, prefer the abort path over surfacing
      // the ProcessExecError to the caller.
      if (signal?.aborted) {
        return { type: 'abort' as const };
      }
      throw err;
    },
  );

  const winner = await Promise.race([
    resultPromise,
    softTimeout.then(() => ({ type: 'migrate' as const })),
    abort.then(() => ({ type: 'abort' as const })),
  ]);

  return winner;
}

/**
 * Factory: create an `exec` Tool that transparently migrates long-running
 * commands to AsyncTaskSystem after a soft timeout.
 */
export function createAsyncExecWrapper(
  params: AsyncExecWrapperParams,
  deps: AsyncExecWrapperDeps,
): Tool {
  const { execWithHandle, softTimeoutMs } = params;
  const timeout = softTimeoutMs ?? ASYNC_EXEC_SOFT_TIMEOUT_MS;
  const migratedHardTimeoutMs = params.migratedHardTimeoutMs ?? ASYNC_EXEC_MIGRATED_HARD_TIMEOUT_MS;
  const { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed, parentStreamLog, shortIdIndex } = deps;
  const sendToolResult = deps.sendToolResult ?? defaultSendToolResult;
  const sendFallbackResult = deps.sendFallbackResult ?? defaultSendFallbackResult;
  const { invocation } = resolveHostCommand('');

  const tool: Tool = {
    name: EXEC_TOOL_NAME,
    profiles: ['full'],  // Phase 773: wrapper is only for the main agent; subagents use plain sync exec.
    description: `Execute a shell command in your clawspace. Runs via \`${invocation}\`; use commands and syntax supported by that interpreter, so shell features (pipes, redirects, quotes) work normally. Use powershell.exe -NoProfile -Command "..." when PowerShell is needed on Windows. Relative paths resolve against your clawspace. Long-running commands are automatically moved to async execution.`,
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command string to execute using the syntax and commands supported by the host interpreter',
        },
        cwd: {
          type: 'string',
          description: 'Working directory, relative to clawspace. Use ".." to escape clawspace to claw root (e.g. cwd: "../memory"). Default: clawspace.',
        },
        timeoutMs: {
          type: 'number',
          description:
            `When set: pure sync mode — the command runs synchronously and is killed ` +
            `after this many milliseconds if it hasn't completed. ` +
            `When not set (default): sync→async mode — the command runs synchronously ` +
            `for up to 10 seconds, then automatically moves to background async execution ` +
            `and the result is delivered via inbox.`,
        },
        stdin: {
          type: 'string',
          description: 'Content to pipe directly to the child process stdin; it is not parsed by the shell.',
        },
      },
      required: ['command'],
    },
    readonly: false,
    idempotent: false,
    outputBounds: { maxBytes: EXEC_MAX_OUTPUT, maxLines: EXEC_MAX_OUTPUT + 1, artifactKind: 'exec' },

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      const command = args.command as string;

      // phase 2135 Step C: only explicit pure-sync calls can exceed the turn
      // budget here; omitted timeoutMs retains the existing async migration.
      const longBlockingRejection = rejectLongBlockingExec(
        command,
        args.timeoutMs as number | undefined,
        ctx,
      );
      if (longBlockingRejection) return longBlockingRejection;

      // --- phase 1863 (AT-D9/H1): 命令侧声明不可迁移 → 超时即终止 ----------------
      // 复用显式 timeout 语义：以声明/装配预算为命令时限，超时由 L1 终止并归类为
      // ProcessExecError（不建迁移任务、无 TASK_MIGRATED_* 留痕）。
      if (args.timeoutMs === undefined && params.migrationPolicy?.migratable === false) {
        const effectiveTimeoutMs = params.migrationPolicy.softTimeoutMs ?? timeout;
        try {
          const handle = await execWithHandle(
            {
              command,
              cwd: args.cwd as string | undefined,
              timeoutMs: effectiveTimeoutMs,
              stdin: args.stdin as string | undefined,
            },
            ctx,
          );

          const result = await handle.promise;
          return formatExecOutputToolResult(ctx, result.output, command);
        } catch (err) {
          if (err instanceof ProcessExecError) {
            return processExecErrorToToolResult(err, command, ctx);
          }
          throw err;
        }
      }

      // --- pure sync mode: caller set an explicit timeout --------------------
      if (args.timeoutMs !== undefined) {
        try {
          const handle = await execWithHandle(
            {
              command,
              cwd: args.cwd as string | undefined,
              timeoutMs: args.timeoutMs as number | undefined,
              stdin: args.stdin as string | undefined,
            },
            ctx,
          );

          const result = await handle.promise;
          // phase 1750 Step B: 同步返回路径施加与 createExecTool 一致的截断协议
          return formatExecOutputToolResult(ctx, result.output, command);
        } catch (err) {
          if (err instanceof ProcessExecError) {
            return processExecErrorToToolResult(err, command, ctx);
          }
          throw err;
        }
      }

      // --- sync→async mode: no explicit timeout, use soft timeout + migration -
      // Create a proxy AbortController linked to the original signal. Before
      // migration we forward abort events so the spawned process is killed as
      // usual. During migration we detach the listener (and unref the child) so
      // the process survives the original turn's AbortSignal.
      const originalSignal = ctx.signal;
      const proxyController = new AbortController();
      const onOriginalAbort = (): void => proxyController.abort();
      if (originalSignal) {
        if (originalSignal.aborted) {
          proxyController.abort();
        } else {
          originalSignal.addEventListener('abort', onOriginalAbort, { once: true });
        }
      }
      const proxyCtx = { ...ctx, signal: proxyController.signal };

      // 1-3. Start the process, collect partial output, and race completion
      //    against soft timeout / original abort signal. Catch ProcessExecError
      //    here so the ToolResult includes [command] instead of falling through
      //    to ToolExecutor's generic timeout formatting.
      // Phase 1272 Step C: the single absolute deadline is generated ONCE
      // here, before spawn, covering soft window + migrated hard budget. It
      // is armed in L1 via `deadlineAtMs`, persisted verbatim as
      // `migratedDeadlineMs` on migration, and consumed by the runtime
      // monitor and restart recovery — one fact, no re-derivation.
      const deadlineAtMs = Date.now() + timeout + migratedHardTimeoutMs;

      // Allocate the durable identity before spawn. L1 invokes the callback
      // after its handle is fully wired and before execWithHandle returns, so
      // every later state (including the former soft-timeout window) can be
      // reconstructed from disk after a daemon crash.
      let fullId: FullTaskId;
      let shortId: ShortTaskId;
      do {
        fullId = makeFullTaskId(newUuid());
        shortId = shortIdIndex.deriveShortId(fullId);
      } while (shortIdIndex.has(shortId));

      const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${fullId}`;
      const resultPath = path.join(resultDir, 'result.txt');
      const exitPath = path.join(resultDir, 'exit.json');
      let task: ToolTask | undefined;
      let executionTarget: ExecutionGroupTarget | undefined;
      let checkpointError: unknown;
      let checkpointErrorContext: MigratedExecTerminalIntentStage = 'result_dir_create';
      let outputPersistenceError: unknown;
      const auditOutputPersistenceFailure = (context: string, error: unknown): void => {
        try {
          emitHandlerFailed(auditWriter, {
            fullTaskId: fullId,
            shortTaskId: shortId,
            context,
            error: formatErr(error),
          });
        } catch { /* an output EventEmitter callback must never rethrow, including audit failures */ }
      };
      const appendOutput = (chunk: Buffer | string): void => {
        try {
          fs.appendSync(resultPath, chunk.toString());
        } catch (err) {
          if (outputPersistenceError === undefined) {
            outputPersistenceError = err;
            auditOutputPersistenceFailure('async_exec_wrapper_output_append', err);
            if (task !== undefined) persistTerminalIntent(task, 'output_append', err);
          }
        }
      };
      const writeExitRecord = (record: MigratedExecResultRecord): boolean => {
        try {
          fs.writeAtomicSync(exitPath, encodeMigratedExecResult(record));
          return true;
        } catch (err) {
          auditOutputPersistenceFailure('async_exec_wrapper_exit_record_write', err);
          if (task !== undefined) {
            persistTerminalIntent(task, 'exit_record_write', err, record.termination, record.evidence);
          }
          return false;
        }
      };
      const outputPersistenceFailureResult = (): { success: false; content: string } => ({
        success: false,
        content: `Failed to persist migrated exec output: ${formatErr(outputPersistenceError)}`,
      });
      const persistTerminalIntent = (
        owner: ToolTask,
        stage: MigratedExecTerminalIntentStage,
        cause: unknown,
        termination?: MigratedExecTerminationRecord,
        evidence?: MigratedExecResultRecord['evidence'],
      ): boolean => {
        const previous = owner.migratedExecTerminalIntent;
        const intent = {
          version: 1 as const,
          stage: previous?.stage ?? stage,
          error: previous?.error ?? formatErr(cause),
          termination: termination ?? previous?.termination,
          evidence: evidence ?? previous?.evidence,
        };
        try {
          fs.writeAtomicSync(
            `${TASKS_QUEUES_RUNNING_DIR}/${owner.id}.json`,
            JSON.stringify({ ...owner, migratedExecTerminalIntent: intent }, null, 2),
          );
          owner.migratedExecTerminalIntent = intent;
          return true;
        } catch (intentErr) {
          auditOutputPersistenceFailure('async_exec_wrapper_terminal_intent_write', intentErr);
          return false;
        }
      };
      const finalizeExecutionFailure = async (
        failedHandle: ExecHandle,
        stage: MigratedExecTerminalIntentStage,
        cause: unknown,
        context: 'identity_checkpoint_failed' | 'persist_failed',
        failurePrefix: string,
      ): Promise<ToolResult> => {
        let outcome: ExecutionTerminationOutcome;
        try {
          outcome = await failedHandle.terminate('caller_requested');
        } catch (terminationErr) {
          auditOutputPersistenceFailure(`${context}_termination_failed`, terminationErr);
          const terminationIdentity = failedHandle.identity ?? executionTarget;
          if (terminationIdentity === undefined) {
            originalSignal?.removeEventListener('abort', onOriginalAbort);
            return { success: false, content: `${failurePrefix}: ${formatErr(cause)}` };
          }
          outcome = {
            status: 'indeterminate',
            identity: terminationIdentity,
            trigger: 'caller_requested',
            termSent: false,
            killSent: false,
            reason: `termination_failed: ${formatErr(terminationErr)}`,
            checkedAt: new Date().toISOString(),
            evidence: { version: 1, atMs: Date.now(), facts: [{ source: 'terminate_rejection' }] },
          };
        }
        void failedHandle.promise.catch((executionErr: unknown) => {
          auditOutputPersistenceFailure(`${context}_execution_rejection`, executionErr);
        });
        if (task !== undefined && !persistTerminalIntent(task, stage, cause, toTerminationRecord(outcome), outcome.evidence)) {
          originalSignal?.removeEventListener('abort', onOriginalAbort);
          return { success: false, content: `${failurePrefix}: ${formatErr(cause)}` };
        }
        try {
          emitMigratedExecTermination(auditWriter, {
            taskId: fullId,
            context,
            identityCols: failedHandle.identity === undefined ? [] : [
              `leader_pid=${failedHandle.identity.leaderPid}`,
              `process_group_id=${failedHandle.identity.processGroupId}`,
            ],
            trigger: outcome.trigger,
            termSent: outcome.termSent,
            killSent: outcome.killSent,
            status: outcome.status,
            reason: outcome.status === 'indeterminate' ? outcome.reason : undefined,
            evidence: JSON.stringify(outcome.evidence),
          });
        } catch (auditErr) {
          auditOutputPersistenceFailure(`${context}_termination_audit_failed`, auditErr);
        }
        if (task !== undefined && outcome.status === 'gone') {
          try {
            fs.ensureDirSync(resultDir);
            if (writeExitRecord({
              version: 1,
              taskId: task.id,
              completedAt: new Date().toISOString(),
              classification: 'error',
              exitCode: null,
              termination: toTerminationRecord(outcome),
              evidence: outcome.evidence,
            })) {
              await moveTaskToFailed(task.id).catch((moveErr: unknown) => {
                auditOutputPersistenceFailure(`${context}_move`, moveErr);
              });
            }
          } catch (terminalErr) {
            auditOutputPersistenceFailure(`${context}_terminal_commit_failed`, terminalErr);
          }
        }
        originalSignal?.removeEventListener('abort', onOriginalAbort);
        return { success: false, content: `${failurePrefix}: ${formatErr(cause)}` };
      };
      const checkpointIdentity = (identity: ExecutionIdentity): void => {
        if (task !== undefined || checkpointError !== undefined) return;
        const capture = captureExecutionTarget(identity);
        if (capture.kind === 'invalid') {
          checkpointError = new Error(`${capture.reason}: ${JSON.stringify(capture.evidence)}`);
          return;
        }
        const candidate = buildMigratedToolTask(fullId, shortId, command, ctx, capture.target, deadlineAtMs);
        try {
          fs.writeAtomicSync(
            `${TASKS_QUEUES_RUNNING_DIR}/${candidate.id}.json`,
            JSON.stringify(candidate, null, 2),
          );
          // The running artifact is now the durable owner. Later failures must
          // update this artifact even though the in-memory checkpoint is partial.
          task = candidate;
          executionTarget = capture.target;
          // The output artifact exists before L1 returns its handle. The single
          // replaying subscription below owns all subsequent writes, including
          // output emitted during the pre-soft-timeout window.
          checkpointErrorContext = 'result_dir_create';
          fs.ensureDirSync(resultDir);
          checkpointErrorContext = 'result_initial_write';
          fs.writeAtomicSync(resultPath, '');
          checkpointErrorContext = 'short_id_index_add';
          shortIdIndex.add(shortId, fullId);
          checkpointErrorContext = 'short_id_index_save';
          shortIdIndex.save();
          checkpointErrorContext = 'identity_checkpoint_audit';
          const checkpointCols: (string | number)[] = [
            `taskId=${fullId}`,
            `pid=${identity.leaderPid}`,
            `pgid=${identity.processGroupId}`,
            `deadline_ms=${deadlineAtMs}`,
            `identity_capture=${capture.kind}`,
          ];
          if (capture.kind === 'unknown') checkpointCols.push(`capture_reason=${capture.reason}`);
          if (capture.kind !== 'captured') {
            checkpointCols.push(`capture_evidence=${JSON.stringify(capture.evidence)}`);
          }
          auditWriter.write(TASK_AUDIT_EVENTS.EXEC_IDENTITY_CHECKPOINTED, ...checkpointCols);
        } catch (err) {
          // Deferred to the checkpointError branch immediately after execWithHandle returns;
          // that branch terminates the execution group, audits termination, and returns structured failure.
          checkpointError = err;
          auditOutputPersistenceFailure(checkpointErrorContext, err);
        }
      };

      let handle: ExecHandle | undefined;
      let winner: Awaited<ReturnType<typeof raceHandle>>;
      try {
        handle = await execWithHandle(
          {
            command,
            cwd: args.cwd as string | undefined,
            deadlineAtMs,
            stdin: args.stdin as string | undefined,
            onExecutionIdentity: checkpointIdentity,
          },
          proxyCtx,
        );

        // Test doubles and alternative implementations may not yet call the
        // hook. Enforce the same invariant locally before the first await.
        if (handle.identity !== undefined && task === undefined && checkpointError === undefined) {
          checkpointIdentity(handle.identity);
        }
        if (checkpointError !== undefined) {
          return finalizeExecutionFailure(
            handle,
            checkpointErrorContext,
            checkpointError,
            'identity_checkpoint_failed',
            'Failed to checkpoint exec identity',
          );
        }

        // One durable subscription for the whole handle lifetime. Replay closes
        // the identity-callback → subscription window; there is no in-memory
        // collector or listener handoff at soft timeout.
        handle.subscribeOutput(appendOutput, { replay: true });

        winner = await raceHandle(handle, timeout, ctx.signal);
      } catch (err) {
        originalSignal?.removeEventListener('abort', onOriginalAbort);
        if (err instanceof ProcessExecError) {
          if (handle === undefined || task === undefined || handle.identity === undefined) {
            return processExecErrorToToolResult(err, command, ctx);
          }
          const fact = err.termination;
          if (fact !== undefined) {
            emitMigratedExecTermination(auditWriter, {
              taskId: task.id,
              context: 'pre_deadline_termination',
              identityCols: [
                `leader_pid=${handle.identity.leaderPid}`,
                `process_group_id=${handle.identity.processGroupId}`,
              ],
              trigger: fact.trigger,
              termSent: fact.termSent,
              killSent: fact.killSent,
              status: fact.status,
              reason: fact.reason,
              evidence: fact.evidence === undefined ? undefined : JSON.stringify(fact.evidence),
            });
            // A rejected execution promise is not proof that the process group
            // is gone. Keep all artifacts running and do not commit exit.json.
            if (fact.status !== 'gone') return processExecErrorToToolResult(err, command, ctx);
          }
          const classification: MigratedExecResultClassification =
            err.maxBufferExceeded || fact?.trigger === 'max_buffer' ? 'max_buffer'
              : fact?.trigger === 'timeout' ? 'timeout'
                : fact?.trigger === 'abort' ? 'abort'
                  : err.exitCode !== null && err.exitCode !== 0 ? 'nonzero_exit' : 'error';
          appendOutput(`\n[Process exited with error: ${formatErr(err)}]`);
          if (outputPersistenceError !== undefined) return outputPersistenceFailureResult();
          if (!writeExitRecord({
            version: 1,
            taskId: task.id,
            completedAt: new Date().toISOString(),
            classification,
            exitCode: err.exitCode,
            stderr: err.stderr,
            signal: err.signal,
            termination: fact === undefined ? undefined : toTerminationRecord(fact),
            evidence: fact?.evidence ?? err.evidence,
          })) {
            return { success: false, content: 'Failed to persist migrated exec exit record; task remains running' };
          }
          await moveTaskToDone(task.id);
          return processExecErrorToToolResult(err, command, ctx);
        }
        throw err;
      }

      // A resolved handle always carries the OS execution identity (absent only
      // when spawn itself failed, which rejects above). Fail-observable, never
      // guess an identity.
      if (handle === undefined) {
        originalSignal?.removeEventListener('abort', onOriginalAbort);
        throw new Error('execWithHandle resolved without a handle');
      }
      const resolvedHandle = handle;
      const identity = resolvedHandle.identity;
      if (identity === undefined || task === undefined) {
        originalSignal?.removeEventListener('abort', onOriginalAbort);
        throw new Error('execWithHandle resolved without a durable execution identity');
      }

      // 4. Sync completion: return result directly.
      if (winner.type === 'result') {
        originalSignal?.removeEventListener('abort', onOriginalAbort);
        const result = winner.value;
        if (outputPersistenceError !== undefined) return outputPersistenceFailureResult();
        if (!writeExitRecord({
          version: 1,
          taskId: task.id,
          completedAt: new Date().toISOString(),
          classification: 'success',
          exitCode: result.exitCode,
          stderr: result.stderr,
        })) {
          return { success: false, content: 'Failed to persist migrated exec exit record; task remains running' };
        }
        await moveTaskToDone(task.id);
        auditWriter.write(
          TASK_AUDIT_EVENTS.EXEC_CHECKPOINT_COMPLETED_SYNC,
          `taskId=${task.id}`,
          `shortTaskId=${shortId}`,
        );
        return formatExecOutputToolResult(ctx, result.output, command);
      }

      // 5. Abort: terminate the execution group via L1 and wait for the
      //    outcome before reporting back to the caller. The L1 trigger is the
      //    real termination word ('abort'); L4 scene lives in the audit context.
      if (winner.type === 'abort') {
        originalSignal?.removeEventListener('abort', onOriginalAbort);
        const outcome = await resolvedHandle.terminate('abort');
        emitMigratedExecTermination(auditWriter, {
          taskId: task.id,
          context: 'caller_abort',
          identityCols: [
            `leader_pid=${identity.leaderPid}`,
            `process_group_id=${identity.processGroupId}`,
          ],
          trigger: outcome.trigger,
          termSent: outcome.termSent,
          killSent: outcome.killSent,
          status: outcome.status,
          reason: outcome.status === 'indeterminate' ? outcome.reason : undefined,
          evidence: JSON.stringify(outcome.evidence),
        });
        // Cancel intent is business-terminal only after L1 confirms the group
        // is gone and output + exit.json have both committed. Unknown/still-alive
        // artifacts stay running for recovery without a terminal record.
        if (outcome.status === 'gone') {
          appendOutput('\n[Process aborted by caller]');
          if (outputPersistenceError !== undefined) return outputPersistenceFailureResult();
          if (!writeExitRecord({
            version: 1,
            taskId: task.id,
            completedAt: new Date().toISOString(),
            classification: 'abort',
            exitCode: null,
            termination: toTerminationRecord(outcome),
            evidence: outcome.evidence,
          })) {
            return { success: false, content: 'Command aborted by caller, but its exit record could not be persisted; task remains running' };
          }
          await moveTaskToFailed(task.id);
        }
        const cleanupSuffix = outcome.status === 'gone' ? ''
          : ` [execution cleanup: ${outcome.status}${outcome.status === 'indeterminate' ? ` (${outcome.reason})` : ''}]`;
        return {
          success: false,
          content: `Command aborted by caller${cleanupSuffix}`,
        };
      }

      // 6. Soft timeout: migrate to background async execution.
      //    Detach from the original signal and unref the child so it can outlive
      //    the caller's turn.
      originalSignal?.removeEventListener('abort', onOriginalAbort);
      resolvedHandle.detach();

      try {
        // Re-save at the presentation transition. The task itself was already
        // durable before execWithHandle crossed the spawn boundary.
        shortIdIndex.save();
      } catch (persistErr) {
        // The authoritative running artifact remains on disk. Terminate the
        // process, but keep that history for recovery/index rebuild instead of
        // deleting evidence after an auxiliary index persistence failure.
        // Migration persistence failed: terminate the execution group via L1,
        // wait for the outcome, and audit it before reporting the error.
        // L1 has no 'persist_failed' word — caller_requested is the correct L1
        // trigger here (the wrapper requested termination); L4 scene is the
        // audit context column.
        auditOutputPersistenceFailure('async_exec_wrapper_persist_failed', persistErr);
        return finalizeExecutionFailure(
          resolvedHandle,
          'migration_index_save',
          persistErr,
          'persist_failed',
          'Failed to persist migrated exec task',
        );
      }

      // Migration persisted: notify viewport that a background exec task started.
      const startedAt = Date.now();
      parentStreamLog?.write({
        ts: startedAt,
        type: STREAM_TASK_EVENTS.TASK_STARTED,
        taskId: shortId,
        fullTaskId: fullId,
        taskKind: 'exec_migrated',
        silent: false,
        command,
        startedAt,
      });

      if (outputPersistenceError !== undefined) return outputPersistenceFailureResult();

      // Background chain: wait for the process to exit, then ask the async task
      // system to deliver the result. result.txt is kept up-to-date in real
      // time by the append listeners above, so no additional persistence is
      // needed.
      const backgroundMonitor = (async (): Promise<void> => {
        // Phase 1272 Step C: the runtime hard timer is armed from the SAME
        // persisted absolute deadline (never a fresh relative duration).
        const hardTimeoutMessage = `Migrated process timed out after ${migratedHardTimeoutMs}ms`;
        let hardTimerWon = false;
        let exitRecord: MigratedExecResultRecord;
        try {
          const remainingMs = Math.max(0, task.migratedDeadlineMs! - Date.now());
          const hardTimeout = new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
              hardTimerWon = true;
              reject(new Error(hardTimeoutMessage));
            }, remainingMs);
            timer.unref?.();
          });

          const result = await Promise.race([resolvedHandle.promise, hardTimeout]);
          exitRecord = {
            version: 1,
            taskId: task.id,
            completedAt: new Date().toISOString(),
            classification: 'success',
            exitCode: result.exitCode,
            stderr: result.stderr,
          };
        } catch (monitorErr) {
          // Deadline race classification must not trust a single closure
          // boolean: L1's own deadline timer can win the race and reject
          // resolvedHandle.promise first, leaving hardTimerWon false.
          const deadlineExceeded = hardTimerWon || Date.now() >= task.migratedDeadlineMs!;
          const processError = monitorErr instanceof ProcessExecError ? monitorErr : undefined;
          let cleanupSuffix = '';
          let termination: MigratedExecTerminationRecord | undefined;
          let evidence: MigratedExecResultRecord['evidence'] = processError?.evidence;
          let terminationUnresolved = false;
          if (deadlineExceeded) {
            const outcome = await resolvedHandle.terminate('timeout');
            emitMigratedExecTermination(auditWriter, {
              taskId: task.id,
              context: 'hard_timeout',
              identityCols: [
                `leader_pid=${identity.leaderPid}`,
                `process_group_id=${identity.processGroupId}`,
              ],
              trigger: outcome.trigger,
              termSent: outcome.termSent,
              killSent: outcome.killSent,
              status: outcome.status,
              reason: outcome.status === 'indeterminate' ? outcome.reason : undefined,
              evidence: JSON.stringify(outcome.evidence),
            });
            termination = toTerminationRecord(outcome);
            evidence = outcome.evidence;
            terminationUnresolved = outcome.status !== 'gone';
            cleanupSuffix = outcome.status === 'gone'
              ? ' [execution cleanup: gone]'
              : outcome.status === 'still_alive'
                ? ' [execution cleanup: still_alive]'
                : ` [execution cleanup: indeterminate (${outcome.reason})]`;
            auditWriter.write(
              TASK_AUDIT_EVENTS.TASK_MIGRATED_TIMED_OUT,
              `taskId=${task.id}`,
              `pid=${identity.leaderPid}`,
            );
          } else if (processError?.termination !== undefined) {
            const fact = processError.termination;
            terminationUnresolved = fact.status !== 'gone';
            termination = toTerminationRecord(fact);
            evidence = fact.evidence ?? processError?.evidence;
            emitMigratedExecTermination(auditWriter, {
              taskId: task.id,
              context: 'pre_deadline_termination',
              identityCols: [
                `leader_pid=${identity.leaderPid}`,
                `process_group_id=${identity.processGroupId}`,
              ],
              trigger: fact.trigger,
              termSent: fact.termSent,
              killSent: fact.killSent,
              status: fact.status,
              reason: fact.reason,
              evidence: fact.evidence === undefined ? undefined : JSON.stringify(fact.evidence),
            });
          }

          appendOutput(
            `\n[Process ${deadlineExceeded ? 'timed out' : 'exited with error'}: ${deadlineExceeded ? hardTimeoutMessage : formatErr(monitorErr)}]${cleanupSuffix}`,
          );

          // Signal issuance / an exited leader is not proof of group cleanup.
          // Keep the running artifact and skip exit.json until recovery observes gone.
          if (terminationUnresolved) return;
          const classification: MigratedExecResultClassification = deadlineExceeded ? 'timeout'
            : processError?.maxBufferExceeded || processError?.termination?.trigger === 'max_buffer' ? 'max_buffer'
              : processError?.termination?.trigger === 'timeout' ? 'timeout'
                : processError?.termination?.trigger === 'abort' ? 'abort'
                  : processError !== undefined && processError.exitCode !== null && processError.exitCode !== 0
                    ? 'nonzero_exit' : 'error';
          exitRecord = {
            version: 1,
            taskId: task.id,
            completedAt: new Date().toISOString(),
            classification,
            exitCode: processError?.exitCode ?? null,
            stderr: processError?.stderr,
            signal: processError?.signal,
            termination,
            evidence,
          };
        }

        // Terminal commit order is output → atomic exit.json → delivery/move.
        // Any earlier output failure permanently vetoes this in-memory terminal
        // chain; restart recovery must not inherit a false clean-exit marker.
        if (outputPersistenceError !== undefined) return;
        if (!writeExitRecord(exitRecord)) return;
        try {
          await executeToolTask(
            task,
            () => Promise.resolve({ success: true, content: '' }),
            new AbortController().signal,
            { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed, sendToolResult, sendFallbackResult, writeInboxAsync: deps.writeInboxAsync },
          );
        } catch (execErr) {
          emitHandlerFailed(auditWriter, {
            fullTaskId: task.id as FullTaskId,
            shortTaskId: taskShortId(task),
            context: 'async_exec_wrapper_monitor',
            error: formatErr(execErr),
          });
          return;
        }
        parentStreamLog?.write({
          ts: Date.now(),
          type: STREAM_TASK_EVENTS.TASK_COMPLETED,
          taskId: shortId,
          fullTaskId: fullId,
          taskKind: 'exec_migrated',
        });
      })();

      // Fire-and-forget: do not await the background chain in the caller path.
      backgroundMonitor.catch((err) => {
        emitHandlerFailed(auditWriter, {
          fullTaskId: task!.id as FullTaskId,
          shortTaskId: taskShortId(task!),
          context: 'async_exec_wrapper_background',
          error: formatErr(err),
        });
      });

      if (executionTarget === undefined) {
        throw new Error('migrated execution target missing after durable checkpoint');
      }
      const registeredCols: (string | number)[] = [
        `taskId=${task.id}`,
        `pid=${executionTarget.leaderPid}`,
        `pgid=${executionTarget.processGroupId}`,
        `command=${command}`,
      ];
      if (executionTarget.leaderStartTime === undefined) {
        // Phase 1269: never silently write -1 — recovery will honestly probe
        // this task as indeterminate and never signal it.
        registeredCols.push('start_time=unavailable');
      }
      auditWriter.write(TASK_AUDIT_EVENTS.TASK_MIGRATED_REGISTERED, ...registeredCols);

      const resultRelPath = path.join('..', resultDir, 'result.txt');

      return {
        success: true,
        content: `Execution moved to async. Task: ${shortId}. Output streaming to ${resultRelPath} — use read to check progress.`,
        metadata: { taskId: shortId, fullTaskId: fullId, async: true, migrated: true },
      };
    },
  };
  return tool;
}
