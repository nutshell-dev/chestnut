import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createViewportAudit } from '../../src/viewport/viewport-audit-events.js';
import {
  clearViewportDraft,
  loadViewportDraft,
  persistViewportDraft,
  VIEWPORT_DRAFT_FILE,
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

    clearViewportDraft(fs, audit);

    expect(fs.existsSync(VIEWPORT_DRAFT_FILE)).toBe(false);
    expect(loadViewportDraft(fs, audit)).toEqual({ kind: 'none' });
    expect(fsSync.readFileSync(path.join(tempDir, 'viewport.tsv'), 'utf8'))
      .toContain('viewport_draft_cleared');
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
