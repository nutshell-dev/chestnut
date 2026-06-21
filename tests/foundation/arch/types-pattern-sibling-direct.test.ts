import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 506: invariant that foundation/<module>/types.ts files exist as
 * sibling-direct ratify (phase 1312 D) — major foundation modules each
 * have a types.ts file that's allowed to be deep-imported.
 *
 * phase 576 扩: 5 → 12 entry 覆盖 foundation 全 types.ts (transport / dialog-store /
 * stream / file-watcher / process-manager / llm-orchestrator / process-exec 7 文件
 * 同型属 sibling-direct ratify pattern、应一同护)。
 */
describe('foundation types.ts sibling-direct pattern (phase 506 / phase 576 expanded)', () => {
  const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

  it.each([
    'foundation/fs/types.ts',
    'foundation/llm-provider/types.ts',
    'foundation/audit/types.ts',
    'foundation/messaging/types.ts',
    'foundation/tools/types.ts',
    // phase 576 +7
    'foundation/transport/types.ts',
    'foundation/dialog-store/types.ts',
    'foundation/stream/types.ts',
    'foundation/file-watcher/types.ts',
    'foundation/process-manager/types.ts',
    'foundation/llm-orchestrator/types.ts',
    'foundation/process-exec/types.ts',
  ])('%s exists (sibling-direct ratify target)', (rel) => {
    const cmd = `test -f ${srcRoot}/${rel} && echo OK || echo MISS`;
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out.trim()).toBe('OK');
  });
});
