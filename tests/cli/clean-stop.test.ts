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
const watchdogPath = path.join(__dirname, '../../src/cli/commands/watchdog.ts');
const stopPath = path.join(__dirname, '../../src/cli/commands/stop.ts');
const daemonLoopPath = path.join(__dirname, '../../src/cli/commands/daemon-loop.ts');

describe('Phase 86: clean stop 生命周期修复', () => {
  const watchdogSource = fs.readFileSync(watchdogPath, 'utf-8');
  const stopSource = fs.readFileSync(stopPath, 'utf-8');
  const daemonLoopSource = fs.readFileSync(daemonLoopPath, 'utf-8');

  // ==========================================================================
  // Step 1: clawPreviouslyAlive 不再持久化
  // ==========================================================================
  describe('Step 1: clawPreviouslyAlive 不持久化', () => {
    it('WatchdogState 接口不应包含 clawPreviouslyAlive 字段', () => {
      // 找到 WatchdogState 接口
      const interfaceMatch = watchdogSource.match(
        /interface WatchdogState \{[\s\S]{0,300}?\}/
      );
      expect(interfaceMatch).toBeTruthy();
      expect(interfaceMatch![0]).not.toContain('clawPreviouslyAlive');
    });

    it('saveWatchdogState 不应写入 clawPreviouslyAlive', () => {
      const saveMatch = watchdogSource.match(
        /function saveWatchdogState\(\)[\s\S]{0,400}?\}/
      );
      expect(saveMatch).toBeTruthy();
      expect(saveMatch![0]).not.toContain('clawPreviouslyAlive');
    });

    it('loadWatchdogState 不应读取 clawPreviouslyAlive', () => {
      const loadMatch = watchdogSource.match(
        /function loadWatchdogState\(\)[\s\S]{0,400}?\}/
      );
      expect(loadMatch).toBeTruthy();
      expect(loadMatch![0]).not.toContain('clawPreviouslyAlive');
    });

    it('clawPreviouslyAlive Map 本身应仍存在（session-local 状态）', () => {
      // 运行期仍用于 crash 检测，只是不持久化
      expect(watchdogSource).toContain('clawPreviouslyAlive');
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
    it('应检查 options.isMotion 来区分 motion 和 claw daemon', () => {
      expect(daemonLoopSource).toContain('options.isMotion');
      // isMotion 判断应在 clean-stop 检测逻辑中（找 cleanStopFile 变量定义处）
      const cleanStopFileIdx = daemonLoopSource.indexOf('cleanStopFile');
      expect(cleanStopFileIdx).toBeGreaterThan(-1);

      const surroundingCode = daemonLoopSource.slice(
        cleanStopFileIdx - 300,
        cleanStopFileIdx + 200
      );
      expect(surroundingCode).toContain('options.isMotion');
    });

    it('claw daemon（isMotion 为 false）应直接返回 false，不消费标记', () => {
      const isCleanStopMatch = daemonLoopSource.match(
        /const isCleanStop = \(\(\) => \{[\s\S]{0,400}?\}\)\(\)/
      );
      expect(isCleanStopMatch).toBeTruthy();
      const block = isCleanStopMatch![0];
      // 应先检查 isMotion，为 false 就 return false
      expect(block).toContain('options.isMotion');
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
