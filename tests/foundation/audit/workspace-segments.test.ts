/**
 * Phase 1288 Step D: workspace 根审计 segments typed 查询验收矩阵
 *
 * - 仅 legacy / 仅新 / 两者并存（merged 时间序视图按 ts 排序、segment+offset
 *   稳定 tie-break，不拼接文件字符串伪造全序）；
 * - 任一段损坏/读取失败逐段分型（missing ≠ unreadable、probe/read stage 分型）、
 *   onIssue 呈现、不静默丢段、不把单段失败当整体空；
 * - 每段保留 origin（legacy/new）与 path；
 * - limit 在 merged 排序后应用；ReadOptions 过滤跨段生效。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import {
  listWorkspaceAuditSegments,
  readWorkspaceAuditMerged,
  AUDIT_PATHS,
  AUDIT_LEGACY_PATHS,
  type WorkspaceAuditSegmentIssue,
} from '../../../src/foundation/audit/index.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

describe('phase 1288 Step D: workspace audit segments', () => {
  let chestnutRoot: string;

  beforeEach(() => {
    chestnutRoot = createTrackedTempDirSync('workspace-segments-');
  });

  afterEach(() => {
    fs.rmSync(chestnutRoot, { recursive: true, force: true });
  });

  const legacyPath = () => path.join(chestnutRoot, AUDIT_LEGACY_PATHS.audit);
  const newPath = () => path.join(chestnutRoot, AUDIT_PATHS.audit);

  function writeLegacy(lines: string): void {
    fs.writeFileSync(legacyPath(), lines);
  }

  function writeNew(lines: string): void {
    fs.mkdirSync(path.dirname(newPath()), { recursive: true });
    fs.writeFileSync(newPath(), lines);
  }

  const row = (ts: string, seq: number, type: string) => `${ts}\tseq=${seq}\t${type}\n`;

  it('仅 legacy：legacy 段 ok、new 段 missing（显式保留在列表中），merged 返回 legacy 行', async () => {
    writeLegacy(row('2024-01-01T00:00:00Z', 1, 'legacy_a') + row('2024-01-01T00:00:01Z', 2, 'legacy_b'));

    const segments = listWorkspaceAuditSegments(fsFactory, chestnutRoot);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ origin: 'legacy', path: legacyPath(), status: 'ok' });
    expect(segments[1]).toMatchObject({ origin: 'new', path: newPath(), status: 'missing' });

    const merged = await readWorkspaceAuditMerged(segments);
    expect(merged.map((m) => m.record.type)).toEqual(['legacy_a', 'legacy_b']);
    expect(merged.every((m) => m.segment.origin === 'legacy' && m.segment.path === legacyPath())).toBe(true);
  });

  it('仅新：new 段 ok、legacy 段 missing，merged 返回新段行', async () => {
    writeNew(row('2026-08-01T00:00:00Z', 1, 'watchdog_start'));

    const segments = listWorkspaceAuditSegments(fsFactory, chestnutRoot);
    expect(segments[0].status).toBe('missing');
    expect(segments[1]).toMatchObject({ origin: 'new', status: 'ok' });

    const merged = await readWorkspaceAuditMerged(segments);
    expect(merged.map((m) => m.record.type)).toEqual(['watchdog_start']);
    expect(merged[0].segment.origin).toBe('new');
  });

  it('两者并存：交错时间戳按 record.ts 归并（非字符串拼接全序），同 ts 以段序+offset 稳定 tie-break', async () => {
    writeLegacy(row('2024-01-01T00:00:00Z', 1, 'legacy_a') + row('2024-01-01T00:00:02Z', 2, 'legacy_b'));
    writeNew(row('2024-01-01T00:00:01Z', 3, 'new_a') + row('2024-01-01T00:00:03Z', 4, 'new_b'));

    const segments = listWorkspaceAuditSegments(fsFactory, chestnutRoot);
    const merged = await readWorkspaceAuditMerged(segments);
    // 交错归并：字符串拼接会给出 1,2,3,4（legacy 全部在前），归并给出时间序 1,3,2,4
    expect(merged.map((m) => m.record.seq)).toEqual([1, 3, 2, 4]);

    // tie-break：同 ts 跨段 → legacy（段序 0）在前；同段内 → offset 序
    writeLegacy(row('2024-01-01T00:00:00Z', 10, 'same_ts_legacy') + row('2024-01-01T00:00:00Z', 11, 'same_ts_legacy_2'));
    writeNew(row('2024-01-01T00:00:00Z', 12, 'same_ts_new'));
    const tied = await readWorkspaceAuditMerged(listWorkspaceAuditSegments(fsFactory, chestnutRoot));
    expect(tied.map((m) => m.record.seq)).toEqual([10, 11, 12]);
    expect(tied[0].offset).toBe(0);
    expect(tied[1].offset).toBe(1);
  });

  it('limit 在 merged 排序后应用；ReadOptions 过滤跨段生效', async () => {
    writeLegacy(row('2024-01-01T00:00:00Z', 1, 'cron_tick') + row('2024-01-01T00:00:02Z', 2, 'other'));
    writeNew(row('2024-01-01T00:00:01Z', 3, 'cron_tick'));

    const segments = listWorkspaceAuditSegments(fsFactory, chestnutRoot);
    const limited = await readWorkspaceAuditMerged(segments, { limit: 2 });
    expect(limited.map((m) => m.record.seq)).toEqual([1, 3]);

    const filtered = await readWorkspaceAuditMerged(segments, { typePattern: 'cron_*' });
    expect(filtered.map((m) => m.record.seq)).toEqual([1, 3]);
    expect(filtered.map((m) => m.segment.origin)).toEqual(['legacy', 'new']);
  });

  it('legacy 段读取失败（probe ok / read EACCES）：逐段分型 onIssue、新段行不丢（不当整体空）', async () => {
    writeLegacy(row('2024-01-01T00:00:00Z', 1, 'legacy_a'));
    writeNew(row('2026-08-01T00:00:00Z', 2, 'new_a'));
    fs.chmodSync(legacyPath(), 0o000);
    try {
      const segments = listWorkspaceAuditSegments(fsFactory, chestnutRoot);
      expect(segments[0].status).toBe('ok'); // 存在性探测通过、失败在 read 阶段分型

      const issues: WorkspaceAuditSegmentIssue[] = [];
      const merged = await readWorkspaceAuditMerged(segments, { onIssue: (i) => issues.push(i) });

      expect(merged.map((m) => m.record.type)).toEqual(['new_a']);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ origin: 'legacy', path: legacyPath(), stage: 'read' });
    } finally {
      fs.chmodSync(legacyPath(), 0o644);
    }
  });

  it('probe 阶段失败（existsSync 抛错）：段状态 unreadable、typed issue 带 code', async () => {
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const stubFs = {
      existsSync: (p: string) => {
        if (p === legacyPath()) throw eacces;
        return false;
      },
    } as unknown as FileSystem;

    const segments = listWorkspaceAuditSegments(() => stubFs, chestnutRoot);
    expect(segments[0]).toMatchObject({ origin: 'legacy', status: 'unreadable' });
    expect(segments[0].status === 'unreadable' && segments[0].issue).toMatchObject({
      stage: 'probe',
      code: 'EACCES',
    });
    expect(segments[1].status).toBe('missing');

    const issues: WorkspaceAuditSegmentIssue[] = [];
    const merged = await readWorkspaceAuditMerged(segments, { onIssue: (i) => issues.push(i) });
    expect(merged).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0].origin).toBe('legacy');
  });

  it('missing 段不触发 onIssue（缺段是合法状态、非失败）', async () => {
    const segments = listWorkspaceAuditSegments(fsFactory, chestnutRoot);
    expect(segments.every((s) => s.status === 'missing')).toBe(true);

    const issues: WorkspaceAuditSegmentIssue[] = [];
    const merged = await readWorkspaceAuditMerged(segments, { onIssue: (i) => issues.push(i) });
    expect(merged).toEqual([]);
    expect(issues).toEqual([]);
  });
});
