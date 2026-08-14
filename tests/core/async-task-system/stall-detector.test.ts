/**
 * phase 1391 Step B: SubAgentTask 停滞检测。
 *
 * 三条件判据（AND）：running + stream 无活动超阈值 + 无 turn 在飞。
 * 阶梯：首次停滞 → task_stage_update 阶段消息；仍停滞 → is_error task_result + moveTaskToFailed。
 * 反例：turn 在飞、ToolTask、stream 有活动、stream 缺失均不判。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { InboxMessage } from '../../../src/foundation/messaging/index.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_QUEUES_RUNNING_DIR } from '../../../src/core/async-task-system/dirs.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import {
  startStallDetector,
  type StallDetectorDeps,
} from '../../../src/core/async-task-system/stall-detector.js';
import type { SubAgentTask } from '../../../src/core/async-task-system/types.js';

import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

const STALL_THRESHOLD_MS = 1000;
const FAIL_AFTER_MS = 1000;
const CHECK_INTERVAL_MS = 10_000;

const BASE_NOW = 1_000_000_000_000;

function makeTask(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  const id = (overrides.id as string | undefined) ?? randomUUID();
  return {
    kind: 'subagent',
    mode: 'standard',
    id: id as SubAgentTask['id'],
    shortId: id.slice(0, 8) as SubAgentTask['shortId'],
    parentClawId: 'parent-claw',
    createdAt: new Date(BASE_NOW - 60_000).toISOString(),
    timeoutMs: 60_000,
    intent: 'test',
    ...overrides,
  } as SubAgentTask;
}

interface FakeNow {
  (): number;
  advance(ms: number): void;
}

function makeFakeNow(start: number): FakeNow {
  let value = start;
  const fn = ((): number => value) as FakeNow;
  fn.advance = (ms: number): void => {
    value += ms;
  };
  return fn;
}

interface Harness {
  baseDir: string;
  nodeFs: NodeFileSystem;
  audit: AuditLog;
  auditEvents: Array<{ type: string; cols: string[] }>;
  sentInbox: InboxMessage[];
  fallbackErrors: Array<{ task: SubAgentTask; errorMsg: string }>;
  movedToFailed: string[];
  listShouldThrow: boolean;
  writeInboxShouldThrow: boolean;
  moveShouldThrow: boolean;
  sendFallbackShouldThrow: boolean;
  tasks: Array<{ task: SubAgentTask; runningPath: string }>;
  nowFn: FakeNow;
}

function makeHarness(): Harness {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const baseDir = path.join(tmpdir(), `phase1391-stall-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(baseDir, TASKS_QUEUES_RUNNING_DIR), { recursive: true });
  fs.mkdirSync(path.join(baseDir, TASKS_QUEUES_RESULTS_DIR), { recursive: true });
  fs.mkdirSync(path.join(baseDir, 'inbox', 'pending'), { recursive: true });

  const nodeFs = new NodeFileSystem({ baseDir });
  const auditEvents: Harness['auditEvents'] = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      auditEvents.push({ type, cols: cols.map(String) });
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };

  const sentInbox: InboxMessage[] = [];
  const fallbackErrors: Harness['fallbackErrors'] = [];
  const movedToFailed: string[] = [];

  return {
    baseDir,
    nodeFs,
    audit,
    auditEvents,
    sentInbox,
    fallbackErrors,
    movedToFailed,
    listShouldThrow: false,
    writeInboxShouldThrow: false,
    moveShouldThrow: false,
    sendFallbackShouldThrow: false,
    tasks: [],
    nowFn: makeFakeNow(BASE_NOW),
  };
}

function writeRunningTask(h: Harness, task: SubAgentTask): void {
  const runningPath = path.join(h.baseDir, TASKS_QUEUES_RUNNING_DIR, `${task.id}.json`);
  fs.writeFileSync(runningPath, JSON.stringify(task));
  h.tasks.push({ task, runningPath });
}

function writeStream(h: Harness, task: SubAgentTask, lines: Array<Record<string, unknown>>): void {
  const dir = path.join(h.baseDir, TASKS_QUEUES_RESULTS_DIR, String(task.id));
  fs.mkdirSync(dir, { recursive: true });
  const streamPath = path.join(dir, 'stream.jsonl');
  fs.writeFileSync(streamPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function makeDeps(h: Harness): StallDetectorDeps {
  return {
    fs: h.nodeFs,
    auditWriter: h.audit,
    listRunningSubagentTasks: async () => {
      if (h.listShouldThrow) throw new Error('list boom');
      return h.tasks.map(({ task }) => ({
        task,
        runningPath: path.join(h.baseDir, TASKS_QUEUES_RUNNING_DIR, `${task.id}.json`),
      }));
    },
    sendFallbackError: async (task, errorMsg) => {
      if (h.sendFallbackShouldThrow) throw new Error('fallback boom');
      h.fallbackErrors.push({ task, errorMsg });
    },
    moveTaskToFailed: async (id) => {
      if (h.moveShouldThrow) throw new Error('move boom');
      h.movedToFailed.push(String(id));
    },
    writeInboxAsync: async (_fs, _inboxDir, msg) => {
      if (h.writeInboxShouldThrow) throw new Error('inbox boom');
      h.sentInbox.push(msg);
    },
    checkIntervalMs: CHECK_INTERVAL_MS,
    stallThresholdMs: STALL_THRESHOLD_MS,
    failAfterMs: FAIL_AFTER_MS,
    now: h.nowFn,
  };
}

function teardown(h: Harness): void {
  try {
    fs.rmSync(h.baseDir, { recursive: true, force: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'ENOENT') throw e;
  }
}

describe('phase 1391 Step B: stall detector', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    teardown(h);
    vi.restoreAllMocks();
  });

  it('三条件齐 → 首次停滞推送 task_stage_update + audit', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    writeStream(h, task, [{ ts: BASE_NOW - STALL_THRESHOLD_MS - 100, type: 'turn_end' }]);
    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    try {
      await detector.checkOnce();
    } finally {
      detector.stop();
    }

    expect(h.sentInbox).toHaveLength(1);
    const msg = h.sentInbox[0];
    expect(msg.type).toBe('task_stage_update');
    expect(msg.to).toBe('parent-claw');
    const content = JSON.parse(msg.content as string) as Record<string, unknown>;
    expect(content.stage).toBe('stalled');
    expect(content.fullTaskId).toBe(task.id);
    expect(content.taskId).toBe(task.shortId);
    expect(content.idle_ms as number).toBeGreaterThanOrEqual(STALL_THRESHOLD_MS);

    const pushed = h.auditEvents.filter(e => e.type === TASK_AUDIT_EVENTS.TASK_STALL_STAGE_PUSHED);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].cols.join(' ')).toContain(`fullTaskId=${task.id}`);

    expect(h.fallbackErrors).toHaveLength(0);
    expect(h.movedToFailed).toHaveLength(0);
  });

  it('推送后仍停滞超过 FAIL_AFTER → is_error fallback + moveTaskToFailed + audit', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    writeStream(h, task, [{ ts: BASE_NOW - STALL_THRESHOLD_MS - FAIL_AFTER_MS - 100, type: 'turn_end' }]);

    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    try {
      await detector.checkOnce();
      expect(h.sentInbox).toHaveLength(1);
      expect(h.movedToFailed).toHaveLength(0);

      h.nowFn.advance(FAIL_AFTER_MS + 1);
      await detector.checkOnce();
    } finally {
      detector.stop();
    }

    expect(h.fallbackErrors).toHaveLength(1);
    expect(h.fallbackErrors[0].task.id).toBe(task.id);
    expect(h.fallbackErrors[0].errorMsg).toContain('stalled');
    expect(h.movedToFailed).toEqual([String(task.id)]);

    const failed = h.auditEvents.filter(e => e.type === TASK_AUDIT_EVENTS.TASK_STALL_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0].cols.join(' ')).toContain(`fullTaskId=${task.id}`);
  });

  it('反例：stream 有活动（idle 未超阈值）→ 不推送也不判失败', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    writeStream(h, task, [{ ts: BASE_NOW - 100, type: 'turn_end' }]);
    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    try {
      await detector.checkOnce();
    } finally {
      detector.stop();
    }
    expect(h.sentInbox).toHaveLength(0);
    expect(h.fallbackErrors).toHaveLength(0);
    expect(h.auditEvents.find(e => e.type === TASK_AUDIT_EVENTS.TASK_STALL_STAGE_PUSHED)).toBeUndefined();
  });

  it('反例：turn 在飞（末尾未配对 turn_start）→ 不触发（timeout-controller 管）', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    writeStream(h, task, [
      { ts: BASE_NOW - STALL_THRESHOLD_MS - 1000, type: 'turn_end' },
      { ts: BASE_NOW - STALL_THRESHOLD_MS - 100, type: 'turn_start' },
    ]);
    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    try {
      await detector.checkOnce();
    } finally {
      detector.stop();
    }
    expect(h.sentInbox).toHaveLength(0);
    expect(h.fallbackErrors).toHaveLength(0);
  });

  it('反例：turn_start 后已 turn_end → 不在飞，按停滞判', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    writeStream(h, task, [
      { ts: BASE_NOW - STALL_THRESHOLD_MS - 2000, type: 'turn_start' },
      { ts: BASE_NOW - STALL_THRESHOLD_MS - 1000, type: 'turn_end' },
    ]);
    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    try {
      await detector.checkOnce();
    } finally {
      detector.stop();
    }
    expect(h.sentInbox).toHaveLength(1);
    expect(h.sentInbox[0].type).toBe('task_stage_update');
  });

  it('反例：turn_interrupted/turn_error 关 turn 后停滞 → 判停滞', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    writeStream(h, task, [{ ts: BASE_NOW - STALL_THRESHOLD_MS - 100, type: 'turn_interrupted' }]);
    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    try {
      await detector.checkOnce();
    } finally {
      detector.stop();
    }
    expect(h.sentInbox).toHaveLength(1);
    expect(h.sentInbox[0].type).toBe('task_stage_update');
  });

  it('反例：stream 缺失 → fail-open 不判停滞', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    try {
      await detector.checkOnce();
    } finally {
      detector.stop();
    }
    expect(h.sentInbox).toHaveLength(0);
    expect(h.fallbackErrors).toHaveLength(0);
  });

  it('节流：同一停滞周期不重复推送阶段消息', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    writeStream(h, task, [{ ts: BASE_NOW - STALL_THRESHOLD_MS - 100, type: 'turn_end' }]);

    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    try {
      await detector.checkOnce();
      h.nowFn.advance(100);
      await detector.checkOnce();
      h.nowFn.advance(100);
      await detector.checkOnce();
    } finally {
      detector.stop();
    }

    expect(h.sentInbox.filter(m => m.type === 'task_stage_update')).toHaveLength(1);
    expect(h.movedToFailed).toHaveLength(0);
  });

  it('任务离开 running 后清理阶梯状态（重新出现可再推送）', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    writeStream(h, task, [{ ts: BASE_NOW - STALL_THRESHOLD_MS - 100, type: 'turn_end' }]);
    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    try {
      await detector.checkOnce();
      expect(h.sentInbox).toHaveLength(1);

      h.tasks = h.tasks.filter(t => t.task.id !== task.id);
      await detector.checkOnce();

      writeRunningTask(h, task);
      await detector.checkOnce();
    } finally {
      detector.stop();
    }

    expect(h.sentInbox.filter(m => m.type === 'task_stage_update')).toHaveLength(2);
  });

  it('sendFallbackError 失败 → 不 moveToFailed，下一轮重试', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    writeStream(h, task, [{ ts: BASE_NOW - STALL_THRESHOLD_MS - FAIL_AFTER_MS - 1000, type: 'turn_end' }]);

    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    try {
      await detector.checkOnce();
      h.nowFn.advance(FAIL_AFTER_MS + 1);

      h.sendFallbackShouldThrow = true;
      await detector.checkOnce();
      expect(h.movedToFailed).toHaveLength(0);
      const scanFailures = h.auditEvents.filter(e => e.type === TASK_AUDIT_EVENTS.TASK_STALL_SCAN_FAILED);
      expect(scanFailures.some(e => e.cols.join(' ').includes('context=send_fallback_error'))).toBe(true);

      h.sendFallbackShouldThrow = false;
      await detector.checkOnce();
    } finally {
      detector.stop();
    }
    expect(h.fallbackErrors).toHaveLength(1);
    expect(h.movedToFailed).toEqual([String(task.id)]);
  });

  it('listRunning 抛错 → audit TASK_STALL_SCAN_FAILED + 不 throw', async () => {
    const deps = makeDeps(h);
    h.listShouldThrow = true;
    const detector = startStallDetector(deps);
    try {
      await expect(detector.checkOnce()).resolves.toBeUndefined();
    } finally {
      detector.stop();
    }
    const scanFailures = h.auditEvents.filter(e => e.type === TASK_AUDIT_EVENTS.TASK_STALL_SCAN_FAILED);
    expect(scanFailures).toHaveLength(1);
    expect(scanFailures[0].cols.join(' ')).toContain('context=list_running');
  });

  it('stop 后 checkOnce 不再执行（no side effects）', async () => {
    const task = makeTask();
    writeRunningTask(h, task);
    writeStream(h, task, [{ ts: BASE_NOW - STALL_THRESHOLD_MS - 100, type: 'turn_end' }]);
    const deps = makeDeps(h);
    const detector = startStallDetector(deps);
    detector.stop();
    await detector.checkOnce();
    expect(h.sentInbox).toHaveLength(0);
    expect(h.auditEvents.find(e => e.type === TASK_AUDIT_EVENTS.TASK_STALL_STAGE_PUSHED)).toBeUndefined();
  });
});
