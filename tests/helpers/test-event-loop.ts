/**
 * Step H (phase1895): EventLoop 驱动的测试装配 helper。
 *
 * 替代已删除的 legacy-process-batch helper：不再 replicate 旧 Runtime.processBatch()
 * 编排（drain → trim → processTurn → ack/nack），而是构造真实 EventLoop 单 owner
 * 驱动现行协议（begin → drain/chain → finish），测试只负责 seed inbox / 注入 mock。
 */

import * as path from 'path';
import { EventLoop } from '../../src/core/event-loop/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { Runtime } from '../../src/core/runtime/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { RuntimeTestInternals } from './runtime-test-internals.js';

export interface TestEventLoopOptions {
  runtime: Runtime;
  clawDir: string;
  clawId: string;
  /** 缺省用 runtime 的 auditWriter（同一引用，spy/mock 前后一致）。 */
  audit?: AuditLog;
  /** inbox 空转等待上限；默认 20ms（测试级小值）。 */
  fallbackTimeoutMs?: number;
}

/** 装配真实 EventLoop，驱动一次 run() = 一轮 begin → drain/chain → finish。 */
export function createTestEventLoop(options: TestEventLoopOptions): EventLoop {
  return new EventLoop({
    runtime: options.runtime,
    fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }),
    agentDir: options.clawDir,
    clawId: options.clawId,
    audit: options.audit ?? (options.runtime as unknown as RuntimeTestInternals).auditWriter,
    inbox: {
      pendingDir: path.join(options.clawDir, 'inbox', 'pending'),
      fallbackTimeoutMs: options.fallbackTimeoutMs ?? 20,
    },
  });
}
