/**
 * `chestnut status` command tests — Phase 977 Step B.
 *
 * Covers audit event emission for FORUM_STATUS, FORUM_CLAW_ERROR, and
 * FORUM_ORPHAN_ERROR. Internal dependencies are mocked to keep tests focused
 * on the command's audit surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { statusCommand } from '../../../src/cli/commands/status.js';
import { STATUS_AUDIT_EVENTS } from '../../../src/core/status-service/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { ForumStatusView } from '../../../src/core/status-service/index.js';

function makeAudit(): AuditLog & { events: [string, ...(string | number)[]][] } {
  const events: [string, ...(string | number)[]][] = [];
  return {
    __brand: 'AuditLog',
    write(type: string, ...cols: (string | number)[]) {
      events.push([type, ...cols]);
    },
    preview(s: string) {
      return s;
    },
    message(s: string) {
      return s;
    },
    summary(s: string) {
      return s;
    },
    dispose() {},
    events,
  } as unknown as AuditLog & { events: [string, ...(string | number)[]][] };
}

let currentAudit: ReturnType<typeof makeAudit>;

vi.mock('../../../src/foundation/audit/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/audit/index.js')>();
  return {
    ...actual,
    createSystemAudit: vi.fn(() => {
      currentAudit = makeAudit();
      return currentAudit;
    }),
  };
});

// phase 1864 Step B：路径群归 foundation/claw-identity（mock 面按 owner 拆两处）。
vi.mock('../../../src/foundation/claw-identity/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/claw-identity/index.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(() => '/forum/motion'),
  };
});

vi.mock('../../../src/core/claw-topology/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/claw-topology/index.js')>();
  return {
    ...actual,
    createClawTopology: vi.fn(() => ({
      enumerate: () => [],
      resolve: () => ({ kind: 'local', clawDir: '/forum/claws/test' }),
      read: async () => '',
      readJSON: async () => ({}),
    })),
  };
});

vi.mock('../../../src/foundation/process-manager/index.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    isAlive: () => false,
    findProcesses: () => [],
  })),
}));

vi.mock('../../../src/daemon/entry-resolver.js', () => ({
  resolveDaemonEntry: vi.fn(() => '/daemon-entry'),
}));

vi.mock('../../../src/watchdog/watchdog.js', () => ({
  getWatchdogPid: vi.fn(() => undefined),
  isWatchdogAlive: vi.fn(() => false),
  getWatchdogEntryPath: vi.fn(() => '/wd-entry'),
}));

vi.mock('../../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    getProcessStartTime: vi.fn(() => undefined),
  };
});

vi.mock('../../../src/core/status-service/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/status-service/index.js')>();
  return {
    ...actual,
    computeForumStatusView: vi.fn(),
    formatForumStatusView: vi.fn(() => []),
  };
});

import { computeForumStatusView } from '../../../src/core/status-service/index.js';

const loadGlobal = vi.fn();

function makeFakeFs(): any {
  return {
    existsSync: vi.fn().mockReturnValue(false),
    statSync: vi.fn(),
    readSync: vi.fn(),
    readBytesSync: vi.fn(),
    listSync: vi.fn().mockReturnValue([]),
    list: vi.fn().mockResolvedValue([]),
  };
}

function baseForumView(): ForumStatusView {
  return {
    timestamp: new Date().toISOString(),
    system: {
      watchdog: { alive: false, reason: 'stopped' },
      motion: { alive: false, reason: 'stopped' },
    },
    activeClaws: [],
    totalClawCount: 0,
    orphans: { watchdog: [], daemon: [] },
  };
}

describe('statusCommand (Phase 977)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadGlobal.mockReturnValue({});
  });

  const deps = () => ({
    fsFactory: () => makeFakeFs(),
    rootConfig: { loadGlobal },
  });

  it('does not write FORUM_STATUS audit event (owner-owned since phase 1761)', async () => {
    vi.mocked(computeForumStatusView).mockResolvedValue(baseForumView());

    await statusCommand(deps());

    // phase 1761 边界：FORUM_* 触发语义归 StatusService owner，CLI 零触发
    expect(
      currentAudit.events.filter((e) => e[0] === STATUS_AUDIT_EVENTS.FORUM_STATUS),
    ).toEqual([]);
  });

  it('does not write FORUM_CLAW_ERROR (owner-owned since phase 1761)', async () => {
    vi.mocked(computeForumStatusView).mockResolvedValue({
      ...baseForumView(),
      activeClaws: [
        { status: 'error', name: 'claw-a', error: 'boom-a' },
        { status: 'error', name: 'claw-b', error: 'boom-b' },
      ],
    });

    await statusCommand(deps());

    expect(
      currentAudit.events.filter((e) => e[0] === STATUS_AUDIT_EVENTS.FORUM_CLAW_ERROR),
    ).toEqual([]);
  });

  it('does not write FORUM_ORPHAN_ERROR (owner-owned since phase 1761)', async () => {
    vi.mocked(computeForumStatusView).mockResolvedValue({
      ...baseForumView(),
      orphans: { watchdog: [], daemon: [], error: 'process list unavailable' },
    });

    await statusCommand(deps());

    expect(
      currentAudit.events.filter((e) => e[0] === STATUS_AUDIT_EVENTS.FORUM_ORPHAN_ERROR),
    ).toEqual([]);
  });

  it('propagates RootConfig error before status computation', async () => {
    const sentinel = new Error('status config sentinel');
    loadGlobal.mockImplementation(() => { throw sentinel; });

    await expect(statusCommand(deps())).rejects.toBe(sentinel);
    expect(computeForumStatusView).not.toHaveBeenCalled();
  });
});
