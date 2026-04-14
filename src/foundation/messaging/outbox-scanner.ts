/**
 * Outbox Scanner - 扫描所有 Claw 的 outbox/pending，
 * 返回结构化列表供调用方决策，不直接写 inbox。
 */

import * as path from 'path';
import * as fs from 'fs/promises';

export interface ClawOutboxInfo {
  clawId: string;
  count: number;
}

/**
 * 扫描所有 claw outbox/pending，有未读则返回结构化列表，否则返回 null。
 * 调用方负责决定何时写 inbox 通知。
 */
export async function scanClawOutboxes(baseDir: string): Promise<ClawOutboxInfo[] | null> {
  try {
    const clawsDir = path.join(baseDir, 'claws');
    try {
      await fs.access(clawsDir);
    } catch {
      return null;
    }

    const entries = await fs.readdir(clawsDir, { withFileTypes: true });
    const clawIds = entries.filter(d => d.isDirectory()).map(d => d.name);

    const counts: Record<string, number> = {};
    for (const id of clawIds) {
      const outboxPending = path.join(clawsDir, id, 'outbox', 'pending');
      try {
        const files = (await fs.readdir(outboxPending)).filter(f => f.endsWith('.md'));
        if (files.length > 0) {
          counts[id] = files.length;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // ENOENT：outbox/pending 目录未创建，正常跳过
      }
    }

    if (Object.keys(counts).length === 0) return null;

    return Object.entries(counts).map(([id, n]) => ({ clawId: id, count: n }));
  } catch (error) {
    console.warn('[OutboxScanner] scan failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}
