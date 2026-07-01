/**
 * @module L5.EventLoop
 * @layer L5 服务层
 * @depends L2.AuditLog, L2.Stream, L2.Messaging, L4.ContextManager, L5.Runtime
 * @consumers L6.Daemon
 *
 * 事件驱动的轮次调度服务。在 daemon（进程生命周期）和 runtime（轮次执行）之间
 * 承担编排职责：消息到达、轮次失败、上下文超限等事件到达后，
 * 决定下一步调度什么动作。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { Runtime } from '../runtime/index.js';
import type { StreamWriter } from '../../foundation/stream/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { STATUS_SUBDIR } from '../../foundation/process-manager/index.js';
import {
  LLM_RETRY_INITIAL_DELAY_MS,
  LLM_RETRY_STATE_FILE,
  REACT_CHAIN_MAX_ITERATIONS,
} from './constants.js';
import { EVENTLOOP_AUDIT_EVENTS, LOOP_ITERATION_TYPES } from './audit-events.js';
import { dispatchError } from './error-handlers.js';
import { createStreamCallbacks } from './stream-callbacks.js';
import { waitForInbox } from './inbox-watcher.js';
import type { EventLoopOptions } from './types.js';

export class EventLoop {
  private runtime: Runtime;
  private clawId: string;
  private audit: AuditLog;
  private loopFs: FileSystem;
  private agentFs: FileSystem;
  private inboxPendingDir: string;
  private fallbackTimeoutMs: number;
  private streamWriter?: StreamWriter;
  private onBatchComplete?: () => Promise<void>;

  private stopped = false;

  // LLM failure retry state
  private llmRetryCount = 0;
  private llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
  private llmRetryPending = false;

  constructor(options: EventLoopOptions) {
    this.runtime = options.runtime;
    this.clawId = options.clawId;
    this.audit = options.audit;
    this.loopFs = options.fsFactory(path.join(options.agentDir, '..'));
    this.agentFs = options.fsFactory(options.agentDir);
    this.inboxPendingDir = options.inbox.pendingDir;
    this.fallbackTimeoutMs = options.inbox.fallbackTimeoutMs ?? 30000;
    this.streamWriter = options.streamWriter;
    this.onBatchComplete = options.onBatchComplete;
  }

  /**
   * 启动时恢复（崩溃重启继续退避；clean stop 后跳过，保持默认值）。
   */
  async initialize(): Promise<void> {
    this.audit.write(EVENTLOOP_AUDIT_EVENTS.ITERATION, `context=initialize`, `claw_id=${this.clawId}`);
    const isCleanStop = (() => {
      try {
        if (!this.loopFs.existsSync('clean-stop')) return false;
        this.loopFs.deleteSync('clean-stop');
        return true;
      } catch {
        return false;
      }
    })();

    if (!isCleanStop) {
      await this._loadLlmRetryState();
    }
  }

  /**
   * 执行一轮事件循环：消费 inbox / 重试 / 等待消息。
   */
  async run(): Promise<void> {
    const wrappedCallbacks = this.streamWriter
      ? createStreamCallbacks(this.streamWriter, this.runtime)
      : undefined;

    try {
      if (this.llmRetryPending) {
        this.llmRetryPending = false;
        await this.runtime.retryLastTurn(wrappedCallbacks);
        this._resetLlmRetryState();
        this._saveLlmRetryState();
        await this.onBatchComplete?.();
      } else {
        const injected = await this.runtime.processBatch(wrappedCallbacks);
        if (injected > 0) {
          let more = injected;
          let chainTotal = injected;
          let chainIters = 0;
          while (more > 0 && !this.stopped && chainIters < REACT_CHAIN_MAX_ITERATIONS) {
            more = await this.runtime.processBatch(wrappedCallbacks);
            chainTotal += more;
            chainIters++;
          }

          const chainType = chainIters >= REACT_CHAIN_MAX_ITERATIONS
            ? LOOP_ITERATION_TYPES.CHAIN_LIMITED
            : LOOP_ITERATION_TYPES.CHAIN;
          this.audit.write(
            EVENTLOOP_AUDIT_EVENTS.ITERATION,
            `type=${chainType}`,
            `injected=${injected}`,
            `chain_total=${chainTotal}`,
          );

          this._resetLlmRetryState();
          this._saveLlmRetryState();
          await this.onBatchComplete?.();
        } else {
          await waitForInbox(this.loopFs, this.audit, this.inboxPendingDir, this.fallbackTimeoutMs);
        }
      }
    } catch (err) {
      const self = this;
      await dispatchError(err, {
        audit: this.audit,
        loopFs: this.loopFs,
        llmRetry: {
          get count() { return self.llmRetryCount; },
          set count(v) { self.llmRetryCount = v; },
          get delayMs() { return self.llmRetryDelayMs; },
          set delayMs(v) { self.llmRetryDelayMs = v; },
          get pending() { return self.llmRetryPending; },
          set pending(v) { self.llmRetryPending = v; },
        },
        saveLlmRetryState: () => this._saveLlmRetryState(),
      });
    }
  }

  /**
   * 中断当前 turn。daemon-loop 在 interrupt watcher 触发时调用。
   */
  abort(): void {
    this.stopped = true;
    this.runtime.abort();
  }

  private _resetLlmRetryState(): void {
    this.llmRetryCount = 0;
    this.llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
  }

  private _saveLlmRetryState(): void {
    try {
      this.agentFs.ensureDirSync(STATUS_SUBDIR);
      this.agentFs.writeAtomicSync(
        path.join(STATUS_SUBDIR, LLM_RETRY_STATE_FILE),
        JSON.stringify({
          schema_version: 1,
          llmRetryCount: this.llmRetryCount,
          llmRetryDelayMs: this.llmRetryDelayMs,
          llmRetryPending: this.llmRetryPending,
        }),
      );
    } catch (e) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=saveLlmRetryState`,
        `reason=${(e as Error).message}`,
      );
    }
  }

  private async _loadLlmRetryState(): Promise<void> {
    let raw: string | undefined;
    try {
      raw = this.agentFs.readSync(path.join(STATUS_SUBDIR, LLM_RETRY_STATE_FILE));
    } catch (e) {
      if (!isFileNotFound(e)) {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=loadLlmRetryState`,
          `reason=read_failed`,
          `error=${formatErr(e)}`,
        );
      }
      raw = undefined;
    }

    if (raw === undefined) return;

    let saved: unknown;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=parse_failed`,
        `error=${formatErr(e)}`,
      );
      return;
    }

    if (typeof saved !== 'object' || saved === null) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=schema_invalid`,
        `actual=${typeof saved}`,
      );
      return;
    }

    const s = saved as Record<string, unknown>;
    if (s.schema_version !== 1) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=schema_version_mismatch`,
        `actual=${String(s.schema_version)}`,
        `expected=1`,
      );
      return;
    }

    if (
      typeof s.llmRetryCount !== 'number' ||
      typeof s.llmRetryDelayMs !== 'number' ||
      typeof s.llmRetryPending !== 'boolean'
    ) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=field_type_mismatch`,
      );
      return;
    }

    this.llmRetryCount = s.llmRetryCount;
    this.llmRetryDelayMs = s.llmRetryDelayMs;
    this.llmRetryPending = s.llmRetryPending;
  }
}
