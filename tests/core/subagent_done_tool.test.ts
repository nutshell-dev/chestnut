/**
 * done tool (generic subagent) 测试 — phase 765 Step C
 *
 * 测试 src/core/subagent/tools/done.ts 中：
 * - execute 成功时 capturedResult 存 { result }
 * - execute 失败时（missing result）不存 capturedResult
 * - 工厂函数每次返回新实例（不共享 state）
 */
import { describe, it, expect, vi } from 'vitest';
import { createDoneTool, DONE_TOOL_NAME } from '../../src/core/subagent/tools/done.js';

function makeCtx() {
  const requestStopSpy = vi.fn();
  return {
    clawId: 'test-claw',
    clawDir: '/tmp/test',
    requestStop: requestStopSpy,
    requestStopSpy,
  } as any;
}

describe('subagent doneTool (generic)', () => {
  it('should capture result on successful execute', async () => {
    const doneTool = createDoneTool();
    const ctx = makeCtx();

    const result = await doneTool.execute({ result: 'hello world' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Result captured');
    expect(doneTool.capturedResult).toEqual({ result: 'hello world' });
    expect(ctx.requestStopSpy).toHaveBeenCalledTimes(1);
  });

  it('should fail when result is missing', async () => {
    const doneTool = createDoneTool();
    const ctx = makeCtx();

    const result = await doneTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('missing result');
    expect(doneTool.capturedResult).toBeUndefined();
  });

  it('should fail when result is empty string', async () => {
    const doneTool = createDoneTool();
    const ctx = makeCtx();

    const result = await doneTool.execute({ result: '' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('missing result');
    expect(doneTool.capturedResult).toBeUndefined();
  });

  it('should have correct tool name and schema', () => {
    const doneTool = createDoneTool();

    expect(doneTool.name).toBe(DONE_TOOL_NAME);
    expect(doneTool.name).toBe('done');
    expect(doneTool.schema.required).toContain('result');
  });

  it('should return new instances from factory (no shared state)', async () => {
    const toolA = createDoneTool();
    const toolB = createDoneTool();
    const ctx = makeCtx();

    await toolA.execute({ result: 'from A' }, ctx);

    expect(toolA.capturedResult).toEqual({ result: 'from A' });
    expect(toolB.capturedResult).toBeUndefined();
  });
});
