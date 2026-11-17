import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createLLMEventSink } from '../../src/assembly/llm-event-sink.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { StreamWriter } from '../../src/foundation/stream/writer.js';
import { STREAM_AUDIT_EVENTS } from '../../src/foundation/stream/audit-events.js';
import { makeAudit } from '../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

describe('Assembly early stream events (phase 2187)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('stream-early-events-');
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempDir(tempDir);
  });

  it('provider/SDK/recovery events emitted immediately after sink creation persist in order', async () => {
    const fs = new NodeFileSystem({ baseDir: tempDir });
    const audit = makeAudit();
    const writer = new StreamWriter(fs, audit.audit);

    // 与 core-infrastructure 的生产顺序一致：先 open，再交付 sink。
    writer.open();
    const sink = createLLMEventSink(audit.audit, writer);

    vi.setSystemTime(1000);
    sink.emit({
      type: 'provider_attempt_failed',
      provider: 'primary',
      attempt: 0,
      maxAttempts: 3,
      error: 'connection refused',
      errorClass: 'transient',
      userActionHint: 'retry_later',
    });
    vi.setSystemTime(2000);
    sink.emit({ type: 'sdk_client_cache_hit', preset: 'anthropic', model: 'claude-test' });
    vi.setSystemTime(3000);
    sink.emit({
      type: 'recovery_scheduled',
      orchestratorInstance: 'owner-early',
      invocationId: 'inv-early',
      attemptId: 'attempt-early',
      revision: 7,
      scheduleKind: 'at',
      resumeAt: '2026-11-17T04:00:00.000Z',
      errorClass: 'rate_limit',
      providerCount: 2,
      failureCount: 1,
    });
    writer.close();

    const events = readFileSync(path.join(tempDir, 'stream.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({
        ts: 1000,
        type: 'provider_attempt_failed',
        provider: 'primary',
        error: 'connection refused',
      }),
      expect.objectContaining({
        ts: 2000,
        type: 'sdk_client_cache_hit',
        preset: 'anthropic',
        model: 'claude-test',
      }),
      expect.objectContaining({
        ts: 3000,
        type: 'recovery_scheduled',
        invocationId: 'inv-early',
        attemptId: 'attempt-early',
        revision: 7,
      }),
    ]);
    expect(audit.events.some(e => e[0] === STREAM_AUDIT_EVENTS.WRITE_BEFORE_OPEN)).toBe(false);
    expect(audit.events.some(e => e[0] === STREAM_AUDIT_EVENTS.WRITE_AFTER_CLOSE)).toBe(false);
  });
});
