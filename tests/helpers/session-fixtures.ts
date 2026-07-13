import * as path from 'path';
import { promises as fs } from 'fs';
import type { SessionData } from '../../src/foundation/dialog-store/types.js';
import type { Message } from '../../src/foundation/llm-provider/types.js';

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
    version: 2,
    clawId: 'test-claw',
    createdAt: now,
    updatedAt: now,
    systemPrompt: '',  // phase 713: per-turn snapshot / test default 空
    messages: [] as Message[],
    toolsForLLM: [],   // phase 713 NEW
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
          // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
