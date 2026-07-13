import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  createSystemAudit,
  DispatchingAuditWriter,
  AuditWriter,
  type AuditLog,
} from '../../../src/foundation/audit/index.js';
import { _resetFallbackForTest } from '../../../src/foundation/audit/writer.js';

describe('DispatchingAuditWriter (phase 159)', () => {
  let tmpDir: string;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = mkdtempSync(join(tmpdir(), 'phase159-dw-'));
    _resetFallbackForTest();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeTypeToFile = () =>
    new Map([
      ['daemon_liveness_heartbeat', 'tick'],
      ['daemon_loop_iteration', 'tick'],
      ['viewport_render_batch', 'viewport'],
    ]);

  it('constructs distinct AuditWriter instances per file', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const dw = new DispatchingAuditWriter(fs, tmpDir, makeTypeToFile());

    expect(dw._getWriterForFile('audit')).toBeInstanceOf(AuditWriter);
    expect(dw._getWriterForFile('tick')).toBeInstanceOf(AuditWriter);
    expect(dw._getWriterForFile('viewport')).toBeInstanceOf(AuditWriter);
  });

  it('emits registered type to correct file', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const dw = new DispatchingAuditWriter(fs, tmpDir, makeTypeToFile());

    dw.write('daemon_liveness_heartbeat', 'job=dream-trigger');

    expect(existsSync(join(tmpDir, 'tick.tsv'))).toBe(true);
    const tickContent = readFileSync(join(tmpDir, 'tick.tsv'), 'utf-8');
    expect(tickContent).toContain('daemon_liveness_heartbeat');
    expect(tickContent).toContain('job=dream-trigger');
  });

  it('emits unregistered type to default audit file', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const dw = new DispatchingAuditWriter(fs, tmpDir, makeTypeToFile());

    dw.write('turn_start', 'trace_id=t1');

    expect(existsSync(join(tmpDir, 'audit.tsv'))).toBe(true);
    const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain('turn_start');
    expect(auditContent).toContain('trace_id=t1');
  });

  it('per-file seq counters are independent', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const dw = new DispatchingAuditWriter(fs, tmpDir, makeTypeToFile());

    dw.write('daemon_liveness_heartbeat', 'job=a');
    dw.write('turn_start', 'trace_id=t1');
    dw.write('daemon_liveness_heartbeat', 'job=b');
    dw.write('turn_end', 'trace_id=t1');

    const tickContent = readFileSync(join(tmpDir, 'tick.tsv'), 'utf-8');
    const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');

    expect(tickContent).toContain('seq=1');
    expect(tickContent).toContain('seq=2');
    expect(auditContent).toContain('seq=1');
    expect(auditContent).toContain('seq=2');
  });

  it('dispose cascades to all internal writers', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const dw = new DispatchingAuditWriter(fs, tmpDir, makeTypeToFile());
    dw.write('daemon_liveness_heartbeat', 'job=x');
    expect(() => dw.dispose()).not.toThrow();
  });

  it('createSystemAudit without options returns single AuditWriter (backward compat)', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createSystemAudit(fs, tmpDir);

    audit.write('turn_start', 'trace_id=t1');
    audit.write('daemon_liveness_heartbeat', 'job=x');

    expect(existsSync(join(tmpDir, 'audit.tsv'))).toBe(true);
    expect(existsSync(join(tmpDir, 'tick.tsv'))).toBe(false);

    const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain('turn_start');
    expect(auditContent).toContain('daemon_liveness_heartbeat');
  });

  it('createSystemAudit with empty typeToFile Map returns single AuditWriter', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createSystemAudit(fs, tmpDir, { typeToFile: new Map() });

    audit.write('daemon_liveness_heartbeat', 'job=x');

    expect(existsSync(join(tmpDir, 'audit.tsv'))).toBe(true);
    expect(existsSync(join(tmpDir, 'tick.tsv'))).toBe(false);
  });

  it('createSystemAudit with typeToFile returns DispatchingAuditWriter', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createSystemAudit(fs, tmpDir, {
      typeToFile: makeTypeToFile(),
    });

    audit.write('daemon_liveness_heartbeat', 'job=x');

    expect(existsSync(join(tmpDir, 'tick.tsv'))).toBe(true);
  });

  it('AuditLog brand compiles', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const dw: AuditLog = new DispatchingAuditWriter(fs, tmpDir, makeTypeToFile());
    expect(dw.__brand).toBe('AuditLog');
  });

  it('per-file rotation is independent', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    // 0.001 MB ≈ 1 KB — tick rotates quickly
    const dw = new DispatchingAuditWriter(fs, tmpDir, makeTypeToFile(), {
      maxSizeMb: 0.001,
    });

    // write a large payload to tick to trigger rotation
    const big = 'x'.repeat(300);
    for (let i = 0; i < 20; i++) {
      dw.write('daemon_liveness_heartbeat', `padding=${big}`);
    }

    // tick should have rotated (original + .bak), audit should not
    const files = readdirSync(tmpDir);
    const tickBaks = files.filter(f => f.startsWith('tick.tsv') && f.endsWith('.bak'));
    const auditBaks = files.filter(f => f.startsWith('audit.tsv') && f.endsWith('.bak'));

    expect(tickBaks.length).toBeGreaterThanOrEqual(1);
    expect(auditBaks.length).toBe(0);
  });
});
