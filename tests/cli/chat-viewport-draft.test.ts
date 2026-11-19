import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createViewportAudit } from '../../src/viewport/viewport-audit-events.js';
import {
  clearViewportDraft,
  createDraftCheckpointReporter,
  createDraftEditorChangeHandler,
  createDraftPersistenceScheduler,
  loadViewportDraft,
  persistViewportDraft,
  VIEWPORT_DRAFT_FILE,
  type DraftRevisionOutcome,
} from '../../src/viewport/chat-viewport-draft.js';
import { cleanupTempDir, createTrackedTempDir } from '../utils/temp.js';

describe('chat viewport durable draft', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('viewport-draft-');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempDir(tempDir);
  });

  function context() {
    const fs = new NodeFileSystem({ baseDir: tempDir });
    return { fs, audit: createViewportAudit(fs, tempDir) };
  }

  it('atomically persists and restores the exact unsubmitted text', () => {
    const { fs, audit } = context();
    const text = 'first line\n第二行';

    persistViewportDraft(fs, audit, text);

    expect(loadViewportDraft(fs, audit)).toEqual({ kind: 'restored', text });
    expect(fsSync.readFileSync(path.join(tempDir, 'audit.tsv'), 'utf8'))
      .toContain('viewport_draft_restored');
    const viewportAudit = fsSync.readFileSync(path.join(tempDir, 'viewport.tsv'), 'utf8');
    expect(viewportAudit).toContain('viewport_draft_persisted');
    expect(viewportAudit).toContain('chars=14');
    expect(viewportAudit).toContain('lines=2');
  });

  it('removes the mutable draft after an explicit clear', () => {
    const { fs, audit } = context();
    persistViewportDraft(fs, audit, 'recover me');

    clearViewportDraft(fs, audit, 'explicit_empty_state');

    expect(fs.existsSync(VIEWPORT_DRAFT_FILE)).toBe(false);
    expect(loadViewportDraft(fs, audit)).toEqual({ kind: 'none' });
    expect(fsSync.readFileSync(path.join(tempDir, 'viewport.tsv'), 'utf8'))
      .toContain('viewport_draft_cleared');
    // phase 1874 Step C: reason 显式可辨
    expect(fsSync.readFileSync(path.join(tempDir, 'viewport.tsv'), 'utf8'))
      .toContain('reason=explicit_empty_state');
  });

  it('quarantines malformed state instead of overwriting it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'));
    const { fs, audit } = context();
    fs.writeAtomicSync(VIEWPORT_DRAFT_FILE, '{broken');

    const result = loadViewportDraft(fs, audit);

    expect(result).toEqual({ kind: 'quarantined', path: 'viewport-draft.corrupt.1786233600000.json' });
    expect(fs.readSync('viewport-draft.corrupt.1786233600000.json')).toBe('{broken');
    expect(fs.existsSync(VIEWPORT_DRAFT_FILE)).toBe(false);
  });

  it('strict scheduler persists every distinct revision and deduplicates only an identical repeat', () => {
    const { fs, audit } = context();
    const scheduler = createDraftPersistenceScheduler(fs, audit);
    const write = vi.spyOn(fs, 'writeAtomicSync');

    expect(scheduler.submit({ revision: 1, text: 'same', changedAtMs: 100 }).checkpoint.kind).toBe('durable');
    expect(scheduler.submit({ revision: 1, text: 'same', changedAtMs: 100 }).deduplicated).toBe(true);
    expect(scheduler.submit({ revision: 2, text: 'same', changedAtMs: 101 }).deduplicated).toBe(false);

    expect(write).toHaveBeenCalledTimes(2);
    const viewportAudit = fsSync.readFileSync(path.join(tempDir, 'viewport.tsv'), 'utf8');
    expect(viewportAudit).toContain('viewport_draft_revision_deduplicated');
    expect(viewportAudit).toContain('revision=2');
  });

  it('rejects conflicting payloads for one revision without overwriting the durable checkpoint', () => {
    const { fs, audit } = context();
    const scheduler = createDraftPersistenceScheduler(fs, audit);
    scheduler.submit({ revision: 1, text: 'original', changedAtMs: 100 });

    const conflict = scheduler.submit({ revision: 1, text: 'changed', changedAtMs: 100 });

    expect(conflict.checkpoint.kind).toBe('revision_conflict');
    expect(loadViewportDraft(fs, audit)).toEqual({ kind: 'restored', text: 'original' });
  });

  it('preserves platform-limited durability as a structured failure with the original error', () => {
    const { fs, audit } = context();
    const error = Object.assign(new Error('directory fsync unsupported'), { code: 'ENOTSUP' });
    vi.spyOn(fs, 'writeAtomicSync').mockReturnValue({ kind: 'committed_platform_limited', error });
    const scheduler = createDraftPersistenceScheduler(fs, audit);

    const result = scheduler.submit({ revision: 1, text: 'limited', changedAtMs: 100 });

    expect(result.checkpoint).toEqual({
      kind: 'committed_platform_limited',
      operation: 'persist',
      error,
    });
    const auditText = fsSync.readFileSync(path.join(tempDir, 'audit.tsv'), 'utf8');
    expect(auditText).toContain('commit_state=committed_platform_limited');
    expect(auditText).not.toContain('viewport_draft_persisted');
  });

  it('allocates revisions by text state and deduplicates repeated editor notifications', () => {
    const { fs, audit } = context();
    const scheduler = createDraftPersistenceScheduler(fs, audit);
    const submit = vi.spyOn(scheduler, 'submit');
    const write = vi.spyOn(fs, 'writeAtomicSync');
    const outcomes: DraftRevisionOutcome[] = [];
    let now = 100;
    const onChange = createDraftEditorChangeHandler(
      scheduler,
      '',
      outcome => outcomes.push(outcome),
      () => now,
    );

    onChange('a');
    onChange('a');
    now = 101;
    onChange('ab');

    expect(submit.mock.calls.map(call => call[0])).toEqual([
      { revision: 1, text: 'a', changedAtMs: 100 },
      { revision: 1, text: 'a', changedAtMs: 100 },
      { revision: 2, text: 'ab', changedAtMs: 101 },
    ]);
    expect(outcomes.map(outcome => outcome.deduplicated)).toEqual([false, true, false]);
    expect(outcomes.every(outcome => outcome.checkpoint.kind === 'durable')).toBe(true);
    expect(outcomes.every(outcome => Number.isFinite(outcome.latencyMs))).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    const viewportAudit = fsSync.readFileSync(path.join(tempDir, 'viewport.tsv'), 'utf8');
    expect(viewportAudit).toContain('viewport_draft_checkpoint');
    expect(viewportAudit).toContain('outcome=durable');
    expect(viewportAudit).toContain('latency_ms=');
  });

  it('retries a non-durable repeat under the same revision until it recovers', () => {
    const { fs, audit } = context();
    const error = Object.assign(new Error('directory fsync unsupported'), { code: 'ENOTSUP' });
    const write = vi.spyOn(fs, 'writeAtomicSync').mockImplementationOnce(() => ({
      kind: 'committed_platform_limited',
      error,
    }));
    const scheduler = createDraftPersistenceScheduler(fs, audit);

    const limited = scheduler.submit({ revision: 1, text: 'retry me', changedAtMs: 100 });
    const recovered = scheduler.submit({ revision: 1, text: 'retry me', changedAtMs: 100 });

    expect(limited.checkpoint.kind).toBe('committed_platform_limited');
    expect(recovered).toMatchObject({
      revision: 1,
      deduplicated: false,
      checkpoint: { kind: 'durable', operation: 'persist' },
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(loadViewportDraft(fs, audit)).toEqual({ kind: 'restored', text: 'retry me' });
  });

  it('keeps a durable commit fact and the original error when audit sync fails', () => {
    const { fs, audit } = context();
    const error = new Error('audit sync failed');
    vi.spyOn(audit, 'write').mockImplementation(() => { throw error; });
    const scheduler = createDraftPersistenceScheduler(fs, audit);

    const result = scheduler.submit({ revision: 1, text: 'still durable', changedAtMs: 100 });

    expect(result.checkpoint.kind).toBe('durable');
    expect(result.checkpoint.auditError).toBe(error);
    expect(fs.readSync(VIEWPORT_DRAFT_FILE)).toContain('still durable');
  });

  it('makes checkpoint failure visible and reports durable recovery without clearing text', () => {
    const { audit } = context();
    const appendOutput = vi.fn();
    const requestRender = vi.fn();
    const report = createDraftCheckpointReporter({ audit, appendOutput, requestRender });
    const error = new Error('disk full');

    report({
      revision: 3,
      deduplicated: false,
      latencyMs: 4,
      checkpoint: { kind: 'failed', operation: 'persist', error },
    });

    expect(appendOutput).toHaveBeenCalledWith(
      '\x1b[31m',
      expect.stringContaining('editor text retained; retry or edit to recover'),
      true,
    );
    expect(fsSync.readFileSync(path.join(tempDir, 'viewport.tsv'), 'utf8'))
      .toContain('viewport_draft_failure_visible');

    report({
      revision: 3,
      deduplicated: false,
      latencyMs: 2,
      checkpoint: { kind: 'durable', operation: 'persist' },
    });

    expect(appendOutput).toHaveBeenLastCalledWith(
      '\x1b[32m',
      '[draft checkpoint recovered: revision=3]',
      true,
    );
    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(fsSync.readFileSync(path.join(tempDir, 'viewport.tsv'), 'utf8'))
      .toContain('viewport_draft_recovered');
  });

  it('flush is synchronous, explicit and auditable without inventing pending revisions', () => {
    const { fs, audit } = context();
    const scheduler = createDraftPersistenceScheduler(fs, audit);
    scheduler.submit({ revision: 7, text: 'latest', changedAtMs: 100 });

    for (const reason of ['submit', 'exit', 'error', 'dispose'] as const) {
      const result = scheduler.flush(reason);
      expect(result.reason).toBe(reason);
      expect(result.latest?.revision).toBe(7);
      expect(result.latest?.checkpoint.kind).toBe('durable');
      expect(Number.isFinite(result.latencyMs)).toBe(true);
    }
    const viewportAudit = fsSync.readFileSync(path.join(tempDir, 'viewport.tsv'), 'utf8');
    expect(viewportAudit).toContain('viewport_draft_flush');
    expect(viewportAudit).toContain('reason=dispose');
    expect(viewportAudit).toContain('latest_revision=7');
  });

  it('empty revisions fsync the directory and expose durability failure', () => {
    const { fs, audit } = context();
    persistViewportDraft(fs, audit, 'recover me');
    const error = Object.assign(new Error('directory sync failed'), { code: 'EIO' });
    vi.spyOn(fs, 'syncSync').mockImplementation(() => { throw error; });
    const scheduler = createDraftPersistenceScheduler(fs, audit);

    const result = scheduler.submit({ revision: 1, text: '', changedAtMs: 100 });

    expect(result.checkpoint).toEqual({
      kind: 'committed_durability_unknown',
      operation: 'clear',
      error,
    });
    const auditText = fsSync.readFileSync(path.join(tempDir, 'audit.tsv'), 'utf8');
    expect(auditText).toContain('viewport_draft_clear_failed');
    expect(auditText).toContain('commit_state=committed_durability_unknown');
  });

  it('audits persistence failure without crashing the editor callback', () => {
    const { fs, audit } = context();
    const write = vi.spyOn(fs, 'writeAtomicSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => persistViewportDraft(fs, audit, 'still in editor')).not.toThrow();

    write.mockRestore();
    const auditText = fsSync.readFileSync(path.join(tempDir, 'audit.tsv'), 'utf8');
    expect(auditText).toContain('viewport_draft_persist_failed');
    expect(auditText).toContain('chars=15');
    expect(auditText).toContain('reason=disk full');
  });
});
