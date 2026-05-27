import { promises as fs } from 'node:fs';
import { rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export async function createTempDir(prefix = 'clawforum-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    console.warn(`[test cleanup] Failed to remove ${tempDir}: ${err?.message ?? err}`);
  }
}

export function cleanupTempDirSync(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    console.warn(`[test cleanup] Failed to remove ${tempDir}: ${err?.message ?? err}`);
  }
}
