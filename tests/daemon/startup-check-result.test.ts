/**
 * Phase 858: startup-check fail-closed behavior with lightweight-query Result.
 * phase 1838: 删除 hasPendingStartupCheck（文件名匹配从未命中真实文件名）；
 * eligibility = inbox empty + has active + cooldown 三条件。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isInboxEmpty,
  startupCheckEnvironmentEligible,
  classifyStartupCheckCooldown,
} from '../../src/daemon/startup-check.js';

// phase 1873 Step H: gate 拆为 env 前置 + cooldown 分类（fresh 由 daemon-loop 做
// 证据调和）；本文件矩阵语义 = env 合格且 cooldown 非 fresh。
function shouldEmitStartupCheck(fs: FileSystem, audit: unknown): boolean {
  return startupCheckEnvironmentEligible(fs, audit as never)
    && classifyStartupCheckCooldown(fs, audit as never).kind !== 'fresh';
}
import { DAEMON_AUDIT_EVENTS } from '../../src/daemon/audit-events.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';

function makeFs(opts: { inboxListError?: NodeJS.ErrnoException; inboxExists?: boolean }): FileSystem {
  return {
    existsSync: vi.fn((dir: string) => {
      if (typeof dir === 'string' && dir.includes('inbox/pending')) {
        return opts.inboxExists ?? true;
      }
      return false;
    }),
    listSync: vi.fn((_dir: string, _options?: unknown) => {
      if (opts.inboxListError) throw opts.inboxListError;
      return [];
    }),
  } as unknown as FileSystem;
}

/** 三条件 eligibility stub：可分别控制 inbox 空 / active 存在 / 冷却状态。 */
function makeEligibilityFs(opts: {
  inboxEntries?: Array<{ name: string }>;
  activeEntries?: Array<{ name: string; isDirectory: boolean }>;
  creating?: boolean;
  cooldownTs?: string | 'ENOENT' | 'EIO';
}): FileSystem {
  return {
    existsSync: vi.fn((p: string) => {
      if (p === 'inbox/pending') return true;
      if (p === 'contract/active') return opts.activeEntries !== undefined;
      if (typeof p === 'string' && p.endsWith('.creating')) return opts.creating ?? false;
      return false;
    }),
    listSync: vi.fn((dir: string) => {
      if (dir === 'inbox/pending') {
        return (opts.inboxEntries ?? []).map(e => ({ name: e.name, isDirectory: false, isFile: true }));
      }
      if (dir === 'contract/active') {
        return (opts.activeEntries ?? []).map(e => ({ name: e.name, isDirectory: e.isDirectory, isFile: !e.isDirectory }));
      }
      return [];
    }),
    readSync: vi.fn((_p: string) => {
      if (opts.cooldownTs === 'EIO') {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      if (opts.cooldownTs === undefined || opts.cooldownTs === 'ENOENT') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return opts.cooldownTs;
    }),
  } as unknown as FileSystem;
}

function makeAudit() {
  return {
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  };
}

describe('startup-check Result adaptation (phase 858)', () => {
  it('isInboxEmpty returns false and emits audit on I/O error (fail-closed)', () => {
    const fs = makeFs({
      inboxListError: Object.assign(new Error('EIO'), { code: 'EIO' }),
    });
    const audit = makeAudit();

    expect(isInboxEmpty(fs, audit as any)).toBe(false);
    expect(audit.write).toHaveBeenCalledWith(
      DAEMON_AUDIT_EVENTS.STARTUP_CHECK_IO_ERROR,
      expect.stringContaining('fn=peekPendingCount'),
      expect.stringContaining('reason='),
    );
  });

  it('isInboxEmpty returns true when inbox has no pending .md files', () => {
    const fs = makeFs({});
    const audit = makeAudit();

    expect(isInboxEmpty(fs, audit as any)).toBe(true);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('shouldEmitStartupCheck returns false when peekPendingCount errors (fail-closed)', () => {
    const fs = makeFs({
      inboxListError: Object.assign(new Error('EIO'), { code: 'EIO' }),
    });
    const audit = makeAudit();

    // Even if other conditions would be true, I/O error on inbox makes isInboxEmpty false.
    expect(shouldEmitStartupCheck(fs, audit as any)).toBe(false);
  });
});

describe('shouldEmitStartupCheck 三条件 eligibility (phase 1838)', () => {
  it('inbox 空 + 有 published active + 无 timestamp → true', () => {
    const fs = makeEligibilityFs({ activeEntries: [{ name: 'c-live', isDirectory: true }] });
    expect(shouldEmitStartupCheck(fs, makeAudit() as any)).toBe(true);
  });

  it('pending 非空（任何消息）→ false', () => {
    const fs = makeEligibilityFs({
      inboxEntries: [{ name: 'daemon-1_high_x.md' }],
      activeEntries: [{ name: 'c-live', isDirectory: true }],
    });
    expect(shouldEmitStartupCheck(fs, makeAudit() as any)).toBe(false);
  });

  it('无 active → false；仅 .creating 占位 → false', () => {
    const noActive = makeEligibilityFs({});
    expect(shouldEmitStartupCheck(noActive, makeAudit() as any)).toBe(false);
    const creating = makeEligibilityFs({
      activeEntries: [{ name: 'c-new', isDirectory: true }],
      creating: true,
    });
    expect(shouldEmitStartupCheck(creating, makeAudit() as any)).toBe(false);
  });

  it('冷却未过 → false；冷却已过 → true', () => {
    const active = [{ name: 'c-live', isDirectory: true }];
    const fresh = makeEligibilityFs({ activeEntries: active, cooldownTs: String(Date.now()) });
    expect(shouldEmitStartupCheck(fresh, makeAudit() as any)).toBe(false);
    const stale = makeEligibilityFs({ activeEntries: active, cooldownTs: String(Date.now() - 11 * 60 * 1000) });
    expect(shouldEmitStartupCheck(stale, makeAudit() as any)).toBe(true);
  });

  it('count 读取失败 → false（不伪称可投递）', () => {
    const fs = {
      existsSync: vi.fn(() => true),
      listSync: vi.fn(() => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); }),
    } as unknown as FileSystem;
    expect(shouldEmitStartupCheck(fs, makeAudit() as any)).toBe(false);
  });
});
