/**
 * @module L5.Runtime.Ports
 * Runtime port interfaces — H7 Runtime 注入化
 *
 * β 方案：按模块，每个依赖一个 port interface，仅暴露 Runtime 实际调用的方法。
 * 对有现有抽象接口的模块（ToolRegistry / IToolExecutor / ExecContext），port 直接继承
 * 以兼容 runReact 等内部消费方的契约要求；其余模块新建最小 port。
 */

import type { Message } from '../../types/message.js';
import type { InboxEntry } from '../../foundation/messaging/inbox-reader.js';
import type { OutboxWriteOptions } from '../../foundation/messaging/outbox-writer.js';
import type { SessionData } from '../../foundation/session-store/types.js';
import type { ToolResult } from '../tools/executor.js';
import type { ToolRegistry, IToolExecutor, ExecContext } from '../tools/executor.js';

// === L2 Foundation ports ===

/** Audit writer port */
export interface AuditPort {
  write(event: string, ...keyVals: (string | number)[]): void;
}

/** Snapshot git-commit port */
export interface SnapshotPort {
  commit(message: string): Promise<{ ok: true } | { ok: false; error: { kind: string; exitCode?: number } }>;
}

/** Session store port */
export interface SessionStorePort {
  archive(): Promise<void>;
  load(): Promise<{ session: SessionData; source?: string }>;
  save(data: Message[]): Promise<void>;
}

/** Inbox reader port */
export interface InboxPort {
  init(): Promise<void>;
  drainInbox(): Promise<InboxEntry[]>;
  markDone(filePath: string): Promise<void>;
  peekMetas(filter?: { priority?: ('critical' | 'high' | 'normal' | 'low')[] }): Promise<Record<string, string>[]>;
}

/** Outbox writer port */
export interface OutboxPort {
  write(options: OutboxWriteOptions): Promise<unknown>;
}

// === L3 Core ports ===

/** Tool registry port（继承现有 ToolRegistry 契约，保证 runReact 兼容） */
export interface ToolRegistryPort extends ToolRegistry {}

/** Tool executor port（继承现有 IToolExecutor 契约，保证 runReact 兼容） */
export interface ToolExecutorPort extends IToolExecutor {}

/** Context injector port */
export interface ContextInjectorPort {
  buildSystemPrompt(): Promise<string>;
  buildParts(): Promise<{
    agents: string;
    memory: string;
    skills: string;
    contract: string;
  }>;
}

/** Execution context port（继承现有 ExecContext 契约，保证 runReact 兼容） */
export interface ExecContextPort extends ExecContext {}

// === L4 Core ports ===

/** Contract manager port */
export interface ContractManagerPort {
  loadPaused(): Promise<{ id: string } | null>;
  resume(id: string): Promise<unknown>;
  setOnNotify(callback: (type: string, data: Record<string, unknown>) => void): void;
}

/** Task lifecycle port */
export interface TaskLifecyclePort {
  initialize(): Promise<void>;
  startDispatch(): void;
  shutdown(timeoutMs: number): Promise<void>;
  setParentStreamLog(streamLog: unknown): void;
  addTaskResultHandler(
    handler: (taskId: string, callerType: string | undefined, result: string, isError: boolean) => Promise<string>,
  ): () => void;
}

// === L2(旧L5) port ===

/** Skill registry port */
export interface SkillRegistryPort {
  formatForContext(): string;
}
