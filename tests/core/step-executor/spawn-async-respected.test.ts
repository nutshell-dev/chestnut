import { describe, it, expect, vi } from 'vitest';
import { executeSingleTool } from '../../../src/core/step-executor/tool-execution.js';

describe('phase 1050: spawn async parameter respected', () => {
  it('async=false → spawn receives args.async=false, no executor async dispatch', async () => {
    const executeCalls: Array<{ args: Record<string, unknown>; async?: boolean }> = [];
    const executor = {
      execute: vi.fn(async (opts) => {
        executeCalls.push({ args: opts.args, async: opts.async });
        return { success: true, content: 'ok' };
      }),
    };

    const toolCall = {
      id: 'tu1',
      name: 'spawn',
      input: { intent: 'test', async: false },
    };

    const ctx = {
      clawId: 'test',
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawDir: '/tmp',
      profile: 'full',
      fs: {},
    } as any;

    const result = await executeSingleTool(toolCall as any, executor as any, ctx);

    expect(result.success).toBe(true);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executeCalls[0].args.async).toBe(false);
    expect(executeCalls[0].async).toBeUndefined();
  });

  it('async=true → spawn receives args.async=true, no executor async dispatch', async () => {
    const executeCalls: Array<{ args: Record<string, unknown>; async?: boolean }> = [];
    const executor = {
      execute: vi.fn(async (opts) => {
        executeCalls.push({ args: opts.args, async: opts.async });
        return { success: true, content: 'ok' };
      }),
    };

    const toolCall = {
      id: 'tu2',
      name: 'spawn',
      input: { intent: 'test', async: true },
    };

    const ctx = {
      clawId: 'test',
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawDir: '/tmp',
      profile: 'full',
      fs: {},
    } as any;

    const result = await executeSingleTool(toolCall as any, executor as any, ctx);

    expect(result.success).toBe(true);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executeCalls[0].args.async).toBe(true);
    expect(executeCalls[0].async).toBeUndefined();
  });

  it('no async → spawn receives args.async undefined, default behavior preserved', async () => {
    const executeCalls: Array<{ args: Record<string, unknown>; async?: boolean }> = [];
    const executor = {
      execute: vi.fn(async (opts) => {
        executeCalls.push({ args: opts.args, async: opts.async });
        return { success: true, content: 'ok' };
      }),
    };

    const toolCall = {
      id: 'tu3',
      name: 'spawn',
      input: { intent: 'test' },
    };

    const ctx = {
      clawId: 'test',
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawDir: '/tmp',
      profile: 'full',
      fs: {},
    } as any;

    const result = await executeSingleTool(toolCall as any, executor as any, ctx);

    expect(result.success).toBe(true);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executeCalls[0].args.async).toBeUndefined();
    expect(executeCalls[0].async).toBeUndefined();
  });
});
