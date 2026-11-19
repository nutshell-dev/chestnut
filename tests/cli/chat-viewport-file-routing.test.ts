/**
 * Phase 1279 Step A: Chat Viewport owner 工厂 createViewportAudit 真实落盘锁。
 *
 * 总览反向验收 3：四个高频事件真正落 viewport.tsv、其余 viewport 事件按默认
 * 兜底落 audit.tsv、无静默丢弃。DispatchingAuditWriter 预建 writer 不等于
 * 预写文件，且真实路由错误无法用存在性区分——所有断言读文件内容。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  createViewportAudit,
  VIEWPORT_FILE_ROUTING,
  VIEWPORT_AUDIT_MAX_SIZE_MB,
  VIEWPORT_AUDIT_MAX_ARCHIVES,
} from '../../src/viewport/viewport-audit-events.js';
import { _resetFallbackForTest } from '../../src/foundation/audit/writer.js';

describe('chat-viewport file routing (phase 1279)', () => {
  let tmpDir: string;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = mkdtempSync(join(tmpdir(), 'phase1279-viewport-routing-'));
    _resetFallbackForTest();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('owner 工厂：四个高频事件真实落 viewport.tsv（读内容，非仅存在性）', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createViewportAudit(fs, tmpDir);

    audit.write('viewport_render_batch', 'count=5');
    audit.write('viewport_event_ingest', 'kind=turn');
    audit.write('viewport_spinner_lifecycle', 'state=start');
    audit.write('viewport_scrollback_clear_suppressed', 'reason=active_stream');
    audit.write('viewport_draft_persisted', 'bytes=12');
    audit.write('viewport_draft_cleared', 'reason=submitted');
    audit.write('viewport_draft_revision_deduplicated', 'revision=1');
    audit.write('viewport_draft_checkpoint', 'revision=1', 'outcome=durable');
    audit.write('viewport_draft_failure_visible', 'revision=1');
    audit.write('viewport_draft_recovered', 'revision=1');
    audit.write('viewport_draft_flush', 'reason=dispose');
    // phase 1874 Step D: 诊断面两事件亦路由 viewport.tsv
    audit.write('viewport_host_input', 'chunks=1');
    audit.write('viewport_screen_reset', 'clears=1');
    // phase 1942 Step B: 逐帧写出观测两事件亦路由 viewport.tsv
    audit.write('viewport_render_request_batch', 'requests=2');
    audit.write('viewport_terminal_write_batch', 'bytes=100');

    expect(existsSync(join(tmpDir, 'viewport.tsv'))).toBe(true);
    const viewportContent = readFileSync(join(tmpDir, 'viewport.tsv'), 'utf-8');
    for (const type of Object.keys(VIEWPORT_FILE_ROUTING)) {
      expect(viewportContent).toContain(type);
    }
    expect(viewportContent).toContain('count=5');

    // 高频事件不得泄漏进默认 audit.tsv
    if (existsSync(join(tmpDir, 'audit.tsv'))) {
      const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');
      for (const type of Object.keys(VIEWPORT_FILE_ROUTING)) {
        expect(auditContent).not.toContain(type);
      }
    }
  });

  it('fallback 不变：非分流 viewport 事件落默认 audit.tsv（无静默丢弃）', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createViewportAudit(fs, tmpDir);

    audit.write('viewport_unknown_event', 'payload=xyz');
    audit.write('viewport_shutdown', 'reason=user_quit');

    expect(existsSync(join(tmpDir, 'audit.tsv'))).toBe(true);
    const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain('viewport_unknown_event');
    expect(auditContent).toContain('viewport_shutdown');

    if (existsSync(join(tmpDir, 'viewport.tsv'))) {
      const viewportContent = readFileSync(join(tmpDir, 'viewport.tsv'), 'utf-8');
      expect(viewportContent).not.toContain('viewport_unknown_event');
      expect(viewportContent).not.toContain('viewport_shutdown');
    }
  });

  it('bounds the live viewport file by rotating at the owner size threshold', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createViewportAudit(fs, tmpDir);
    writeFileSync(join(tmpDir, 'viewport.tsv'), Buffer.alloc(VIEWPORT_AUDIT_MAX_SIZE_MB * 1024 * 1024, 120));

    audit.write('viewport_render_batch', 'count=after_rotation');

    expect(readdirSync(tmpDir).some(name => /^viewport\.tsv\..+\.bak$/.test(name))).toBe(true);
    expect(readFileSync(join(tmpDir, 'viewport.tsv'), 'utf8')).toContain('count=after_rotation');
    expect(existsSync(join(tmpDir, 'audit.tsv'))).toBe(false);
  });

  it('prunes expired and excess viewport archives without touching audit archives', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createViewportAudit(fs, tmpDir);
    writeFileSync(join(tmpDir, 'viewport.20200101.tsv'), 'expired\n');
    writeFileSync(join(tmpDir, 'audit.20200101.tsv'), 'keep audit\n');
    const old = new Date('2020-01-02T00:00:00Z');
    for (let i = 0; i <= VIEWPORT_AUDIT_MAX_ARCHIVES; i++) {
      const name = join(tmpDir, `viewport.tsv.${i}.bak`);
      writeFileSync(name, `archive=${i}\n`);
      utimesSync(name, old, old);
    }

    audit.write('viewport_render_batch', 'count=prune');

    const files = readdirSync(tmpDir);
    expect(files).not.toContain('viewport.20200101.tsv');
    expect(files).toContain('audit.20200101.tsv');
    expect(files.filter(name => /^viewport\.tsv\..+\.bak$/.test(name))).toHaveLength(VIEWPORT_AUDIT_MAX_ARCHIVES);
  });

  it('per-file seq 独立计数（viewport.tsv 与 audit.tsv 各自 seq=1 起）', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = createViewportAudit(fs, tmpDir);

    audit.write('viewport_render_batch', 'count=1');
    audit.write('viewport_command_error', 'cmd=/bad');
    audit.write('viewport_render_batch', 'count=2');

    const viewportContent = readFileSync(join(tmpDir, 'viewport.tsv'), 'utf-8');
    const auditContent = readFileSync(join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(viewportContent).toContain('seq=1');
    expect(viewportContent).toContain('seq=2');
    expect(auditContent).toContain('seq=1');
    expect(auditContent).not.toContain('seq=2');
  });
});
