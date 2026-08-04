import { describe, it, expect } from 'vitest';
import {
  AggregatedFileRouting,
  createAggregatedFileRouting,
  lookupFileForType,
  getRoutedFileNames,
  DEFAULT_FILE,
} from '../../src/assembly/file-routing-aggregator.js';
import { CLI_AUDIT_EVENTS } from '../../src/cli/audit-events.js';
import { CRON_FILE_ROUTING } from '../../src/foundation/cron/audit-events.js';
import { DAEMON_FILE_ROUTING } from '../../src/daemon/audit-events.js';

describe('file-routing-aggregator (phase 159 / 1243 / 1279 / 1281)', () => {
  it('AggregatedFileRouting contains all internal owner-declared types', () => {
    const ownerRoutings = {
      ...CRON_FILE_ROUTING,
    };
    for (const [type, file] of Object.entries(ownerRoutings)) {
      expect(AggregatedFileRouting.has(type)).toBe(true);
      expect(AggregatedFileRouting.get(type)).toBe(file);
    }
  });

  it('createAggregatedFileRouting merges external contributions (Daemon routing)', () => {
    const routing = createAggregatedFileRouting([DAEMON_FILE_ROUTING]);
    expect(routing.get('daemon_liveness_heartbeat')).toBe('tick');
  });

  it('lookupFileForType returns correct file for known internal types', () => {
    expect(lookupFileForType('eventloop_iteration')).toBe('tick');
  });

  it('phase 1279 reverse lock: Assembly aggregate 不再含 viewport routing（归 CLI owner 工厂）', () => {
    // daemon/Assembly 零 viewport producer；viewport 事件在 Assembly 聚合图上必须走默认兜底
    expect(lookupFileForType('viewport_render_batch')).toBe(DEFAULT_FILE);
    expect(lookupFileForType('viewport_event_ingest')).toBe(DEFAULT_FILE);
    expect(lookupFileForType('viewport_spinner_lifecycle')).toBe(DEFAULT_FILE);
    expect(lookupFileForType('viewport_scrollback_clear_suppressed')).toBe(DEFAULT_FILE);
  });

  it('phase 1281 reverse lock: 全部 CLI 事件走 DEFAULT_FILE（CLI_FILE_ROUTING 伪贡献已删除）', () => {
    // Assembly 聚合图不再含任何 cli_* routing；CLI 事件经未知类型 fallback 仍落 audit
    for (const eventType of Object.values(CLI_AUDIT_EVENTS)) {
      expect(lookupFileForType(eventType), `${eventType} must fall back to DEFAULT_FILE`).toBe(DEFAULT_FILE);
    }
  });

  it('lookupFileForType with external routing returns correct file for contributed types', () => {
    const routing = createAggregatedFileRouting([DAEMON_FILE_ROUTING]);
    expect(lookupFileForType('daemon_liveness_heartbeat', routing)).toBe('tick');
  });

  it('lookupFileForType returns DEFAULT_FILE for unknown types', () => {
    expect(lookupFileForType('unknown_type')).toBe(DEFAULT_FILE);
    expect(lookupFileForType('turn_start')).toBe(DEFAULT_FILE);
    expect(lookupFileForType('contract_created')).toBe(DEFAULT_FILE);
  });

  it('getRoutedFileNames includes audit and tick, not viewport (phase 1279)', () => {
    const files = getRoutedFileNames();
    expect(files.has('audit')).toBe(true);
    expect(files.has('tick')).toBe(true);
    // 反向锁：Assembly daemon AuditLog 不再创建 viewport.tsv writer
    expect(files.has('viewport')).toBe(false);
  });

  it('getRoutedFileNames always includes DEFAULT_FILE even if no routings', () => {
    // 这是行为契约：default file 必在集合中
    const files = getRoutedFileNames();
    expect(files.has(DEFAULT_FILE)).toBe(true);
  });

  it('cron handler events stay in audit (exceptions)', () => {
    expect(lookupFileForType('cron_handler_aborted')).toBe('audit');
    expect(lookupFileForType('cron_handler_timeout')).toBe('audit');
    expect(lookupFileForType('cron_handler_stuck')).toBe('audit');
    expect(lookupFileForType('cron_job_error')).toBe('audit');
    expect(lookupFileForType('cron_job_late_settled')).toBe('audit');
  });
});
