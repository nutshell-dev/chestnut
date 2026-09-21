/**
 * Phase 86：clean stop 生命周期修复
 *
 * 测试策略：源代码结构验证（不依赖进程 mock）
 *
 * 验证点：
 * 1. watchdog-state.json 不再持久化 clawPreviouslyAlive
 * 2. stop.ts 写入 clean-stop 标记
 * 3. daemon-loop.ts 仅对 motion daemon（options.isMotion 为 true 时）检查 clean-stop
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watchdogDir = path.join(__dirname, '../../src/watchdog');
const stopPath = path.join(__dirname, '../../src/cli/commands/stop.ts');
const daemonLoopPath = path.join(__dirname, '../../src/daemon/daemon-loop.ts');
const eventLoopPath = path.join(__dirname, '../../src/core/event-loop/event-loop.ts');

describe('Phase 86: clean stop 生命周期修复', () => {
  // 合并所有 watchdog 子文件源码（重构后代码分散在多个 sub-file）
  const watchdogFiles = [
    'watchdog.ts',
    'watchdog-context.ts',
    'watchdog-pid.ts',
    'watchdog-log.ts',
    'watchdog-state.ts',
    'executor-recovery.ts',
    'spawn.ts',
  ];
  const watchdogSource = watchdogFiles
    .map(f => fs.readFileSync(path.join(watchdogDir, f), 'utf-8'))
    .join('\n');
  const stopSource = fs.readFileSync(stopPath, 'utf-8');
  const daemonLoopSource = fs.readFileSync(daemonLoopPath, 'utf-8');
  const eventLoopSource = fs.readFileSync(eventLoopPath, 'utf-8');

  // ==========================================================================
  // Step 1: Phase 1396 Step H 后 Watchdog 持久化状态
  // ==========================================================================
  describe('Step 1: durable state after Phase 1396 Step H', () => {
    it('WatchdogState 接口应包含 motionRestart 与 executorRestart 字段', () => {
      const interfaceMatch = watchdogSource.match(
        /interface WatchdogState \{[\s\S]{0,800}?\}/
      );
      expect(interfaceMatch).toBeTruthy();
      expect(interfaceMatch![0]).toContain('motionRestart');
      expect(interfaceMatch![0]).toContain('executorRestart');
    });

    it('saveWatchdogState 应调用两个 durable state API 的 snapshot()', () => {
      const saveMatch = watchdogSource.match(
        /function saveWatchdogState\(fsFactory[\s\S]{0,800}?\}/
      );
      expect(saveMatch).toBeTruthy();
      expect(saveMatch![0]).toContain('motionRestartStateAPI.snapshot()');
      expect(saveMatch![0]).toContain('executorRestartStateAPI.snapshot()');
    });

    it('loadWatchdogState 应调用两个 durable state API 的 replace()', () => {
      const startIdx = watchdogSource.indexOf('function loadWatchdogState(fsFactory');
      expect(startIdx).toBeGreaterThan(-1);
      const endIdx = watchdogSource.indexOf('export function saveWatchdogState(fsFactory', startIdx);
      expect(endIdx).toBeGreaterThan(startIdx);
      const loadBlock = watchdogSource.slice(startIdx, endIdx);
      expect(loadBlock).toContain('motionRestartStateAPI.replace(');
      expect(loadBlock).toContain('executorRestartStateAPI.replace(');
    });

    it('saveWatchdogState 不应再持久化 retired notification Maps', () => {
      const saveStart = watchdogSource.indexOf('export function saveWatchdogState(fsFactory');
      expect(saveStart).toBeGreaterThan(-1);
      const saveBlock = watchdogSource.slice(saveStart);
      expect(saveBlock).not.toContain('clawPreviouslyAlive');
      expect(saveBlock).not.toContain('everSpawned');
      expect(saveBlock).not.toContain('lastInactivityNotified');
    });
  });

  // ==========================================================================
  // Step 2: stop.ts 写入 clean-stop 标记
  // ==========================================================================
  describe('Step 2: stop.ts 写入 clean-stop 标记', () => {
    it('应写入名为 clean-stop 的文件', () => {
      expect(stopSource).toContain('clean-stop');
    });

    it('应使用 atomic write 写入标记', () => {
      // 找到 clean-stop 相关代码块
      const cleanStopSection = stopSource.slice(
        stopSource.indexOf('clean-stop') - 100,
        stopSource.indexOf('clean-stop') + 200
      );
      expect(cleanStopSection).toContain('writeAtomicSync');
    });

    it('应在 claws 停止后、Done 输出前写入标记', () => {
      const allClawsStoppedIdx = stopSource.indexOf('All claws stopped');
      const cleanStopIdx = stopSource.indexOf('clean-stop');
      const doneIdx = stopSource.indexOf("console.log('Done.')");

      expect(allClawsStoppedIdx).toBeGreaterThan(-1);
      expect(cleanStopIdx).toBeGreaterThan(-1);
      expect(doneIdx).toBeGreaterThan(-1);

      expect(cleanStopIdx).toBeGreaterThan(allClawsStoppedIdx);
      expect(cleanStopIdx).toBeLessThan(doneIdx);
    });
  });

  // ==========================================================================
  // Step 3 + 4: EventLoop 加载 clean-stop / llm-retry-state（phase 783 从 daemon-loop 迁入）
  // ==========================================================================
  describe('Step 3+4: EventLoop clean-stop / llm-retry-state 加载', () => {
    it('EventLoop 应包含 clean-stop 标记检测逻辑', () => {
      const cleanStopIdx = eventLoopSource.indexOf("'clean-stop'");
      expect(cleanStopIdx).toBeGreaterThan(-1);
    });

    it('clean stop 不再清除已决定的 LLM 恢复等待（phase 1826：特例移除）', () => {
      // 旧「clean stop 跳过 llm-retry-state 加载」特例已删除：恢复安排是持久事实，
      // 进程恢复与 clean-stop 都不清除。phase 1890 Step D：旧文件迁移读取
      // （_readLegacyRecoveryExport）随存量废弃删除。
      expect(eventLoopSource).not.toContain('!isCleanStop');
    });

    it('标记文件应被一次性消费（deleteSync）', () => {
      // 找到 clean-stop 附近 deleteSync 调用
      const cleanStopIdx = eventLoopSource.indexOf("'clean-stop'");
      expect(cleanStopIdx).toBeGreaterThan(-1);
      // deleteSync 应在 clean-stop 附近（±300字符内）
      const surroundingCode = eventLoopSource.slice(
        cleanStopIdx - 50,
        cleanStopIdx + 300
      );
      expect(surroundingCode).toContain('deleteSync');
    });
  });
});
