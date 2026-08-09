/**
 * Phase 8 — audit-size-monitor viewport stream injection 反向测试
 * Phase 1242 Step A: 测试归位 foundation/audit/jobs（monitor capability 不再依赖 Cron）
 * Phase 1288 Step D: 三段常驻观察收口（legacyAuditPath 必填）+ 验收矩阵
 *
 * (1) under threshold 不 emit
 * (2) over warn → emit THRESHOLD_EXCEEDED level=warn + streamLog dev_warning
 * (3) over critical → emit critical + streamLog dev_warning level=critical
 * (4) file 不存在不 emit CHECK_FAILED（α-1 helper 复用；缺段是合法状态）
 * (5) dedup: same level 二次跑不 re-fire；level 升级 (warn→critical) re-fire
 * Step D 矩阵（根级新旧两段均可观察）：
 * (6) 仅 legacy 超阈值 → 只 emit legacy 段
 * (7) 仅新段超阈值 → 只 emit new 段
 * (8) 并存 → 三段各自 emit
 * (9) legacy 段 stat 失败（非 FNF）→ CHECK_FAILED 逐段分型、其他段照常观察（不当整体空）
 * (10) legacy 段缺失（FNF）→ 合法跳过、不 emit CHECK_FAILED
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runAuditSizeMonitor,
  __resetAuditSizeMonitorState,
} from '../../../../src/foundation/audit/jobs/audit-size-monitor.js';
import { FileNotFoundError } from '../../../../src/foundation/fs/types.js';
import { AUDIT_SIZE_MONITOR_AUDIT_EVENTS } from '../../../../src/foundation/audit/jobs/audit-size-monitor-audit-events.js';
import { makeAudit } from '../../../helpers/audit.js';
import type { FileSystem } from '../../../../src/foundation/fs/types.js';

const PRIMARY = '/tmp/test/motion/audit.tsv';      // motion scope（保持原值、零迁移）
const SECONDARY = '/tmp/test/audit/audit.tsv';     // 根审计新段（AUDIT_PATHS.audit）
const LEGACY = '/tmp/test/audit.tsv';              // 根审计 legacy 段（只读观察）

const WARN = 600 * 1024 * 1024;
const CRITICAL = 1200 * 1024 * 1024;
const UNDER = 100 * 1024 * 1024;

/** 按路径配置 size / 抛错；未列路径 → FileNotFoundError（缺段）。 */
function makeFs(sizes: Record<string, number> = {}, errors: Record<string, unknown> = {}): FileSystem {
  return {
    statSync: (p: string) => {
      if (p in errors) throw errors[p];
      if (p in sizes) {
        return { size: sizes[p], mtime: new Date(), ctime: new Date(), isDirectory: false, isFile: true };
      }
      throw new FileNotFoundError(p);
    },
  } as unknown as FileSystem;
}

function runAll(fs: FileSystem, audit: ReturnType<typeof makeAudit>['audit'], streamLog?: { write(event: Record<string, unknown>): void }) {
  return runAuditSizeMonitor({
    fs, audit,
    primaryAuditPath: PRIMARY,
    secondaryAuditPath: SECONDARY,
    legacyAuditPath: LEGACY,
    streamLog,
    streamEventType: 'system_notify',
  });
}

describe('phase 8 — audit-size-monitor viewport stream', () => {
  beforeEach(() => { __resetAuditSizeMonitorState(); });

  it('under threshold → 0 emit', async () => {
    const { audit, events } = makeAudit();
    const streamLog = { write: vi.fn() };
    await runAll(makeFs({ [PRIMARY]: UNDER, [SECONDARY]: UNDER, [LEGACY]: UNDER }), audit, streamLog);
    expect(events).toHaveLength(0);
    expect(streamLog.write).not.toHaveBeenCalled();
  });

  it('over warn (600 MB) → THRESHOLD_EXCEEDED level=warn + streamLog dev_warning', async () => {
    const { audit, events } = makeAudit();
    const streamLog = { write: vi.fn() };
    await runAll(makeFs({ [PRIMARY]: WARN, [SECONDARY]: WARN, [LEGACY]: WARN }), audit, streamLog);
    expect(events).toHaveLength(3);
    expect(events[0][0]).toBe(AUDIT_SIZE_MONITOR_AUDIT_EVENTS.THRESHOLD_EXCEEDED);
    expect(events[0]).toContain('level=warn');
    expect(streamLog.write).toHaveBeenCalledTimes(3);
    expect(streamLog.write).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system_notify',
      subtype: 'dev_warning',
      kind: 'audit_size',
      level: 'warn',
    }));
  });

  it('over critical (1.2 GB) → critical + streamLog dev_warning level=critical', async () => {
    const { audit, events } = makeAudit();
    const streamLog = { write: vi.fn() };
    await runAll(makeFs({ [PRIMARY]: CRITICAL, [SECONDARY]: CRITICAL, [LEGACY]: CRITICAL }), audit, streamLog);
    expect(events).toHaveLength(3);
    expect(events[0]).toContain('level=critical');
    expect(streamLog.write).toHaveBeenCalledTimes(3);
    expect(streamLog.write).toHaveBeenCalledWith(expect.objectContaining({
      level: 'critical',
    }));
  });

  it('file not found → 0 emit CHECK_FAILED', async () => {
    const { audit, events } = makeAudit();
    await runAll(makeFs(), audit);
    expect(events).toHaveLength(0);
  });

  it('dedup: same level 二次跑不 re-fire；warn→critical 升级 re-fire', async () => {
    const { audit, events } = makeAudit();
    const streamLog = { write: vi.fn() };
    const fsWarn = makeFs({ [PRIMARY]: WARN, [SECONDARY]: WARN, [LEGACY]: WARN });
    await runAll(fsWarn, audit, streamLog);
    expect(streamLog.write).toHaveBeenCalledTimes(3); // primary + secondary + legacy warn
    // phase 1322: audit 侧同款翻转写（进入超阈值各写 1 条）
    expect(events).toHaveLength(3);

    // 同 level 二次跑 → 0 新 write（audit + streamLog 双侧）
    await runAll(fsWarn, audit, streamLog);
    expect(streamLog.write).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(3);

    // 升级 warn → critical → 双侧 re-fire
    const fsCritical = makeFs({ [PRIMARY]: CRITICAL, [SECONDARY]: CRITICAL, [LEGACY]: CRITICAL });
    await runAll(fsCritical, audit, streamLog);
    expect(streamLog.write).toHaveBeenCalledTimes(6); // +3 critical
    expect(events).toHaveLength(6);
  });
});

describe('phase 1288 Step D — 根级新旧两段常驻观察矩阵', () => {
  beforeEach(() => { __resetAuditSizeMonitorState(); });

  it('仅 legacy 超阈值 → 只 emit legacy 段（motion/new 缺段合法跳过）', async () => {
    const { audit, events } = makeAudit();
    const streamLog = { write: vi.fn() };
    await runAll(makeFs({ [LEGACY]: WARN }), audit, streamLog);
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(AUDIT_SIZE_MONITOR_AUDIT_EVENTS.THRESHOLD_EXCEEDED);
    expect(events[0]).toContain(`path=${LEGACY}`);
    expect(events[0]).toContain('level=warn');
    expect(streamLog.write).toHaveBeenCalledTimes(1);
    expect(streamLog.write).toHaveBeenCalledWith(expect.objectContaining({ path: LEGACY }));
  });

  it('仅新段超阈值 → 只 emit new 段', async () => {
    const { audit, events } = makeAudit();
    await runAll(makeFs({ [SECONDARY]: WARN }), audit);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(`path=${SECONDARY}`);
  });

  it('并存：motion + 新 + legacy 三段各自独立 emit、路径分型', async () => {
    const { audit, events } = makeAudit();
    await runAll(makeFs({ [PRIMARY]: WARN, [SECONDARY]: CRITICAL, [LEGACY]: WARN }), audit);
    expect(events).toHaveLength(3);
    const byPath = new Map(events.map((e) => [e[1], e]));
    expect(byPath.get(`path=${PRIMARY}`)).toContain('level=warn');
    expect(byPath.get(`path=${SECONDARY}`)).toContain('level=critical');
    expect(byPath.get(`path=${LEGACY}`)).toContain('level=warn');
  });

  it('legacy 段 stat 失败（非 FNF）→ CHECK_FAILED 逐段分型、其他段照常观察（不当整体空）', async () => {
    const { audit, events } = makeAudit();
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    await runAll(makeFs({ [SECONDARY]: WARN }, { [LEGACY]: eacces }), audit);

    expect(events).toHaveLength(2);
    const exceeded = events.find((e) => e[0] === AUDIT_SIZE_MONITOR_AUDIT_EVENTS.THRESHOLD_EXCEEDED);
    const failed = events.find((e) => e[0] === AUDIT_SIZE_MONITOR_AUDIT_EVENTS.CHECK_FAILED);
    expect(exceeded).toContain(`path=${SECONDARY}`);
    expect(failed).toContain(`path=${LEGACY}`);
    expect(failed).toContain('code=EACCES');
  });

  it('legacy 段缺失（FNF）→ 合法跳过、不 emit CHECK_FAILED；新段照常观察', async () => {
    const { audit, events } = makeAudit();
    await runAll(makeFs({ [SECONDARY]: UNDER }), audit);
    expect(events).toHaveLength(0);
  });
});
