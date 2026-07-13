import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { summarizeLastExit, readLastExitEvent } from '../../src/daemon/last-exit-summary.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';

describe('summarizeLastExit', () => {
  let tmpDir: string;
  let auditPath: string;
  let testFs: FileSystem;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-exit-test-'));
    auditPath = path.join(tmpDir, 'audit.tsv');
    testFs = new NodeFileSystem({ baseDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAudit(lines: string[]): void {
    fs.writeFileSync(auditPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  }

  it('returns null when audit.tsv does not exist', () => {
    expect(summarizeLastExit(testFs, 'audit.tsv')).toBeNull();
  });

  it('returns null when audit.tsv is empty', () => {
    writeAudit([]);
    expect(summarizeLastExit(testFs, 'audit.tsv')).toBeNull();
  });

  it('summarizes daemon_stop with reason col', () => {
    writeAudit(['2026-04-16T10:00:00.000Z\tdaemon_stop\treason=sigterm']);
    const out = summarizeLastExit(testFs, 'audit.tsv');
    expect(out).toContain('stopped normally');
    expect(out).toContain('2026-04-16T10:00:00.000Z');
    expect(out).toContain('reason=sigterm');
  });

  it('summarizes daemon_crash with err col', () => {
    writeAudit(['2026-04-16T10:00:00.000Z\tdaemon_crash\terr=TypeError: foo']);
    const out = summarizeLastExit(testFs, 'audit.tsv');
    expect(out).toContain('crashed');
    expect(out).toContain('err=TypeError: foo');
  });

  it('summarizes daemon_unclean_exit with last_ts col', () => {
    writeAudit(['2026-04-16T10:00:00.000Z\tdaemon_unclean_exit\tlast_ts=2026-04-16T09:55:00.000Z']);
    const out = summarizeLastExit(testFs, 'audit.tsv');
    expect(out).toContain('exited uncleanly');
    expect(out).toContain('SIGKILL');
    expect(out).toContain('last_ts=2026-04-16T09:55:00.000Z');
  });

  it('summarizes other event types as "did not write a shutdown event"', () => {
    writeAudit([
      '2026-04-16T09:00:00.000Z\tturn_start',
      '2026-04-16T09:00:01.000Z\tllm_call\tmodel=foo\tin=10\tout=20',
    ]);
    const out = summarizeLastExit(testFs, 'audit.tsv');
    expect(out).toContain('did not write a shutdown event');
    expect(out).toContain("'llm_call'");
    expect(out).toContain('model=foo');
  });

  it('handles event with no cols (no parens)', () => {
    writeAudit(['2026-04-16T10:00:00.000Z\tturn_start']);
    const out = summarizeLastExit(testFs, 'audit.tsv');
    expect(out).toContain("'turn_start'");
    expect(out).not.toContain('()');
  });

  it('skips malformed last line and uses prior valid line', () => {
    writeAudit([
      '2026-04-16T09:00:00.000Z\tdaemon_stop\treason=sigterm',
      'malformed-line-no-tab',
    ]);
    const out = summarizeLastExit(testFs, 'audit.tsv');
    expect(out).toContain('stopped normally');
  });

  it('returns null when all lines are malformed', () => {
    writeAudit([
      'no-tab-1',
      'no-tab-2',
    ]);
    expect(summarizeLastExit(testFs, 'audit.tsv')).toBeNull();
  });

  it('reads last line correctly when file is much larger than tail buffer', () => {
    // 写入 ~10KB 的伪事件，确保 tail buffer 切尾逻辑生效
    const padding = Array.from({ length: 200 }, (_, i) =>
      `2026-04-16T08:${String(i % 60).padStart(2, '0')}:00.000Z\tturn_start\tn=${i}`
    );
    const lines = [
      ...padding,
      '2026-04-16T10:00:00.000Z\tdaemon_stop\treason=sigterm',
    ];
    writeAudit(lines);
    expect(fs.statSync(auditPath).size).toBeGreaterThan(4096);
    const out = summarizeLastExit(testFs, 'audit.tsv');
    expect(out).toContain('stopped normally');
    expect(out).toContain('2026-04-16T10:00:00.000Z');
  });

  it('falls back to full read when tail buffer cannot fit a single line', () => {
    // 单行 > 4KB（极端情况）
    const longCol = 'x'.repeat(5000);
    writeAudit([`2026-04-16T10:00:00.000Z\tdaemon_crash\terr=${longCol}`]);
    const out = summarizeLastExit(testFs, 'audit.tsv');
    expect(out).toContain('crashed');
    expect(out).toContain(longCol);
  });

  it('summarizes daemon_stop without cols (no parens)', () => {
    writeAudit(['2026-04-16T10:00:00.000Z\tdaemon_stop']);
    const out = summarizeLastExit(testFs, 'audit.tsv');
    expect(out).toContain('stopped normally');
    expect(out).toContain('2026-04-16T10:00:00.000Z.');
    expect(out).not.toContain('(');
  });

  it('summarizes daemon_unclean_exit without cols (no last activity line)', () => {
    writeAudit(['2026-04-16T10:00:00.000Z\tdaemon_unclean_exit']);
    const out = summarizeLastExit(testFs, 'audit.tsv');
    expect(out).toContain('exited uncleanly');
    expect(out).not.toContain('Last activity timestamp');
  });
});

describe('readLastExitEvent', () => {
  // 基础 reader 行为已被 summarizeLastExit 间接覆盖；
  // 这里补一个直接测试，验证返回结构
  it('returns parsed event structure', () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-exit-test-'));
    const auditPath = path.join(tmpDir, 'audit.tsv');
    fs.writeFileSync(auditPath, '2026-04-16T10:00:00.000Z\tdaemon_stop\treason=sigterm\textra=col\n');
    const innerFs = new NodeFileSystem({ baseDir: tmpDir });
    try {
      const ev = readLastExitEvent(innerFs, 'audit.tsv');
      expect(ev).not.toBeNull();
      expect(ev!.ts).toBe('2026-04-16T10:00:00.000Z');
      expect(ev!.type).toBe('daemon_stop');
      expect(ev!.cols).toEqual(['reason=sigterm', 'extra=col']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
