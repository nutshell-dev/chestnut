import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createSystemAudit, type AuditLog } from '../../../src/foundation/audit/index.js';
import { AggregatedFileRouting, lookupFileForType } from '../../../src/assembly/file-routing-aggregator.js';
import { _resetFallbackForTest } from '../../../src/foundation/audit/writer.js';

describe('multi-file emit E2E (phase 159)', () => {
  let tmpDir: string;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = mkdtempSync(join(tmpdir(), 'phase159-e2e-'));
    _resetFallbackForTest();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('装配 DispatchingAuditWriter + emit tick 类 → 落到 tick.tsv', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit: AuditLog = createSystemAudit(fs, tmpDir, { typeToFile: AggregatedFileRouting });

    audit.write('daemon_liveness_heartbeat', 'job=dream-trigger');
    audit.write('eventloop_iteration', 'reason=empty');

    expect(existsSync(join(tmpDir, 'tick.tsv'))).toBe(true);
    const tickContent = readFileSync(join(tmpDir, 'tick.tsv'), 'utf-8');
    expect(tickContent).toContain('daemon_liveness_heartbeat');
    expect(tickContent).toContain('eventloop_iteration');

    // audit.tsv 不含 tick 类 event
    if (existsSync(join(tmpDir, 'audit.tsv'))) {
      const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');
      expect(auditContent).not.toContain('daemon_liveness_heartbeat');
    }
  });

  it('emit 业务类 type → 落到 audit.tsv（默认）', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit: AuditLog = createSystemAudit(fs, tmpDir, { typeToFile: AggregatedFileRouting });

    audit.write('turn_start', 'trace_id=t1');
    audit.write('contract_created', 'contract_id=c1');

    expect(existsSync(join(tmpDir, 'audit.tsv'))).toBe(true);
    const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain('turn_start');
    expect(auditContent).toContain('contract_created');
  });

  it('emit viewport 类 → 落到 viewport.tsv', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit: AuditLog = createSystemAudit(fs, tmpDir, { typeToFile: AggregatedFileRouting });

    audit.write('viewport_render_batch', 'count=5');

    expect(existsSync(join(tmpDir, 'viewport.tsv'))).toBe(true);
    const viewportContent = readFileSync(join(tmpDir, 'viewport.tsv'), 'utf-8');
    expect(viewportContent).toContain('viewport_render_batch');
  });

  it('per-file seq 独立计数', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit: AuditLog = createSystemAudit(fs, tmpDir, { typeToFile: AggregatedFileRouting });

    // 交叉 emit：tick + audit + tick + audit
    audit.write('daemon_liveness_heartbeat', 'job=a');
    audit.write('turn_start', 'trace_id=t1');
    audit.write('daemon_liveness_heartbeat', 'job=b');
    audit.write('turn_end', 'trace_id=t1');

    const tickContent = readFileSync(join(tmpDir, 'tick.tsv'), 'utf-8');
    const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');

    // tick.tsv: seq=1 (daemon_liveness_heartbeat a), seq=2 (daemon_liveness_heartbeat b)
    expect(tickContent).toContain('seq=1');
    expect(tickContent).toContain('seq=2');

    // audit.tsv: seq=1 (turn_start), seq=2 (turn_end)
    expect(auditContent).toContain('seq=1');
    expect(auditContent).toContain('seq=2');
  });

  it('无 typeToFile spec → 单 AuditWriter to audit.tsv（向后兼容）', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit: AuditLog = createSystemAudit(fs, tmpDir); // 无 options

    audit.write('daemon_liveness_heartbeat', 'job=x');
    audit.write('turn_start', 'trace_id=t1');

    // 全 emit 到 audit.tsv
    expect(existsSync(join(tmpDir, 'audit.tsv'))).toBe(true);
    expect(existsSync(join(tmpDir, 'tick.tsv'))).toBe(false);

    const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain('daemon_liveness_heartbeat');
    expect(auditContent).toContain('turn_start');
  });

  it('audit.tsv 仍是业务事件主 file（cross-process 字面契约保留）', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit: AuditLog = createSystemAudit(fs, tmpDir, { typeToFile: AggregatedFileRouting });

    // 模拟 daemon_stop 业务事件
    audit.write('daemon_stop', 'reason=user');

    // last-exit-summary.ts:80 boot-time 读 audit.tsv tail、必须含 daemon_stop
    const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain('daemon_stop');
    expect(lookupFileForType('daemon_stop')).toBe('audit');
  });

  it('emit unknown type → 落 audit.tsv（兜底）', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit: AuditLog = createSystemAudit(fs, tmpDir, { typeToFile: AggregatedFileRouting });

    audit.write('totally_unknown_event', 'payload=xyz');

    expect(existsSync(join(tmpDir, 'audit.tsv'))).toBe(true);
    const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain('totally_unknown_event');
  });
});
