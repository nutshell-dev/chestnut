/**
 * @module L2c.Tools
 * Caller-output-domain journal for real tool settlement and late results.
 */

import { formatErr } from '../node-utils/index.js';
import type { AtomicWriteResult } from '../fs/index.js';
import { TOOL_AUDIT_EVENTS } from './audit-events.js';
import { TOOL_EXECUTION_JOURNAL_ROOT } from './constants.js';
import { resolveToolOutputWriteSide, type ToolOutputWriteSide } from './output-cap.js';
import type {
  ExecuteOptions,
  ExecContext,
  ToolExecutionFinal,
  ToolExecutionPersistence,
  ToolExecutionWriteEvidence,
} from './types.js';

export type ToolExecutionFinalDocument = Omit<ToolExecutionFinal, 'persistence'> & {
  readonly persistence: Omit<ToolExecutionPersistence, 'final'>;
};

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Error) {
      return { name: item.name, message: item.message, stack: item.stack };
    }
    // Cycles/BigInt fail the write explicitly; never replace real output with a
    // lossy marker merely because actual/presented results share an object.
    return item;
  }, 2);
}

export class ToolExecutionStore {
  readonly journalPath: string;
  readonly stops: ToolExecutionWriteEvidence[] = [];
  started?: ToolExecutionWriteEvidence;

  private readonly writeSide: ToolOutputWriteSide;
  private stopSequence = 0;

  constructor(private readonly ctx: ExecContext, readonly executionId: string) {
    this.journalPath = `${TOOL_EXECUTION_JOURNAL_ROOT}/${executionId}`;
    this.writeSide = resolveToolOutputWriteSide(ctx);
  }

  recordStarted(options: ExecuteOptions, timeoutMs?: number): Promise<ToolExecutionWriteEvidence> {
    const promise = this.write('started', 'started.json', {
      schema_version: 1,
      kind: 'started',
      executionId: this.executionId,
      toolName: options.toolName,
      args: options.args,
      toolUseId: options.toolUseId,
      timeoutMs,
      startedAtMs: Date.now(),
    });
    return promise.then((evidence) => {
      this.started = evidence;
      return evidence;
    });
  }

  recordStop(reason: unknown): Promise<ToolExecutionWriteEvidence> {
    const sequence = ++this.stopSequence;
    const promise = this.write('stop', `stop-${sequence}.json`, {
      schema_version: 1,
      kind: 'stop_requested',
      executionId: this.executionId,
      sequence,
      reason,
      requestedAtMs: Date.now(),
    });
    return promise.then((evidence) => {
      this.stops.push(evidence);
      return evidence;
    });
  }

  recordFinal(
    final: Omit<ToolExecutionFinal, 'persistence'>,
  ): Promise<ToolExecutionWriteEvidence> {
    const document: ToolExecutionFinalDocument = {
      ...final,
      persistence: {
        journalPath: this.journalPath,
        ...(this.started ? { started: this.started } : {}),
        stops: [...this.stops],
      },
    };
    return this.write('final', 'final.json', document);
  }

  persistence(final: ToolExecutionWriteEvidence): ToolExecutionPersistence {
    return {
      journalPath: this.journalPath,
      ...(this.started ? { started: this.started } : {}),
      stops: [...this.stops],
      final,
    };
  }

  private async write(
    stage: 'started' | 'stop' | 'final',
    fileName: string,
    record: unknown,
  ): Promise<ToolExecutionWriteEvidence> {
    const path = `${this.journalPath}/${fileName}`;
    if (typeof this.writeSide.fs.writeAtomic !== 'function') {
      return this.auditFailure(stage, {
        path,
        kind: 'unavailable',
        persisted: false,
        durable: false,
        error: 'tool output filesystem does not provide writeAtomic',
      });
    }

    let result: AtomicWriteResult;
    try {
      result = await this.writeSide.fs.writeAtomic(path, json(record));
    } catch (error) {
      return this.auditFailure(stage, {
        path,
        kind: 'failed',
        persisted: false,
        durable: false,
        error: formatErr(error),
      });
    }

    const evidence: ToolExecutionWriteEvidence = {
      path,
      kind: result.kind,
      persisted: true,
      durable: result.kind === 'durable',
      ...(result.kind === 'durable' ? {} : { error: formatErr(result.error) }),
    };
    if (!evidence.durable) this.auditFailure(stage, evidence);
    return evidence;
  }

  private auditFailure(
    stage: 'started' | 'stop' | 'final',
    evidence: ToolExecutionWriteEvidence,
  ): ToolExecutionWriteEvidence {
    try {
      this.ctx.auditWriter?.write(
        TOOL_AUDIT_EVENTS.TOOL_EXECUTION_PERSIST_FAILED,
        `executionId=${this.executionId}`,
        `stage=${stage}`,
        `path=${evidence.path}`,
        `persisted=${evidence.persisted}`,
        `durable=${evidence.durable}`,
        `error=${evidence.error ?? 'unknown'}`,
      );
    } catch (error) {
      // Audit failure is additional degraded evidence on stderr, never a fake durable write.
      process.stderr.write(`[tools] execution journal audit failed: ${formatErr(error)}\n`);
    }
    return evidence;
  }
}
