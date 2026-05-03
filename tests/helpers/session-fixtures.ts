import * as path from 'path';
import { promises as fs } from 'fs';

/**
 * Write a dialog/current.json that triggers DialogStore.repair
 * (assistant message with tool_use block, no following tool_result).
 */
export async function writeSessionWithIncompleteToolUse(clawDir: string, clawId: string): Promise<void> {
  const dialogDir = path.join(clawDir, 'dialog');
  await fs.mkdir(dialogDir, { recursive: true });

  const session = {
    version: 1,
    clawId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'readFile', input: { path: '/tmp/test' } },
        ],
      },
    ],
  };

  await fs.writeFile(
    path.join(dialogDir, 'current.json'),
    JSON.stringify(session),
  );
}
