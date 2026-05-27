/**
 * Phase 890: callback safeCallback wrap reverse tests
 *
 * Reverse coverage: onToolInputParseError + onToolExecutionFailed throw
 * → onSafeCallbackError emit + structured return preserved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSingleTool } from '../../../src/core/step-executor/tool-execution.js';
import type { IToolExecutor } from '../../../src/foundation/tools/index.js';
import type { ExecContext } from '../../../src/foundation/tool-protocol/index.js';

describe('phase 890: callback safeCallback wrap', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('onToolExecutionFailed throw isolation', () => {
    it('callback throw（执行已 fail 的 catch block 内）→ structured return 仍执行 + onSafeCallbackError 触发', async () => {
      const safeCallbackErrors: Array<{ label: string; err: unknown }> = [];
      const callbacks = {
        onToolExecutionFailed: vi.fn(() => { throw new Error('callback-boom'); }),
        onSafeCallbackError: (label: string, err: unknown) => {
          safeCallbackErrors.push({ label, err });
        },
      };

      const toolCall = {
        id: 'tu2',
        name: 'failTool',
        input: {},
      };

      const executor = {
        execute: vi.fn(async () => { throw new Error('exec-boom'); }),
      } as unknown as IToolExecutor;

      const ctx = {
        clawId: 'test',
        clawDir: '/tmp',
        workspaceDir: '/tmp',
        syncDir: '/tmp',
        callerType: 'main' as const,
        fs: {},
        profile: 'full' as const,
        stepNumber: 1,
        maxSteps: 10,
      } as ExecContext;

      const result = await executeSingleTool(toolCall as any, executor, ctx, callbacks as any);

      // 验证 1：structured return 不被 bypass、原 error 信息保留
      expect(result.success).toBe(false);
      expect(result.content).toContain('工具执行失败');
      expect(result.content).toContain('exec-boom');

      // 验证 2：callback 被 call 一次（throw 之前）
      expect(callbacks.onToolExecutionFailed).toHaveBeenCalledTimes(1);
      expect(callbacks.onToolExecutionFailed).toHaveBeenCalledWith('failTool', 'tu2', 'Error', 'exec-boom');

      // 验证 3：onSafeCallbackError 被触发、label 对
      expect(safeCallbackErrors).toHaveLength(1);
      expect(safeCallbackErrors[0].label).toBe('onToolExecutionFailed');
      expect((safeCallbackErrors[0].err as Error).message).toBe('callback-boom');

      // 验证 4：console.warn 已移除（phase 1179: caller lifecycle audit 覆盖）
    });
  });
});
