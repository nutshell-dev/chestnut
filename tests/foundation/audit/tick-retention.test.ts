/**
 * Phase 1318 Step A: tick.tsv 30 天滚动（按天归档 + prune）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createSystemAudit } from '../../../src/foundation/audit/index.js';
import { TICK_RETENTION_DAYS } from '../../../src/foundation/audit/writer.js';
import { _resetFallbackForTest } from '../../../src/foundation/audit/writer.js';

describe('tick.tsv 30-day rolling retention (phase 1318 Step A)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'phase1318-tick-'));
    _resetFallbackForTest();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const makeTypeToFile = () =>
    new Map<string, 'tick'>([['daemon_liveness_heartbeat', 'tick']]);

  function yyyymmdd(d: Date): string {
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }

  it('same-day writes append to tick.tsv without archiving', () => {
    vi.useFakeTimers({ now: new Date('2026-08-07T00:00:00.000Z') });
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createSystemAudit(fs, tmpDir, { typeToFile: makeTypeToFile() });

    audit.write('daemon_liveness_heartbeat', 'seq=a');
    audit.write('daemon_liveness_heartbeat', 'seq=b');

    expect(existsSync(join(tmpDir, 'tick.tsv'))).toBe(true);
    expect(readdirSync(tmpDir).filter(f => f.startsWith('tick.') && f.endsWith('.tsv') && f !== 'tick.tsv').length).toBe(0);
    const content = readFileSync(join(tmpDir, 'tick.tsv'), 'utf8');
    expect(content).toContain('seq=a');
    expect(content).toContain('seq=b');
  });

  it('cross-day write archives previous day and starts a new tick.tsv', () => {
    vi.useFakeTimers({ now: new Date('2026-08-06T23:59:50.000Z') });
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createSystemAudit(fs, tmpDir, { typeToFile: makeTypeToFile() });

    audit.write('daemon_liveness_heartbeat', 'day1');

    // roll clock to next day
    vi.setSystemTime(new Date('2026-08-07T00:00:05.000Z'));
    audit.write('daemon_liveness_heartbeat', 'day2');

    const files = readdirSync(tmpDir);
    expect(files).toContain('tick.tsv');
    expect(files).toContain(`tick.${yyyymmdd(new Date('2026-08-06T00:00:00Z'))}.tsv`);

    const archived = readFileSync(join(tmpDir, `tick.${yyyymmdd(new Date('2026-08-06T00:00:00Z'))}.tsv`), 'utf8');
    expect(archived).toContain('day1');

    const live = readFileSync(join(tmpDir, 'tick.tsv'), 'utf8');
    expect(live).toContain('day2');
    expect(live).not.toContain('day1');
  });

  it('prunes archives older than TICK_RETENTION_DAYS days', () => {
    const today = new Date('2026-08-07T00:00:00.000Z');
    vi.useFakeTimers({ now: today });
    const fs = new NodeFileSystem({ baseDir: tmpDir });

    // seed old archives: 31 days ago should be pruned; 29 days ago should stay.
    const oldDate = new Date(today);
    oldDate.setUTCDate(oldDate.getUTCDate() - TICK_RETENTION_DAYS - 1);
    const recentDate = new Date(today);
    recentDate.setUTCDate(recentDate.getUTCDate() - TICK_RETENTION_DAYS + 1);

    const oldName = `tick.${yyyymmdd(oldDate)}.tsv`;
    const recentName = `tick.${yyyymmdd(recentDate)}.tsv`;

    fs.writeAtomicSync(oldName, '2026-07-07T00:00:00.000Z\tseq=1\told\n');
    fs.writeAtomicSync(recentName, '2026-07-09T00:00:00.000Z\tseq=1\trecent\n');

    const audit = createSystemAudit(fs, tmpDir, { typeToFile: makeTypeToFile() });
    audit.write('daemon_liveness_heartbeat', 'today');

    const filesAfter = readdirSync(tmpDir);
    // debug on failure
    expect(filesAfter, `files after prune: ${filesAfter.join(', ')}`).toContain(recentName);
    expect(filesAfter).not.toContain(oldName);
  });

  it('audit.tsv is unaffected by daily rotation', () => {
    vi.useFakeTimers({ now: new Date('2026-08-06T00:00:00.000Z') });
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createSystemAudit(fs, tmpDir, { typeToFile: makeTypeToFile() });

    audit.write('some_event', 'col=x');
    vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));
    audit.write('some_event', 'col=y');

    expect(existsSync(join(tmpDir, 'audit.tsv'))).toBe(true);
    expect(readdirSync(tmpDir).some(f => f.startsWith('audit.') && f.endsWith('.tsv') && f !== 'audit.tsv')).toBe(false);
  });
});
