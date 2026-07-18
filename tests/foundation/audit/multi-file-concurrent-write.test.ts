import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as actualFs from 'node:fs/promises';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

// Must mock before importing the module-under-test (hoisted by vitest)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
  };
});

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  AuditWriter,
  _resetFallbackForTest,
  reconcileFallbackDumps,
} from '../../../src/foundation/audit/writer.js';
import { DispatchingAuditWriter } from '../../../src/foundation/audit/dispatching-writer.js';
import * as nodeFs from 'node:fs';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeFailingFs(): FileSystem {
  return {
    appendSync: vi.fn(() => {
      throw new Error('EIO disk full');
    }),
    statSync: vi.fn(() => ({ size: 0 } as any)),
    moveSync: vi.fn(),
  } as any;
}

describe(
  'DispatchingAuditWriter multi-file concurrent write invariants (phase 176 Step B / Gap-7)',
  () => {
    let tmpDir: string;
    let exitListeners: Array<() => void>;
    const dumpFiles: string[] = [];

    async function writeDump(lines: string[]): Promise<string> {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      const dumpDir = tmpdir();
      let ts = Date.now();
      let p = join(dumpDir, `chestnut-audit-fallback-${process.pid}-${ts}.tsv`);
      while (existsSync(p)) {
        ts++;
        p = join(dumpDir, `chestnut-audit-fallback-${process.pid}-${ts}.tsv`);
      }
      await actualFs.writeFile(p, lines.join('\n') + '\n');
      dumpFiles.push(p);
      return p;
    }

    beforeEach(() => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      tmpDir = mkdtempSync(join(tmpdir(), 'phase176-mfcw-'));
      _resetFallbackForTest();
      exitListeners = [];
      vi.spyOn(process, 'on').mockImplementation((event: string, handler: any) => {
        if (event === 'exit') exitListeners.push(handler);
        return process;
      });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      for (const p of dumpFiles) {
        try { rmSync(p); } catch { /* silent: test cleanup */ }
      }
      dumpFiles.length = 0;
      vi.restoreAllMocks();
      vi.mocked(nodeFs.writeFileSync).mockClear();
      _resetFallbackForTest();
    });

    it('per-file seq 独立计数（cross-instance emit 不 cross-contamination）', () => {
      const fs = new NodeFileSystem({ baseDir: tmpDir });
      const dw = new DispatchingAuditWriter(
        fs,
        tmpDir,
        new Map([
          ['daemon_liveness_heartbeat', 'tick'],
          ['turn_start', 'audit'],
        ]),
      );

      dw.write('daemon_liveness_heartbeat', 'job=a');
      dw.write('daemon_liveness_heartbeat', 'job=b');
      dw.write('daemon_liveness_heartbeat', 'job=c');
      dw.write('turn_start', 'trace_id=t1');
      dw.write('turn_end', 'trace_id=t1');

      const tickContent = readFileSync(join(tmpDir, 'tick.tsv'), 'utf-8');
      const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');

      expect(tickContent).toContain('seq=1');
      expect(tickContent).toContain('seq=2');
      expect(tickContent).toContain('seq=3');
      expect(auditContent).toContain('seq=1');
      expect(auditContent).toContain('seq=2');
    });

    it('fallback queue origin frontmatter 标 source file 路径', () => {
      const fs = makeFailingFs();
      const dw = new DispatchingAuditWriter(
        fs,
        tmpDir,
        new Map([['daemon_liveness_heartbeat', 'tick']]),
      );

      dw.write('daemon_liveness_heartbeat', 'job=a');
      dw.dispose();

      expect(nodeFs.writeFileSync).toHaveBeenCalled();
      const call = vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any;
      const dumpedPath = call[0] as string;
      const dumpedContent = call[1] as string;

      expect(dumpedPath).toMatch(
        new RegExp(
          // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
          `^${escapeRegex(tmpdir())}/chestnut-audit-fallback-\\d+-\\d+\\.tsv$`,
        ),
      );
      expect(dumpedContent).toContain(join(tmpDir, 'tick.tsv'));
    });

    it('cross-instance fallback push 不 cross-contamination', () => {
      const fs = makeFailingFs();
      const dw = new DispatchingAuditWriter(
        fs,
        tmpDir,
        new Map([
          ['daemon_liveness_heartbeat', 'tick'],
          ['turn_start', 'audit'],
        ]),
      );

      dw.write('daemon_liveness_heartbeat', 'job=a');
      dw.write('turn_start', 'trace_id=t1');
      dw.dispose();

      expect(nodeFs.writeFileSync).toHaveBeenCalled();
      const call = vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any;
      const dumpedContent = call[1] as string;

      const lines = dumpedContent
        .split('\n')
        .filter((l: string) => l.length > 0 && !l.startsWith('#'));
      expect(lines.length).toBe(2);

      const tickOrigin = lines.filter((l: string) =>
        l.startsWith(join(tmpDir, 'tick.tsv')),
      );
      const auditOrigin = lines.filter((l: string) =>
        l.startsWith(join(tmpDir, 'audit.tsv')),
      );
      expect(tickOrigin.length).toBe(1);
      expect(auditOrigin.length).toBe(1);
      expect(tickOrigin[0]).toContain('daemon_liveness_heartbeat');
      expect(auditOrigin[0]).toContain('turn_start');
    });

    it('reconcile 按 origin 分桶回放各 file 独立', async () => {
      const dumpPath = await writeDump([
        `${join(tmpDir, 'tick.tsv')}\t2026-06-07T10:00:00.000Z\tseq=1\tdaemon_liveness_heartbeat\tjob=a`,
        `${join(tmpDir, 'tick.tsv')}\t2026-06-07T10:00:01.000Z\tseq=2\tdaemon_liveness_heartbeat\tjob=b`,
        `${join(tmpDir, 'audit.tsv')}\t2026-06-07T10:00:02.000Z\tseq=1\tturn_start\ttrace_id=t1`,
      ]);

      const appended = new Map<string, string>();
      const synced: string[] = [];
      const mockFs: FileSystem = {
        appendSync: vi.fn((origin: string, content: string) => {
          appended.set(origin, (appended.get(origin) || '') + content);
        }),
        syncSync: vi.fn((origin: string) => {
          synced.push(origin);
        }),
      } as any;

      await reconcileFallbackDumps(mockFs);

      expect(appended.has(join(tmpDir, 'tick.tsv'))).toBe(true);
      expect(appended.has(join(tmpDir, 'audit.tsv'))).toBe(true);

      const tickAppended = appended.get(join(tmpDir, 'tick.tsv'))!;
      const auditAppended = appended.get(join(tmpDir, 'audit.tsv'))!;

      expect(tickAppended).toContain('daemon_liveness_heartbeat');
      expect(tickAppended).toContain('job=a');
      expect(tickAppended).toContain('job=b');
      expect(tickAppended).not.toContain('turn_start');

      expect(auditAppended).toContain('turn_start');
      expect(auditAppended).not.toContain('daemon_liveness_heartbeat');

      expect(synced).toContain(join(tmpDir, 'tick.tsv'));
      expect(synced).toContain(join(tmpDir, 'audit.tsv'));

      expect(existsSync(dumpPath)).toBe(false);
    });

    it('module-level fallback drop 计数器 cross-instance shared 但 dump frontmatter 正确', () => {
      const fs = makeFailingFs();
      const dw = new DispatchingAuditWriter(
        fs,
        tmpDir,
        new Map([
          ['daemon_liveness_heartbeat', 'tick'],
          ['turn_start', 'audit'],
        ]),
      );

      // overflow fallback buffer: write 1002 entries (cap=1000 → 2 dropped)
      for (let i = 0; i < 1002; i++) {
        if (i % 2 === 0) {
          dw.write('daemon_liveness_heartbeat', `job=${i}`);
        } else {
          dw.write('turn_start', `trace_id=t${i}`);
        }
      }

      dw.dispose();

      expect(nodeFs.writeFileSync).toHaveBeenCalled();
      const call = vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any;
      const dumpedContent = call[1] as string;

      // frontmatter should contain drop_count_since_last_dump=2
      expect(dumpedContent).toMatch(/^# drop_count_since_last_dump=2 /);

      // buffer should contain exactly 1000 lines (2 dropped)
      const allLines = dumpedContent.split('\n').filter((l: string) => l.length > 0);
      const hasFrontmatter = allLines[0] && allLines[0].startsWith('# drop_count_since_last_dump=');
      const lineCount = hasFrontmatter ? allLines.length - 1 : allLines.length;
      expect(lineCount).toBe(1000);
    });

    it('未 register type 兜底 default file emit 不 cross-contamination per-instance seq', () => {
      const fs = new NodeFileSystem({ baseDir: tmpDir });
      const dw = new DispatchingAuditWriter(
        fs,
        tmpDir,
        new Map([['daemon_liveness_heartbeat', 'tick']]),
      );

      dw.write('turn_start', 'trace_id=t1');
      dw.write('unregistered_event', 'payload=xyz');
      dw.write('turn_end', 'trace_id=t1');

      const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');

      expect(auditContent).toContain('turn_start');
      expect(auditContent).toContain('unregistered_event');
      expect(auditContent).toContain('turn_end');
      expect(auditContent).toContain('seq=1');
      expect(auditContent).toContain('seq=2');
      expect(auditContent).toContain('seq=3');
    });

    it('dispose 联级 dispose 各 internal writer / fallback dump 触发 / 0 leak', () => {
      const fs = makeFailingFs();
      const dw = new DispatchingAuditWriter(
        fs,
        tmpDir,
        new Map([
          ['daemon_liveness_heartbeat', 'tick'],
          ['turn_start', 'audit'],
        ]),
      );

      dw.write('daemon_liveness_heartbeat', 'job=a');

      // dispose should not throw and should trigger dumpFallback
      expect(() => dw.dispose()).not.toThrow();
      expect(nodeFs.writeFileSync).toHaveBeenCalledTimes(1);

      // double dispose should be safe (no additional writeFileSync calls)
      expect(() => dw.dispose()).not.toThrow();
      expect(nodeFs.writeFileSync).toHaveBeenCalledTimes(1);
    });

    it('exit handler 模块-level once-init / 多 internal writer 仅注册一次', () => {
      const fs = makeFailingFs();
      const dw = new DispatchingAuditWriter(
        fs,
        tmpDir,
        new Map([
          ['daemon_liveness_heartbeat', 'tick'],
          ['turn_start', 'audit'],
        ]),
      );

      dw.write('daemon_liveness_heartbeat', 'job=a');
      dw.write('turn_start', 'trace_id=t1');

      // only one exit listener despite two internal writers + fallback pushes
      expect(exitListeners).toHaveLength(1);
    });
  },
);
