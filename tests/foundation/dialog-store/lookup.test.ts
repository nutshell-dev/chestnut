/**
 * Phase 147 Step B: dialog-store lookupContentByToolUseId + 4 级降级路径 invariant tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import {
  lookupContentByToolUseId,
  type LookupResult,
} from '../../../src/foundation/dialog-store/lookup.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import { makeToolUseId } from '../../../src/foundation/llm-provider/tool-use-id.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/types.js';

function makeFs(entries: Record<string, string | { size: number; isDirectory?: boolean }>): FileSystem {
  const store: Record<string, string> = {};
  const meta: Record<string, { size: number; isDirectory: boolean }> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (typeof v === 'string') {
      store[k] = v;
      meta[k] = { size: v.length, isDirectory: false };
    } else {
      meta[k] = { size: v.size, isDirectory: v.isDirectory ?? false };
    }
    // phase 918: auto-create parent directories so existsSync('/dialog') works
    let dir = k;
    while ((dir = path.dirname(dir)) !== '/' && !(dir in meta)) {
      meta[dir] = { size: 0, isDirectory: true };
    }
  }
  return {
    existsSync: (p: string) => p in store || p in meta,
    readSync: (p: string) => store[p] ?? '',
    statSync: (p: string) => ({
      size: meta[p]?.size ?? 0,
      mtime: new Date(),
      ctime: new Date(),
      isDirectory: () => meta[p]?.isDirectory ?? false,
      isFile: () => !meta[p]?.isDirectory,
    }),
    listSync: (p: string, opts?: { includeDirs?: boolean }) => {
      const result: { name: string; path: string; isDirectory: boolean; isFile: boolean; size: number; mtime: Date }[] = [];
      for (const key of Object.keys(meta)) {
        const dir = key.split('/').slice(0, -1).join('/') || '/';
        if (dir === p) {
          result.push({
            name: key.split('/').pop()!,
            path: key,
            isDirectory: meta[key].isDirectory,
            isFile: !meta[key].isDirectory,
            size: meta[key].size,
            mtime: new Date(),
          });
        }
      }
      if (!opts?.includeDirs) {
        return result.filter(e => !e.isDirectory);
      }
      return result;
    },
  } as unknown as FileSystem;
}

function currentJson(messages: unknown[]) {
  return JSON.stringify({ version: 2, messages });
}

describe('lookupContentByToolUseId', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('level 1: finds content in current.json', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello current' }] },
      ]),
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('current');
    expect((result as Extract<LookupResult, { source: 'current' }>).content).toBe('hello current');
  });

  it('level 2: falls back to archive when missing in current', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([]),
      '/dialog/archive': { size: 0, isDirectory: true },
      '/dialog/archive/1704067200000_abc123.json': currentJson([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello archive' }] },
      ]),
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('archive');
    const ar = result as Extract<LookupResult, { source: 'archive'; archivedAt: string }>;
    expect(ar.content).toBe('hello archive');
    expect(ar.archivedAt).toBe('1704067200000');
  });

  it('level 2: picks latest archive entry by ts desc', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([]),
      '/dialog/archive': { size: 0, isDirectory: true },
      '/dialog/archive/1704067200000_abc123.json': currentJson([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'old' }] },
      ]),
      '/dialog/archive/1706745600000_def456.json': currentJson([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'latest' }] },
      ]),
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('archive');
    const ar = result as Extract<LookupResult, { source: 'archive'; archivedAt: string }>;
    expect(ar.content).toBe('latest');
    expect(ar.archivedAt).toBe('1706745600000');
  });

  it('level 2: skips corrupted archive entry and continues scanning', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([]),
      '/dialog/archive': { size: 0, isDirectory: true },
      '/dialog/archive/1706745600000_bad1.json': 'not-valid-json',
      '/dialog/archive/1704067200000_good2.json': currentJson([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'from-second' }] },
      ]),
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('archive');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('parse failed'));
    const ar = result as Extract<LookupResult, { source: 'archive'; archivedAt: string }>;
    expect(ar.content).toBe('from-second');
  });

  it('level 4: unavailable when not in current nor archive', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([]),
      '/dialog/archive': { size: 0, isDirectory: true },
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('all_failed');
  });

  it('level 3: hash match returns archive with hashVerified', () => {
    const content = 'hello archive';
    const fs = makeFs({
      '/dialog/current.json': currentJson([]),
      '/dialog/archive': { size: 0, isDirectory: true },
      '/dialog/archive/1704067200000_abc123.json': currentJson([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
      ]),
    });
    // pre-computed sha8 of 'hello archive'
    const hash = require('node:crypto').createHash('sha256').update(content).digest('hex').slice(0, 8);
    const result = lookupContentByToolUseId(fs, '/dialog', 't1', { contentHash: hash });
    expect(result.source).toBe('archive');
    const ar = result as Extract<LookupResult, { source: 'archive'; hashVerified: true }>;
    expect(ar.hashVerified).toBe(true);
    expect(ar.content).toBe(content);
  });

  it('level 3: hash mismatch returns unavailable hash_mismatch', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([]),
      '/dialog/archive': { size: 0, isDirectory: true },
      '/dialog/archive/1704067200000_abc123.json': currentJson([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello archive' }] },
      ]),
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1', { contentHash: '00000000' });
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('hash_mismatch');
  });

  it('accepts ToolUseId brand type', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'branded' }] },
      ]),
    });
    const branded = makeToolUseId('t1');
    const result = lookupContentByToolUseId(fs, '/dialog', branded);
    expect(result.source).toBe('current');
    expect((result as Extract<LookupResult, { source: 'current' }>).content).toBe('branded');
  });

  it('unavailable when dialog dir does not exist', () => {
    const fs = makeFs({});
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('all_failed');
  });

  it('phase 918: returns not_in_current when current.json does not exist', () => {
    const fs = makeFs({
      '/dialog/archive': { size: 0, isDirectory: true },
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('not_in_current');
  });

  it('phase 919: returns not_in_current when current.json is corrupted', () => {
    const fs = makeFs({
      '/dialog/current.json': 'not-valid-json',
      '/dialog/archive': { size: 0, isDirectory: true },
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('not_in_current');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('current.json parse failed'));
  });

  it('phase 919: returns all_failed when current.json is valid but id not found and archive is empty', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'other', content: 'ok' }] },
      ]),
      '/dialog/archive': { size: 0, isDirectory: true },
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('all_failed');
  });

  it('phase 918: returns not_in_archive when archive directory list fails', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([]),
      '/dialog/archive': { size: 0, isDirectory: true },
    });
    vi.spyOn(fs, 'listSync').mockImplementation(() => {
      throw new Error('permission denied');
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('not_in_archive');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('archive list failed'));
  });

  it('serializes object content via JSON.stringify', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: { key: 'value' } }] },
      ]),
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('current');
    expect((result as Extract<LookupResult, { source: 'current' }>).content).toBe('{"key":"value"}');
  });

  it('skips string content messages (tool_result only in array content)', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([
        { role: 'user', content: 'plain text' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'found' }] },
      ]),
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('current');
    expect((result as Extract<LookupResult, { source: 'current' }>).content).toBe('found');
  });

  it('skips non-array content messages', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([
        { role: 'user', content: null },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'found' }] },
      ]),
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1');
    expect(result.source).toBe('current');
    expect((result as Extract<LookupResult, { source: 'current' }>).content).toBe('found');
  });

  it('phase 985: current.json EACCES read returns io_error and audits LOOKUP_IO_ERROR', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([]),
    });
    const audit = { write: vi.fn() } as unknown as AuditLog;
    vi.spyOn(fs, 'readSync').mockImplementation((p: string) => {
      if (p === '/dialog/current.json') {
        const err = new Error('EACCES: permission denied') as any;
        err.code = 'EACCES';
        throw err;
      }
      return (makeFs({}).readSync as any)(p);
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1', undefined, audit);
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('io_error');
    expect(audit.write).toHaveBeenCalledWith(
      DIALOG_AUDIT_EVENTS.LOOKUP_IO_ERROR,
      'file=current.json',
      'toolUseId=t1',
      'reason=EACCES',
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('phase 985: archive list EACCES returns io_error and audits LOOKUP_IO_ERROR', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([]),
      '/dialog/archive': { size: 0, isDirectory: true },
    });
    const audit = { write: vi.fn() } as unknown as AuditLog;
    vi.spyOn(fs, 'listSync').mockImplementation(() => {
      const err = new Error('EACCES: permission denied') as any;
      err.code = 'EACCES';
      throw err;
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1', undefined, audit);
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('io_error');
    expect(audit.write).toHaveBeenCalledWith(
      DIALOG_AUDIT_EVENTS.LOOKUP_IO_ERROR,
      'dir=archive',
      'toolUseId=t1',
      'reason=EACCES',
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('phase 985: archive file EACCES read returns io_error and audits LOOKUP_IO_ERROR', () => {
    const fs = makeFs({
      '/dialog/current.json': currentJson([]),
      '/dialog/archive': { size: 0, isDirectory: true },
      '/dialog/archive/1704067200000_abc123.json': currentJson([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello archive' }] },
      ]),
    });
    const audit = { write: vi.fn() } as unknown as AuditLog;
    vi.spyOn(fs, 'readSync').mockImplementation((p: string) => {
      if (p === '/dialog/archive/1704067200000_abc123.json') {
        const err = new Error('EACCES: permission denied') as any;
        err.code = 'EACCES';
        throw err;
      }
      // Fallback to original behavior for other paths.
      const base = makeFs({
        '/dialog/current.json': currentJson([]),
        '/dialog/archive': { size: 0, isDirectory: true },
        '/dialog/archive/1704067200000_abc123.json': currentJson([
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello archive' }] },
        ]),
      });
      return (base.readSync as any)(p);
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1', undefined, audit);
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('io_error');
    expect(audit.write).toHaveBeenCalledWith(
      DIALOG_AUDIT_EVENTS.LOOKUP_IO_ERROR,
      'file=1704067200000_abc123.json',
      'toolUseId=t1',
      'reason=EACCES',
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('phase 987: dialogDir existsSync EACCES returns unavailable io_error and audits LOOKUP_IO_ERROR', () => {
    const fs = makeFs({});
    const audit = { write: vi.fn() } as unknown as AuditLog;
    vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
      if (p === '/dialog') {
        const err = new Error('EACCES: permission denied') as any;
        err.code = 'EACCES';
        throw err;
      }
      return false;
    });
    const result = lookupContentByToolUseId(fs, '/dialog', 't1', undefined, audit);
    expect(result.source).toBe('unavailable');
    expect((result as Extract<LookupResult, { source: 'unavailable' }>).reason).toBe('io_error');
    expect(audit.write).toHaveBeenCalledWith(
      DIALOG_AUDIT_EVENTS.LOOKUP_IO_ERROR,
      'dir=dialog',
      'toolUseId=t1',
      expect.stringContaining('EACCES'),
    );
  });
});
