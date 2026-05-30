/**
 * phase 1443: readFileState persistence — atomic write + load + clear.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import {
  persistReadFileState,
  loadReadFileState,
  clearReadFileState,
  READ_STATE_FILE,
} from '../../../src/foundation/file-tool/file-state-persist.js';
import { FILE_TOOL_AUDIT_EVENTS } from '../../../src/foundation/file-tool/audit-events.js';
import type { ExecContext, FileState } from '../../../src/foundation/tools/types.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';

describe('file-state-persist', () => {
  let tempDir: string;
  let nfs: NodeFileSystem;
  let auditHelper: ReturnType<typeof makeAudit>;
  let baseCtx: Pick<ExecContext, 'fs' | 'auditWriter' | 'readFileState' | 'persistReadFileState'>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    nfs = new NodeFileSystem({ baseDir: tempDir });
    auditHelper = makeAudit();
    baseCtx = {
      fs: nfs,
      auditWriter: auditHelper.audit,
      readFileState: new Map(),
      persistReadFileState: true,
    };
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('persistReadFileState writes JSON v1 atomically when persist flag set', async () => {
    baseCtx.readFileState.set('clawspace/notes.md', {
      hash: 'abc123',
      timestamp: 1717000000000,
      isFullRead: true,
    });

    await persistReadFileState(baseCtx as ExecContext);

    const onDisk = await fs.readFile(path.join(tempDir, READ_STATE_FILE), 'utf-8');
    const parsed = JSON.parse(onDisk);
    expect(parsed.version).toBe(1);
    expect(parsed.entries['clawspace/notes.md']).toEqual({
      hash: 'abc123',
      timestamp: 1717000000000,
      isFullRead: true,
    });
    expect(parsed.updated_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('persistReadFileState is a no-op when persist flag is false (subagent semantic)', async () => {
    baseCtx.persistReadFileState = false;
    baseCtx.readFileState.set('foo.md', { hash: 'x', timestamp: 1, isFullRead: false });

    await persistReadFileState(baseCtx as ExecContext);

    const exists = await fs.access(path.join(tempDir, READ_STATE_FILE)).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('loadReadFileState returns empty Map when file is missing (first run / cleared)', async () => {
    const loaded = await loadReadFileState(nfs, auditHelper.audit);
    expect(loaded.size).toBe(0);
    // ENOENT is silent — no audit emitted
    const loadAudits = auditHelper.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED);
    expect(loadAudits.length).toBe(0);
  });

  it('loadReadFileState restores entries from disk after round-trip', async () => {
    const original: FileState = { hash: 'xyz789', timestamp: 1717000123456, isFullRead: false };
    baseCtx.readFileState.set('clawspace/big.md', original);
    await persistReadFileState(baseCtx as ExecContext);

    const loaded = await loadReadFileState(nfs, auditHelper.audit);
    expect(loaded.get('clawspace/big.md')).toEqual(original);

    const loadAudits = auditHelper.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED);
    expect(loadAudits.length).toBe(1);
    expect(loadAudits[0].join(' ')).toMatch(/result=ok entry_count=1/);
  });

  it('loadReadFileState returns empty + audits parse_failed on corrupt JSON', async () => {
    await fs.writeFile(path.join(tempDir, READ_STATE_FILE), '{not valid json');

    const loaded = await loadReadFileState(nfs, auditHelper.audit);
    expect(loaded.size).toBe(0);

    const loadAudits = auditHelper.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED);
    expect(loadAudits.length).toBe(1);
    expect(loadAudits[0].join(' ')).toMatch(/result=parse_failed/);
  });

  it('loadReadFileState returns empty + audits skipped_unknown_version on v!=1 payload', async () => {
    await fs.writeFile(
      path.join(tempDir, READ_STATE_FILE),
      JSON.stringify({ version: 99, updated_at: '', entries: {} }),
    );

    const loaded = await loadReadFileState(nfs, auditHelper.audit);
    expect(loaded.size).toBe(0);

    const loadAudits = auditHelper.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED);
    expect(loadAudits.length).toBe(1);
    expect(loadAudits[0].join(' ')).toMatch(/skipped_unknown_version version=99/);
  });

  it('clearReadFileState empties Map AND deletes disk file (when persist set)', async () => {
    baseCtx.readFileState.set('a.md', { hash: 'h', timestamp: 1, isFullRead: true });
    await persistReadFileState(baseCtx as ExecContext);

    await clearReadFileState(baseCtx as ExecContext);

    expect(baseCtx.readFileState.size).toBe(0);
    const exists = await fs.access(path.join(tempDir, READ_STATE_FILE)).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('clearReadFileState silently handles missing file (ENOENT)', async () => {
    baseCtx.readFileState.set('a.md', { hash: 'h', timestamp: 1, isFullRead: true });
    // no prior persist → disk file doesn't exist

    await clearReadFileState(baseCtx as ExecContext);

    expect(baseCtx.readFileState.size).toBe(0);
    // No persist_failed audit for ENOENT
    const persistFailed = auditHelper.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_PERSIST_FAILED);
    expect(persistFailed.length).toBe(0);
  });

  it('clearReadFileState only empties Map when persist flag is false (subagent)', async () => {
    baseCtx.persistReadFileState = false;
    baseCtx.readFileState.set('a.md', { hash: 'h', timestamp: 1, isFullRead: true });

    await clearReadFileState(baseCtx as ExecContext);

    expect(baseCtx.readFileState.size).toBe(0);
    // No disk delete attempt for subagent
  });
});
