/**
 * done tool (generic) 测试 — phase 765 Step C
 *
 * 测试 src/core/subagent/tools/done.ts 中：
 * - execute 成功时结果写入注入的 capture channel（phase 1858 Step F：per-run 通道取代实例字段）
 * - execute 失败时（missing result）不写 channel
 * - 二次调用拒绝（首次结果为权威）
 * - 各 channel 相互独立（无共享 state）
 */
import { describe, it, expect, vi } from 'vitest';
import { createDoneTool, DONE_TOOL_NAME, createResultCaptureChannel } from '../../src/core/subagent/tools/done.js';

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
  it('should capture result into injected channel on successful execute', async () => {
    const capture = createResultCaptureChannel<{ result: string }>();
    const doneTool = createDoneTool(capture);
    const ctx = makeCtx();

    const result = await doneTool.execute({ result: 'hello world' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Result captured');
    expect(capture.get()).toEqual({ result: 'hello world' });
    expect(ctx.requestStopSpy).toHaveBeenCalledTimes(1);
  });

  it('should fail when result is missing', async () => {
    const capture = createResultCaptureChannel<{ result: string }>();
    const doneTool = createDoneTool(capture);
    const ctx = makeCtx();

    const result = await doneTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('missing result');
    expect(capture.get()).toBeUndefined();
  });

  it('should fail when result is empty string', async () => {
    const capture = createResultCaptureChannel<{ result: string }>();
    const doneTool = createDoneTool(capture);
    const ctx = makeCtx();

    const result = await doneTool.execute({ result: '' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('missing result');
    expect(capture.get()).toBeUndefined();
  });

  it('should have correct tool name and schema', () => {
    const doneTool = createDoneTool();

    expect(doneTool.name).toBe(DONE_TOOL_NAME);
    expect(doneTool.name).toBe('done');
    expect(doneTool.schema.required).toContain('result');
  });

  it('should reject second done call; first result remains authoritative (phase 337 M5)', async () => {
    const capture = createResultCaptureChannel<{ result: string }>();
    const doneTool = createDoneTool(capture);
    const ctx = makeCtx();

    await doneTool.execute({ result: 'first' }, ctx);
    const second = await doneTool.execute({ result: 'second' }, ctx);

    expect(second.success).toBe(false);
    expect(second.error).toBe('duplicate done call');
    expect(capture.get()).toEqual({ result: 'first' });
  });

  it('channels are independent (no shared capture state)', async () => {
    const captureA = createResultCaptureChannel<{ result: string }>();
    const captureB = createResultCaptureChannel<{ result: string }>();
    const toolA = createDoneTool(captureA);
    const toolB = createDoneTool(captureB);
    const ctx = makeCtx();

    await toolA.execute({ result: 'from A' }, ctx);

    expect(captureA.get()).toEqual({ result: 'from A' });
    expect(captureB.get()).toBeUndefined();
    // toolB 未被调用，二次调用保护不误伤独立通道
    await toolB.execute({ result: 'from B' }, ctx);
    expect(captureB.get()).toEqual({ result: 'from B' });
  });
});
