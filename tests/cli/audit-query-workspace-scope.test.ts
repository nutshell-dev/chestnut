/**
 * Phase 1288 Step D: CLI `audit query` / `audit info` workspace 根 scope
 * （-c workspace）—— 切换到 segments 查询。
 *
 * 验收：
 * - 双段并存：legacy/new 行 merged 时间序输出（不拼接伪造全序）、同 ts 段序 tie-break；
 * - 仅 legacy / 仅新 各可查询；
 * - 任一段读取失败逐段分型呈现（stderr typed warning）、不静默丢段、不当整体空；
 * - claw 专属 flag（--file / --all-files）在 workspace scope 下 fail-loud；
 * - audit info workspace scope 输出显式 segment 列表（origin/path/status）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import { auditQueryCommand as auditQueryCommandImpl, WORKSPACE_AUDIT_SCOPE } from '../../src/cli/commands/audit-query.js';
import { auditInfoCommand as auditInfoCommandImpl } from '../../src/cli/commands/audit-info.js';
import { getChestnutRoot } from '../../src/core/claw-topology/claw-instance-paths.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { makeAuditCommandDeps } from '../helpers/audit-command-deps.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const auditQueryCommand = (_deps: { fsFactory: typeof fsFactory }, opts: Parameters<typeof auditQueryCommandImpl>[1]) =>
  auditQueryCommandImpl(makeAuditCommandDeps(fsFactory), opts);
const auditInfoCommand = (_deps: { fsFactory: typeof fsFactory }, opts: Parameters<typeof auditInfoCommandImpl>[1]) =>
  auditInfoCommandImpl(makeAuditCommandDeps(fsFactory), opts);

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getChestnutRoot: vi.fn(),
  };
});

const row = (ts: string, seq: number, type: string) => `${ts}\tseq=${seq}\t${type}\n`;

describe('phase 1288 Step D: audit query/info workspace scope (segments)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;
  let chestnutRoot: string;

  const legacyPath = () => path.join(chestnutRoot, 'audit.tsv');
  const newPath = () => path.join(chestnutRoot, 'audit', 'audit.tsv');

  beforeEach(async () => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    tempDir = await createTrackedTempDir('chestnut-ws-scope-');
    chestnutRoot = path.join(tempDir, '.chestnut');
    fsNative.mkdirSync(chestnutRoot, { recursive: true });
    vi.mocked(getChestnutRoot).mockReturnValue(chestnutRoot);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  function writeLegacy(lines: string): void {
    fsNative.writeFileSync(legacyPath(), lines);
  }
  function writeNew(lines: string): void {
    fsNative.mkdirSync(path.dirname(newPath()), { recursive: true });
    fsNative.writeFileSync(newPath(), lines);
  }
  const stdoutText = () => stdoutSpy.mock.calls.map(c => c[0] as string).join('');
  const stderrText = () => stderrSpy.mock.calls.map(c => c[0] as string).join('');

  it('双段并存：交错时间戳 merged 时间序输出（非拼接全序），同 ts legacy 段在前', async () => {
    writeLegacy(row('2024-01-01T00:00:00Z', 1, 'legacy_a') + row('2024-01-01T00:00:02Z', 2, 'legacy_b'));
    writeNew(row('2024-01-01T00:00:01Z', 3, 'new_a') + row('2024-01-01T00:00:02Z', 4, 'new_b'));

    await auditQueryCommand({ fsFactory }, { claw: WORKSPACE_AUDIT_SCOPE, file: 'audit' });

    const out = stdoutText();
    // 字符串拼接会输出 1,2,3,4；merged 时间序输出 1,3 然后同 ts 的 2(legacy) 在 4(new) 前
    const order = ['seq=1', 'seq=3', 'seq=2', 'seq=4'].map((m) => out.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(process.exitCode).toBeUndefined();
  });

  it('仅 legacy：legacy 行可查询（旧历史不因切换而丢失）', async () => {
    writeLegacy(row('2024-01-01T00:00:00Z', 1, 'legacy_only'));

    await auditQueryCommand({ fsFactory }, { claw: WORKSPACE_AUDIT_SCOPE, file: 'audit' });

    expect(stdoutText()).toContain('legacy_only');
  });

  it('仅新：新段行可查询', async () => {
    writeNew(row('2026-08-01T00:00:00Z', 1, 'watchdog_start'));

    await auditQueryCommand({ fsFactory }, { claw: WORKSPACE_AUDIT_SCOPE, file: 'audit' });

    expect(stdoutText()).toContain('watchdog_start');
  });

  it('legacy 段读取失败：stderr 分型呈现 origin=legacy、新段行不丢（不当整体空）', async () => {
    writeLegacy(row('2024-01-01T00:00:00Z', 1, 'legacy_a'));
    writeNew(row('2026-08-01T00:00:00Z', 2, 'new_a'));
    fsNative.chmodSync(legacyPath(), 0o000);
    try {
      await auditQueryCommand({ fsFactory }, { claw: WORKSPACE_AUDIT_SCOPE, file: 'audit' });

      const err = stderrText();
      expect(err).toContain('workspace segment unreadable');
      expect(err).toContain('origin=legacy');
      expect(stdoutText()).toContain('new_a');
      expect(stdoutText()).not.toContain('legacy_a');
    } finally {
      fsNative.chmodSync(legacyPath(), 0o644);
    }
  });

  it('claw 专属 flag 在 workspace scope 下 fail-loud', async () => {
    await expect(auditQueryCommand(
      { fsFactory },
      { claw: WORKSPACE_AUDIT_SCOPE, file: 'tick' },
    )).rejects.toThrow('--file is claw-scoped');
    await expect(auditQueryCommand(
      { fsFactory },
      { claw: WORKSPACE_AUDIT_SCOPE, file: 'audit', allFiles: true },
    )).rejects.toThrow('--all-files is claw-scoped');
  });

  it('workspace scope 不要求 claw 存在（clawExists false 也可查询）', async () => {
    writeNew(row('2026-08-01T00:00:00Z', 1, 'new_a'));
    await expect(
      auditQueryCommand({ fsFactory }, { claw: WORKSPACE_AUDIT_SCOPE, file: 'audit' }),
    ).resolves.toBeUndefined();
    expect(stdoutText()).toContain('new_a');
  });

  it('audit info workspace scope：json 输出显式 segments（origin/status/path）', async () => {
    writeLegacy(row('2024-01-01T00:00:00Z', 1, 'legacy_a'));

    await auditInfoCommand({ fsFactory }, { claw: WORKSPACE_AUDIT_SCOPE, json: true });

    const parsed = JSON.parse(stdoutText());
    expect(parsed.claw).toBe(WORKSPACE_AUDIT_SCOPE);
    expect(parsed.base_dir).toBe(path.resolve(chestnutRoot));
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]).toMatchObject({ name: 'audit', origin: 'legacy', status: 'ok', path: legacyPath() });
    expect(parsed.files[1]).toMatchObject({ name: 'audit', origin: 'new', status: 'missing', path: newPath() });
  });

  it('audit info workspace scope：文本输出含 origin/status', async () => {
    writeNew(row('2026-08-01T00:00:00Z', 1, 'new_a'));

    await auditInfoCommand({ fsFactory }, { claw: WORKSPACE_AUDIT_SCOPE });

    const out = stdoutText();
    expect(out).toContain(`Claw: ${WORKSPACE_AUDIT_SCOPE}`);
    expect(out).toContain('origin: legacy  status: missing');
    expect(out).toContain('origin: new  status: ok');
  });
});
