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

describe('Phase 86: clean stop 生命周期修复', () => {
  // 合并所有 watchdog 子文件源码（重构后代码分散在多个 sub-file）
  const watchdogFiles = [
    'watchdog.ts',
    'watchdog-context.ts',
    'watchdog-pid.ts',
    'watchdog-log.ts',
    'watchdog-state.ts',
    'watchdog-cron.ts',
    'watchdog-cli.ts',
  ];
  const watchdogSource = watchdogFiles
    .map(f => fs.readFileSync(path.join(watchdogDir, f), 'utf-8'))
    .join('\n');
  const stopSource = fs.readFileSync(stopPath, 'utf-8');
  const daemonLoopSource = fs.readFileSync(daemonLoopPath, 'utf-8');

  // ==========================================================================
  // Step 1: clawPreviouslyAlive + everSpawned 持久化 (phase 1072)
  // ==========================================================================
  describe('Step 1: clawPreviouslyAlive + everSpawned 持久化', () => {
    it('WatchdogState 接口应包含 clawPreviouslyAlive 字段', () => {
      const interfaceMatch = watchdogSource.match(
        /interface WatchdogState \{[\s\S]{0,800}?\}/
      );
      expect(interfaceMatch).toBeTruthy();
      expect(interfaceMatch![0]).toContain('clawPreviouslyAlive');
    });

    it('WatchdogState 接口应包含 everSpawned 字段', () => {
      const interfaceMatch = watchdogSource.match(
        /interface WatchdogState \{[\s\S]{0,800}?\}/
      );
      expect(interfaceMatch).toBeTruthy();
      expect(interfaceMatch![0]).toContain('everSpawned');
    });

    it('saveWatchdogState 应写入 clawPreviouslyAlive', () => {
      const saveMatch = watchdogSource.match(
        /function saveWatchdogState\(\)[\s\S]{0,800}?\}/
      );
      expect(saveMatch).toBeTruthy();
      expect(saveMatch![0]).toContain('clawPreviouslyAlive');
    });

    it('saveWatchdogState 应写入 everSpawned', () => {
      const saveMatch = watchdogSource.match(
        /function saveWatchdogState\(\)[\s\S]{0,800}?\}/
      );
      expect(saveMatch).toBeTruthy();
      expect(saveMatch![0]).toContain('everSpawned');
    });

    it('loadWatchdogState 应读取 clawPreviouslyAlive', () => {
      const startIdx = watchdogSource.indexOf('function loadWatchdogState()');
      expect(startIdx).toBeGreaterThan(-1);
      const endIdx = watchdogSource.indexOf('export function saveWatchdogState', startIdx);
      expect(endIdx).toBeGreaterThan(startIdx);
      const loadBlock = watchdogSource.slice(startIdx, endIdx);
      expect(loadBlock).toContain('clawPreviouslyAlive');
    });

    it('loadWatchdogState 应读取 everSpawned', () => {
      const startIdx = watchdogSource.indexOf('function loadWatchdogState()');
      expect(startIdx).toBeGreaterThan(-1);
      const endIdx = watchdogSource.indexOf('export function saveWatchdogState', startIdx);
      expect(endIdx).toBeGreaterThan(startIdx);
      const loadBlock = watchdogSource.slice(startIdx, endIdx);
      expect(loadBlock).toContain('everSpawned');
    });

    it('clawPreviouslyAlive Map 本身应仍存在（用于 crash 检测）', () => {
      expect(watchdogSource).toContain('clawPreviouslyAlive');
    });

    it('everSpawned Set 本身应仍存在（用于 first-tick crash 检测）', () => {
      expect(watchdogSource).toContain('everSpawned');
    });
  });

  // ==========================================================================
  // Step 2: stop.ts 写入 clean-stop 标记
  // ==========================================================================
  describe('Step 2: stop.ts 写入 clean-stop 标记', () => {
    it('应写入名为 clean-stop 的文件', () => {
      expect(stopSource).toContain('clean-stop');
    });

    it('应使用 writeFileSync 写入标记', () => {
      // 找到 clean-stop 相关代码块
      const cleanStopSection = stopSource.slice(
        stopSource.indexOf('clean-stop') - 100,
        stopSource.indexOf('clean-stop') + 200
      );
      expect(cleanStopSection).toContain('writeFileSync');
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
  // Step 3 + 4: daemon-loop.ts 仅对 motion 检查 clean-stop
  // ==========================================================================
  describe('Step 3+4: daemon-loop clean-stop 检测', () => {
    it('daemon-loop 应包含 clean-stop 标记检测逻辑', () => {
      const cleanStopFileIdx = daemonLoopSource.indexOf('cleanStopFile');
      expect(cleanStopFileIdx).toBeGreaterThan(-1);
    });

    it('clean-stop 检测应消费标记文件', () => {
      const isCleanStopMatch = daemonLoopSource.match(
        /const isCleanStop = \(\(\) => \{[\s\S]{0,400}?\}\)\(\)/
      );
      expect(isCleanStopMatch).toBeTruthy();
      const block = isCleanStopMatch![0];
      expect(block).toContain('unlinkSync');
      expect(block).toContain('return true');
      expect(block).toContain('return false');
    });

    it('clean stop 后应跳过 llm-retry-state 加载', () => {
      // 找到 !isCleanStop 条件块
      const condIdx = daemonLoopSource.indexOf('!isCleanStop');
      expect(condIdx).toBeGreaterThan(-1);
      const condBlock = daemonLoopSource.slice(condIdx, condIdx + 300);
      expect(condBlock).toContain('llmRetryStateFile');
    });

    it('标记文件应被一次性消费（unlinkSync）', () => {
      // 找到 cleanStopFile 定义（而非注释中的 clean-stop）
      const cleanStopFileIdx = daemonLoopSource.indexOf('cleanStopFile');
      expect(cleanStopFileIdx).toBeGreaterThan(-1);
      // unlinkSync 应在 cleanStopFile 附近（±300字符内）
      const surroundingCode = daemonLoopSource.slice(
        cleanStopFileIdx - 50,
        cleanStopFileIdx + 300
      );
      expect(surroundingCode).toContain('unlinkSync');
    });
  });
});
