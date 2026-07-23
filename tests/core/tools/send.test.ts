/**
 * send tool 测试 - sendTool 特有逻辑
 *
 * 测试 scope:
 * - 成功路径 → outboxWriter.write 调用参数断言（content-only）
 * - 错误 catch 包装
 *
 * 不测 OutboxWriter 行为（归属 tests/foundation/outbox-writer.test.ts）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSendTool } from '../../../src/foundation/messaging/tools/send.js';
import type { ExecContext } from '../../../src/foundation/tool-protocol/index.js';
import type { OutboxWriter } from '../../../src/foundation/messaging/index.js';
import { makeExecContext } from '../../helpers/exec-context.js';

function createMockCtx(): ExecContext {
  return makeExecContext({ stepNumber: 1, maxSteps: 10 });
}

describe('sendTool', () => {
  let writeMock: ReturnType<typeof vi.fn>;
  let ctx: ExecContext;
  let sendTool: ReturnType<typeof createSendTool>;

  beforeEach(() => {
    writeMock = vi.fn().mockResolvedValue('/tmp/test-claw/outbox/pending/msg.md');
    ctx = createMockCtx();
    sendTool = createSendTool({ write: writeMock } as unknown as OutboxWriter, 'motion');
  });

  it('calls outboxWriter.write with content and target on success', async () => {
    const result = await sendTool.execute({ content: 'hello' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Message sent');
    expect(writeMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'motion', content: 'hello' }),
    );
  });

  it('wraps outboxWriter.write errors into ToolResult success=false', async () => {
    writeMock.mockRejectedValue(new Error('disk full'));
    const result = await sendTool.execute({ content: 'test' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Error sending message');
    expect(result.content).toContain('disk full');
  });
});
