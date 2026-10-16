/**
 * Phase 1279 Step A: Chat Viewport owner 工厂 createViewportAudit 真实落盘锁。
 *
 * 总览反向验收 3：四个高频事件真正落 viewport.tsv、其余 viewport 事件按默认
 * 兜底落 audit.tsv、无静默丢弃。DispatchingAuditWriter 预建 writer 不等于
 * 预写文件，且真实路由错误无法用存在性区分——所有断言读文件内容。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  createViewportAudit,
  VIEWPORT_FILE_ROUTING,
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
    // phase 1874 Step D: 诊断面两事件亦路由 viewport.tsv
    audit.write('viewport_host_input', 'chunks=1');
    audit.write('viewport_screen_reset', 'clears=1');

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
