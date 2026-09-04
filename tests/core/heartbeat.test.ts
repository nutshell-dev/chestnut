/**
 * Heartbeat 单元测试 - 简化为纯 timer
 *
 * Heartbeat 只负责：
 * 1. isDue() - 检查是否应该触发
 * 2. fire() - 向 motion/inbox/pending/ 写入 .md 消息
 */

import { makeChestnutRoot } from '../../src/core/claw-topology/claw-instance-paths.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Heartbeat } from '../../src/core/heartbeat/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import { makeAudit } from '../helpers/audit.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createSystemAudit } from '../../src/foundation/audit/index.js';
import { createInboxReader } from '../../src/foundation/messaging/index.js';
import { routeNotifyClaw } from '../../src/core/claw-topology/index.js';
import { createTempDir, cleanupTempDirSync } from '../utils/temp.js';

function createTestHeartbeat(tempDir: string, intervalSec?: number): Heartbeat {
  const nodeFs = new NodeFileSystem({ baseDir: tempDir });
  const audit = createSystemAudit(nodeFs, tempDir);
  const inboxReader = createInboxReader(nodeFs, audit, path.join(tempDir, 'motion', 'inbox'));
  // phase 84: DI callback - bind chestnutRoot + MOTION_CLAW_ID + fs + audit at caller
  const chestnutRoot = makeChestnutRoot(tempDir);
  return new Heartbeat({
    // phase 1405: intervalSec 为 undefined 时物理省略 interval key，真实覆盖缺省路径
    ...(intervalSec === undefined ? {} : { interval: intervalSec }),
    audit,
    inboxReader,
    notifyInbox: (msg) => routeNotifyClaw(nodeFs, chestnutRoot, 'motion', 'motion', msg, audit),
  });
}

describe('Heartbeat', () => {
  let tempDir: string;
  let heartbeat: Heartbeat;

  beforeEach(async () => {
    tempDir = await createTempDir('chestnut-hb-test-');
    // 创建 motion/inbox/pending 目录结构
    fs.mkdirSync(path.join(tempDir, 'motion', 'inbox', 'pending'), { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupTempDirSync(tempDir);
  });

  describe('isDue', () => {
    it('should return false on first call (initialized to now)', () => {
      heartbeat = createTestHeartbeat(tempDir, 1);
      expect(heartbeat.isDue()).toBe(false);  // 启动后等满 interval 才触发
    });

    it('should return false immediately after fire', async () => {
      heartbeat = createTestHeartbeat(tempDir, 1);
      await heartbeat.fire();
      expect(heartbeat.isDue()).toBe(false);
    });

    it('interval zero is disabled even when constructed directly', async () => {
      heartbeat = createTestHeartbeat(tempDir, 0);
      vi.useFakeTimers();
      vi.advanceTimersByTime(60_000);
      expect(heartbeat.isDue()).toBe(false);
      await heartbeat.fire();
      const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
      expect(fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'))).toHaveLength(0);
    });

    describe('with fake timers', () => {
      beforeEach(() => { vi.useFakeTimers(); });
      afterEach(() => { vi.useRealTimers(); });

      it('should return true after interval elapsed', async () => {
        heartbeat = createTestHeartbeat(tempDir, 1); // 1秒间隔
        await heartbeat.fire();
        expect(heartbeat.isDue()).toBe(false);

        vi.advanceTimersByTime(1100);
        expect(heartbeat.isDue()).toBe(true);
      });

      it('should respect custom interval', async () => {
        heartbeat = createTestHeartbeat(tempDir, 5); // 5秒间隔
        await heartbeat.fire();
        expect(heartbeat.isDue()).toBe(false);

        vi.advanceTimersByTime(1000);
        expect(heartbeat.isDue()).toBe(false);
      });
    });
  });

  describe('fire', () => {
    it('should write heartbeat message to motion inbox', async () => {
      heartbeat = createTestHeartbeat(tempDir, 1);
      await heartbeat.fire();

      const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));

      expect(files.length).toBe(1);

      const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf-8');
      expect(content).toContain('type: heartbeat');
      expect(content).toContain('from: "system"');
      expect(content).toContain('priority: low');
      // phase 1419: heartbeat body is now empty (formatter ignores ctx.body / 措辞由 formatter 拼 base + HEARTBEAT.md)
      // Body section after frontmatter must be empty string (no Chinese, no leftover payload)
      const bodyAfterFrontmatter = content.split(/^---\s*$/m).slice(2).join('---').trim();
      expect(bodyAfterFrontmatter).toBe('');
    });

    describe('with fake timers', () => {
      beforeEach(() => { vi.useFakeTimers(); });
      afterEach(() => { vi.useRealTimers(); });

      it('should update lastRun after fire', async () => {
        heartbeat = createTestHeartbeat(tempDir, 1);
        expect(heartbeat.isDue()).toBe(false);  // 首次不 due

        vi.advanceTimersByTime(1100);
        expect(heartbeat.isDue()).toBe(true);

        await heartbeat.fire();
        expect(heartbeat.isDue()).toBe(false);  // fire 后重置

        vi.advanceTimersByTime(1100);
        expect(heartbeat.isDue()).toBe(true);
      });

      it('should generate unique filenames for multiple fires', async () => {
        heartbeat = createTestHeartbeat(tempDir, 1);

        vi.useFakeTimers({ shouldAdvanceTime: false });
        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 0));
        await heartbeat.fire();
        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 100)); // +100ms 确保不同时间戳
        await heartbeat.fire();

        const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
        const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));

        // 第一次 fire 生成文件，第二次被去重跳过
        expect(files.length).toBe(1);
      });

      it('should generate new file after previous heartbeat is consumed', async () => {
        heartbeat = createTestHeartbeat(tempDir, 1);

        // 第一次 fire
        await heartbeat.fire();
        const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
        let files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
        expect(files.length).toBe(1);

        // 模拟消费（移走文件）
        fs.unlinkSync(path.join(inboxDir, files[0]));

        // 第二次 fire 应该生成新文件
        vi.useFakeTimers({ shouldAdvanceTime: false });
        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 1, 0)); // +1s 确保不同时间戳
        await heartbeat.fire();
        files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
        expect(files.length).toBe(1);
      });
    });

    it('should create inbox pending directory when motion root exists', async () => {
      // phase 1170: claw root lifecycle is owned by topology; Messaging only owns inbox subdirs.
      const newBaseDir = path.join(tempDir, 'newbase');
      fs.mkdirSync(path.join(newBaseDir, 'motion'), { recursive: true });

      heartbeat = createTestHeartbeat(newBaseDir, 1);
      await heartbeat.fire();

      const inboxDir = path.join(newBaseDir, 'motion', 'inbox', 'pending');
      expect(fs.existsSync(inboxDir)).toBe(true);

      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
      expect(files.length).toBe(1);
    });
  });

  describe('default interval', () => {
    it('omitting interval disables heartbeat (phase 1405)', async () => {
      // fake timers 在构造前开启，避免 lastRun 时钟混用
      vi.useFakeTimers();
      heartbeat = createTestHeartbeat(tempDir); // 物理省略 interval key

      // 推进超过旧的 300s 默认，禁用语义下时间推移不影响 isDue
      vi.advanceTimersByTime(400_000);
      expect(heartbeat.isDue()).toBe(false);

      await heartbeat.fire();
      const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
      expect(fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'))).toHaveLength(0);
    });
  });

  // phase 1767 (Phase 1766 冻结设计): wall-clock 回拨不造成无限期 due 阻塞，
  // rollback 事实可观察；回拨不触发重复 heartbeat（重锚定后等满 interval）。
  describe('wall-clock rollback（phase 1767）', () => {
    function createClockControlledHeartbeat(
      intervalSec: number,
      clock: { now: number },
      audit: AuditLog,
    ): Heartbeat {
      const nodeFs = new NodeFileSystem({ baseDir: tempDir });
      const inboxReader = createInboxReader(nodeFs, audit, path.join(tempDir, 'motion', 'inbox'));
      const chestnutRoot = makeChestnutRoot(tempDir);
      return new Heartbeat({
        interval: intervalSec,
        audit,
        inboxReader,
        notifyInbox: (msg) => routeNotifyClaw(nodeFs, chestnutRoot, 'motion', 'motion', msg, audit),
        now: () => clock.now,
      });
    }

    it('回拨时重锚定 due 基线并写可观察 rollback 事实，且不立即 due', () => {
      const { audit, events } = makeAudit();
      const clock = { now: 1_000_000 };
      heartbeat = createClockControlledHeartbeat(60, clock, audit);

      // 前进满 interval → due，fire 后 lastRun 锚定
      clock.now += 60_000;
      expect(heartbeat.isDue()).toBe(true);

      // wall-clock 回拨到启动前
      clock.now = 500_000;
      expect(heartbeat.isDue()).toBe(false);

      const rollbackEvents = events.filter((e) => e[0] === 'heartbeat_clock_rollback');
      expect(rollbackEvents.length).toBe(1);
      expect(rollbackEvents[0].join('\t')).toContain('last_run=1000000');
      expect(rollbackEvents[0].join('\t')).toContain('now=500000');
      expect(rollbackEvents[0].join('\t')).toContain('delta_ms=-500000');
    });

    it('回拨不立即 due；重锚定后须从新基线等满 interval 才 due（回拨本身不触发重复 heartbeat）', async () => {
      const { audit, events } = makeAudit();
      const clock = { now: 1_000_000 };
      heartbeat = createClockControlledHeartbeat(10, clock, audit);

      clock.now += 10_000;
      expect(heartbeat.isDue()).toBe(true);
      await heartbeat.fire(); // lastRun 锚定到 1_010_000，inbox 落一条 heartbeat
      const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
      expect(fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'))).toHaveLength(1);

      // 回拨：重锚定到 900_000，不 due、不重复触发
      clock.now = 900_000;
      expect(heartbeat.isDue()).toBe(false);
      expect(events.filter((e) => e[0] === 'heartbeat_clock_rollback').length).toBe(1);
      expect(fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'))).toHaveLength(1);

      // 从新基线前进不足 interval → 仍不 due
      clock.now = 905_000;
      expect(heartbeat.isDue()).toBe(false);

      // 从新基线等满 interval → due
      clock.now = 910_000;
      expect(heartbeat.isDue()).toBe(true);
    });

    it('正常前进沿用 elapsed interval 语义', () => {
      const { audit } = makeAudit();
      const clock = { now: 2_000_000 };
      heartbeat = createClockControlledHeartbeat(30, clock, audit);

      clock.now += 29_999;
      expect(heartbeat.isDue()).toBe(false);
      clock.now += 1;
      expect(heartbeat.isDue()).toBe(true);
    });

    it('相等边界（elapsed == interval）保持 due', () => {
      const { audit } = makeAudit();
      const clock = { now: 3_000_000 };
      heartbeat = createClockControlledHeartbeat(5, clock, audit);

      clock.now += 5_000; // 恰好相等
      expect(heartbeat.isDue()).toBe(true);
    });

    it('同一回拨片段只审计一次（重锚定后 lastRun=now，后续观测正常）', () => {
      const { audit, events } = makeAudit();
      const clock = { now: 4_000_000 };
      heartbeat = createClockControlledHeartbeat(60, clock, audit);

      clock.now = 3_000_000; // 回拨
      expect(heartbeat.isDue()).toBe(false);
      expect(heartbeat.isDue()).toBe(false);
      expect(events.filter((e) => e[0] === 'heartbeat_clock_rollback').length).toBe(1);

      // 时钟继续回拨（第二次、更深的回拨）→ 新的事实
      clock.now = 2_000_000;
      expect(heartbeat.isDue()).toBe(false);
      expect(events.filter((e) => e[0] === 'heartbeat_clock_rollback').length).toBe(2);
    });
  });
});
