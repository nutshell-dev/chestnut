/**
 * @module L5.EventLoop
 * @layer L5 服务层
 * @depends L2.AuditLog, L2.Stream, L2.Messaging, L4.ContextManager, L4.Runtime
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
import type { Runtime, TurnResult } from '../runtime/index.js';
import type { StreamWriter } from '../../foundation/stream/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { STATUS_SUBDIR } from '../../foundation/process-manager/index.js';
import {
  INBOX_FALLBACK_TIMEOUT_MS_DEFAULT,
  LLM_MAX_RETRIES,
  LLM_RETRY_INITIAL_DELAY_MS,
  LLM_RETRY_STATE_FILE,
  REACT_CHAIN_MAX_ITERATIONS,
} from './constants.js';
import { EVENTLOOP_AUDIT_EVENTS, LOOP_ITERATION_TYPES } from './audit-events.js';
import { dispatchError, isAgentLoopCrashError } from './error-handlers.js';
import { createStreamCallbacks } from './stream-callbacks.js';
import { waitForInbox } from './inbox-watcher.js';
import { isContextExceededError } from '../../foundation/llm-orchestrator/index.js';
import type { InboxHandle } from '../../foundation/messaging/index.js';
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
  private rootFs: FileSystem;

  private stopped = false;

  // LLM failure retry state
  private llmRetryCount = 0;
  private llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;

  constructor(options: EventLoopOptions) {
    this.runtime = options.runtime;
    this.clawId = options.clawId;
    this.audit = options.audit;
    this.loopFs = options.fsFactory(path.join(options.agentDir, '..'));
    this.agentFs = options.fsFactory(options.agentDir);
    this.rootFs = this._resolveRootFs(options.fsFactory, options.agentDir);
    this.inboxPendingDir = options.inbox.pendingDir;
    this.fallbackTimeoutMs = options.inbox.fallbackTimeoutMs ?? INBOX_FALLBACK_TIMEOUT_MS_DEFAULT;
    this.streamWriter = options.streamWriter;
    this.onBatchComplete = options.onBatchComplete;
  }

  /**
   * 启动时恢复（崩溃重启继续退避；clean stop 后跳过，保持默认值）。
   */
  async initialize(): Promise<void> {
    this.audit.write(EVENTLOOP_AUDIT_EVENTS.ITERATION, `context=initialize`, `claw_id=${this.clawId}`);
    const consumeMarker = (fs: FileSystem): boolean => {
      try {
        if (!fs.existsSync('clean-stop')) return false;
        fs.deleteSync('clean-stop');
        return true;
      } catch {
        return false;  // marker 读删失败 best-effort（缺 marker 仅次启动 spurious warn，现状语义保留）
      }
    };
    // P1-11: per-claw marker（<agentDir>/clean-stop）优先，全局 marker（<root>/clean-stop）兜底。
    // 原 loopFs=fsFactory(join(agentDir,'..')) 对 claw 解析到 claws/ 目录，与 marker 实写位置均不匹配。
    const isCleanStop = consumeMarker(this.agentFs)   // per-claw
                     || consumeMarker(this.rootFs);  // global

    if (!isCleanStop) {
      await this._loadLlmRetryState();
    }
  }

  /**
   * 执行一轮事件循环：消费 inbox / 重试 / 等待消息。
   */
  async run(): Promise<void> {
    this.stopped = false;
    const wrappedCallbacks = this.streamWriter
      ? createStreamCallbacks(this.streamWriter, this.runtime)
      : undefined;

    try {
      // drain and process, with internal chaining
      let chainIters = 0;
      let chainTotal = 0;
      let firstInjected = 0;

      while (!this.stopped) {
        const { injected, sources, count, addressedHandles } = await this.runtime.drainInbox();
        if (count === 0) break;

        if (chainIters === 0) {
          firstInjected = count;
        }
        chainTotal += count;
        chainIters++;

        const systemPrompt = await this.runtime.getSystemPrompt();
        const tools = this.runtime.getToolsForLLM();
        const sessionMessages = await this.runtime.getMessages();
        let messages = [...sessionMessages, ...injected];
        messages = await this.runtime.proactiveTrimIfNeeded(messages, systemPrompt, tools);

        wrappedCallbacks?.onTurnStart?.(sources);
        const result = await this.runtime.processTurn(messages, systemPrompt, tools, wrappedCallbacks);

        if (result.status === 'success') {
          await this.runtime.ackHandles(addressedHandles, 'normal_turn_end');
          this._resetLlmRetryState();
          this._saveLlmRetryState();

          if (chainIters >= REACT_CHAIN_MAX_ITERATIONS) {
            this.audit.write(
              EVENTLOOP_AUDIT_EVENTS.ITERATION,
              `type=${LOOP_ITERATION_TYPES.chain_limited}`,
              `injected=${firstInjected}`,
              `chain_total=${chainTotal}`,
            );
            break;
          }
          // continue chain loop
        } else if (result.status === 'interrupted') {
          if (result.cause === 'idle_timeout') {
            await this.runtime.nackHandles(addressedHandles, result.cause, 'graceful_interrupt');
          } else {
            await this.runtime.ackHandles(addressedHandles, 'graceful_interrupt');
          }
          break;
        } else {
          await this._handleFailedTurn(result, addressedHandles);
          break;
        }
      }

      if (chainIters > 0) {
        if (chainIters < REACT_CHAIN_MAX_ITERATIONS) {
          this.audit.write(
            EVENTLOOP_AUDIT_EVENTS.ITERATION,
            `type=${LOOP_ITERATION_TYPES.chain}`,
            `injected=${firstInjected}`,
            `chain_total=${chainTotal}`,
          );
        }
        await this.onBatchComplete?.();
      } else {
        await waitForInbox(this.loopFs, this.audit, this.inboxPendingDir, this.fallbackTimeoutMs);
      }
    } catch (err) {
      // EventLoop-level unexpected error
      await this._dispatchError(err);
    }
  }

  /**
   * 中断当前 turn。daemon-loop 在 interrupt watcher 触发时调用。
   */
  abort(): void {
    this.stopped = true;
    this.runtime.abort();
  }

  private async _handleFailedTurn(
    result: TurnResult,
    addressedHandles: InboxHandle[],
  ): Promise<void> {
    if (result.status !== 'failed') return;
    if (isAgentLoopCrashError(result.error)) {
      // phase 1121 Step B: process failure 不再 mutate Contract；直接 ack 破热循环，
      // 错误调度 / fatal audit 由 _dispatchError 负责。
      await this.runtime.ackHandles(addressedHandles, 'agent_loop_crash');
    } else {
      await this.runtime.nackHandles(addressedHandles, formatErr(result.error) ?? 'failed', 'rollback');
    }
    if (isContextExceededError(result.error) && this.llmRetryCount < LLM_MAX_RETRIES) {
      try {
        await this.runtime.reactiveTrim();
      } catch {
        // silent: reactive trim is best-effort; dispatchError below will emit cooldown/retry audit
      }
    }
    await this._dispatchError(result.error);
  }

  private async _dispatchError(err: unknown): Promise<void> {
    const self = this;
    await dispatchError(err, {
      audit: this.audit,
      loopFs: this.loopFs,
      llmRetry: {
        get count() { return self.llmRetryCount; },
        set count(v) { self.llmRetryCount = v; },
        get delayMs() { return self.llmRetryDelayMs; },
        set delayMs(v) { self.llmRetryDelayMs = v; },
      },
      saveLlmRetryState: () => this._saveLlmRetryState(),
    });
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
          // P1-10: pending 字段已废弃，恒 false 保持 schema 兼容。
          llmRetryPending: false,
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
    // P1-10: 旧文件 pending=true 不再恢复，消息已经 inflight reconcile 重投。
    // 仅审计记录后忽略，避免重复重放。
    if (s.llmRetryPending === true) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.ITERATION,
        `context=loadLlmRetryState`,
        `reason=legacy_pending_ignored`,
      );
    }
  }

  /**
   * P1-11: 从 agentDir 解析 chestnut root 目录。
   * agentDir 形态：<root>/motion（motion）或 <root>/claws/<id>（claw）。
   * 避免 motion 字面，按路径形状判断。
   */
  private _resolveRootFs(
    fsFactory: (baseDir: string) => FileSystem,
    agentDir: string,
  ): FileSystem {
    // 用 path.resolve 而非 path.dirname 避免 no-clawdir-path-anti-pattern。
    const parentDir = path.resolve(agentDir, '..');
    const rootDir = path.basename(parentDir) === 'claws'
      ? path.resolve(parentDir, '..')
      : parentDir;
    return fsFactory(rootDir);
  }
}
