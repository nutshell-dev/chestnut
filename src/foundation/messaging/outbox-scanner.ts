/**
 * Outbox Scanner - scan all Claw outbox/pending,
 * return structured list for caller decisions, no direct inbox writes.
 *
 * Scanner returns a semantic snapshot (outbox count + daemon + contract status),
 * so callers can compose context-appropriate notifications without re-probing each field.
 */

import * as path from 'path';
import type { FileSystem } from '../fs/types.js';

/** Check if a claw's daemon process is alive. Injected to avoid cross-layer coupling. */
export interface ClawStatusProbe {
  isAlive(clawId: string): boolean;
}

export interface ClawOutboxInfo {
  clawId: string;
  count: number;
  /** Daemon liveness. 'unknown' when no probe is supplied. */
  daemon: 'running' | 'stopped' | 'unknown';
  /** Contract status inferred from directory presence. */
  contract: 'active' | 'paused' | 'none';
}

async function detectContractStatus(
  fs: FileSystem,
  clawDir: string,
): Promise<'active' | 'paused' | 'none'> {
  for (const state of ['active', 'paused'] as const) {
    const dir = path.join(clawDir, 'contract', state);
    try {
      const entries = await fs.list(dir, { includeDirs: true });
      if (entries.some(e => e.isDirectory)) return state;
    } catch (err: any) {
      const code = err?.code;
      if (code !== 'FS_NOT_FOUND' && code !== 'ENOENT') throw err;
    }
  }
  return 'none';
}

/**
 * Scan all claw outbox/pending, return structured list if any pending, null otherwise.
 * Caller decides when to write inbox notifications.
 */
export async function scanClawOutboxes(
  fs: FileSystem,
  baseDir: string,
  probe?: ClawStatusProbe,
): Promise<ClawOutboxInfo[] | null> {
  try {
    const clawsDir = path.join(baseDir, 'claws');
    if (!fs.existsSync(clawsDir)) {
      return null;
    }

    const entries = await fs.list(clawsDir, { includeDirs: true });
    const clawIds = entries.filter(e => e.isDirectory).map(e => e.name);

    const infos: ClawOutboxInfo[] = [];
    for (const id of clawIds) {
      const clawDir = path.join(clawsDir, id);
      const outboxPending = path.join(clawDir, 'outbox', 'pending');
      let count = 0;
      try {
        const files = (await fs.list(outboxPending, { includeDirs: false })).filter(f => f.name.endsWith('.md'));
        count = files.length;
      } catch (err: any) {
        const code = err?.code;
        if (code !== 'FS_NOT_FOUND' && code !== 'ENOENT') throw err;
        // 目录未创建，count 保持 0
      }
      if (count === 0) continue;

      // Probe daemon status defensively — probe failure must not kill the scan
      let daemon: 'running' | 'stopped' | 'unknown' = 'unknown';
      if (probe) {
        try {
          daemon = probe.isAlive(id) ? 'running' : 'stopped';
        } catch {
          daemon = 'unknown';
        }
      }

      const contract = await detectContractStatus(fs, clawDir);
      infos.push({ clawId: id, count, daemon, contract });
    }

    return infos.length === 0 ? null : infos;
  } catch (error) {
    console.warn('[OutboxScanner] scan failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}
