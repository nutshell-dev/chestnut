import { describe, it, expect } from 'vitest';
import {
  AggregatedFileRouting,
  lookupFileForType,
  getRoutedFileNames,
  DEFAULT_FILE,
} from '../../src/assembly/file-routing-aggregator.js';
import { CRON_FILE_ROUTING } from '../../src/core/cron/audit-events.js';
import { DAEMON_FILE_ROUTING } from '../../src/daemon/audit-events.js';
import { VIEWPORT_FILE_ROUTING } from '../../src/cli/commands/viewport-audit-events.js';

describe('file-routing-aggregator (phase 159)', () => {
  it('AggregatedFileRouting contains all owner-declared types', () => {
    const ownerRoutings = {
      ...CRON_FILE_ROUTING,
      ...DAEMON_FILE_ROUTING,
      ...VIEWPORT_FILE_ROUTING,
    };
    for (const [type, file] of Object.entries(ownerRoutings)) {
      expect(AggregatedFileRouting.has(type)).toBe(true);
      expect(AggregatedFileRouting.get(type)).toBe(file);
    }
  });

  it('lookupFileForType returns correct file for known types', () => {
    expect(lookupFileForType('cron_job_started')).toBe('tick');
    expect(lookupFileForType('cron_outbox_summary_skipped')).toBe('tick');
    expect(lookupFileForType('daemon_liveness_heartbeat')).toBe('tick');
    expect(lookupFileForType('daemon_loop_iteration')).toBe('tick');
    expect(lookupFileForType('viewport_render_batch')).toBe('viewport');
    expect(lookupFileForType('viewport_event_ingest')).toBe('viewport');
    expect(lookupFileForType('viewport_spinner_lifecycle')).toBe('viewport');
  });

  it('lookupFileForType returns DEFAULT_FILE for unknown types', () => {
    expect(lookupFileForType('unknown_type')).toBe(DEFAULT_FILE);
    expect(lookupFileForType('turn_start')).toBe(DEFAULT_FILE);
    expect(lookupFileForType('contract_created')).toBe(DEFAULT_FILE);
  });

  it('getRoutedFileNames includes audit, tick, and viewport', () => {
    const files = getRoutedFileNames();
    expect(files.has('audit')).toBe(true);
    expect(files.has('tick')).toBe(true);
    expect(files.has('viewport')).toBe(true);
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
