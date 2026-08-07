/**
 * Forum-level aggregator multi-file last-activity tests — phase 172.
 *
 * Covers: computeClawLastActivityAgoMs cross-file tail max timestamp.
 * Invariant: tick / viewport activity must not be dropped when they are
 * routed to separate files (phase 159 fileRouting).
 */

import { describe, it, expect } from 'vitest';
import { computeClawLastActivityAgoMs } from '../../../src/core/status-service/forum-aggregators.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
// phase 259: 本测试仅测 computeClawLastActivityAgoMs 纯 helper，不涉 ForumStatusDeps / clawTopology

// ── Fake FS helpers ─────────────────────────────────────────────────────────

interface FakeFile {
  content: string | Buffer;
  size: number;
}

function makeFs(files: Record<string, string | Buffer>, dirs: Record<string, string[]> = {}): FileSystem {
  const entries: Record<string, FakeFile> = {};
  for (const [p, c] of Object.entries(files)) {
    const buf = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
    entries[p] = { content: buf, size: buf.length };
  }
  return {
    existsSync: (p: string) => {
      if (p === '.' && (Object.keys(entries).length > 0 || Object.keys(dirs).length > 0)) return true;
      return p in entries || p in dirs;
    },
    statSync: (p: string) => {
      if (p in entries) return { size: entries[p].size, mtimeMs: 0, isDirectory: false, isFile: true };
      if (p in dirs) return { size: 0, mtimeMs: 0, isDirectory: true, isFile: false };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readSync: (p: string) => {
      const e = entries[p];
      if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Buffer.isBuffer(e.content) ? e.content.toString('utf8') : e.content;
    },
    readBytesSync: (p: string, start: number, end: number) => {
      const e = entries[p];
      if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const buf = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8');
      return buf.slice(start, end);
    },
    listSync: (p: string, _opts?: unknown) => {
      if (p === '.') {
        const names = new Set<string>();
        for (const k of Object.keys(entries)) {
          const slashIdx = k.indexOf('/');
          names.add(slashIdx === -1 ? k : k.slice(0, slashIdx));
        }
        for (const k of Object.keys(dirs)) {
          const slashIdx = k.indexOf('/');
          names.add(slashIdx === -1 ? k : k.slice(0, slashIdx));
        }
        return Array.from(names).map(n => ({ name: n, isDirectory: true, isFile: false }));
      }
      const list = dirs[p] || [];
      return list.map(n => ({ name: n, isDirectory: true, isFile: false }));
    },
  } as unknown as FileSystem;
}

// ── computeClawLastActivityAgoMs multi-file aware ───────────────────────────

describe('computeClawLastActivityAgoMs multi-file aware (phase 172)', () => {
  const NOW = Date.parse('2026-05-30T14:00:00Z');

  it('single audit.tsv scenario (pre-phase 159 backwards compat)', () => {
    const ts = '2026-05-30T13:58:00Z';
    const fs = makeFs({
      'audit.tsv': `${ts}\tseq=2\ttool_call\tname=read\n`,
    });
    const v = computeClawLastActivityAgoMs(fs, NOW);
    expect(v).toBe(2 * 60 * 1000);
  });

  it('tick.tsv newer than audit.tsv → tick activity counted (phase 159 post)', () => {
    const auditTs = '2026-05-30T13:50:00Z';
    const tickTs = '2026-05-30T13:58:00Z';
    const fs = makeFs({
      'audit.tsv': `${auditTs}\tseq=1\tboot\tx=1\n`,
      'tick.tsv': `${tickTs}\tseq=2\tdaemon_liveness_heartbeat\n`,
    });
    const v = computeClawLastActivityAgoMs(fs, NOW);
    expect(v).toBe(2 * 60 * 1000);
  });

  it('audit.tsv + tick.tsv + viewport.tsv → max across all three', () => {
    const auditTs = '2026-05-30T13:50:00Z';
    const tickTs = '2026-05-30T13:55:00Z';
    const viewportTs = '2026-05-30T13:59:00Z';
    const fs = makeFs({
      'audit.tsv': `${auditTs}\tseq=1\tboot\tx=1\n`,
      'tick.tsv': `${tickTs}\tseq=2\tdaemon_liveness_heartbeat\n`,
      'viewport.tsv': `${viewportTs}\tseq=3\tviewport_render\n`,
    });
    const v = computeClawLastActivityAgoMs(fs, NOW);
    expect(v).toBe(1 * 60 * 1000);
  });

  it('viewport.tsv newer than audit.tsv → viewport activity counted', () => {
    const auditTs = '2026-05-30T13:50:00Z';
    const viewportTs = '2026-05-30T13:58:30Z';
    const fs = makeFs({
      'audit.tsv': `${auditTs}\tseq=1\tboot\tx=1\n`,
      'viewport.tsv': `${viewportTs}\tseq=3\tviewport_render\n`,
    });
    const v = computeClawLastActivityAgoMs(fs, NOW);
    expect(v).toBe(90 * 1000);
  });

  it('corrupt tick.tsv skipped, audit.tsv still works', () => {
    const auditTs = '2026-05-30T13:58:00Z';
    const fs = makeFs({
      'audit.tsv': `${auditTs}\tseq=1\tboot\tx=1\n`,
      'tick.tsv': 'this-is-not-a-valid-audit-line\n',
    });
    const v = computeClawLastActivityAgoMs(fs, NOW);
    expect(v).toBe(2 * 60 * 1000);
  });

  it('all files empty → undefined', () => {
    const fs = makeFs({
      'audit.tsv': '',
      'tick.tsv': '',
    });
    const v = computeClawLastActivityAgoMs(fs, NOW);
    expect(v).toBeUndefined();
  });

  it('empty baseDir → undefined', () => {
    const fs = makeFs({});
    const v = computeClawLastActivityAgoMs(fs, NOW);
    expect(v).toBeUndefined();
  });

  it('only tick.tsv exists (no business events) → tick ts used', () => {
    const tickTs = '2026-05-30T13:58:00Z';
    const fs = makeFs({
      'tick.tsv': `${tickTs}\tseq=1\tdaemon_liveness_heartbeat\n`,
    });
    const v = computeClawLastActivityAgoMs(fs, NOW);
    expect(v).toBe(2 * 60 * 1000);
  });

  it('future timestamp in one file returns 0 (clock skew)', () => {
    const auditTs = '2026-05-30T13:50:00Z';
    const tickTs = '2026-05-30T15:00:00Z';
    const fs = makeFs({
      'audit.tsv': `${auditTs}\tseq=1\tboot\tx=1\n`,
      'tick.tsv': `${tickTs}\tseq=2\tdaemon_liveness_heartbeat\n`,
    });
    const v = computeClawLastActivityAgoMs(fs, NOW);
    // maxTs = tickTs (future), elapsed = NOW - future < 0 → clamped to 0
    expect(v).toBe(0);
  });

  it('.bak files are ignored by listAuditFiles', () => {
    const auditTs = '2026-05-30T13:58:00Z';
    const fs = makeFs({
      'audit.tsv': `${auditTs}\tseq=1\tboot\tx=1\n`,
      'audit.tsv.bak': '2026-05-30T13:00:00Z\tseq=0\told\n',
    });
    const v = computeClawLastActivityAgoMs(fs, NOW);
    expect(v).toBe(2 * 60 * 1000);
  });

  it('phase 1318: daily archive tick.<yyyymmdd>.tsv is ignored by listAuditFiles', () => {
    const auditTs = '2026-05-30T13:58:00Z';
    const archiveTs = '2026-05-30T13:59:00Z'; // newer than audit, but must be ignored
    const fs = makeFs({
      'audit.tsv': `${auditTs}\tseq=1\tboot\tx=1\n`,
      'tick.20260530.tsv': `${archiveTs}\tseq=1\tdaemon_liveness_heartbeat\n`,
    });
    const v = computeClawLastActivityAgoMs(fs, NOW);
    expect(v).toBe(2 * 60 * 1000);
  });
});
