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

vi.mock('../../../src/assembly/config/config-load.js', () => ({
  loadGlobalConfig: vi.fn(),
}));

vi.mock('../../../src/core/claw-topology/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/claw-topology/index.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(() => '/forum/motion'),
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
    getAliveStatus: () => ({ alive: false, reason: 'no PID file' }),
    findProcesses: () => [],
  })),
}));

vi.mock('../../../src/assembly/spawn-entry.js', () => ({
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
  });

  it('writes FORUM_STATUS audit event', async () => {
    vi.mocked(computeForumStatusView).mockResolvedValue(baseForumView());

    await statusCommand({ fsFactory: () => makeFakeFs() });

    const events = currentAudit.events.filter(
      (e) => e[0] === STATUS_AUDIT_EVENTS.FORUM_STATUS,
    );
    expect(events.length).toBe(1);
    expect(events[0][1]).toMatch(/^claws=/);
    expect(events[0][2]).toMatch(/^total=/);
  });

  it('writes FORUM_CLAW_ERROR for each error claw', async () => {
    vi.mocked(computeForumStatusView).mockResolvedValue({
      ...baseForumView(),
      activeClaws: [
        { status: 'error', name: 'claw-a', error: 'boom-a' },
        { status: 'error', name: 'claw-b', error: 'boom-b' },
      ],
    });

    await statusCommand({ fsFactory: () => makeFakeFs() });

    const clawErrors = currentAudit.events.filter(
      (e) => e[0] === STATUS_AUDIT_EVENTS.FORUM_CLAW_ERROR,
    );
    expect(clawErrors.length).toBe(2);
    expect(clawErrors[0]).toEqual([
      STATUS_AUDIT_EVENTS.FORUM_CLAW_ERROR,
      'claw=claw-a',
      'error=boom-a',
    ]);
    expect(clawErrors[1]).toEqual([
      STATUS_AUDIT_EVENTS.FORUM_CLAW_ERROR,
      'claw=claw-b',
      'error=boom-b',
    ]);
  });

  it('writes FORUM_ORPHAN_ERROR when orphan detection fails', async () => {
    vi.mocked(computeForumStatusView).mockResolvedValue({
      ...baseForumView(),
      orphans: { watchdog: [], daemon: [], error: 'process list unavailable' },
    });

    await statusCommand({ fsFactory: () => makeFakeFs() });

    const orphanErrors = currentAudit.events.filter(
      (e) => e[0] === STATUS_AUDIT_EVENTS.FORUM_ORPHAN_ERROR,
    );
    expect(orphanErrors.length).toBe(1);
    expect(orphanErrors[0]).toEqual([
      STATUS_AUDIT_EVENTS.FORUM_ORPHAN_ERROR,
      'error=process list unavailable',
    ]);
  });
});
