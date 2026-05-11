import * as path from 'path';
import { promises as fs } from 'fs';
import type { SessionData } from '../../src/foundation/dialog-store/types.js';
import type { Message } from '../../src/types/message.js';

/**
 * Test helper: build a SessionData literal with sane defaults + overrides.
 *
 * Mirror src/foundation/dialog-store/types.ts:9 SessionData interface.
 * Schema drift → tsc fails here AND in callers (per phase 703 D-4 / ML「编译器检查」).
 *
 * @param overrides Partial fields to override defaults.
 */
export function makeSession(
  overrides: Partial<SessionData> = {},
): SessionData {
  const now = new Date().toISOString();
  return {
    version: 1,
    clawId: 'test-claw',
    createdAt: now,
    updatedAt: now,
    systemPrompt: '',  // phase 466: 必字段 / test default 空 / 业务 lifetime 锁不影响 fixture
    messages: [] as Message[],
    ...overrides,
  };
}

/**
 * Write a dialog/current.json that triggers DialogStore.repair
 * (assistant message with tool_use block, no following tool_result).
 *
 * Preserved from phase < 703 / single caller tests/core/runtime.test.ts.
 */
export async function writeSessionWithIncompleteToolUse(clawDir: string, clawId: string): Promise<void> {
  const dialogDir = path.join(clawDir, 'dialog');
  await fs.mkdir(dialogDir, { recursive: true });

  const session = makeSession({
    clawId,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'readFile', input: { path: '/tmp/test' } },
        ],
      },
    ],
  });

  await fs.writeFile(
    path.join(dialogDir, 'current.json'),
    JSON.stringify(session),
  );
}
