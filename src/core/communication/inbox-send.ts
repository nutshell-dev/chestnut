/**
 * Inbox message sending — write a message file to a claw's inbox/pending/.
 *
 * Extracted from LocalTransport. This is Messaging (L2) logic,
 * temporarily in core/communication/ until the Messaging module is created.
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import type { InboxMessage } from '../../types/contract.js';
import { writeAtomic } from '../../foundation/fs/atomic.js';

/**
 * Build YAML frontmatter + body from InboxMessage.
 */
function buildFrontmatterMessage(msg: InboxMessage): string {
  return `---
id: ${msg.id}
type: ${msg.type}
from: ${msg.from}
to: ${msg.to}
priority: ${msg.priority}
timestamp: ${msg.timestamp}
${msg.contract_id ? `contract_id: ${msg.contract_id}` : ''}
---

${msg.content}
`;
}

/**
 * Send a message to a claw's inbox.
 *
 * @param workspaceDir — workspace root (e.g. ~/.clawforum/), claws live under {workspaceDir}/claws/
 * @param clawId — target claw identifier
 * @param msg — message to deliver
 */
export async function sendInboxMessage(
  workspaceDir: string,
  clawId: string,
  msg: InboxMessage,
): Promise<void> {
  const pendingDir = path.join(workspaceDir, 'claws', clawId, 'inbox', 'pending');
  await fs.mkdir(pendingDir, { recursive: true });

  const timestamp = Date.now();
  const priority = msg.priority ?? 'normal';
  const filename = `${timestamp}_${priority}_${randomUUID().slice(0, 8)}.md`;
  const filePath = path.join(pendingDir, filename);

  await writeAtomic(filePath, buildFrontmatterMessage(msg));
}
