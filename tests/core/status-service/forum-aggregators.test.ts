/**
 * Forum-level aggregator tests — phase 1478 Step A.
 *
 * Covers:
 *   - computeProcessUptimeMs (parses lstart-style start strings)
 *   - computeClawInboxUnread (counts inbox/pending files)
 *   - computeClawLastActivityAgoMs (tails audit.tsv)
 *   - computeForumStatusView (composite — system + active claws + orphans)
 *   - formatForumStatusView snapshot
 *   - humanizeUptime / humanizeAgo
 *
 * Reverse cases: missing PID start, absent inbox dir, empty audit file,
 * unparseable audit line, watchdog stopped, motion stopped, 0 claws dir.
 */

import { describe, it, expect, vi } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import {
  computeForumStatusView,
  formatForumStatusView,
} from '../../../src/core/status-service/index.js';
import {
  computeProcessUptimeMs,
  computeClawInboxUnread,
  computeClawLastActivityAgoMs,
  computeOrphans,
  type ForumStatusDeps,
} from '../../../src/core/status-service/forum-aggregators.js';
import { humanizeUptime, humanizeAgo } from '../../../src/core/status-service/forum-formatter.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { ProcessManager } from '../../../src/foundation/process-manager/index.js';
import * as messaging from '../../../src/foundation/messaging/index.js';
import { ProcessListUnavailable } from '../../../src/foundation/process-exec/index.js';
import { MOTION_CLAW_ID } from '../../../src/core/claw-topology/index.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';
import { STATUS_AUDIT_EVENTS } from '../../../src/core/status-service/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

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
      // Fake-fs convention: all listed children are treated as directories
      // (sufficient for CLAWS_DIR scan + inbox/pending count which ignores kind).
      return list.map(n => ({ name: n, isDirectory: true, isFile: false }));
    },
    list: (p: string, _opts?: unknown) => {
      return Promise.resolve(makeFs(files, dirs).listSync(p, _opts));
    },
  } as unknown as FileSystem;
}

// ── computeProcessUptimeMs ──────────────────────────────────────────────────

describe('computeProcessUptimeMs', () => {
  const NOW = Date.parse('2026-05-30T14:00:00Z');

  it('returns elapsed ms when getStartTime returns parseable string', () => {
    const start = '2026-05-30T13:00:00Z';
    const v = computeProcessUptimeMs(1234, NOW, () => start);
    expect(v).toBe(3600_000);
  });

  it('returns undefined when getStartTime returns undefined (PID gone)', () => {
    const v = computeProcessUptimeMs(1234, NOW, () => undefined);
    expect(v).toBeUndefined();
  });

  it('returns undefined when start string is unparseable', () => {
    const v = computeProcessUptimeMs(1234, NOW, () => 'not-a-date');
    expect(v).toBeUndefined();
  });

  it('returns undefined when start is in the future (clock skew)', () => {
    const future = '2026-05-30T15:00:00Z';
    const v = computeProcessUptimeMs(1234, NOW, () => future);
    expect(v).toBeUndefined();
  });
});

// ── computeClawInboxUnread ──────────────────────────────────────────────────

describe('computeClawInboxUnread', () => {
  const TEST_CLAW_LABEL = 'test-claw';

  function makeDummyAudit(): AuditLog {
    return { write: vi.fn() } as unknown as AuditLog;
  }

  it('returns 0 when inbox/pending dir does not exist', async () => {
    const fs = makeFs({}, {});
    expect(await computeClawInboxUnread(fs, makeDummyAudit(), TEST_CLAW_LABEL)).toBe(0);
  });

  it('returns number of files in inbox/pending', async () => {
    const fs = makeFs({}, { 'inbox/pending': ['msg-1.md', 'msg-2.md', 'msg-3.md'] });
    expect(await computeClawInboxUnread(fs, makeDummyAudit(), TEST_CLAW_LABEL)).toBe(3);
  });

  it('returns 0 when inbox/pending is empty', async () => {
    const fs = makeFs({}, { 'inbox/pending': [] });
    expect(await computeClawInboxUnread(fs, makeDummyAudit(), TEST_CLAW_LABEL)).toBe(0);
  });

  it('returns undefined inboxUnread and writes audit when peekPendingCount fails', async () => {
    vi.spyOn(messaging, 'createInboxReader').mockReturnValue({
      peekPendingCount: vi.fn().mockRejectedValue(new Error('EACCES')),
    } as unknown as ReturnType<typeof messaging.createInboxReader>);
    const audit = makeDummyAudit();
    const result = await computeClawInboxUnread(makeFs({}), audit, TEST_CLAW_LABEL);
    expect(result).toBeUndefined();
    expect(audit.write).toHaveBeenCalledWith(
      STATUS_AUDIT_EVENTS.INBOX_UNREAD_ERROR,
      `claw=${TEST_CLAW_LABEL}`,
      'error=EACCES',
    );
    vi.restoreAllMocks();
  });
});

// ── computeClawLastActivityAgoMs ────────────────────────────────────────────

describe('computeClawLastActivityAgoMs', () => {
  const NOW = Date.parse('2026-05-30T14:00:00Z');

  it('returns undefined when audit.tsv does not exist', () => {
    const fs = makeFs({});
    // phase 1759: 文件不存在 = 正常无活动（complete），非读取故障
    const r = computeClawLastActivityAgoMs(fs, NOW);
    expect(r.kind).toBe('complete');
    expect(r.agoMs).toBeUndefined();
  });

  it('returns undefined for empty audit.tsv', () => {
    const fs = makeFs({ 'audit.tsv': '' });
    expect(computeClawLastActivityAgoMs(fs, NOW).agoMs).toBeUndefined();
  });

  it('parses last line timestamp and returns elapsed ms', () => {
    const ts = '2026-05-30T13:58:00Z';
    const content = [
      `2026-05-30T13:00:00Z\tseq=1\tboot\tx=1`,
      `${ts}\tseq=2\ttool_call\tname=read`,
      '', // trailing newline
    ].join('\n');
    const fs = makeFs({ 'audit.tsv': content });
    const v = computeClawLastActivityAgoMs(fs, NOW).agoMs;
    expect(v).toBe(2 * 60 * 1000);
  });

  it('returns undefined when last line has unparseable timestamp', () => {
    const fs = makeFs({ 'audit.tsv': 'garbage-no-tab-no-iso\n' });
    expect(computeClawLastActivityAgoMs(fs, NOW).agoMs).toBeUndefined();
  });

  it('returns 0 when last activity is in the future (clock skew)', () => {
    const fs = makeFs({ 'audit.tsv': `2026-05-30T15:00:00Z\tseq=1\tfuture\n` });
    expect(computeClawLastActivityAgoMs(fs, NOW).agoMs).toBe(0);
  });
});

// ── humanize ────────────────────────────────────────────────────────────────

describe('humanizeUptime / humanizeAgo', () => {
  it('humanizeUptime: hours/min/sec/unknown', () => {
    expect(humanizeUptime(undefined)).toBe('unknown');
    expect(humanizeUptime(45_000)).toBe('45s');
    expect(humanizeUptime(12 * 60_000)).toBe('12m');
    expect(humanizeUptime(4 * 3600_000 + 12 * 60_000)).toBe('4h 12m');
  });

  it('humanizeAgo: s/m/h+m/unknown', () => {
    expect(humanizeAgo(undefined)).toBe('unknown');
    expect(humanizeAgo(18_000)).toBe('18s ago');
    expect(humanizeAgo(2 * 60_000)).toBe('2m ago');
    expect(humanizeAgo(1 * 3600_000 + 3 * 60_000)).toBe('1h 3m ago');
  });
});

// ── computeForumStatusView (composite) ──────────────────────────────────────

function makePm(
  alive: Record<string, { alive: boolean; reason: string; pid?: number }>,
  orphanPids: number[] = [],
): ProcessManager {
  return {
    getAliveStatus: (daemonDir: string) => {
      const s = String(daemonDir);
      // phase 694: daemonDir is branded path; match by key or by trailing segment
      if (alive[s]) return alive[s];
      for (const [k, v] of Object.entries(alive)) {
        if (s.endsWith(`/${k}`) || s.endsWith(k)) return v;
      }
      return { alive: false, reason: 'no PID file' };
    },
    findProcesses: () => orphanPids,
  } as unknown as ProcessManager;
}

describe('computeForumStatusView', () => {
  const NOW = Date.parse('2026-05-30T14:23:07Z');

  function makeDeps(
    overrides: Partial<ForumStatusDeps> & {
      claws?: string[];
      clawFs?: Record<string, FileSystem>;
      aliveMap?: Record<string, { alive: boolean; reason: string; pid?: number }>;
      startTimes?: Record<number, string>;
      audit?: AuditLog;
    } = {},
  ): ForumStatusDeps {
    const baseDir = '/forum';
    const motionDir = '/forum/motion';
    const claws = overrides.claws ?? [];
    const clawFs = overrides.clawFs ?? {};
    const aliveMap = overrides.aliveMap ?? {};
    const startTimes = overrides.startTimes ?? {};
    const audit = overrides.audit ?? ({ write: vi.fn() } as unknown as AuditLog);

    const rootFs = makeFs({}, { claws: claws });
    const motionFs = makeFs({}, {});

    const fsFactory = (dir: string): FileSystem => {
      if (dir === baseDir) return rootFs;
      if (dir === motionDir) return motionFs;
      // per-claw dirs
      for (const name of claws) {
        if (dir === path.join(baseDir, 'claws', name)) return clawFs[name] ?? makeFs({});
      }
      return makeFs({});
    };

    const clawTopology: ClawTopology = {
      enumerate: () => claws.map(name => name),
      resolve: (clawId) => ({ kind: 'local', clawDir: path.join(baseDir, 'claws', clawId) }),
      read: async () => '',
      readJSON: async () => ({} as any),
    };

    return {
      fsFactory,
      clawTopology,
      motionDir,
      pm: makePm(aliveMap),
      now: () => NOW,
      getStartTime: (pid: number) => startTimes[pid],
      watchdog: { pid: undefined, alive: false, entryPath: '/wd-entry' },
      daemonEntryPath: '/daemon-entry',
      audit,
      ...overrides,
    };
  }

  it('all-stopped baseline: 0 active claws + N/M counts + system stopped', async () => {
    const deps = makeDeps({ claws: ['a', 'b', 'c'] });
    const v = await computeForumStatusView(deps);
    expect(v.system.watchdog.alive).toBe(false);
    expect(v.system.motion.alive).toBe(false);
    expect(v.activeClaws).toEqual([]);
    expect(v.totalClawCount).toBe(3);
    expect(v.orphans).toEqual({ watchdog: [], daemon: [] });
  });

  it('watchdog + motion + 1 claw running: full happy path', async () => {
    const fourHoursAgo = '2026-05-30T10:11:00Z';
    const motionFs = makeFs({}, { 'inbox/pending': ['m1.md', 'm2.md'] });
    const clawAuditTs = '2026-05-30T14:21:00Z';
    const clawAFs = makeFs(
      {
        'audit.tsv': `${clawAuditTs}\tseq=5\ttool_call\tname=read\n`,
      },
      { 'inbox/pending': ['c1.md'] },
    );
    const deps = makeDeps({
      claws: ['cmdtool-v3'],
      clawFs: { 'cmdtool-v3': clawAFs },
      aliveMap: {
        [String(MOTION_CLAW_ID)]: { alive: true, reason: 'alive', pid: 52703 },
        [String('cmdtool-v3')]: { alive: true, reason: 'alive', pid: 53508 },
      },
      startTimes: { 52703: fourHoursAgo, 53508: fourHoursAgo, 52933: fourHoursAgo },
      watchdog: { pid: 52933, alive: true, entryPath: '/wd-entry' },
      fsFactory: ((): ((d: string) => FileSystem) => {
        const baseRoot = makeFs({}, { claws: ['cmdtool-v3'] });
        return (dir: string) => {
          if (dir === '/forum') return baseRoot;
          if (dir === '/forum/motion') return motionFs;
          if (dir === path.join('/forum', 'claws', 'cmdtool-v3')) return clawAFs;
          return makeFs({});
        };
      })(),
    });
    const v = await computeForumStatusView(deps);
    expect(v.system.watchdog.alive).toBe(true);
    expect(v.system.watchdog.pid).toBe(52933);
    expect(v.system.motion.alive).toBe(true);
    expect(v.system.motion.inboxUnread).toBe(2);
    expect(v.activeClaws).toHaveLength(1);
    expect(v.activeClaws[0].name).toBe('cmdtool-v3');
    expect(v.activeClaws[0].pid).toBe(53508);
    expect(v.activeClaws[0].inboxUnread).toBe(1);
    expect(v.activeClaws[0].lastActivityAgoMs).toBe(2 * 60_000 + 7 * 1000);
    expect(v.totalClawCount).toBe(1);
  });

  it('ProcessListUnavailable in findProcesses degrades to empty orphan list with error field', async () => {
    const deps = makeDeps({
      pm: {
        getAliveStatus: () => ({ alive: false, reason: 'no PID file' }),
        findProcesses: () => {
          throw new ProcessListUnavailable('ps not available');
        },
      } as unknown as ProcessManager,
    });
    const v = await computeForumStatusView(deps);
    expect(v.orphans).toEqual({
      watchdog: [],
      daemon: [],
      error: 'process list unavailable',
    });
  });

  it('continues to next claw when one fails', async () => {
    const pm = {
      getAliveStatus: vi.fn()
        .mockReturnValueOnce({ alive: false, reason: 'no PID file' }) // motion
        .mockReturnValueOnce({ alive: true, pid: 100 }) // claw-a
        .mockImplementationOnce(() => {
          throw new Error('EIO');
        }), // claw-b
      findProcesses: vi.fn().mockReturnValue([]),
    } as unknown as ProcessManager;
    const deps = makeDeps({ claws: ['claw-a', 'claw-b'], pm });
    const view = await computeForumStatusView(deps);
    expect(view.activeClaws.length).toBeGreaterThan(0);
    expect(view.activeClaws[0].name).toBe('claw-a');
  });

  it('returns error field when process list unavailable', () => {
    const pm = {
      findProcesses: vi.fn().mockImplementation(() => {
        throw new ProcessListUnavailable('test');
      }),
    } as unknown as ProcessManager;
    const orphans = computeOrphans(pm, 'entry', 'daemon', {
      watchdog: undefined,
      trackedPids: [],
    });
    expect(orphans.error).toBe('process list unavailable');
    expect(orphans.watchdog).toEqual([]);
    expect(orphans.daemon).toEqual([]);
  });
});

// ── formatForumStatusView snapshot ──────────────────────────────────────────

describe('formatForumStatusView', () => {
  it('snapshot: full mockup form (watchdog + motion + 2 active claws)', () => {
    const lines = formatForumStatusView({
      timestamp: '2026-05-30T14:23:07.000Z',
      system: {
        watchdog: { alive: true, pid: 52933, uptimeMs: 4 * 3600_000 + 12 * 60_000, reason: 'alive' },
        motion: {
          alive: true,
          pid: 52703,
          uptimeMs: 4 * 3600_000 + 12 * 60_000,
          inboxUnread: 2,
          reason: 'alive',
        },
      },
      activeClaws: [
        {
          status: 'ok',
          name: 'cmdtool-v3',
          pid: 53508,
          uptimeMs: 1 * 3600_000 + 3 * 60_000,
          lastActivityAgoMs: 2 * 60_000,
          inboxUnread: 0,
        },
        {
          status: 'ok',
          name: 'tools-auditor',
          pid: 54201,
          uptimeMs: 12 * 60_000,
          lastActivityAgoMs: 18_000,
          inboxUnread: 1,
        },
      ],
      totalClawCount: 70,
      orphans: { watchdog: [], daemon: [] },
    });
    expect(lines).toMatchInlineSnapshot(`
      [
        "chestnut status                                    2026-05-30T14:23:07.000Z",
        "",
        "System",
        "  watchdog  running   PID 52933   uptime 4h 12m",
        "  motion    running   PID 52703   uptime 4h 12m   inbox: 2 unread",
        "",
        "Active claws (2 / 70)",
        "  cmdtool-v3        running   PID 53508   uptime 1h 3m",
        "    last activity   2m ago",
        "    inbox           0 unread",
        "  tools-auditor     running   PID 54201   uptime 12m",
        "    last activity   18s ago",
        "    inbox           1 unread",
      ]
    `);
  });

  it('all-stopped: shows stopped system + 0 active', () => {
    const lines = formatForumStatusView({
      timestamp: '2026-05-30T14:23:07.000Z',
      system: {
        watchdog: { alive: false, pid: undefined, reason: 'stopped' },
        motion: { alive: false, pid: undefined, reason: 'no PID file' },
      },
      activeClaws: [],
      totalClawCount: 70,
      orphans: { watchdog: [], daemon: [] },
    });
    expect(lines).toEqual([
      'chestnut status                                    2026-05-30T14:23:07.000Z',
      '',
      'System',
      '  watchdog  stopped',
      '  motion    stopped   (no PID file)',
      '',
      'Active claws (0 / 70)',
    ]);
  });

  it('orphan watchdog + daemon: warning lines included', () => {
    const lines = formatForumStatusView({
      timestamp: '2026-05-30T14:23:07.000Z',
      system: {
        watchdog: { alive: true, pid: 1, uptimeMs: 1000, reason: 'alive' },
        motion: { alive: false, pid: undefined, reason: 'stopped' },
      },
      activeClaws: [],
      totalClawCount: 0,
      orphans: { watchdog: [9999], daemon: [8888, 7777] },
    });
    expect(lines).toContain('  ⚠ orphan watchdog: PID 9999');
    expect(lines).toContain('  ⚠ orphan daemon:   PID 8888');
    expect(lines).toContain('  ⚠ orphan daemon:   PID 7777');
  });

  it('shows warning on alive system component', () => {
    const lines = formatForumStatusView({
      timestamp: '2026-05-30T14:23:07.000Z',
      system: {
        watchdog: { alive: true, pid: 1, uptimeMs: 1000, reason: 'alive', warning: 'PID file unreadable' },
        motion: { alive: false, pid: undefined, reason: 'stopped' },
      },
      activeClaws: [],
      totalClawCount: 0,
      orphans: { watchdog: [], daemon: [] },
    });
    expect(lines).toContain('  watchdog  running (warning: PID file unreadable)   PID 1   uptime 1s');
  });

  it('renders error claw as unavailable with no activity/inbox lines', () => {
    const lines = formatForumStatusView({
      timestamp: '2026-05-30T14:23:07.000Z',
      system: {
        watchdog: { alive: false, pid: undefined, reason: 'stopped' },
        motion: { alive: false, pid: undefined, reason: 'stopped' },
      },
      activeClaws: [{ status: 'error', name: 'cmdtool-v3', error: 'EACCES' }],
      totalClawCount: 1,
      orphans: { watchdog: [], daemon: [] },
    });
    expect(lines).toContain('  cmdtool-v3        unavailable   (EACCES)');
    expect(lines).not.toContain('    last activity');
    expect(lines).not.toContain('    inbox');
  });

  it('renders orphan detection error when process list unavailable', () => {
    const lines = formatForumStatusView({
      timestamp: '2026-05-30T14:23:07.000Z',
      system: {
        watchdog: { alive: false, pid: undefined, reason: 'stopped' },
        motion: { alive: false, pid: undefined, reason: 'stopped' },
      },
      activeClaws: [],
      totalClawCount: 0,
      orphans: { watchdog: [], daemon: [], error: 'process list unavailable' },
    });
    expect(lines).toContain('  ⚠ orphan detection unavailable: process list unavailable');
  });
});

// ── phase 1759: last-activity read failure evidence ─────────────────────────

describe('phase 1759: computeClawLastActivityAgoMs degraded result', () => {
  const NOW = Date.parse('2026-05-30T14:00:00Z');

  function errnoErr(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
  }

  it('returns degraded with partial agoMs + per-file evidence when one file stat fails', () => {
    const auditTs = '2026-05-30T13:58:00Z';
    const tickTs = '2026-05-30T13:30:00Z';
    const base = makeFs({
      'audit.tsv': `${auditTs}\tseq=1\tboot\tx=1\n`,
      'tick.tsv': `${tickTs}\tseq=2\tdaemon_liveness_heartbeat\n`,
    });
    const failing: FileSystem = {
      ...base,
      statSync: ((p: string) => {
        if (p === 'tick.tsv') throw errnoErr('EACCES');
        return base.statSync(p);
      }) as FileSystem['statSync'],
    };

    const r = computeClawLastActivityAgoMs(failing, NOW);

    expect(r.kind).toBe('degraded');
    if (r.kind === 'degraded') {
      // 部分结果保留：可读 audit.tsv 的 max ts 仍展示
      expect(r.agoMs).toBe(2 * 60 * 1000);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0].file).toBe('tick.tsv');
      expect(r.failures[0].error).toContain('EACCES');
    }
  });

  it('returns degraded with agoMs undefined when all files fail (distinguishable from complete no-activity)', () => {
    const base = makeFs({ 'audit.tsv': '2026-05-30T13:58:00Z\tseq=1\tboot\tx=1\n' });
    const failing: FileSystem = {
      ...base,
      readBytesSync: (() => {
        throw errnoErr('EIO');
      }) as FileSystem['readBytesSync'],
    };

    const r = computeClawLastActivityAgoMs(failing, NOW);

    expect(r.kind).toBe('degraded');
    if (r.kind === 'degraded') {
      expect(r.agoMs).toBeUndefined();
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0].file).toBe('audit.tsv');
      expect(r.failures[0].error).toContain('EIO');
    }
  });

  it('file vanished between list and read (existsSync false) is skipped, not a failure', () => {
    const auditTs = '2026-05-30T13:58:00Z';
    const base = makeFs({
      'audit.tsv': `${auditTs}\tseq=1\tboot\tx=1\n`,
      'tick.tsv': '2026-05-30T13:30:00Z\tseq=2\tdaemon_liveness_heartbeat\n',
    });
    // listAuditFiles 从目录 listing 发现 tick.tsv；existsSync false 模拟 list 与 read 之间
    // 文件消失（TOCTOU）——跳过、不计入 failures。
    const vanishing: FileSystem = {
      ...base,
      existsSync: ((p: string) => (p === 'tick.tsv' ? false : base.existsSync(p))) as FileSystem['existsSync'],
    };

    const r = computeClawLastActivityAgoMs(vanishing, NOW);

    expect(r).toEqual({ kind: 'complete', agoMs: 2 * 60 * 1000 });
  });

  it('complete result carries kind complete and no failures when all readable', () => {
    const fs = makeFs({ 'audit.tsv': '2026-05-30T13:58:00Z\tseq=1\tboot\tx=1\n' });
    const r = computeClawLastActivityAgoMs(fs, NOW);
    expect(r).toEqual({ kind: 'complete', agoMs: 2 * 60 * 1000 });
  });

  it('formatter renders degraded evidence as warning lines (not flattened)', () => {
    const lines = formatForumStatusView({
      timestamp: '2026-05-30T14:23:07.000Z',
      system: {
        watchdog: { alive: false, pid: undefined, reason: 'stopped' },
        motion: { alive: false, pid: undefined, reason: 'stopped' },
      },
      activeClaws: [
        {
          status: 'ok',
          name: 'alpha',
          pid: 4242,
          uptimeMs: 60_000,
          lastActivityAgoMs: 2 * 60_000,
          lastActivityReadFailures: [{ file: 'tick.tsv', error: 'EACCES: EACCES' }],
          inboxUnread: 0,
        },
      ],
      totalClawCount: 1,
      orphans: { watchdog: [], daemon: [] },
    });
    expect(lines).toContain('    last activity   2m ago');
    expect(lines).toContain('    ⚠ last activity degraded: 1 audit file(s) unreadable');
    expect(lines).toContain('      - tick.tsv: EACCES: EACCES');
  });

  it('formatter renders no degraded lines for complete activity', () => {
    const lines = formatForumStatusView({
      timestamp: '2026-05-30T14:23:07.000Z',
      system: {
        watchdog: { alive: false, pid: undefined, reason: 'stopped' },
        motion: { alive: false, pid: undefined, reason: 'stopped' },
      },
      activeClaws: [
        {
          status: 'ok',
          name: 'alpha',
          pid: 4242,
          uptimeMs: 60_000,
          lastActivityAgoMs: 2 * 60_000,
          inboxUnread: 0,
        },
      ],
      totalClawCount: 1,
      orphans: { watchdog: [], daemon: [] },
    });
    expect(lines.some(l => l.includes('degraded'))).toBe(false);
  });
});
